/**
 * Independent RFC-6902 subset (add / replace / remove, `-` append) for rebuilding world states from an audit
 * bundle's events, plus structural equality and canonical JSON. Written from the RFC, not from the harness reducer.
 */
import type { PatchOp } from '../../core/types.js';

export class OraclePatchError extends Error {}

function decode(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new OraclePatchError(`bad pointer ${pointer}`);
  return pointer
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function index(arr: unknown[], token: string, end: boolean): number {
  if (token === '-' && end) return arr.length;
  if (!/^(0|[1-9]\d*)$/.test(token)) throw new OraclePatchError(`bad array index ${token}`);
  const i = Number(token);
  if (i > (end ? arr.length : arr.length - 1)) throw new OraclePatchError(`index ${i} out of range`);
  return i;
}

export function applyOne(root: unknown, op: PatchOp): void {
  const tokens = decode(op.path);
  if (tokens.length === 0) throw new OraclePatchError('root operations are not supported');
  let node: unknown = root;
  for (const t of tokens.slice(0, -1)) {
    if (Array.isArray(node)) node = node[index(node, t, false)];
    else if (isObj(node) && Object.hasOwn(node, t)) node = node[t];
    else throw new OraclePatchError(`missing path ${op.path}`);
  }
  const last = tokens[tokens.length - 1] as string;
  const value = 'value' in op ? structuredClone(op.value) : undefined;
  if (Array.isArray(node)) {
    if (op.op === 'add') node.splice(index(node, last, true), 0, value);
    else if (op.op === 'replace') node[index(node, last, false)] = value;
    else node.splice(index(node, last, false), 1);
    return;
  }
  if (!isObj(node)) throw new OraclePatchError(`parent of ${op.path} is not a container`);
  if (op.op === 'add') node[last] = value;
  else if (!Object.hasOwn(node, last)) throw new OraclePatchError(`${op.op} target ${op.path} missing`);
  else if (op.op === 'replace') node[last] = value;
  else delete node[last];
}

export function applyPatchOps<T>(state: T, ops: readonly PatchOp[]): T {
  const copy = structuredClone(state);
  for (const op of ops) applyOne(copy, op);
  return copy;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(b as object, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value as object).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

/** Numeric part of a counter id (`offer:12` → 12); NaN if none. */
export function idNum(id: string): number {
  const m = /:(\d+)$/.exec(id);
  return m ? Number(m[1]) : Number.NaN;
}

export function byIdNum(a: string, b: string): number {
  return idNum(a) - idNum(b) || (a < b ? -1 : a > b ? 1 : 0);
}
