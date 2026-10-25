/**
 * Typed runtime configuration from environment variables (see `.env.example` for every variable).
 *
 * `loadConfig()` first loads `.env` with Node's built-in `process.loadEnvFile()` when the file exists
 * (variables already set in the shell take precedence), then reads `process.env`. The API key is held
 * in a `SecretValue` (never printed by `String`, `JSON.stringify` or `util.inspect`) and registered for
 * redaction. `describeConfig()` shows the key only as `set` / `missing`.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_PRICES, lookupPrice, parsePriceBounds, type PriceTable } from '../llm/prices.js';
import { redactSecrets, SecretValue } from '../llm/redact.js';
import {
  LLM_ROLES,
  REASONING_SETTINGS,
  RESPONSE_FORMAT_MODES,
  type LlmRole,
  type ReasoningSetting,
  type ResponseFormatMode,
} from '../llm/types.js';

export { createLlmClient } from '../llm/client.js';

export const LLM_PROVIDERS = ['mock', 'openrouter'] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];
export const NARRATIVE_LANGS = ['zh', 'en'] as const;
export type NarrativeLang = (typeof NARRATIVE_LANGS)[number];

export interface AppConfig {
  provider: LlmProvider;
  openrouterApiKey: SecretValue | null;
  models: Record<LlmRole, string>;
  temperatures: Record<LlmRole, number>;
  /** Output cap per role (`max_tokens`; reasoning tokens count toward it). */
  maxTokens: Record<LlmRole, number>;
  /** Input guard per role: total characters of the request messages; exceeding it fails fast (`config`). */
  maxInputChars: Record<LlmRole, number>;
  timeoutMs: number;
  httpRetries: number;
  responseFormat: ResponseFormatMode;
  reasoning: ReasoningSetting;
  /** OpenRouter provider slugs excluded from routing (shared across every role). */
  providerIgnore: string[];
  budget: { maxCallsPerSession: number; maxUsdPerSession: number };
  /** Price bounds (USD per million tokens): DEFAULT_PRICES merged with LLM_PRICE_BOUNDS. */
  prices: PriceTable;
  narrativeLang: NarrativeLang;
  /** The env file that was looked for (null when file loading was disabled). */
  envFile: { path: string; loaded: boolean } | null;
}

/** Its message is redacted at construction (a key pasted into the wrong variable never surfaces). */
export class ConfigError extends Error {
  constructor(message: string, secrets: readonly string[] = []) {
    super(redactSecrets(message, secrets));
    this.name = 'ConfigError';
  }
}

export const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';

export const DEFAULT_TEMPERATURES: Readonly<Record<LlmRole, number>> = {
  character: 0.7,
  judge: 0.2,
  narrator: 0.7,
  mapper: 0.2,
  answer: 0.7,
  rater: 0.2,
  smoke: 0.2,
};

export const DEFAULT_MAX_TOKENS: Readonly<Record<LlmRole, number>> = {
  character: 700,
  judge: 500,
  narrator: 900,
  mapper: 300,
  answer: 300,
  rater: 500,
  smoke: 300,
};

/**
 * PLAN §9: character 32,000 (the context builder trims prompts to about 24,000; the rest is headroom for text that
 * cannot be trimmed), judge 16,000, narrator 12,000, mapper 8,000 (rater/smoke are not in the plan).
 */
export const DEFAULT_MAX_INPUT_CHARS: Readonly<Record<LlmRole, number>> = {
  character: 32_000,
  judge: 16_000,
  narrator: 12_000,
  mapper: 8_000,
  answer: 24_000,
  rater: 48_000,
  smoke: 8_000,
};

/** PLAN §9 per-run budget (one run = one session): 100 calls, US$0.50. */
export const DEFAULT_BUDGET = { maxCallsPerSession: 100, maxUsdPerSession: 0.5 } as const;

const MODEL_ENV: Readonly<Record<LlmRole, string>> = {
  character: 'MODEL_CHARACTER',
  judge: 'MODEL_JUDGE',
  narrator: 'MODEL_NARRATOR',
  mapper: 'MODEL_MAPPER',
  answer: 'MODEL_CHARACTER',
  rater: 'MODEL_RATER',
  smoke: 'MODEL_CHARACTER',
};

type Env = Record<string, string | undefined>;

export interface LoadConfigOptions {
  /** Variables to read instead of `process.env` (tests). When given, no env file is loaded unless `envFile` is set. */
  env?: Env;
  /** Path of the env file to load into `process.env` (default `.env`), or `false` to skip. */
  envFile?: string | false;
}

/** Values are echoed in error messages only when short (a mis-assigned key is never echoed). */
function shown(raw: string): string {
  return raw.length <= 24 ? `"${raw}"` : `a ${raw.length}-character value (not shown)`;
}

function readString(env: Env, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readEnum<T extends string>(env: Env, name: string, allowed: readonly T[], fallback: T, problems: string[]): T {
  const raw = readString(env, name);
  if (raw === undefined) return fallback;
  const value = raw.toLowerCase();
  if ((allowed as readonly string[]).includes(value)) return value as T;
  problems.push(`${name} must be one of ${allowed.join('|')} (got ${shown(raw)})`);
  return fallback;
}

function readNumber(
  env: Env,
  name: string,
  fallback: number,
  rule: { min: number; max: number; integer?: boolean },
  problems: string[],
): number {
  const raw = readString(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < rule.min || value > rule.max || (rule.integer && !Number.isInteger(value))) {
    problems.push(`${name} must be ${rule.integer ? 'an integer' : 'a number'} in [${rule.min}, ${rule.max}] (got ${shown(raw)})`);
    return fallback;
  }
  return value;
}

function perRole(
  env: Env,
  prefix: string,
  defaults: Readonly<Record<LlmRole, number>>,
  rule: { min: number; max: number; integer?: boolean },
  problems: string[],
): Record<LlmRole, number> {
  const global = readString(env, prefix) !== undefined ? readNumber(env, prefix, Number.NaN, rule, problems) : Number.NaN;
  const out = {} as Record<LlmRole, number>;
  for (const role of LLM_ROLES) {
    const base = Number.isNaN(global) ? defaults[role] : global;
    out[role] = readNumber(env, `${prefix}_${role.toUpperCase()}`, base, rule, problems);
  }
  return out;
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const envFileSetting = options.envFile ?? (options.env ? false : '.env');
  let envFile: AppConfig['envFile'] = null;
  if (envFileSetting !== false) {
    const path = resolve(envFileSetting);
    const exists = existsSync(path);
    if (exists) process.loadEnvFile(path);
    envFile = { path, loaded: exists };
  }
  const env: Env = options.env ?? process.env;
  const problems: string[] = [];

  // Read and register the key first so every later message can be redacted.
  const key = readString(env, 'OPENROUTER_API_KEY');
  const secret = key !== undefined ? new SecretValue(key) : null;
  const provider = readEnum(env, 'LLM_PROVIDER', LLM_PROVIDERS, 'mock', problems);
  const bounds = parsePriceBounds(readString(env, 'LLM_PRICE_BOUNDS') ?? '');
  problems.push(...bounds.problems);
  const models = {} as Record<LlmRole, string>;
  for (const role of LLM_ROLES) models[role] = readString(env, MODEL_ENV[role]) ?? DEFAULT_MODEL;

  const config: AppConfig = {
    provider,
    openrouterApiKey: secret,
    models,
    temperatures: perRole(env, 'LLM_TEMPERATURE', DEFAULT_TEMPERATURES, { min: 0, max: 2 }, problems),
    maxTokens: perRole(env, 'LLM_MAX_TOKENS', DEFAULT_MAX_TOKENS, { min: 16, max: 200_000, integer: true }, problems),
    maxInputChars: perRole(env, 'LLM_MAX_INPUT_CHARS', DEFAULT_MAX_INPUT_CHARS, { min: 100, max: 2_000_000, integer: true }, problems),
    timeoutMs: readNumber(env, 'LLM_TIMEOUT_MS', 60_000, { min: 1_000, max: 600_000, integer: true }, problems),
    httpRetries: readNumber(env, 'LLM_HTTP_RETRIES', 2, { min: 0, max: 10, integer: true }, problems),
    responseFormat: readEnum(env, 'LLM_RESPONSE_FORMAT', RESPONSE_FORMAT_MODES, 'json_schema', problems),
    reasoning: readEnum(env, 'OPENROUTER_REASONING', REASONING_SETTINGS, 'off', problems),
    providerIgnore: [...new Set((readString(env, 'OPENROUTER_PROVIDER_IGNORE') ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))].sort(),
    budget: {
      maxCallsPerSession: readNumber(env, 'BUDGET_MAX_CALLS_PER_SESSION', DEFAULT_BUDGET.maxCallsPerSession, { min: 1, max: 100_000, integer: true }, problems),
      maxUsdPerSession: readNumber(env, 'BUDGET_MAX_USD_PER_SESSION', DEFAULT_BUDGET.maxUsdPerSession, { min: 0.000001, max: 1_000 }, problems),
    },
    prices: { ...DEFAULT_PRICES, ...bounds.table },
    narrativeLang: readEnum(env, 'NARRATIVE_LANG', NARRATIVE_LANGS, 'zh', problems),
    envFile,
  };
  if (problems.length > 0) {
    throw new ConfigError(`Invalid configuration:\n- ${problems.join('\n- ')}`, key !== undefined ? [key] : []);
  }
  return config;
}

function roleList(values: Record<LlmRole, string | number>, roles: readonly LlmRole[] = LLM_ROLES): string {
  return roles.map((r) => `${r}=${values[r]}`).join(', ');
}

function describeBounds(config: AppConfig): string {
  const models = [...new Set(Object.values(config.models))];
  return models
    .map((m) => {
      const p = lookupPrice(m, config.prices);
      return p ? `${m} ${p.inputUsdPerMTok}/${p.outputUsdPerMTok}` : `${m} MISSING (live calls refused; set LLM_PRICE_BOUNDS)`;
    })
    .join('; ');
}

/** Printable summary; the API key appears only as `set` / `missing`. */
export function describeConfig(config: AppConfig): string {
  const envFile = config.envFile ? `${config.envFile.loaded ? 'loaded' : 'not found'} (${config.envFile.path})` : 'not used';
  return [
    `LLM provider:        ${config.provider}`,
    `OPENROUTER_API_KEY:  ${config.openrouterApiKey ? 'set' : 'missing'}`,
    `.env file:           ${envFile}`,
    `Models:              ${roleList(config.models, ['character', 'judge', 'narrator', 'mapper', 'rater'])}`,
    `Temperatures:        ${roleList(config.temperatures)}`,
    `Max output tokens:   ${roleList(config.maxTokens)}`,
    `Max input chars:     ${roleList(config.maxInputChars)}`,
    `Response format:     ${config.responseFormat}${config.responseFormat === 'json_schema' ? ' (strict)' : ' (schema described in prompt)'}`,
    `Reasoning:           ${config.reasoning}`,
    `Provider ignore:     ${config.providerIgnore.length ? config.providerIgnore.join(', ') : '(none)'}`,
    `Timeout / retries:   ${config.timeoutMs} ms per attempt / ${config.httpRetries} HTTP retries + 1 repair retry`,
    `Budget per session:  ${config.budget.maxCallsPerSession} calls, $${config.budget.maxUsdPerSession}`,
    `Price bounds (USD/M, sent as provider.max_price): ${describeBounds(config)}`,
    `Narrative language:  ${config.narrativeLang}`,
  ].join('\n');
}

export const LIVE_SETUP_HELP = [
  'To make live OpenRouter calls:',
  '  1. copy .env.example .env        (.env is gitignored; never commit or share it)',
  '  2. in .env set LLM_PROVIDER=openrouter and OPENROUTER_API_KEY=<your key>',
  '  3. run the command again with --live, e.g.  npm run live:smoke -- --live',
  'Offline pipeline check without network:       npm run live:smoke -- --dry',
].join('\n');

/**
 * Live calls are explicit opt-in: they need the `--live` flag AND `LLM_PROVIDER=openrouter` AND a key.
 * Returns a human-readable problem, or null when live calls are allowed.
 */
export function liveOptInProblem(config: AppConfig, flags: { live: boolean }): string | null {
  const problems: string[] = [];
  if (!flags.live) problems.push('the --live flag was not given');
  if (config.provider !== 'openrouter') problems.push(`LLM_PROVIDER is "${config.provider}" (must be "openrouter")`);
  if (!config.openrouterApiKey) problems.push('OPENROUTER_API_KEY is missing');
  return problems.length > 0 ? `Refusing to make live LLM calls: ${problems.join('; ')}.` : null;
}
