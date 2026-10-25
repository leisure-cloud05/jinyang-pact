import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BudgetedClient, MESSAGE_OVERHEAD_TOKENS, REQUEST_OVERHEAD_TOKENS } from '../../src/llm/budget.js';
import { JSON_OBJECT_INSTRUCTION } from '../../src/llm/openrouter.js';
import { REPAIR_PROMPT_MAX_CHARS } from '../../src/llm/parse.js';
import { describeSchemaCompact, toStrictJsonSchema } from '../../src/llm/schemas.js';
import { MemorySink } from '../../src/llm/usage.js';
import type { LlmClient, LlmRequest, LlmResult, Usage } from '../../src/llm/types.js';
import { completion, FAKE_KEY, fakeFetch, makeClient, testRequest, TestSchema, VALID_JSON } from './helpers.js';

const FLASH = 'deepseek/deepseek-v4-flash';
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

function okResult(usage: Partial<Usage> = {}, attempts = 1): LlmResult<never> {
  return {
    ok: true,
    value: { speech: 'ok', mood: 'calm', note: null } as never,
    raw: '{}',
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, costSource: 'reported', ...usage },
    attempts,
    latencyMs: 1,
    model: FLASH,
  };
}

/** Inner client whose calls resolve only when the test says so. */
class DeferredClient implements LlmClient {
  readonly pending: Array<(r: LlmResult<never>) => void> = [];
  calls = 0;

  complete<T>(_req: LlmRequest<T>): Promise<LlmResult<T>> {
    this.calls += 1;
    return new Promise((resolve) => this.pending.push(resolve as (r: LlmResult<never>) => void));
  }
}

class FixedClient implements LlmClient {
  calls = 0;
  constructor(private readonly make: () => LlmResult<never>) {}
  async complete<T>(_req: LlmRequest<T>): Promise<LlmResult<T>> {
    this.calls += 1;
    return this.make() as LlmResult<T>;
  }
}

const priced = { resolveModel: () => FLASH, resolveMaxTokens: () => 700 };

describe('BudgetedClient admission', () => {
  it('refuses once the per-session call cap is reached, without calling the inner client', async () => {
    const inner = new FixedClient(() => okResult());
    const sink = new MemorySink();
    const client = new BudgetedClient(inner, { maxCallsPerSession: 2, maxUsdPerSession: 1 }, { sink, ...priced });
    expect((await client.complete(testRequest())).ok).toBe(true);
    expect((await client.complete(testRequest())).ok).toBe(true);
    const third = await client.complete(testRequest());
    expect(inner.calls).toBe(2);
    expect(third).toMatchObject({ ok: false, attempts: 0, error: { kind: 'budget' } });
    expect(sink.records[0]).toMatchObject({ status: 'budget', attempts: 0, costUsd: 0, sessionId: 'sess-1' });
    expect(sink.attempts).toHaveLength(0);
    expect(client.status('sess-1')).toMatchObject({ calls: 2, exhausted: true });
    expect((await client.complete(testRequest({ sessionId: 'sess-2' }))).ok).toBe(true);
  });

  it('refuses once reported spend reaches the USD cap', async () => {
    const inner = new FixedClient(() => okResult({ costUsd: 0.3 }));
    const client = new BudgetedClient(inner, { maxCallsPerSession: 100, maxUsdPerSession: 0.5 }, priced);
    await client.complete(testRequest());
    await client.complete(testRequest());
    const third = await client.complete(testRequest());
    expect(inner.calls).toBe(2);
    expect(third).toMatchObject({ ok: false, error: { kind: 'budget' } });
    expect(client.status('sess-1').spentUsd).toBeCloseTo(0.6, 10);
  });

  it('rejects a model without a price bound under a finite USD cap (live); the mock is exempt', async () => {
    const inner = new FixedClient(() => okResult());
    const live = new BudgetedClient(inner, { maxCallsPerSession: 10, maxUsdPerSession: 0.5 });
    const refused = await live.complete(testRequest({ model: 'someone/unpriced-model' }));
    expect(refused).toMatchObject({ ok: false, attempts: 0, error: { kind: 'config' } });
    if (!refused.ok) expect(refused.error.message).toContain('LLM_PRICE_BOUNDS');
    expect(inner.calls).toBe(0);
    expect(live.reservationUsd(testRequest({ model: 'someone/unpriced-model' }) as LlmRequest<unknown>)).toBeNull();

    const bounded = new BudgetedClient(inner, { maxCallsPerSession: 10, maxUsdPerSession: 0.5 }, {
      prices: { 'someone/unpriced-model': { inputUsdPerMTok: 1, outputUsdPerMTok: 2, note: 'test' } },
    });
    expect((await bounded.complete(testRequest({ model: 'someone/unpriced-model' }))).ok).toBe(true);

    const mock = new BudgetedClient(inner, { maxCallsPerSession: 10, maxUsdPerSession: 0.5 }, { resolveModel: () => 'mock', requirePrice: false });
    expect((await mock.complete(testRequest())).ok).toBe(true);
    expect(mock.status('sess-1').reservedUsd).toBe(0);
  });
});

describe('worst-case reservation', () => {
  it('prices (1 + retries) × (initial + repair) attempts with byte-bounded inputs at the price bound', () => {
    const client = new BudgetedClient(new FixedClient(() => okResult()), { maxCallsPerSession: 10, maxUsdPerSession: 1 }, { ...priced, httpRetries: 2 });
    const req = testRequest();
    const strict = toStrictJsonSchema(TestSchema);
    const prompt =
      req.messages.reduce((n, m) => n + bytes(m.content) + MESSAGE_OVERHEAD_TOKENS, 0) +
      bytes(JSON.stringify(strict)) +
      bytes(describeSchemaCompact(strict)) +
      bytes(JSON_OBJECT_INSTRUCTION) +
      REQUEST_OVERHEAD_TOKENS;
    const repair = prompt + 3 * (Math.max(2000, 4 * 700) + REPAIR_PROMPT_MAX_CHARS) + 2 * MESSAGE_OVERHEAD_TOKENS;
    const expected = (3 * (prompt + repair) * 0.15 + 3 * 2 * 700 * 0.3) / 1e6;
    expect(client.promptTokenBound(req as LlmRequest<unknown>)).toBe(prompt);
    expect(client.reservationUsd(req as LlmRequest<unknown>)).toBeCloseTo(expected, 15);
    const noRetries = new BudgetedClient(new FixedClient(() => okResult()), { maxCallsPerSession: 10, maxUsdPerSession: 1 }, { ...priced, httpRetries: 0 });
    expect(noRetries.reservationUsd(req as LlmRequest<unknown>)).toBeCloseTo(expected / 3, 15);
  });

  it('covers the six-billed-attempt sequence (2 lost + malformed, then 2 lost + repair) at bound prices', async () => {
    const huge = '长'.repeat(5000); // a long malformed reply (echo is capped)
    let billedUsd = 0;
    let n = 0;
    const { fetch, calls } = fakeFetch((call) => {
      // Pessimistic billing model: every attempt is billed for all input bytes and the full max_tokens.
      const body = call.body as { messages: Array<{ content: string }>; max_tokens: number; response_format: { json_schema: { schema: unknown } } };
      const inputTokens = body.messages.reduce((s, m) => s + bytes(m.content) + MESSAGE_OVERHEAD_TOKENS, 0) + bytes(JSON.stringify(body.response_format.json_schema.schema));
      billedUsd += (inputTokens * 0.15 + body.max_tokens * 0.3) / 1e6;
      n += 1;
      if (n === 1 || n === 2 || n === 4 || n === 5) return { throw: new TypeError('fetch failed: connection reset') };
      if (n === 3) return { json: completion(huge) };
      return { json: completion(VALID_JSON) };
    });
    const { client: inner } = makeClient(fetch, { httpRetries: 2 });
    const budget = new BudgetedClient(inner, { maxCallsPerSession: 10, maxUsdPerSession: 1 }, { ...priced, httpRetries: 2 });
    const reservation = budget.reservationUsd(testRequest() as LlmRequest<unknown>)!;
    const result = await budget.complete(testRequest());
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(6);
    expect(result.attempts).toBe(6);
    expect(billedUsd).toBeLessThanOrEqual(reservation);
    // unknown-cost attempts (lost connections) ⇒ the call is charged the reserved worst case
    expect(result.usage.costUsd).toBeNull();
    expect(budget.status('sess-1').spentUsd).toBeCloseTo(reservation, 15);
  });

  it('is safe under parallel calls: reservations are atomic and reconciled afterwards', async () => {
    const inner = new DeferredClient();
    const probe = new BudgetedClient(inner, { maxCallsPerSession: 100, maxUsdPerSession: 1 }, priced);
    const reservation = probe.reservationUsd(testRequest() as LlmRequest<unknown>)!;
    const client = new BudgetedClient(inner, { maxCallsPerSession: 100, maxUsdPerSession: reservation * 2.5 }, priced);

    const p1 = client.complete(testRequest());
    const p2 = client.complete(testRequest());
    const third = await client.complete(testRequest()); // refused synchronously: 3 worst cases do not fit
    expect(third).toMatchObject({ ok: false, error: { kind: 'budget' } });
    expect(inner.calls).toBe(2);
    expect(client.status('sess-1')).toMatchObject({ inFlight: 2, calls: 0 });
    expect(client.status('sess-1').reservedUsd).toBeCloseTo(2 * reservation, 15);

    inner.pending[0]!(okResult({ costUsd: reservation * 0.1, costSource: 'reported' }));
    inner.pending[1]!(okResult({ costUsd: reservation * 0.1, costSource: 'estimated' }));
    await Promise.all([p1, p2]);
    const after = client.status('sess-1');
    expect(after).toMatchObject({ inFlight: 0, calls: 2, reservedUsd: 0 });
    expect(after.spentUsd).toBeCloseTo(reservation * 0.2, 15);

    const p4 = client.complete(testRequest());
    expect(inner.calls).toBe(3);
    inner.pending[2]!(okResult({ costUsd: 0 }));
    expect((await p4).ok).toBe(true);
  });

  it('releases the reservation on failure; unknown cost is charged at the worst case, zero-attempt calls cost nothing', async () => {
    let next: LlmResult<never> = okResult();
    const inner = new FixedClient(() => next);
    const client = new BudgetedClient(inner, { maxCallsPerSession: 100, maxUsdPerSession: 1 }, priced);
    const reservation = client.reservationUsd(testRequest() as LlmRequest<unknown>)!;

    next = {
      ok: false,
      error: { kind: 'aborted', message: 'aborted by caller' },
      usage: { inputTokens: 0, outputTokens: 0, costUsd: null, costSource: 'none' },
      attempts: 1,
      latencyMs: 1,
      model: FLASH,
    };
    await client.complete(testRequest());
    expect(client.status('sess-1')).toMatchObject({ reservedUsd: 0, unknownCostCalls: 1, calls: 1 });
    expect(client.status('sess-1').spentUsd).toBeCloseTo(reservation, 15);

    next = {
      ok: false,
      error: { kind: 'config', message: 'input too large' },
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, costSource: 'estimated' },
      attempts: 0,
      latencyMs: 0,
      model: FLASH,
    };
    await client.complete(testRequest());
    expect(client.status('sess-1')).toMatchObject({ reservedUsd: 0, calls: 1 });
    expect(client.status('sess-1').spentUsd).toBeCloseTo(reservation, 15);
  });
});

describe('BudgetedClient boundary', () => {
  it('redacts a throwing inner client and validates limits', async () => {
    const thrower: LlmClient = {
      complete: async () => {
        throw new Error(`upstream said Authorization: Bearer ${FAKE_KEY}`);
      },
    };
    const client = new BudgetedClient(thrower, { maxCallsPerSession: 5, maxUsdPerSession: 1 }, priced);
    const result = await client.complete(testRequest());
    expect(result).toMatchObject({ ok: false, error: { kind: 'config' } });
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
    expect(() => new BudgetedClient(thrower, { maxCallsPerSession: 0, maxUsdPerSession: 1 })).toThrow(RangeError);
    expect(() => new BudgetedClient(thrower, { maxCallsPerSession: 1, maxUsdPerSession: 0 })).toThrow(RangeError);
  });

  it('sanitizes secret-bearing results from an arbitrary inner client (re-validating the value)', async () => {
    const leaky = new FixedClient(() => ({
      ...okResult(),
      value: { speech: `key ${FAKE_KEY}`, mood: 'calm', note: null } as never,
      raw: FAKE_KEY,
      provider: FAKE_KEY,
      generationId: `gen-${FAKE_KEY}`,
    }));
    const client = new BudgetedClient(leaky, { maxCallsPerSession: 5, maxUsdPerSession: 1 }, priced);
    const result = await client.complete(testRequest());
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);

    const strict = z.object({ speech: z.string().max(10) });
    const tooLong = new FixedClient(() => ({ ...okResult(), value: { speech: FAKE_KEY.slice(0, 10) } as never }));
    const c2 = new BudgetedClient(tooLong, { maxCallsPerSession: 5, maxUsdPerSession: 1 }, priced);
    const r2 = await c2.complete({ ...testRequest(), schema: strict } as never);
    // "sk-or-v1-0" is redacted to "[REDACTED]" (10 chars) and still validates
    expect(JSON.stringify(r2)).not.toContain('sk-or-v1-0');
  });
});
