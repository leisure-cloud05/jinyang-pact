/**
 * Secret redaction. Every error message, log line, stored raw response and JSONL line produced by the
 * LLM layer passes through `redactSecrets`. The configured API key is registered at config load /
 * client construction; in addition, any `Bearer <token>` and `sk-or-…` pattern is removed.
 */
import { inspect } from 'node:util';

export const REDACTED = '[REDACTED]';

/** Shorter values are not registered, to avoid shredding ordinary words. Real keys are ~70 chars. */
const MIN_SECRET_LENGTH = 8;

const registeredSecrets = new Set<string>();

/** `Bearer` is matched case-sensitively with a token-like value (≥ 12 chars) so prose ("the bearer of…") survives. */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g, `Bearer ${REDACTED}`],
  [/sk-or-[A-Za-z0-9_-]+/g, REDACTED],
];

/** Registers a secret value (e.g. the OpenRouter key) so that `redactSecrets` removes it everywhere. */
export function registerSecret(value: string | null | undefined): void {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (trimmed.length >= MIN_SECRET_LENGTH) registeredSecrets.add(trimmed);
}

export function redactSecrets(text: string, extraSecrets: Iterable<string> = []): string {
  let out = String(text);
  const secrets = [...registeredSecrets, ...extraSecrets]
    .filter((s) => typeof s === 'string' && s.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) out = out.split(secret).join(REDACTED);
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** Redacts and caps the length of an error/log detail. */
export function redactAndTruncate(text: string, maxChars = 600): string {
  const redacted = redactSecrets(text);
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars)}…[truncated]` : redacted;
}

/**
 * Holds a secret without exposing it through `String()`, `JSON.stringify` or `util.inspect`
 * (so logging a config object cannot leak the key). Use `reveal()` only to build the auth header.
 */
export class SecretValue {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
    registerSecret(value);
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return `SecretValue(${REDACTED})`;
  }
}
