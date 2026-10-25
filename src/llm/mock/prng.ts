/** Small deterministic PRNG utilities for the mock LLM (no dependency on Math.random). */

/** FNV-1a 32-bit hash of a string. */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: returns a generator of floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A generator seeded from a base seed and a list of key parts (order-independent across keys). */
export function seededRng(seed: number, ...parts: Array<string | number | undefined>): () => number {
  return mulberry32(fnv1a32(`${seed}|${parts.map((p) => (p === undefined ? '-' : String(p))).join('|')}`));
}
