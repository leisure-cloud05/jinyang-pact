/**
 * Per-session budget guard (max calls, max USD) that is safe under parallel calls.
 *
 * Before a call it synchronously (hence atomically on the JS event loop) reserves one call slot and a
 * worst-case cost; if either does not fit, the call is refused with `{ kind: 'budget' }` without touching
 * the inner client. After the call the reservation is released and the actual cost (reported or
 * estimated) is charged; an unknown cost (`null`) is charged at the reserved worst case.
 *
 * Worst case of one logical call = every potentially billed attempt:
 *   (1 + httpRetries) attempts of the initial request + (1 + httpRetries) attempts of the repair request.
 * Token bounds (a byte-level BPE token covers ≥ 1 UTF-8 byte, and UTF-8 bytes ≤ 3 × JS string length):
 *   prompt  = Σ (UTF-8 bytes of each message + per-message template allowance) + schema bytes (both the
 *             json_schema payload and the json_object prompt description) + request allowance
 *   repair  = prompt + 3 × (echo cap + repair-prompt cap) + allowances   (both caps enforced in parse.ts)
 *   output  = max_tokens per attempt (reasoning tokens count toward max_tokens)
 * priced at the model's price BOUND (prices.ts), which OpenRouter enforces through `provider.max_price`.
 *
 * Live (priced) mode: a model without a price bound is rejected with `{ kind: 'config' }` under a finite
 * USD cap. Mock mode (`requirePrice: false`) is exempt: unpriced models reserve 0 (mock cost is 0).
 */
import { JSON_OBJECT_INSTRUCTION } from './openrouter.js';
import { repairEchoMaxChars, REPAIR_PROMPT_MAX_CHARS } from './parse.js';
import { lookupPrice, DEFAULT_PRICES, type PriceTable } from './prices.js';
import { redactAndTruncate } from './redact.js';
import { sanitizeRecord, sanitizeResult } from './sanitize.js';
import { describeSchemaCompact, toStrictJsonSchema } from './schemas.js';
import { nextCallId, promptHash } from './usage.js';
import type { LlmCallRecord, LlmClient, LlmErrorKind, LlmRequest, LlmResult, UsageSink } from './types.js';

export interface BudgetLimits {
  maxCallsPerSession: number;
  maxUsdPerSession: number;
}

export interface BudgetOptions {
  sink?: UsageSink | undefined;
  /** Model used for pricing the reservation; default `req.model`. */
  resolveModel?: (req: LlmRequest<unknown>) => string | undefined;
  /** Output cap used for the reservation; default `req.maxTokens`, else `fallbackMaxTokens`. */
  resolveMaxTokens?: (req: LlmRequest<unknown>) => number | undefined;
  fallbackMaxTokens?: number;
  /** HTTP retries of the inner client (every retry may be billed). Default 2. */
  httpRetries?: number;
  prices?: PriceTable;
  /** Require a price bound for every model (live mode). Default true; the mock factory passes false. */
  requirePrice?: boolean;
  now?: () => number;
  newCallId?: () => string;
}

export interface BudgetStatus {
  sessionKey: string;
  calls: number;
  inFlight: number;
  spentUsd: number;
  reservedUsd: number;
  maxCalls: number;
  maxUsd: number;
  unknownCostCalls: number;
  exhausted: boolean;
}

interface SessionBudget {
  calls: number;
  inFlight: number;
  spentUsd: number;
  reservedUsd: number;
  unknownCostCalls: number;
}

export const NO_SESSION_KEY = '(no-session)';
/** Chat-template tokens per message (role markers, separators) — generous allowance. */
export const MESSAGE_OVERHEAD_TOKENS = 16;
/** Per-request allowance (BOS/assistant prefix, response-format wrapper). */
export const REQUEST_OVERHEAD_TOKENS = 64;

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export class BudgetedClient implements LlmClient {
  readonly inner: LlmClient;
  readonly limits: Readonly<BudgetLimits>;
  private readonly options: BudgetOptions;
  private readonly sessions = new Map<string, SessionBudget>();

  constructor(inner: LlmClient, limits: BudgetLimits, options: BudgetOptions = {}) {
    if (!Number.isInteger(limits.maxCallsPerSession) || limits.maxCallsPerSession < 1) {
      throw new RangeError('maxCallsPerSession must be an integer >= 1');
    }
    if (!(limits.maxUsdPerSession > 0)) throw new RangeError('maxUsdPerSession must be > 0 (use Infinity for no USD cap)');
    this.inner = inner;
    this.limits = { ...limits };
    this.options = options;
  }

  private session(key: string): SessionBudget {
    let s = this.sessions.get(key);
    if (!s) {
      s = { calls: 0, inFlight: 0, spentUsd: 0, reservedUsd: 0, unknownCostCalls: 0 };
      this.sessions.set(key, s);
    }
    return s;
  }

  /** Upper bound on the input tokens of one initial-request attempt. */
  promptTokenBound(req: LlmRequest<unknown>): number {
    let schemaBytes = 0;
    try {
      const strict = toStrictJsonSchema(req.schema);
      schemaBytes = utf8Bytes(JSON.stringify(strict)) + utf8Bytes(describeSchemaCompact(strict)) + utf8Bytes(JSON_OBJECT_INSTRUCTION);
    } catch {
      schemaBytes = 0; // the inner client rejects the schema before sending anything
    }
    const messages = (req.messages ?? []).reduce((n, m) => n + utf8Bytes(m.content) + MESSAGE_OVERHEAD_TOKENS, 0);
    return messages + schemaBytes + REQUEST_OVERHEAD_TOKENS;
  }

  /** Worst-case USD for one logical call (see module doc); `null` when the model has no price bound. */
  reservationUsd(req: LlmRequest<unknown>): number | null {
    const model = this.options.resolveModel?.(req) ?? req.model;
    const price = model ? lookupPrice(model, this.options.prices ?? DEFAULT_PRICES) : undefined;
    if (!price) return null;
    const maxTokens = req.maxTokens ?? this.options.resolveMaxTokens?.(req) ?? this.options.fallbackMaxTokens ?? 4096;
    const attemptsPerPhase = 1 + (this.options.httpRetries ?? 2);
    const prompt = this.promptTokenBound(req);
    const repairPrompt = prompt + 3 * (repairEchoMaxChars(maxTokens) + REPAIR_PROMPT_MAX_CHARS) + 2 * MESSAGE_OVERHEAD_TOKENS;
    const inputTokens = attemptsPerPhase * (prompt + repairPrompt);
    const outputTokens = attemptsPerPhase * 2 * maxTokens;
    return (inputTokens * price.inputUsdPerMTok + outputTokens * price.outputUsdPerMTok) / 1_000_000;
  }

  status(sessionId?: string): BudgetStatus {
    const key = sessionId ?? NO_SESSION_KEY;
    const s = this.sessions.get(key) ?? { calls: 0, inFlight: 0, spentUsd: 0, reservedUsd: 0, unknownCostCalls: 0 };
    return {
      sessionKey: key,
      ...s,
      maxCalls: this.limits.maxCallsPerSession,
      maxUsd: this.limits.maxUsdPerSession,
      exhausted: s.calls + s.inFlight >= this.limits.maxCallsPerSession || s.spentUsd >= this.limits.maxUsdPerSession,
    };
  }

  async complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    const key = req.sessionId ?? NO_SESSION_KEY;
    const s = this.session(key);
    const model = this.options.resolveModel?.(req as LlmRequest<unknown>) ?? req.model ?? 'unknown';
    const { maxCallsPerSession: maxCalls, maxUsdPerSession: maxUsd } = this.limits;
    const bound = this.reservationUsd(req as LlmRequest<unknown>);

    // --- atomic check-and-reserve (no await before this point) ---
    if (bound === null && (this.options.requirePrice ?? true) && Number.isFinite(maxUsd)) {
      return this.refuse(
        req,
        'config',
        `no price bound for model "${model}": add it to LLM_PRICE_BOUNDS (vendor/model=<input>/<output> USD per million tokens) ` +
          'so the USD budget can reserve a worst case and OpenRouter can enforce provider.max_price',
      );
    }
    const reservation = bound ?? 0;
    if (s.calls + s.inFlight >= maxCalls) {
      return this.refuse(req, 'budget', `call budget exhausted for session ${key}: ${s.calls} done + ${s.inFlight} in flight >= ${maxCalls}`);
    }
    if (s.spentUsd >= maxUsd || s.spentUsd + s.reservedUsd + reservation > maxUsd) {
      return this.refuse(
        req,
        'budget',
        `USD budget for session ${key}: spent $${s.spentUsd.toFixed(6)} + reserved $${s.reservedUsd.toFixed(6)} ` +
          `+ this call's worst case $${reservation.toFixed(6)} > $${maxUsd}`,
      );
    }
    s.inFlight += 1;
    s.reservedUsd += reservation;

    let result: LlmResult<T>;
    try {
      result = await this.inner.complete(req);
    } catch (err) {
      result = {
        ok: false,
        error: { kind: 'config', message: redactAndTruncate(`inner LLM client threw: ${(err as Error)?.message ?? String(err)}`) },
        usage: { inputTokens: 0, outputTokens: 0, costUsd: null, costSource: 'none' },
        attempts: 1,
        latencyMs: 0,
        model,
      };
    } finally {
      s.inFlight -= 1;
      s.reservedUsd = s.inFlight === 0 ? 0 : Math.max(0, s.reservedUsd - reservation);
    }
    if (result.attempts > 0) s.calls += 1;
    if (result.usage.costUsd === null) {
      if (result.attempts > 0) {
        s.unknownCostCalls += 1;
        s.spentUsd += reservation;
      }
    } else {
      s.spentUsd += result.usage.costUsd;
    }
    return sanitizeResult(result, req.schema);
  }

  private refuse<T>(req: LlmRequest<T>, kind: Extract<LlmErrorKind, 'budget' | 'config'>, rawMessage: string): LlmResult<T> {
    const message = redactAndTruncate(rawMessage, 2_000);
    const model = this.options.resolveModel?.(req as LlmRequest<unknown>) ?? req.model ?? 'unknown';
    const now = this.options.now ?? Date.now;
    const record: LlmCallRecord = {
      callId: (this.options.newCallId ?? nextCallId)(),
      ts: new Date(now()).toISOString(),
      role: req.role,
      ...(req.actor !== undefined ? { actor: req.actor } : {}),
      ...(req.sessionId !== undefined ? { sessionId: req.sessionId } : {}),
      ...(req.round !== undefined ? { round: req.round } : {}),
      ...(req.callTag !== undefined ? { callTag: req.callTag } : {}),
      model,
      promptHash: promptHash(req.messages ?? []),
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      costSource: 'estimated',
      latencyMs: 0,
      attempts: 0,
      status: kind,
      error: message,
      repairUsed: false,
    };
    try {
      this.options.sink?.record(sanitizeRecord(record), []);
    } catch {
      // recording must not turn a refusal into a throw
    }
    return sanitizeResult<T>({
      ok: false,
      error: { kind, message },
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, costSource: 'estimated' },
      attempts: 0,
      latencyMs: 0,
      model,
      repairUsed: false,
    });
  }
}
