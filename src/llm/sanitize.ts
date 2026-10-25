/**
 * Boundary sanitization: every string that leaves the LLM layer (decoded output values, raw text,
 * error messages, provider / generation / model metadata) passes through `redactSecrets`.
 */
import type { z } from 'zod';
import { redactAndTruncate, redactSecrets } from './redact.js';
import type { LlmResult } from './types.js';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Deep copy with every string (values and object keys) redacted; `changed` tells whether anything was removed. */
export function redactDeep<T>(value: T): { value: T; changed: boolean } {
  let changed = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = redactSecrets(v);
      if (r !== v) changed = true;
      return r;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (isPlainObject(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(v)) {
        const key = redactSecrets(k);
        if (key !== k) changed = true;
        out[key] = walk(child);
      }
      return out;
    }
    return v;
  };
  const out = walk(value) as T;
  return { value: out, changed };
}

/** Decodes JSON string escapes (`\uXXXX`, `\n`, `\"`, …) in one left-to-right pass, as JSON.parse would. */
export function decodeJsonEscapes(text: string): string {
  const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
  return text.replace(/\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g, (_m, hex: string | undefined, ch: string | undefined) =>
    hex !== undefined ? String.fromCharCode(parseInt(hex, 16)) : (simple[ch ?? ''] ?? ''),
  );
}

export const RAW_SUPPRESSED = '[REDACTED: raw model output contained a secret]';

/**
 * Redacts raw model output on both its literal and its decoded (JSON-unescaped) representation, so an
 * escaped secret (e.g. `sk-or-…`) cannot survive. If a secret is found in either view, parseable
 * JSON is re-serialized canonically from redacted decoded strings; anything else is suppressed.
 */
export function redactRaw(raw: string): string {
  const literal = redactSecrets(raw);
  const decoded = decodeJsonEscapes(raw);
  if (literal === raw && redactSecrets(decoded) === decoded) return raw;
  try {
    return JSON.stringify(redactDeep(JSON.parse(raw) as unknown).value);
  } catch {
    return RAW_SUPPRESSED;
  }
}

/** Deep-redacted copy of a usage record (call or attempt); applied before ANY sink sees it. */
export function sanitizeRecord<T>(record: T): T {
  return redactDeep(record).value;
}

function redactOptional(v: string | undefined): string | undefined {
  return v === undefined ? undefined : redactSecrets(v);
}

/**
 * Sanitizes a result at a public boundary (e.g. results from an arbitrary inner client). If the value
 * contained a secret, the redacted value is re-validated with `schema`; if it no longer validates, the
 * result becomes a `schema` failure (the secret-bearing output is never returned).
 */
export function sanitizeResult<T>(result: LlmResult<T>, schema?: z.ZodType<T>): LlmResult<T> {
  const meta = {
    model: redactSecrets(result.model),
    ...(result.provider !== undefined ? { provider: redactOptional(result.provider) } : {}),
    ...(result.generationId !== undefined ? { generationId: redactOptional(result.generationId) } : {}),
  };
  if (!result.ok) {
    return {
      ...result,
      ...meta,
      error: { ...result.error, message: redactAndTruncate(result.error.message, 2_000) },
      ...(result.raw !== undefined ? { raw: redactRaw(result.raw) } : {}),
    };
  }
  const { value, changed } = redactDeep(result.value);
  let safeValue: T = result.value;
  if (changed) {
    if (!schema) {
      safeValue = value;
    } else {
      const reparsed = schema.safeParse(value);
      if (!reparsed.success) {
        return {
          ok: false,
          error: { kind: 'schema', message: 'output contained a secret; the redacted output no longer matches the schema' },
          raw: redactRaw(result.raw),
          usage: result.usage,
          attempts: result.attempts,
          latencyMs: result.latencyMs,
          ...meta,
          ...(result.repairUsed !== undefined ? { repairUsed: result.repairUsed } : {}),
          ...(result.repairReason !== undefined ? { repairReason: result.repairReason } : {}),
        };
      }
      safeValue = reparsed.data;
    }
  }
  return { ...result, ...meta, value: safeValue, raw: redactRaw(result.raw) };
}
