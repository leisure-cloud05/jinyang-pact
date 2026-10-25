/**
 * Seeded PRNG (mulberry32) with serialisable state, plus seed derivation from strings
 * (e.g. `seedFrom(case, rep, actor, round, epoch, callTag)`, §9.3). Never uses Math.random.
 */
import { createHash } from 'node:crypto';

/** 32-bit unsigned seed derived from the SHA-256 of the joined parts. */
export function seedFrom(...parts: ReadonlyArray<string | number | boolean | null>): number {
  const text = parts.map((p) => (p === null ? '∅' : String(p))).join('␟');
  const digest = createHash('sha256').update(text, 'utf8').digest();
  return digest.readUInt32BE(0);
}

export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  /** True with probability p. */
  chance(p: number): boolean;
  /** Current internal state (persist to resume the same sequence). */
  state(): number;
  /** Independent generator derived from this one's seed state and a tag (does not advance this one). */
  fork(tag: string): Rng;
}

export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    int(min, max) {
      if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
        throw new RangeError(`invalid int range [${min}, ${max}]`);
      }
      return min + Math.floor(next() * (max - min + 1));
    },
    pick(items) {
      if (items.length === 0) throw new RangeError('pick from empty list');
      return items[Math.floor(next() * items.length)] as (typeof items)[number];
    },
    chance(p) {
      return next() < p;
    },
    state() {
      return a;
    },
    fork(tag) {
      return createRng(seedFrom(a, tag));
    },
  };
  return rng;
}
