import { describe, expect, it } from 'vitest';
import { caseInitialState, toTraceSpec } from '../../src/content/loader.js';
import { ActionEnvelopeSchema, ActionSchema, parseAction } from '../../src/core/actions.js';
import { CanonicalJsonError, canonicalJson, hashState, hashValue } from '../../src/core/hash.js';
import { compareIds, formatId, parseId, sortedIds } from '../../src/core/ids.js';
import { PatchError, applyOp, applyPatch, replayEvents } from '../../src/core/reducer.js';
import { createRng, seedFrom } from '../../src/core/rng.js';
import { simulateTrace } from '../../src/core/simulate.js';
import { toStrictJsonSchema } from '../../src/llm/schemas.js';
import { config, fixture } from './helpers.js';

describe('canonical JSON and hashing', () => {
  it('is independent of key order', () => {
    const a = { b: 1, a: { d: [1, { y: 1, x: 2 }], c: 'z' } };
    const b = { a: { c: 'z', d: [1, { x: 2, y: 1 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":"z","d":[1,{"x":2,"y":1}]},"b":1}');
    expect(hashValue(a)).toBe(hashValue(b));
    expect(hashValue(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('distinguishes values, omits undefined members and rejects non-JSON values', () => {
    expect(hashValue({ a: 1 })).not.toBe(hashValue({ a: 2 }));
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson([undefined])).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ d: new Date(0) })).toThrow(CanonicalJsonError);
  });

  it('the initial state hash equals the hash of its JSON round-trip', () => {
    const s = caseInitialState(fixture(), 'FX3');
    expect(hashState(JSON.parse(JSON.stringify(s)))).toBe(hashState(s));
  });
});

describe('seeded randomness and ids', () => {
  it('derives seeds deterministically and respects part boundaries', () => {
    expect(seedFrom('C1', 1, 'yelu_deguang', 2, 0, 'character')).toBe(seedFrom('C1', 1, 'yelu_deguang', 2, 0, 'character'));
    expect(seedFrom('a', 'bc')).not.toBe(seedFrom('ab', 'c'));
  });

  it('replays the same sequence from a seed or a saved state; fork does not advance', () => {
    const a = createRng(42);
    const b = createRng(42);
    const seqA = [a.next(), a.int(1, 6), a.pick(['x', 'y', 'z'])];
    expect([b.next(), b.int(1, 6), b.pick(['x', 'y', 'z'])]).toEqual(seqA);
    const saved = a.state();
    const n1 = a.next();
    expect(createRng(saved).next()).toBe(n1);
    const c = createRng(7);
    const before = c.state();
    c.fork('judge').next();
    expect(c.state()).toBe(before);
    expect(createRng(1).next()).not.toBe(createRng(2).next());
  });

  it('formats, parses and orders ids by creation', () => {
    expect(formatId('offer', 12)).toBe('offer:12');
    expect(parseId('k:7')).toEqual({ prefix: 'k', n: 7 });
    expect(parseId('bad')).toBeNull();
    expect(compareIds('k:9', 'k:10')).toBeLessThan(0);
    expect(sortedIds(['k:10', 'k:2', 'k:1'])).toEqual(['k:1', 'k:2', 'k:10']);
  });
});

describe('patch application and replay', () => {
  it('applies add / replace / remove / append and fails on missing targets', () => {
    const doc = { a: { b: 1 }, list: [1] };
    const out = applyPatch(doc, [
      { op: 'add', path: '/a/c', value: 2 },
      { op: 'replace', path: '/a/b', value: 3 },
      { op: 'add', path: '/list/-', value: 2 },
      { op: 'remove', path: '/a/c' },
      { op: 'add', path: '/k~1x', value: true },
    ]);
    expect(out).toEqual({ a: { b: 3 }, list: [1, 2], 'k/x': true });
    expect(doc).toEqual({ a: { b: 1 }, list: [1] }); // pure
    expect(() => applyOp(structuredClone(doc), { op: 'replace', path: '/zz', value: 1 })).toThrow(PatchError);
    expect(() => applyOp(structuredClone(doc), { op: 'remove', path: '/a/zz' })).toThrow(PatchError);
  });

  it('patch replay reproduces every snapshot and the final state of a full trace', () => {
    const initial = caseInitialState(fixture(), 'FX3');
    const run = simulateTrace(initial, config(), toTraceSpec(fixture().traces.FX3!), 'full');
    expect(run.mismatches).toEqual([]);
    expect(run.events.map((e) => e.version)).toEqual(run.events.map((_, i) => i + 1)); // +1 per event
    const states = replayEvents(initial, run.events);
    expect(states).toHaveLength(run.events.length);
    expect(hashState(states[states.length - 1])).toBe(hashState(run.state));
    for (const [i, st] of states.entries()) expect(st.version).toBe(i + 1);
  });

  it('re-deriving a trace gives identical events and final hash', () => {
    const spec = toTraceSpec(fixture().traces.FX3!);
    const a = simulateTrace(caseInitialState(fixture(), 'FX3'), config(), spec, 'full');
    const b = simulateTrace(caseInitialState(fixture(), 'FX3'), config(), spec, 'full');
    expect(hashValue(a.events)).toBe(hashValue(b.events));
    expect(hashState(a.state)).toBe(hashState(b.state));
  });
});

describe('LLM-facing action schema', () => {
  it('converts to a strict JSON schema (every key required, optionals as nullable)', () => {
    const schema = toStrictJsonSchema(ActionEnvelopeSchema) as { properties: { action: { anyOf: unknown[] } } };
    const branches = schema.properties.action.anyOf as Array<{ properties: { type: { enum: string[] }; args: { required: string[]; properties: Record<string, unknown> } } }>;
    expect(branches).toHaveLength(15);
    const respond = branches.find((b) => b.properties.type.enum[0] === 'respond_to_offer');
    expect([...(respond?.properties.args.required ?? [])].sort()).toEqual(['counterTerms', 'offerId', 'reason', 'response']);
    expect(JSON.stringify(respond?.properties.args.properties.counterTerms)).toContain('"null"');
  });

  it('parses nulls for absent optional arguments', () => {
    expect(parseAction({ type: 'set_dispatch_timing', args: { docId: 'doc:1', mode: 'now', rounds: null } }).ok).toBe(true);
    expect(parseAction({ type: 'set_dispatch_timing', args: { docId: 'doc:1', mode: 'now' } }).ok).toBe(false);
    expect(ActionSchema.options).toHaveLength(15);
  });
});
