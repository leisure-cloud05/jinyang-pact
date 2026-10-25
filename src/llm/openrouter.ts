/**
 * OpenRouter chat-completions client (non-streaming).
 *
 * Request body: `model, messages, temperature, max_tokens, response_format, provider: { require_parameters:
 * true }, usage: { include: true }` and optionally `reasoning`. References (checked 2026-09-27):
 * - structured outputs: https://openrouter.ai/docs/guides/features/structured-outputs
 * - provider routing (`require_parameters`): https://openrouter.ai/docs/features/provider-routing
 * - reasoning: https://openrouter.ai/docs/guides/best-practices/reasoning-tokens — `reasoning: { effort |
 *   max_tokens, exclude, enabled }`; DeepSeek models mainly honour `enabled`; reasoning tokens count as
 *   output tokens and toward `max_tokens`.
 * - usage accounting: https://openrouter.ai/docs/cookbook/administration/usage-accounting — usage (with
 *   `cost`) is now always returned; `usage: { include: true }` is deprecated and has no effect (sent anyway
 *   because it is harmless and the WP contract lists it).
 * - errors: https://openrouter.ai/docs/api-reference/errors — a 200 response can carry an `error` body.
 */
import { DEFAULT_EXECUTOR_TUNING, executeCompletion, isRetryableStatus, realSleep } from './core.js';
import type { AttemptInput, AttemptOutcome, AttemptUsage, ExecutorOptions, SleepFn, Transport } from './core.js';
import { DEFAULT_PRICES, estimateCostUsd, lookupPrice, maxPriceParam, type PriceTable } from './prices.js';
import { redactAndTruncate, registerSecret, SecretValue } from './redact.js';
import { describeSchemaCompact, type JsonSchema } from './schemas.js';
import { nextCallId } from './usage.js';
import type {
  ChatMessage,
  LlmClient,
  LlmRequest,
  LlmResult,
  LlmRole,
  ReasoningSetting,
  ResponseFormatMode,
  UsageSink,
} from './types.js';
import type { AppConfig } from '../config/env.js';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_APP_TITLE = 'Jinyang Pact (DSA4213)';
export const DEFAULT_OPENROUTER_MODEL = 'deepseek/deepseek-v4-flash';

/** Minimal structural `fetch` so tests can inject a fake; the global `fetch` satisfies it. */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<FetchResponseLike>;

export interface ClientDeps {
  fetch?: FetchLike;
  sleep?: SleepFn;
  random?: () => number;
  now?: () => number;
  newCallId?: () => string;
  logger?: (line: string) => void;
}

export interface OpenRouterClientOptions extends ClientDeps {
  apiKey: string | SecretValue;
  models?: Partial<Record<LlmRole, string>>;
  temperatures?: Partial<Record<LlmRole, number>>;
  maxTokens?: Partial<Record<LlmRole, number>>;
  maxInputChars?: Partial<Record<LlmRole, number>>;
  timeoutMs?: number;
  httpRetries?: number;
  retryOnTimeout?: boolean;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  responseFormat?: ResponseFormatMode;
  reasoning?: ReasoningSetting;
  providerIgnore?: readonly string[];
  prices?: PriceTable;
  sink?: UsageSink;
  baseUrl?: string;
}

/** Maps OPENROUTER_REASONING to the unified `reasoning` request object (`undefined` = omit the field). */
export function reasoningParam(setting: ReasoningSetting): Record<string, unknown> | undefined {
  switch (setting) {
    case 'default':
      return undefined;
    case 'off':
      return { enabled: false };
    case 'low':
    case 'medium':
    case 'high':
      return { effort: setting };
  }
}

/** OpenAI-compatible schema names: `^[a-zA-Z0-9_-]{1,64}$`. */
export function sanitizeSchemaName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return cleaned.length > 0 ? cleaned : 'output';
}

export const JSON_OBJECT_INSTRUCTION =
  'Output format: reply with exactly one JSON object and nothing else (no prose, no markdown code fences). ' +
  'It must match this TypeScript-like type; every key is required and null is allowed only where the type says so:';

/** json_object mode: append the compact schema to the last system message (or add one). */
export function withSchemaInstruction(messages: readonly ChatMessage[], jsonSchema: JsonSchema): ChatMessage[] {
  const instruction = `${JSON_OBJECT_INSTRUCTION}\n${describeSchemaCompact(jsonSchema)}`;
  const out = messages.map((m) => ({ role: m.role, content: m.content }));
  let lastSystem = -1;
  out.forEach((m, i) => {
    if (m.role === 'system') lastSystem = i;
  });
  const target = lastSystem >= 0 ? out[lastSystem] : undefined;
  if (target) target.content = `${target.content}\n\n${instruction}`;
  else out.unshift({ role: 'system', content: instruction });
  return out;
}

export interface ChatRequestParams {
  model: string;
  messages: readonly ChatMessage[];
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  responseFormat: ResponseFormatMode;
  schemaName: string;
  jsonSchema: JsonSchema;
  reasoning: ReasoningSetting;
  providerIgnore?: readonly string[];
  /** `provider.max_price` in USD per million tokens (enforces the price bound in routing). */
  maxPrice?: { prompt: number; completion: number } | undefined;
}

export function buildChatRequestBody(p: ChatRequestParams): Record<string, unknown> {
  const messages =
    p.responseFormat === 'json_object'
      ? withSchemaInstruction(p.messages, p.jsonSchema)
      : p.messages.map((m) => ({ role: m.role, content: m.content }));
  const body: Record<string, unknown> = { model: p.model, messages };
  if (p.temperature !== undefined) body.temperature = p.temperature;
  if (p.maxTokens !== undefined) body.max_tokens = p.maxTokens;
  body.response_format =
    p.responseFormat === 'json_object'
      ? { type: 'json_object' }
      : { type: 'json_schema', json_schema: { name: sanitizeSchemaName(p.schemaName), strict: true, schema: p.jsonSchema } };
  body.provider = {
    require_parameters: true,
    ...(p.maxPrice ? { max_price: p.maxPrice } : {}),
    ...(p.providerIgnore?.length ? { ignore: [...p.providerIgnore] } : {}),
  };
  body.usage = { include: true };
  const reasoning = reasoningParam(p.reasoning);
  if (reasoning) body.reasoning = reasoning;
  return body;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseRetryAfterMs(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}

const UNKNOWN_USAGE: AttemptUsage = { inputTokens: 0, outputTokens: 0, costUsd: null, costSource: 'none' };

function nonNegative(v: unknown, integer: boolean): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined;
  return integer && !Number.isInteger(v) ? undefined : v;
}

/**
 * Accounting from an OpenRouter `usage` block. A reported `usage.cost` (including 0) wins; otherwise the
 * cost is estimated at the price bound only when both token counts are valid; anything else is unknown
 * (`null` / `none`) — missing evidence never becomes a known zero.
 */
export function usageFromResponse(usage: unknown, model: string, prices: PriceTable): AttemptUsage {
  if (!isRecord(usage)) return { ...UNKNOWN_USAGE };
  const inputTokens = nonNegative(usage.prompt_tokens, true);
  const outputTokens = nonNegative(usage.completion_tokens, true);
  const details = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : undefined;
  const reasoningTokens = nonNegative(details?.reasoning_tokens, true);
  const reported = nonNegative(usage.cost, false);
  const base: AttemptUsage = { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0, costUsd: null, costSource: 'none' };
  if (reasoningTokens !== undefined) base.reasoningTokens = reasoningTokens;
  if (reported !== undefined) return { ...base, costUsd: reported, costSource: 'reported' };
  if (inputTokens === undefined || outputTokens === undefined) return base;
  const estimated = estimateCostUsd(model, inputTokens, outputTokens, prices);
  return estimated === null ? base : { ...base, costUsd: estimated, costSource: 'estimated' };
}

function describeErrorBody(json: unknown, text: string): string {
  const err = isRecord(json) && isRecord(json.error) ? json.error : undefined;
  if (err) {
    const parts = [typeof err.message === 'string' ? err.message : 'error'];
    const meta = isRecord(err.metadata) ? err.metadata : undefined;
    if (meta && typeof meta.provider_name === 'string') parts.push(`provider=${meta.provider_name}`);
    if (meta && typeof meta.raw === 'string') parts.push(`raw=${meta.raw.slice(0, 300)}`);
    return redactAndTruncate(parts.join(' | '));
  }
  return redactAndTruncate(text.trim().length > 0 ? text.trim() : '(empty body)', 300);
}

function contentText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((p) => (isRecord(p) && typeof p.text === 'string' ? p.text : ''))
      .filter((s) => s.length > 0);
    return parts.length > 0 ? parts.join('') : null;
  }
  return null;
}

/**
 * Interprets one HTTP exchange (exported for unit tests). Identifiers and accounting are read from the
 * body before branching on the status. Billing evidence for failures:
 * - a well-formed error (non-2xx, a 200 `error` envelope, or `finish_reason: "error"`) without usage is
 *   treated as unbilled (OpenRouter does not bill failed requests / error finish reasons);
 * - usage present in an error body is kept as is (a reported 0 stays a reported 0);
 * - a malformed 200 (unparseable, or neither choices nor error) has an unknown cost.
 */
export function interpretResponse(
  status: number,
  ok: boolean,
  text: string,
  retryAfterMs: number | undefined,
  model: string,
  prices: PriceTable,
): AttemptOutcome {
  let json: unknown;
  try {
    json = text.trim().length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  const body = isRecord(json) ? json : undefined;
  const provider = typeof body?.provider === 'string' ? body.provider : undefined;
  const generationId = typeof body?.id === 'string' ? body.id : undefined;
  const ids = { ...(provider !== undefined ? { provider } : {}), ...(generationId !== undefined ? { generationId } : {}) };
  const usage = body && body.usage !== undefined ? usageFromResponse(body.usage, model, prices) : undefined;
  const withRetryAfter = retryAfterMs !== undefined ? { retryAfterMs } : {};

  if (!ok) {
    return {
      kind: 'http_error',
      status,
      message: describeErrorBody(json, text),
      retryable: isRetryableStatus(status),
      billing: usage ?? 'unbilled',
      ...withRetryAfter,
      ...ids,
    };
  }
  if (!body) {
    return {
      kind: 'http_error',
      status,
      message: `unparseable response body: ${describeErrorBody(undefined, text)}`,
      retryable: true,
      billing: 'unknown',
      ...withRetryAfter,
    };
  }
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : undefined;
  if (!choice) {
    const errObj = isRecord(body.error) ? body.error : undefined;
    const code = errObj ? (nonNegative(errObj.code, true) ?? 502) : 502;
    return {
      kind: 'http_error',
      status: code,
      message: errObj ? describeErrorBody(body, text) : `malformed response (no choices): ${describeErrorBody(undefined, text)}`,
      retryable: errObj ? isRetryableStatus(code) : true,
      billing: usage ?? (errObj ? 'unbilled' : 'unknown'),
      ...withRetryAfter,
      ...ids,
    };
  }
  const choiceError = isRecord(choice.error) ? choice.error : undefined;
  if (choice.finish_reason === 'error' || choiceError) {
    const code = nonNegative(choiceError?.code, true) ?? 502;
    return {
      kind: 'http_error',
      status: code,
      message: describeErrorBody({ error: choiceError ?? {} }, text),
      retryable: isRetryableStatus(code),
      billing: usage ?? 'unbilled',
      ...withRetryAfter,
      ...ids,
    };
  }
  const message = isRecord(choice.message) ? choice.message : undefined;
  const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : null;
  const refusal = typeof message?.refusal === 'string' && message.refusal.trim().length > 0 ? message.refusal : undefined;
  return {
    kind: 'response',
    content: contentText(message?.content),
    finishReason,
    usage: usage ?? null,
    ...(refusal !== undefined ? { refusal } : {}),
    ...ids,
  };
}

export class OpenRouterClient implements LlmClient {
  private readonly executor: ExecutorOptions;

  constructor(options: OpenRouterClientOptions) {
    const key = typeof options.apiKey === 'string' ? options.apiKey.trim() : options.apiKey.reveal().trim();
    if (key.length === 0) throw new Error('OpenRouterClient requires an API key (OPENROUTER_API_KEY)');
    registerSecret(key);
    const secret = typeof options.apiKey === 'string' ? new SecretValue(key) : options.apiKey;
    const fetchImpl: FetchLike = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    const baseUrl = (options.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, '');
    const responseFormat = options.responseFormat ?? 'json_schema';
    const reasoning = options.reasoning ?? 'off';
    const prices = options.prices ?? DEFAULT_PRICES;
    const now = options.now ?? Date.now;
    const maxPriceFor = (model: string): { prompt: number; completion: number } | undefined => {
      const price = lookupPrice(model, prices);
      return price ? maxPriceParam(price) : undefined;
    };

    const transport: Transport = async (input: AttemptInput): Promise<AttemptOutcome> => {
      const body = buildChatRequestBody({
        model: input.model,
        messages: input.messages,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        responseFormat,
        schemaName: input.schemaName,
        jsonSchema: input.jsonSchema,
        reasoning,
        providerIgnore: options.providerIgnore,
        maxPrice: maxPriceFor(input.model),
      });
      const res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret.reveal()}`,
          'Content-Type': 'application/json',
          'X-Title': OPENROUTER_APP_TITLE,
        },
        body: JSON.stringify(body),
        signal: input.signal,
      });
      const text = await res.text();
      const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'), now());
      return interpretResponse(res.status, res.ok, text, retryAfterMs, input.model, prices);
    };

    const models = options.models ?? {};
    const temperatures = options.temperatures ?? {};
    const maxTokens = options.maxTokens ?? {};
    const maxInputChars = options.maxInputChars ?? {};
    this.executor = {
      transport,
      sink: options.sink,
      resolveModel: (req) => req.model ?? models[req.role] ?? DEFAULT_OPENROUTER_MODEL,
      resolveTemperature: (req) => req.temperature ?? temperatures[req.role],
      resolveMaxTokens: (req) => req.maxTokens ?? maxTokens[req.role],
      resolveMaxInputChars: (req) => maxInputChars[req.role],
      timeoutMs: options.timeoutMs ?? DEFAULT_EXECUTOR_TUNING.timeoutMs,
      httpRetries: options.httpRetries ?? DEFAULT_EXECUTOR_TUNING.httpRetries,
      retryOnTimeout: options.retryOnTimeout ?? DEFAULT_EXECUTOR_TUNING.retryOnTimeout,
      backoffBaseMs: options.backoffBaseMs ?? DEFAULT_EXECUTOR_TUNING.backoffBaseMs,
      backoffMaxMs: options.backoffMaxMs ?? DEFAULT_EXECUTOR_TUNING.backoffMaxMs,
      retryAfterCapMs: DEFAULT_EXECUTOR_TUNING.retryAfterCapMs,
      sleep: options.sleep ?? realSleep,
      random: options.random ?? Math.random,
      now,
      newCallId: options.newCallId ?? nextCallId,
      logger: options.logger,
    };
  }

  static fromConfig(config: AppConfig, sink?: UsageSink, deps: ClientDeps = {}): OpenRouterClient {
    if (!config.openrouterApiKey) throw new Error('LLM_PROVIDER=openrouter requires OPENROUTER_API_KEY (set it in .env)');
    return new OpenRouterClient({
      ...deps,
      apiKey: config.openrouterApiKey,
      models: config.models,
      temperatures: config.temperatures,
      maxTokens: config.maxTokens,
      maxInputChars: config.maxInputChars,
      timeoutMs: config.timeoutMs,
      httpRetries: config.httpRetries,
      responseFormat: config.responseFormat,
      reasoning: config.reasoning,
      providerIgnore: config.providerIgnore,
      prices: config.prices,
      ...(sink ? { sink } : {}),
    });
  }

  complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    return executeCompletion(req, this.executor);
  }
}
