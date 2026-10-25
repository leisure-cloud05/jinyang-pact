/**
 * Deterministic world-object ids: `<prefix>:<n>` with one counter per prefix in `state.counters` (§3.1).
 * Allocation itself happens through `Draft.nextId` so that counter bumps are recorded as patch operations.
 */
import { ID_PREFIXES, type IdPrefix } from './types.js';

export function formatId(prefix: IdPrefix, n: number): string {
  return `${prefix}:${n}`;
}

export function parseId(id: string): { prefix: string; n: number } | null {
  const match = /^([a-z]+):(\d+)$/.exec(id);
  if (!match || match[1] === undefined || match[2] === undefined) return null;
  return { prefix: match[1], n: Number(match[2]) };
}

/** Numeric part of an id (for creation-order comparisons); -1 if malformed. */
export function idNumber(id: string): number {
  return parseId(id)?.n ?? -1;
}

/** Sorts ids of the same prefix by creation order. */
export function compareIds(a: string, b: string): number {
  const pa = parseId(a);
  const pb = parseId(b);
  if (pa && pb && pa.prefix === pb.prefix) return pa.n - pb.n;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortedIds(ids: Iterable<string>): string[] {
  return [...ids].sort(compareIds);
}

export function initialCounters(): Record<string, number> {
  const counters: Record<string, number> = {};
  for (const prefix of ID_PREFIXES) counters[prefix] = 0;
  counters.sendSeq = 0;
  return counters;
}

/**
 * Own-property lookup: keys that come from actions or content (`"__proto__"`, `"toString"`, …) never resolve to
 * inherited members.
 */
export function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function isIdPrefix(value: string): value is IdPrefix {
  return (ID_PREFIXES as readonly string[]).includes(value);
}
