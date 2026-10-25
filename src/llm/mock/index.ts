/**
 * Deterministic mock LLM. Handlers are registered per role (optionally narrowed to an actor and/or a
 * callTag) and return the structured output (or a raw string to emit verbatim). Output goes through the
 * same executor as the OpenRouter client: JSON round trip, strict-schema conversion, zod validation,
 * the single repair retry, HTTP-retry logic, input-size guard, per-attempt usage records.
 *
 * Failure injection (tests / misbehaviour runs): explicit FIFO scripts via `injectFaults`, or seeded
 * random `faultRates`. Faults apply per attempt, e.g. `['invalid_json']` = first attempt returns broken
 * JSON, the repair attempt gets the handler's normal output.
 *
 * Usage: tokens are estimated as characters / 4; cost is a reported 0 (provider `mock`).
 * Persona handlers are added by the agents work package (`src/llm/mock/personas*`).
 */
import { DEFAULT_EXECUTOR_TUNING, executeCompletion } from '../core.js';
import type { AttemptInput, AttemptOutcome, ExecutorOptions, SleepFn } from '../core.js';
import { estimateTokensFromChars, messageChars, nextCallId } from '../usage.js';
import type { AttemptPhase, ChatMessage, LlmClient, LlmRequest, LlmResult, LlmRole, UsageSink } from '../types.js';
import { seededRng } from './prng.js';

export const MOCK_MODEL = 'mock';
export const MOCK_PROVIDER = 'mock';
/** Content emitted for an `invalid_json` fault (neither JSON nor recoverable by brace extraction). */
export const MOCK_INVALID_JSON = 'Sorry, here is my answer: {"unterminated": tru';

export interface MockCallContext {
  callId: string;
  attempt: number;
  phase: AttemptPhase;
  /** Messages of this attempt (includes the bad reply + repair prompt on a repair attempt). */
  messages: ChatMessage[];
  /** Seeded by (seed, sessionId, round, role, actor, callTag, keyCallIndex, attempt): independent of call order. */
  rng: () => number;
  /** 0-based index of this call among calls with the same (sessionId, round, role, actor, callTag). */
  keyCallIndex: number;
}

/** Returns the output object (validated with the request's zod schema) or a raw string. May be async. */
export type MockHandler = (req: LlmRequest<unknown>, ctx: MockCallContext) => unknown;

export interface MockMatch {
  role: LlmRole;
  actor?: string;
  callTag?: string;
}

export const MOCK_FAULT_KINDS = [
  'timeout',
  'abort',
  'network',
  'http_429',
  'http_500',
  'http_400',
  'invalid_json',
  'schema_invalid',
  'truncated',
  'content_filter',
] as const;
export type MockFaultKind = (typeof MOCK_FAULT_KINDS)[number];
/** `content` overrides the emitted text for invalid_json / schema_invalid / truncated / content_filter. */
export type MockFault = MockFaultKind | { kind: MockFaultKind; content?: string };

export interface MockLlmClientOptions {
  sink?: UsageSink | undefined;
  seed?: number;
  /** Probability per attempt of each fault (sum ≤ 1), drawn from a seeded PRNG. */
  faultRates?: Partial<Record<MockFaultKind, number>>;
  /** Model name recorded for mock calls (default `mock`, regardless of `req.model`). */
  model?: string;
  httpRetries?: number;
  timeoutMs?: number;
  retryOnTimeout?: boolean;
  maxTokens?: Partial<Record<LlmRole, number>>;
  maxInputChars?: Partial<Record<LlmRole, number>>;
  /** Backoff sleep; default resolves immediately (the mock never waits). */
  sleep?: SleepFn;
  now?: () => number;
  newCallId?: () => string;
  logger?: ((line: string) => void) | undefined;
}

export interface MockAttemptLogEntry {
  callId: string;
  role: LlmRole;
  actor?: string;
  callTag?: string;
  attempt: number;
  phase: AttemptPhase;
  fault: MockFaultKind | null;
}

interface Registration {
  match: MockMatch;
  handler: MockHandler;
  order: number;
}

function normalizeFault(fault: MockFault): { kind: MockFaultKind; content?: string } {
  return typeof fault === 'string' ? { kind: fault } : fault;
}

function describeKey(role: LlmRole, actor?: string, callTag?: string): string {
  return `role=${role}${actor !== undefined ? ` actor=${actor}` : ''}${callTag !== undefined ? ` callTag=${callTag}` : ''}`;
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

export class MockLlmClient implements LlmClient {
  readonly seed: number;
  /** One entry per attempt (fault or normal), for tests and debugging. */
  readonly attemptLog: MockAttemptLogEntry[] = [];
  private readonly handlers: Registration[] = [];
  private readonly faultQueue: Array<{ match: Partial<MockMatch>; fault: { kind: MockFaultKind; content?: string } }> = [];
  private readonly faultRates: Partial<Record<MockFaultKind, number>> | undefined;
  private readonly keyCounters = new Map<string, number>();
  private readonly keyIndexByRequest = new WeakMap<object, number>();
  private readonly executor: ExecutorOptions;
  private registrations = 0;

  constructor(options: MockLlmClientOptions = {}) {
    this.seed = options.seed ?? 1;
    if (options.faultRates) {
      const total = Object.values(options.faultRates).reduce((a, b) => a + (b ?? 0), 0);
      if (total > 1 || Object.values(options.faultRates).some((r) => (r ?? 0) < 0)) {
        throw new RangeError('faultRates must be non-negative and sum to at most 1');
      }
    }
    this.faultRates = options.faultRates;
    const model = options.model ?? MOCK_MODEL;
    const maxTokens = options.maxTokens ?? {};
    const maxInputChars = options.maxInputChars ?? {};
    this.executor = {
      transport: (input) => this.transport(input),
      sink: options.sink,
      resolveModel: () => model,
      resolveTemperature: (req) => req.temperature,
      resolveMaxTokens: (req) => req.maxTokens ?? maxTokens[req.role],
      resolveMaxInputChars: (req) => maxInputChars[req.role],
      preflight: (req) =>
        this.findHandler(req.role, req.actor, req.callTag)
          ? null
          : { kind: 'config', message: `no mock handler registered for ${describeKey(req.role, req.actor, req.callTag)}` },
      timeoutMs: options.timeoutMs ?? DEFAULT_EXECUTOR_TUNING.timeoutMs,
      httpRetries: options.httpRetries ?? DEFAULT_EXECUTOR_TUNING.httpRetries,
      retryOnTimeout: options.retryOnTimeout ?? DEFAULT_EXECUTOR_TUNING.retryOnTimeout,
      backoffBaseMs: DEFAULT_EXECUTOR_TUNING.backoffBaseMs,
      backoffMaxMs: DEFAULT_EXECUTOR_TUNING.backoffMaxMs,
      retryAfterCapMs: DEFAULT_EXECUTOR_TUNING.retryAfterCapMs,
      sleep: options.sleep ?? (async () => {}),
      random: () => 0.5,
      now: options.now ?? Date.now,
      newCallId: options.newCallId ?? nextCallId,
      logger: options.logger,
    };
  }

  /** Registers a handler. More specific matches win (actor > callTag > role only); later wins on ties. */
  register(match: LlmRole | MockMatch, handler: MockHandler): this {
    const m: MockMatch = typeof match === 'string' ? { role: match } : { ...match };
    this.registrations += 1;
    this.handlers.push({ match: m, handler, order: this.registrations });
    return this;
  }

  hasHandler(role: LlmRole, actor?: string, callTag?: string): boolean {
    return this.findHandler(role, actor, callTag) !== undefined;
  }

  /** Queues faults (consumed one per attempt, FIFO) for attempts whose request matches `match`. */
  injectFaults(faults: readonly MockFault[], match: Partial<MockMatch> = {}): this {
    for (const fault of faults) this.faultQueue.push({ match: { ...match }, fault: normalizeFault(fault) });
    return this;
  }

  get pendingFaults(): number {
    return this.faultQueue.length;
  }

  clearFaults(): this {
    this.faultQueue.length = 0;
    return this;
  }

  complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    const tagged: LlmRequest<T> = { ...req };
    const key = [req.sessionId, req.round, req.role, req.actor, req.callTag].map((v) => (v === undefined ? '-' : String(v))).join('|');
    const index = this.keyCounters.get(key) ?? 0;
    this.keyCounters.set(key, index + 1);
    this.keyIndexByRequest.set(tagged, index);
    return executeCompletion(tagged, this.executor);
  }

  private findHandler(role: LlmRole, actor?: string, callTag?: string): Registration | undefined {
    let best: { entry: Registration; score: number } | undefined;
    for (const entry of this.handlers) {
      const m = entry.match;
      if (m.role !== role) continue;
      if (m.actor !== undefined && m.actor !== actor) continue;
      if (m.callTag !== undefined && m.callTag !== callTag) continue;
      const score = (m.actor !== undefined ? 2 : 0) + (m.callTag !== undefined ? 1 : 0);
      if (!best || score > best.score || (score === best.score && entry.order > best.entry.order)) best = { entry, score };
    }
    return best?.entry;
  }

  private takeFault(req: LlmRequest<unknown>, input: AttemptInput, keyIndex: number): { kind: MockFaultKind; content?: string } | null {
    const idx = this.faultQueue.findIndex(
      ({ match }) =>
        (match.role === undefined || match.role === req.role) &&
        (match.actor === undefined || match.actor === req.actor) &&
        (match.callTag === undefined || match.callTag === req.callTag),
    );
    if (idx >= 0) return this.faultQueue.splice(idx, 1)[0]?.fault ?? null;
    if (this.faultRates) {
      const r = seededRng(this.seed, 'fault', req.sessionId, req.round, req.role, req.actor, req.callTag, keyIndex, input.attempt)();
      let acc = 0;
      for (const kind of MOCK_FAULT_KINDS) {
        acc += this.faultRates[kind] ?? 0;
        if (r < acc) return { kind };
      }
    }
    return null;
  }

  private async transport(input: AttemptInput): Promise<AttemptOutcome> {
    const req = input.request;
    const keyIndex = this.keyIndexByRequest.get(req) ?? 0;
    const fault = this.takeFault(req, input, keyIndex);
    this.attemptLog.push({
      callId: input.callId,
      role: req.role,
      ...(req.actor !== undefined ? { actor: req.actor } : {}),
      ...(req.callTag !== undefined ? { callTag: req.callTag } : {}),
      attempt: input.attempt,
      phase: input.phase,
      fault: fault?.kind ?? null,
    });
    if (input.signal.aborted) throw input.signal.reason ?? new Error('aborted');
    switch (fault?.kind) {
      case 'timeout':
        return { kind: 'timeout' };
      case 'abort':
        return { kind: 'aborted' };
      case 'network':
        return { kind: 'network_error', message: 'mock network failure' };
      case 'http_429':
        return { kind: 'http_error', status: 429, message: 'mock rate limit', retryable: true, billing: 'unbilled' };
      case 'http_500':
        return { kind: 'http_error', status: 500, message: 'mock upstream error', retryable: true, billing: 'unbilled' };
      case 'http_400':
        return { kind: 'http_error', status: 400, message: 'mock bad request', retryable: false, billing: 'unbilled' };
      default:
        break;
    }
    const registration = this.findHandler(req.role, req.actor, req.callTag);
    if (!registration) {
      return { kind: 'fatal', error: { kind: 'config', message: `no mock handler registered for ${describeKey(req.role, req.actor, req.callTag)}` } };
    }
    const ctx: MockCallContext = {
      callId: input.callId,
      attempt: input.attempt,
      phase: input.phase,
      messages: input.messages,
      rng: seededRng(this.seed, 'handler', req.sessionId, req.round, req.role, req.actor, req.callTag, keyIndex, input.attempt),
      keyCallIndex: keyIndex,
    };
    let output: unknown;
    try {
      output = await raceAbort(Promise.resolve().then(() => registration.handler(req, ctx)), input.signal);
    } catch (err) {
      if (input.signal.aborted) throw err;
      return {
        kind: 'fatal',
        error: { kind: 'config', message: `mock handler for ${describeKey(req.role, req.actor, req.callTag)} threw: ${(err as Error).message}` },
      };
    }
    let content = typeof output === 'string' ? output : (JSON.stringify(output) ?? 'null');
    let finishReason = 'stop';
    if (fault?.kind === 'invalid_json') content = fault.content ?? MOCK_INVALID_JSON;
    else if (fault?.kind === 'schema_invalid') content = fault.content ?? '[]';
    else if (fault?.kind === 'truncated') {
      content = fault.content ?? content.slice(0, Math.floor(content.length / 2));
      finishReason = 'length';
    } else if (fault?.kind === 'content_filter') {
      content = fault.content ?? content;
      finishReason = 'content_filter';
    }
    return {
      kind: 'response',
      content,
      finishReason,
      usage: {
        inputTokens: estimateTokensFromChars(messageChars(input.messages)),
        outputTokens: estimateTokensFromChars(content.length),
        costUsd: 0,
        costSource: 'reported',
      },
      provider: MOCK_PROVIDER,
      generationId: `mock-${input.callId}-${input.attempt}`,
    };
  }
}
