/**
 * Shared completion executor. Both the OpenRouter client and the mock client run through it, so the
 * mock exercises exactly the production logic for timeouts, HTTP retries with backoff, the single
 * parse/schema repair retry, input-size guard, usage aggregation, redaction and per-attempt records.
 * A `Transport` performs one attempt; the executor never throws.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { buildRepairPrompt, parseJsonContent, repairEcho, validateOutput } from './parse.js';
import { redactDeep, redactRaw, sanitizeRecord } from './sanitize.js';
import { redactAndTruncate, redactSecrets } from './redact.js';
import { toStrictJsonSchema, type JsonSchema } from './schemas.js';
import { aggregateUsage, messageChars, nextCallId, promptHash } from './usage.js';
import type {
  AttemptPhase,
  ChatMessage,
  CostSource,
  LlmAttemptRecord,
  LlmCallRecord,
  LlmError,
  LlmRequest,
  LlmResult,
  RepairReason,
  UsageSink,
} from './types.js';

export interface AttemptUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  costUsd: number | null;
  costSource: CostSource;
}

export interface AttemptInput {
  callId: string;
  request: LlmRequest<unknown>;
  model: string;
  /** Messages for this attempt (the caller's messages, plus the bad reply and repair prompt when repairing). */
  messages: ChatMessage[];
  jsonSchema: JsonSchema;
  schemaName: string;
  temperature: number | undefined;
  maxTokens: number | undefined;
  /** Combined per-attempt timeout + external abort signal; transports must honour it. */
  signal: AbortSignal;
  attempt: number;
  phase: AttemptPhase;
}

export type AttemptOutcome =
  | {
      kind: 'response';
      content: string | null;
      finishReason: string | null;
      /** `null` when the response carried no usage block (cost unknown). */
      usage: AttemptUsage | null;
      /** Model refusal text (OpenAI-style `message.refusal`), if any. */
      refusal?: string;
      provider?: string;
      generationId?: string;
    }
  | {
      kind: 'http_error';
      status: number;
      message: string;
      retryable: boolean;
      retryAfterMs?: number;
      /**
       * Accounting evidence: usage parsed from the error body; `unbilled` for a well-formed failure that
       * OpenRouter does not bill; `unknown` when there is no reliable evidence (malformed response).
       */
      billing: AttemptUsage | 'unbilled' | 'unknown';
      provider?: string;
      generationId?: string;
    }
  | { kind: 'network_error'; message: string }
  /** Simulated by transports that do not really wait (mock). */
  | { kind: 'timeout' }
  | { kind: 'aborted' }
  /** Non-retryable local failure (e.g. a mock handler threw); no attempt is recorded. */
  | { kind: 'fatal'; error: LlmError };

export type Transport = (input: AttemptInput) => Promise<AttemptOutcome>;

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface ExecutorOptions {
  transport: Transport;
  sink?: UsageSink | undefined;
  resolveModel(req: LlmRequest<unknown>): string;
  resolveTemperature(req: LlmRequest<unknown>): number | undefined;
  resolveMaxTokens(req: LlmRequest<unknown>): number | undefined;
  resolveMaxInputChars(req: LlmRequest<unknown>): number | undefined;
  /** Checked before any attempt; a returned error ends the call with zero attempts. */
  preflight?: ((req: LlmRequest<unknown>) => LlmError | null) | undefined;
  timeoutMs: number;
  httpRetries: number;
  retryOnTimeout: boolean;
  backoffBaseMs: number;
  backoffMaxMs: number;
  retryAfterCapMs: number;
  sleep: SleepFn;
  random: () => number;
  now: () => number;
  newCallId: () => string;
  logger?: ((line: string) => void) | undefined;
}

/** PLAN §9 concrete limits: 60 s per attempt, 2 HTTP retries with 1 s / 2 s backoff ±20 % jitter. */
export const DEFAULT_EXECUTOR_TUNING = {
  timeoutMs: 60_000,
  httpRetries: 2,
  retryOnTimeout: false,
  backoffBaseMs: 1_000,
  backoffMaxMs: 16_000,
  retryAfterCapMs: 30_000,
} as const;

/** Jitter amplitude: the backoff is multiplied by a factor in [1 - JITTER, 1 + JITTER]. */
export const BACKOFF_JITTER = 0.2;

export const realSleep: SleepFn = async (ms, signal) => {
  await delay(ms, undefined, signal ? { signal } : undefined);
};

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || (status >= 500 && status <= 599);
}

export function computeBackoffMs(
  retryIndex: number,
  opts: Pick<ExecutorOptions, 'backoffBaseMs' | 'backoffMaxMs' | 'retryAfterCapMs' | 'random'>,
  retryAfterMs?: number,
): number {
  const exponential = Math.min(opts.backoffMaxMs, opts.backoffBaseMs * 2 ** retryIndex);
  const jittered = Math.round(exponential * (1 - BACKOFF_JITTER + 2 * BACKOFF_JITTER * opts.random()));
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.max(jittered, Math.min(retryAfterMs, opts.retryAfterCapMs));
  }
  return jittered;
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const causeText = cause instanceof Error ? `: ${cause.message}` : '';
    return `${err.name}: ${err.message}${causeText}`;
  }
  return String(err);
}

type PhaseResult =
  | { kind: 'response'; content: string | null; finishReason: string | null; refusal?: string; record: LlmAttemptRecord }
  | { kind: 'error'; error: LlmError };

export async function executeCompletion<T>(req: LlmRequest<T>, opts: ExecutorOptions): Promise<LlmResult<T>> {
  const callId = opts.newCallId();
  const startedAt = opts.now();
  const attempts: LlmAttemptRecord[] = [];
  const request = req as LlmRequest<unknown>;
  let model = req.model ?? '(unresolved)';
  let repairUsed = false;
  let repairReason: RepairReason | undefined;
  let lastRaw: string | undefined;
  let lastProvider: string | undefined;
  let lastGenerationId: string | undefined;

  const log = (line: string): void => {
    if (!opts.logger) return;
    try {
      opts.logger(redactSecrets(line));
    } catch {
      // a failing logger must not break the call
    }
  };
  const who = `${req.role}${req.actor ? `/${req.actor}` : ''}`;

  const finish = (
    outcome: { ok: true; value: T; raw: string } | { ok: false; error: LlmError; raw?: string | undefined },
  ): LlmResult<T> => {
    const latencyMs = Math.max(0, opts.now() - startedAt);
    const usage = aggregateUsage(attempts);
    // Every string leaving the executor is redacted (metadata included).
    const common = {
      usage,
      attempts: attempts.length,
      latencyMs,
      model: redactSecrets(model),
      repairUsed,
      ...(repairReason !== undefined ? { repairReason } : {}),
      ...(lastProvider !== undefined ? { provider: redactSecrets(lastProvider) } : {}),
      ...(lastGenerationId !== undefined ? { generationId: redactSecrets(lastGenerationId) } : {}),
    };
    let result: LlmResult<T>;
    if (outcome.ok) {
      result = { ok: true, value: outcome.value, raw: redactRaw(outcome.raw), ...common };
    } else {
      const error: LlmError = { ...outcome.error, message: redactAndTruncate(outcome.error.message, 2_000) };
      result = {
        ok: false,
        error,
        ...(outcome.raw !== undefined ? { raw: redactRaw(outcome.raw) } : {}),
        ...common,
      };
    }
    const record: LlmCallRecord = {
      callId,
      ts: new Date(startedAt).toISOString(),
      role: req.role,
      ...(req.actor !== undefined ? { actor: req.actor } : {}),
      ...(req.sessionId !== undefined ? { sessionId: req.sessionId } : {}),
      ...(req.round !== undefined ? { round: req.round } : {}),
      ...(req.callTag !== undefined ? { callTag: req.callTag } : {}),
      model,
      ...(lastProvider !== undefined ? { provider: lastProvider } : {}),
      promptHash: promptHash(req.messages ?? []),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
      costSource: usage.costSource,
      latencyMs,
      attempts: attempts.length,
      status: result.ok ? 'ok' : result.error.kind,
      ...(result.ok ? {} : { error: redactAndTruncate(result.error.message) }),
      ...(lastGenerationId !== undefined ? { generationId: lastGenerationId } : {}),
      repairUsed,
      ...(repairReason !== undefined ? { repairReason } : {}),
      ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
    };
    if (opts.sink) {
      try {
        // Records are sanitized before ANY sink (custom sinks included) sees them.
        opts.sink.record(sanitizeRecord(record), attempts.map((a) => sanitizeRecord(a)));
      } catch (err) {
        log(`[llm] ${callId} usage sink failed: ${errorText(err)}`);
      }
    }
    return result;
  };

  try {
    model = opts.resolveModel(request);
    if (req.signal?.aborted) {
      return finish({ ok: false, error: { kind: 'aborted', message: 'aborted before any request was sent' } });
    }
    if (!Array.isArray(req.messages) || req.messages.length === 0) {
      return finish({ ok: false, error: { kind: 'config', message: 'request has no messages' } });
    }
    const maxInputChars = opts.resolveMaxInputChars(request);
    const inputChars = messageChars(req.messages);
    if (maxInputChars !== undefined && inputChars > maxInputChars) {
      return finish({
        ok: false,
        error: {
          kind: 'config',
          message: `input too large for role ${req.role}: ${inputChars} characters > limit ${maxInputChars} (trim the context)`,
        },
      });
    }
    const pre = opts.preflight?.(request) ?? null;
    if (pre) return finish({ ok: false, error: pre });

    let jsonSchema: JsonSchema;
    try {
      jsonSchema = toStrictJsonSchema(req.schema);
    } catch (err) {
      return finish({
        ok: false,
        error: { kind: 'config', message: `output schema "${req.schemaName}" is unusable: ${(err as Error).message}` },
      });
    }
    const temperature = opts.resolveTemperature(request);
    const maxTokens = opts.resolveMaxTokens(request);
    const timeoutMs = req.timeoutMs ?? opts.timeoutMs;

    const runPhase = async (phase: AttemptPhase, messages: ChatMessage[]): Promise<PhaseResult> => {
      let retries = 0;
      for (;;) {
        if (req.signal?.aborted) return { kind: 'error', error: { kind: 'aborted', message: 'aborted by caller' } };
        const attemptNo = attempts.length + 1;
        const attemptStart = opts.now();
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort(new Error(`timeout after ${timeoutMs} ms`));
        }, timeoutMs);
        const onExternalAbort = (): void => controller.abort(req.signal?.reason);
        req.signal?.addEventListener('abort', onExternalAbort, { once: true });
        let outcome: AttemptOutcome;
        try {
          outcome = await opts.transport({
            callId,
            request,
            model,
            messages,
            jsonSchema,
            schemaName: req.schemaName,
            temperature,
            maxTokens,
            signal: controller.signal,
            attempt: attemptNo,
            phase,
          });
        } catch (err) {
          if (req.signal?.aborted) outcome = { kind: 'aborted' };
          else if (timedOut) outcome = { kind: 'timeout' };
          else outcome = { kind: 'network_error', message: errorText(err) };
        } finally {
          clearTimeout(timer);
          req.signal?.removeEventListener('abort', onExternalAbort);
        }
        if (outcome.kind === 'fatal') return { kind: 'error', error: outcome.error };

        const record: LlmAttemptRecord = {
          callId,
          attemptNo,
          kind: retries > 0 ? 'http_retry' : phase === 'repair' ? 'repair' : 'first',
          status: 'ok',
          latencyMs: Math.max(0, opts.now() - attemptStart),
          generationId: null,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: null,
          costSource: 'none',
          reconciled: false,
        };
        attempts.push(record);

        if (outcome.kind === 'response') {
          if (outcome.usage) {
            record.inputTokens = outcome.usage.inputTokens;
            record.outputTokens = outcome.usage.outputTokens;
            if (outcome.usage.reasoningTokens !== undefined) record.reasoningTokens = outcome.usage.reasoningTokens;
            record.costUsd = outcome.usage.costSource === 'none' ? null : outcome.usage.costUsd;
            record.costSource = record.costUsd === null ? 'none' : outcome.usage.costSource;
          }
          if (outcome.provider !== undefined) {
            record.provider = outcome.provider;
            lastProvider = outcome.provider;
          }
          if (outcome.generationId !== undefined) {
            record.generationId = outcome.generationId;
            lastGenerationId = outcome.generationId;
          }
          if (outcome.finishReason !== null) record.finishReason = outcome.finishReason;
          if (req.signal?.aborted) {
            record.status = 'aborted';
            return { kind: 'error', error: { kind: 'aborted', message: 'aborted by caller (response discarded)' } };
          }
          return {
            kind: 'response',
            content: outcome.content,
            finishReason: outcome.finishReason,
            ...(outcome.refusal !== undefined ? { refusal: outcome.refusal } : {}),
            record,
          };
        }

        let error: LlmError;
        let retryable = false;
        let retryAfterMs: number | undefined;
        switch (outcome.kind) {
          case 'aborted':
            record.status = 'aborted';
            record.error = 'aborted by caller';
            return { kind: 'error', error: { kind: 'aborted', message: 'aborted by caller' } };
          case 'timeout':
            record.status = 'timeout';
            error = { kind: 'timeout', message: `no response within ${timeoutMs} ms` };
            retryable = opts.retryOnTimeout;
            break;
          case 'network_error':
            record.status = 'network';
            error = { kind: 'network', message: `network error: ${outcome.message}` };
            retryable = true;
            break;
          case 'http_error': {
            record.status = 'http';
            record.httpStatus = outcome.status;
            const billing = outcome.billing;
            if (billing === 'unbilled') {
              // a well-formed failure: OpenRouter does not bill failed requests / error finish reasons
              record.costUsd = 0;
              record.costSource = 'estimated';
            } else if (billing === 'unknown') {
              record.costUsd = null;
              record.costSource = 'none';
            } else {
              record.inputTokens = billing.inputTokens;
              record.outputTokens = billing.outputTokens;
              if (billing.reasoningTokens !== undefined) record.reasoningTokens = billing.reasoningTokens;
              record.costUsd = billing.costSource === 'none' ? null : billing.costUsd;
              record.costSource = record.costUsd === null ? 'none' : billing.costSource;
            }
            if (outcome.provider !== undefined) {
              record.provider = outcome.provider;
              lastProvider = outcome.provider;
            }
            if (outcome.generationId !== undefined) {
              record.generationId = outcome.generationId;
              lastGenerationId = outcome.generationId;
            }
            error = { kind: 'http', status: outcome.status, message: `HTTP ${outcome.status}: ${outcome.message}` };
            retryable = outcome.retryable;
            retryAfterMs = outcome.retryAfterMs;
            break;
          }
        }
        record.error = redactAndTruncate(error.message);

        if (retryable && retries < opts.httpRetries) {
          const waitMs = computeBackoffMs(retries, opts, retryAfterMs);
          record.retryDelayMs = waitMs;
          retries++;
          log(`[llm] ${callId} ${who} attempt ${attemptNo} (${phase}) failed: ${error.message}; retry ${retries}/${opts.httpRetries} in ${waitMs} ms`);
          try {
            await opts.sleep(waitMs, req.signal);
          } catch {
            return { kind: 'error', error: { kind: 'aborted', message: 'aborted by caller during retry backoff' } };
          }
          if (req.signal?.aborted) {
            return { kind: 'error', error: { kind: 'aborted', message: 'aborted by caller during retry backoff' } };
          }
          continue;
        }
        log(`[llm] ${callId} ${who} attempt ${attemptNo} (${phase}) failed: ${error.message}; giving up`);
        return { kind: 'error', error };
      }
    };

    let phase: AttemptPhase = 'initial';
    let messages: ChatMessage[] = req.messages.map((m) => ({ role: m.role, content: m.content }));
    for (;;) {
      const step = await runPhase(phase, messages);
      if (step.kind === 'error') return finish({ ok: false, error: step.error, raw: lastRaw });
      const content = step.content ?? '';
      lastRaw = content;

      // Filtered or refused output is an explicit failure (never parsed, never repaired); usage is kept.
      if (step.finishReason === 'content_filter' || step.refusal !== undefined) {
        step.record.status = 'filtered';
        const message =
          step.refusal !== undefined
            ? `model refused: ${step.refusal.slice(0, 300)}`
            : 'output blocked by the provider content filter (finish_reason=content_filter)';
        step.record.error = redactAndTruncate(message);
        log(`[llm] ${callId} ${who} attempt ${step.record.attemptNo}: ${message}`);
        return finish({ ok: false, error: { kind: 'filtered', message }, raw: content });
      }

      if (step.finishReason === 'length') {
        step.record.status = 'truncated';
        const reasoning = step.record.reasoningTokens ? `, reasoning tokens ${step.record.reasoningTokens}` : '';
        const message = `output truncated (finish_reason=length, max_tokens=${maxTokens ?? 'provider default'}${reasoning})`;
        step.record.error = message;
        log(`[llm] ${callId} ${who} attempt ${step.record.attemptNo}: ${message}`);
        return finish({ ok: false, error: { kind: 'truncated', message }, raw: content });
      }

      const parsed = parseJsonContent(step.content);
      let failure: { reason: RepairReason; detail: string };
      if (parsed.ok) {
        // Decoded strings are redacted BEFORE validation, so a returned value can never carry a secret.
        const validated = validateOutput(req.schema, redactDeep(parsed.value).value);
        if (validated.ok) {
          step.record.status = 'ok';
          return finish({ ok: true, value: validated.value, raw: content });
        }
        failure = { reason: 'schema', detail: validated.summary };
      } else {
        const note = step.finishReason && step.finishReason !== 'stop' ? ` (finish_reason=${step.finishReason})` : '';
        failure = { reason: 'parse', detail: `${parsed.message}${note}` };
      }
      step.record.status = failure.reason;
      step.record.error = redactAndTruncate(failure.detail);

      if (phase === 'repair') {
        log(`[llm] ${callId} ${who} repair attempt failed (${failure.reason})`);
        return finish({ ok: false, error: { kind: failure.reason, message: failure.detail }, raw: content });
      }
      repairUsed = true;
      repairReason = failure.reason;
      log(`[llm] ${callId} ${who} ${failure.reason} failure; sending one repair request`);
      messages = [
        ...req.messages.map((m) => ({ role: m.role, content: m.content })),
        { role: 'assistant', content: repairEcho(redactRaw(content), maxTokens) },
        { role: 'user', content: buildRepairPrompt(failure.reason, failure.detail) },
      ];
      phase = 'repair';
    }
  } catch (err) {
    return finish({ ok: false, error: { kind: 'config', message: `internal client error: ${errorText(err)}` }, raw: lastRaw });
  }
}

/** Builds executor defaults for callers that only want to override a few knobs. */
export function defaultExecutorDeps(): Pick<ExecutorOptions, 'sleep' | 'random' | 'now' | 'newCallId'> {
  return { sleep: realSleep, random: Math.random, now: Date.now, newCallId: nextCallId };
}
