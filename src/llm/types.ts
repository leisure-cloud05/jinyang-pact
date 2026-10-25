/**
 * Public types of the LLM client layer (WP C1). Domain-independent: nothing here knows
 * about Jinyang, characters or actions — callers pass messages plus a zod output contract.
 */
import type { z } from 'zod';

export const LLM_ROLES = ['character', 'judge', 'narrator', 'mapper', 'answer', 'rater', 'smoke'] as const;
export type LlmRole = (typeof LLM_ROLES)[number];

/** `json_schema` = strict structured outputs (default); `json_object` = JSON mode + schema described in the prompt. */
export const RESPONSE_FORMAT_MODES = ['json_schema', 'json_object'] as const;
export type ResponseFormatMode = (typeof RESPONSE_FORMAT_MODES)[number];

/** OPENROUTER_REASONING: `default` omits the `reasoning` parameter (model default). */
export const REASONING_SETTINGS = ['off', 'low', 'medium', 'high', 'default'] as const;
export type ReasoningSetting = (typeof REASONING_SETTINGS)[number];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmRequest<T> {
  role: LlmRole;
  actor?: string;
  sessionId?: string;
  round?: number;
  callTag?: string;
  /** Model slug; defaults to the configured model for `role`. */
  model?: string;
  messages: ChatMessage[];
  /** Output contract. The root must be a `z.object` (strict structured outputs need an object root). */
  schema: z.ZodType<T>;
  schemaName: string;
  temperature?: number;
  maxTokens?: number;
  /** External cancellation (e.g. an epoch bump). An external abort is never retried. */
  signal?: AbortSignal;
  /** Per-attempt timeout override (ms). */
  timeoutMs?: number;
  /** Structured context consumed by mock handlers only; never sent to the API. */
  meta?: Record<string, unknown>;
}

/**
 * - `reported`: every billable attempt carried a provider-reported cost (OpenRouter `usage.cost`; the
 *   mock reports 0).
 * - `estimated`: at least one part was computed locally (price table, or known-zero: HTTP-error attempts
 *   are not billed by OpenRouter, and calls that sent no request cost nothing).
 * - `none`: some billable attempt has an unknown cost (unknown model price and no reported cost, or a
 *   request that timed out / was aborted / lost its connection). Then `costUsd` is `null`, never 0.
 */
export type CostSource = 'reported' | 'estimated' | 'none';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  costSource: CostSource;
  /** Extension: reasoning tokens reported by the provider (already included in outputTokens). */
  reasoningTokens?: number;
}

export type LlmErrorKind =
  | 'timeout'
  | 'aborted'
  | 'http'
  | 'network'
  | 'parse'
  | 'schema'
  | 'truncated'
  /** Extension: the provider filtered the output (`finish_reason: content_filter`) or the model refused. */
  | 'filtered'
  | 'budget'
  | 'config';

export type LlmError = { kind: LlmErrorKind; message: string; status?: number };

/** Why the single repair retry was used (first bad output was unparseable JSON, or parsed but failed zod). */
export type RepairReason = 'parse' | 'schema';

/**
 * `attempts` counts every request attempt: HTTP retries, the repair attempt, and an attempt that was
 * in flight when the call was aborted. Extensions beyond the WP-C1 contract are optional fields
 * (`provider` on failures, `generationId`, `repairUsed`, `repairReason`).
 */
export type LlmResult<T> =
  | {
      ok: true;
      value: T;
      raw: string;
      usage: Usage;
      attempts: number;
      latencyMs: number;
      model: string;
      provider?: string;
      /** OpenRouter generation id (response `id`) of the response that produced `value`. */
      generationId?: string;
      /** Whether the single parse/schema repair retry was needed. */
      repairUsed?: boolean;
      repairReason?: RepairReason;
    }
  | {
      ok: false;
      error: LlmError;
      raw?: string;
      usage: Usage;
      attempts: number;
      latencyMs: number;
      model: string;
      /** Provider / generation id of the last response received, if any. */
      provider?: string;
      generationId?: string;
      repairUsed?: boolean;
      repairReason?: RepairReason;
    };

/** Implementations never throw from `complete`; every failure is an `{ ok: false }` result. */
export interface LlmClient {
  complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>>;
}

/** Phase of a logical call: the initial request, or the single parse/schema repair request. */
export type AttemptPhase = 'initial' | 'repair';
/** PLAN §9 cost record contract: first attempt, an HTTP/network/timeout retry, or the repair attempt. */
export type AttemptKind = 'first' | 'http_retry' | 'repair';
export type AttemptStatus = 'ok' | 'http' | 'network' | 'timeout' | 'aborted' | 'parse' | 'schema' | 'truncated' | 'filtered';

/**
 * One request attempt of a logical call (PLAN §9 `llm_attempts` row). A billed malformed response and
 * its billed repair are two attempts with two generation ids; call totals are the sums over attempts.
 */
export interface LlmAttemptRecord {
  callId: string;
  /** 1-based index within the call. */
  attemptNo: number;
  kind: AttemptKind;
  status: AttemptStatus;
  latencyMs: number;
  /** OpenRouter generation id (response `id`), null when no response was received. */
  generationId: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  costSource: CostSource;
  /** Set by a later reconciliation against OpenRouter generation records; always false when written by the client. */
  reconciled: boolean;
  /** Extensions (diagnostics). */
  httpStatus?: number;
  provider?: string;
  finishReason?: string;
  reasoningTokens?: number;
  /** Backoff scheduled after this attempt before the next HTTP retry. */
  retryDelayMs?: number;
  /** Redacted, truncated error detail. */
  error?: string;
}

export interface LlmCallRecord {
  callId: string;
  ts: string;
  role: LlmRole;
  actor?: string;
  sessionId?: string;
  round?: number;
  callTag?: string;
  model: string;
  provider?: string;
  promptHash: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  costSource: CostSource;
  latencyMs: number;
  attempts: number;
  status: 'ok' | LlmErrorKind;
  error?: string;
  /** Extensions (diagnostics for the smoke report, cost reconciliation and pilot tuning). */
  generationId?: string;
  repairUsed?: boolean;
  repairReason?: RepairReason;
  reasoningTokens?: number;
}

/**
 * Receives one logical-call record (PLAN §9 `llm_calls` row) together with its attempt records
 * (`llm_attempts` rows; empty when no request was sent, e.g. a budget refusal or input-size failure).
 * Token and cost totals on `call` are the sums over `attempts`.
 */
export interface UsageSink {
  record(call: LlmCallRecord, attempts: readonly LlmAttemptRecord[]): void;
}
