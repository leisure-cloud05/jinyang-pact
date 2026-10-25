import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MockLlmClient } from '../../src/llm/mock/index.js';
import { MemorySink } from '../../src/llm/usage.js';
import { testRequest, type TestOutput } from './helpers.js';

const OUT: TestOutput = { speech: '臣以为可。', mood: 'calm', note: null };

function mockWith(options: ConstructorParameters<typeof MockLlmClient>[0] = {}) {
  const sink = new MemorySink();
  const mock = new MockLlmClient({ sink, ...options });
  mock.register('character', () => OUT);
  return { mock, sink };
}

describe('MockLlmClient handlers', () => {
  it('returns the handler output validated by the request schema and records mock usage', async () => {
    const { mock, sink } = mockWith();
    const result = await mock.complete(testRequest());
    expect(result).toMatchObject({ ok: true, value: OUT, attempts: 1, model: 'mock', provider: 'mock' });
    const raw = JSON.stringify(OUT);
    const inputChars = testRequest().messages.reduce((n, m) => n + m.content.length, 0);
    expect(result.usage).toEqual({
      inputTokens: Math.ceil(inputChars / 4),
      outputTokens: Math.ceil(raw.length / 4),
      costUsd: 0,
      costSource: 'reported',
    });
    expect(sink.records[0]).toMatchObject({ status: 'ok', model: 'mock', costUsd: 0 });
    expect(sink.attempts[0]).toMatchObject({ kind: 'first', status: 'ok', reconciled: false });
  });

  it('picks the most specific handler (actor > callTag > role), later registration wins ties', async () => {
    const mock = new MockLlmClient();
    const make = (speech: string) => () => ({ ...OUT, speech });
    mock.register('character', make('role'));
    mock.register({ role: 'character', callTag: 'tag' }, make('tag'));
    mock.register({ role: 'character', actor: 'liu_zhiyuan' }, make('actor'));
    mock.register({ role: 'character', actor: 'liu_zhiyuan', callTag: 'tag' }, make('both'));
    mock.register('character', make('role-later'));
    const speech = async (actor: string, callTag: string) => {
      const r = await mock.complete(testRequest({ actor, callTag }));
      return r.ok ? r.value.speech : r.error.kind;
    };
    expect(await speech('sang_weihan', 'x')).toBe('role-later');
    expect(await speech('sang_weihan', 'tag')).toBe('tag');
    expect(await speech('liu_zhiyuan', 'x')).toBe('actor');
    expect(await speech('liu_zhiyuan', 'tag')).toBe('both');
    expect(mock.hasHandler('judge')).toBe(false);
  });

  it('returns a config error (no attempt) when no handler matches, or when a handler throws', async () => {
    const sink = new MemorySink();
    const mock = new MockLlmClient({ sink });
    const missing = await mock.complete(testRequest({ role: 'judge' }));
    expect(missing).toMatchObject({ ok: false, attempts: 0, error: { kind: 'config' } });
    expect(sink.records[0]).toMatchObject({ status: 'config' });
    mock.register('judge', () => {
      throw new Error('persona bug');
    });
    const threw = await mock.complete(testRequest({ role: 'judge' }));
    expect(threw.ok).toBe(false);
    if (!threw.ok) expect(threw.error.message).toContain('persona bug');
  });

  it('validates with zod: a handler that violates the schema fails with kind schema after one repair', async () => {
    const mock = new MockLlmClient();
    mock.register('character', () => ({ speech: '', mood: 'furious', note: null }));
    const r = await mock.complete(testRequest());
    expect(r).toMatchObject({ ok: false, attempts: 2, repairUsed: true, error: { kind: 'schema' } });
  });

  it('accepts raw string output (e.g. fenced JSON) and passes structured meta to handlers', async () => {
    const mock = new MockLlmClient();
    mock.register('character', (req) => '```json\n' + JSON.stringify({ ...OUT, speech: String(req.meta?.line) }) + '\n```');
    const r = await mock.complete(testRequest({ meta: { line: '诺。' } }));
    expect(r.ok && r.value.speech).toBe('诺。');
  });

  it('enforces the per-role input cap', async () => {
    const { mock } = mockWith({ maxInputChars: { character: 10 } });
    expect(await mock.complete(testRequest())).toMatchObject({ ok: false, attempts: 0, error: { kind: 'config' } });
  });
});

describe('MockLlmClient failure injection', () => {
  it('invalid JSON then valid → one repair', async () => {
    const { mock, sink } = mockWith();
    mock.injectFaults(['invalid_json']);
    const r = await mock.complete(testRequest());
    expect(r).toMatchObject({ ok: true, attempts: 2, repairUsed: true, repairReason: 'parse' });
    expect(sink.attempts.map((a) => [a.kind, a.status])).toEqual([
      ['first', 'parse'],
      ['repair', 'ok'],
    ]);
    expect(sink.attempts.map((a) => a.generationId)).toEqual([expect.stringMatching(/-1$/), expect.stringMatching(/-2$/)]);
  });

  it('schema-invalid output then valid → one schema repair', async () => {
    const { mock } = mockWith();
    mock.injectFaults(['schema_invalid']);
    expect(await mock.complete(testRequest())).toMatchObject({ ok: true, repairReason: 'schema', attempts: 2 });
  });

  it('two invalid replies → parse failure', async () => {
    const { mock } = mockWith();
    mock.injectFaults(['invalid_json', 'invalid_json']);
    expect(await mock.complete(testRequest())).toMatchObject({ ok: false, error: { kind: 'parse' }, attempts: 2 });
  });

  it('HTTP 429 then ok → retried without waiting', async () => {
    const { mock, sink } = mockWith();
    mock.injectFaults(['http_429']);
    const started = Date.now();
    const r = await mock.complete(testRequest());
    expect(Date.now() - started).toBeLessThan(500);
    expect(r).toMatchObject({ ok: true, attempts: 2, repairUsed: false });
    expect(sink.attempts.map((a) => [a.kind, a.status, a.httpStatus ?? null])).toEqual([
      ['first', 'http', 429],
      ['http_retry', 'ok', null],
    ]);
  });

  it('HTTP 400 is not retried; exhausted 500s fail with kind http', async () => {
    const a = mockWith();
    a.mock.injectFaults(['http_400']);
    expect(await a.mock.complete(testRequest())).toMatchObject({ ok: false, attempts: 1, error: { kind: 'http', status: 400 } });
    const b = mockWith();
    b.mock.injectFaults(['http_500', 'http_500', 'http_500']);
    expect(await b.mock.complete(testRequest())).toMatchObject({ ok: false, attempts: 3, error: { kind: 'http', status: 500 } });
  });

  it('timeout, abort and truncation faults end the call without retries', async () => {
    for (const [fault, kind] of [
      ['timeout', 'timeout'],
      ['abort', 'aborted'],
      ['truncated', 'truncated'],
    ] as const) {
      const { mock } = mockWith();
      mock.injectFaults([fault]);
      expect(await mock.complete(testRequest()), fault).toMatchObject({ ok: false, attempts: 1, error: { kind } });
      expect(mock.pendingFaults).toBe(0);
    }
  });

  it('a network fault makes the call cost unknown (null), never 0', async () => {
    const { mock } = mockWith();
    mock.injectFaults(['network']);
    const r = await mock.complete(testRequest());
    expect(r).toMatchObject({ ok: true, attempts: 2, usage: { costUsd: null, costSource: 'none' } });
  });

  it('targets faults by actor / callTag', async () => {
    const { mock } = mockWith();
    mock.injectFaults(['invalid_json'], { actor: 'liu_zhiyuan' });
    expect(await mock.complete(testRequest())).toMatchObject({ attempts: 1 });
    expect(await mock.complete(testRequest({ actor: 'liu_zhiyuan' }))).toMatchObject({ attempts: 2, repairUsed: true });
  });

  it('honours a real AbortSignal while a handler is pending', async () => {
    const mock = new MockLlmClient();
    mock.register('character', () => new Promise(() => {}));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    expect(await mock.complete(testRequest({ signal: controller.signal }))).toMatchObject({ ok: false, error: { kind: 'aborted' } });
  });

  it('seeded fault rates are deterministic and independent of call order across actors', async () => {
    const run = async (seed: number, actors: string[]) => {
      const mock = new MockLlmClient({ seed, faultRates: { invalid_json: 0.3, http_429: 0.2 } });
      mock.register('character', () => OUT);
      const byActor: Record<string, string[]> = {};
      for (let i = 0; i < 10; i++) {
        for (const actor of actors) {
          const r = await mock.complete(testRequest({ actor, round: i }));
          (byActor[actor] ??= []).push(`${r.attempts}:${r.repairUsed}`);
        }
      }
      return byActor;
    };
    const a = await run(7, ['sang_weihan', 'liu_zhiyuan']);
    const b = await run(7, ['liu_zhiyuan', 'sang_weihan']);
    expect(b).toEqual(a);
    const all = Object.values(a).flat();
    expect(all.some((x) => x !== '1:false')).toBe(true);
    expect(() => new MockLlmClient({ faultRates: { timeout: 0.7, abort: 0.5 } })).toThrow(RangeError);
  });

  it('gives handlers a per-key seeded rng independent of other actors', async () => {
    const seen = async (order: string[]) => {
      const mock = new MockLlmClient({ seed: 3 });
      const values: Record<string, number> = {};
      mock.register('character', (req, ctx) => {
        values[req.actor ?? '-'] = ctx.rng();
        return OUT;
      });
      for (const actor of order) await mock.complete(testRequest({ actor }));
      return values;
    };
    expect(await seen(['a', 'b'])).toEqual(await seen(['b', 'a']));
  });

  it('works with arbitrary object schemas', async () => {
    const mock = new MockLlmClient();
    mock.register('judge', () => ({ items: [{ id: 'p1', verdict: 'PAUSE' }] }));
    const r = await mock.complete({
      role: 'judge',
      messages: [{ role: 'user', content: 'judge' }],
      schema: z.object({ items: z.array(z.object({ id: z.string(), verdict: z.enum(['CONTINUE', 'PAUSE']) })) }),
      schemaName: 'verdicts',
    });
    expect(r.ok && r.value.items[0]?.verdict).toBe('PAUSE');
  });
});

describe('MockLlmClient content filter', () => {
  it('a content_filter fault is a filtered failure without repair', async () => {
    const { mock } = mockWith();
    mock.injectFaults(['content_filter']);
    expect(await mock.complete(testRequest())).toMatchObject({ ok: false, attempts: 1, repairUsed: false, error: { kind: 'filtered' } });
  });
});
