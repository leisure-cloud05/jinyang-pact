/**
 * Canonical JSON + SHA-256 (deterministic; key order independent).
 *
 * Canonical form: object keys sorted by UTF-16 code unit order, no whitespace, `undefined` object members
 * omitted (JSON semantics), numbers in JSON notation. Non-finite numbers, `undefined` array items, functions,
 * symbols, bigints and non-plain objects (Date, Map, class instances) are rejected so that a value's hash always
 * equals the hash of its JSON round-trip.
 */
import { createHash } from 'node:crypto';

export class CanonicalJsonError extends Error {
  constructor(message: string, path: string) {
    super(`${message} at ${path || '$'}`);
    this.name = 'CanonicalJsonError';
  }
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function write(value: unknown, path: string, out: string[]): void {
  if (value === null) {
    out.push('null');
    return;
  }
  switch (typeof value) {
    case 'string':
      out.push(JSON.stringify(value));
      return;
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError(`non-finite number ${String(value)}`, path);
      out.push(JSON.stringify(value));
      return;
    case 'object': {
      if (Array.isArray(value)) {
        out.push('[');
        value.forEach((item, i) => {
          if (item === undefined) throw new CanonicalJsonError('undefined array item', `${path}[${i}]`);
          if (i > 0) out.push(',');
          write(item, `${path}[${i}]`, out);
        });
        out.push(']');
        return;
      }
      if (!isPlainObject(value)) throw new CanonicalJsonError('non-plain object', path);
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((k) => record[k] !== undefined)
        .sort();
      out.push('{');
      keys.forEach((key, i) => {
        if (i > 0) out.push(',');
        out.push(JSON.stringify(key), ':');
        write(record[key], `${path}.${key}`, out);
      });
      out.push('}');
      return;
    }
    default:
      throw new CanonicalJsonError(`unsupported ${typeof value}`, path);
  }
}

export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  write(value, '', out);
  return out.join('');
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** SHA-256 of the canonical JSON of `value`. */
export function hashValue(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export const hashState = hashValue;
