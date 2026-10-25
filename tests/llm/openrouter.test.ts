import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildChatRequestBody, JSON_OBJECT_INSTRUCTION, reasoningParam } from '../../src/llm/openrouter.js';
import { toStrictJsonSchema } from '../../src/llm/schemas.js';
import { completion, FAKE_KEY, fakeFetch, makeClient, testRequest, TestSchema, VALID_JSON } from './helpers.js';

describe('OpenRouterClient success path', () => {
  it('sends the documented request body and headers and returns the validated value', async () => {
    const { fetch, calls } = fakeFetch([{ json: completion(VALID_JSON, { id: 'gen-abc', provider: 'DeepInfra' }) }]);
    const { client, sink } = makeClient(fetch);
    const result = await client.complete(testRequest({ meta: { secretContext: 'mock-only' } }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ speech: '主公且慢。', mood: 'calm', note: null });
    expect(result.raw).toBe(VALID_JSON);
    expect(result.attempts).toBe(1);
    expect(result.model).toBe('deepseek/deepseek-v4-flash');
    expect(result.provider).toBe('DeepInfra');
    expect(result.generationId).toBe('gen-abc');
    expect(result.repairUsed).toBe(false);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20, costUsd: 0.00001, costSource: 'reported' });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(call.headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(call.headers['X-Title']).toBe('Jinyang Pact (DSA4213)');
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(call.body).toEqual({
      model: 'deepseek/deepseek-v4-flash',
      messages: testRequest().messages,
      temperature: 0.7,
      max_tokens: 700,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'test_output', strict: true, schema: toStrictJsonSchema(TestSchema) },
      },
      provider: { require_parameters: true, max_price: { prompt: 0.15, completion: 0.3 } },
      usage: { include: true },
      reasoning: { enabled: false },
    });
    expect(JSON.stringify(call.body)).not.toContain('secretContext');

    expect(sink.records).toHaveLength(1);
    const rec = sink.records[0]!;
    expect(rec).toMatchObject({
      role: 'character',
      actor: 'sang_weihan',
      sessionId: 'sess-1',
      round: 1,
      callTag: 'unit',
      model: 'deepseek/deepseek-v4-flash',
      provider: 'DeepInfra',
      status: 'ok',
      attempts: 1,
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.00001,
      costSource: 'reported',
      generationId: 'gen-abc',
    });
    expect(rec.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sink.attemptsOf(rec.callId)).toEqual([
      expect.objectContaining({
        callId: rec.callId,
        attemptNo: 1,
        kind: 'first',
        status: 'ok',
        generationId: 'gen-abc',
        inputTokens: 100,
        outputTokens: 20,
        costUsd: 0.00001,
        costSource: 'reported',
        reconciled: false,
      }),
    ]);
  });

  it('strips ```json fences from the content', async () => {
    const { fetch } = fakeFetch([{ json: completion('```json\n' + VALID_JSON + '\n```') }]);
    const { client } = makeClient(fetch);
    const result = await client.complete(testRequest());
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.repairUsed).toBe(false);
  });

  it('maps OPENROUTER_REASONING to the unified reasoning parameter', () => {
    expect(reasoningParam('off')).toEqual({ enabled: false });
    expect(reasoningParam('high')).toEqual({ effort: 'high' });
    expect(reasoningParam('default')).toBeUndefined();
    const base = {
      model: 'm',
      messages: [{ role: 'user' as const, content: 'x' }],
      responseFormat: 'json_schema' as const,
      schemaName: 'n',
      jsonSchema: toStrictJsonSchema(TestSchema),
    };
    expect(buildChatRequestBody({ ...base, reasoning: 'default' })).not.toHaveProperty('reasoning');
    expect(buildChatRequestBody({ ...base, reasoning: 'low' }).reasoning).toEqual({ effort: 'low' });
  });

  it('json_object mode sends type json_object and appends the schema to the last system message', async () => {
    const { fetch, calls } = fakeFetch([{ json: completion(VALID_JSON) }]);
    const { client } = makeClient(fetch, { responseFormat: 'json_object' });
    const result = await client.complete(
      testRequest({
        messages: [
          { role: 'system', content: 'First system.' },
          { role: 'system', content: 'Second system.' },
          { role: 'user', content: 'Go.' },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    const body = calls[0]!.body as { response_format: unknown; messages: Array<{ role: string; content: string }> };
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0]!.content).toBe('First system.');
    expect(body.messages[1]!.content).toContain('Second system.\n\n' + JSON_OBJECT_INSTRUCTION);
    expect(body.messages[1]!.content).toContain('"mood": "calm" | "angry"');
    expect(body.messages[2]!.content).toBe('Go.');

    const noSystem = buildChatRequestBody({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      responseFormat: 'json_object',
      schemaName: 'n',
      jsonSchema: toStrictJsonSchema(TestSchema),
      reasoning: 'off',
    }).messages as Array<{ role: string; content: string }>;
    expect(noSystem[0]!.role).toBe('system');
    expect(noSystem[0]!.content.startsWith(JSON_OBJECT_INSTRUCTION)).toBe(true);
  });
});

describe('repair retry', () => {
  it('repairs an unparseable reply with exactly one extra request', async () => {
    const { fetch, calls } = fakeFetch([
      { json: completion('I think the answer is calm.', { id: 'gen-1' }) },
      { json: completion(VALID_JSON, { id: 'gen-2' }) },
    ]);
    const { client, sink } = makeClient(fetch);
    const result = await client.complete(testRequest());
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.repairUsed).toBe(true);
    expect(result.repairReason).toBe('parse');
    const messages = (calls[1]!.body as { messages: Array<{ role: string; content: string }> }).messages;
    expect(messages).toHaveLength(4);
    expect(messages[2]).toEqual({ role: 'assistant', content: 'I think the answer is calm.' });
    expect(messages[3]!.role).toBe('user');
    expect(messages[3]!.content).toContain('could not be parsed as JSON');
    // two billed attempts, two generation ids; call totals are the sums
    const attempts = sink.attemptsOf(sink.records[0]!.callId);
    expect(attempts.map((a) => [a.kind, a.status, a.generationId])).toEqual([
      ['first', 'parse', 'gen-1'],
      ['repair', 'ok', 'gen-2'],
    ]);
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 40, costUsd: 0.00002, costSource: 'reported' });
  });

  it('repairs a schema violation, feeding back the zod issues', async () => {
    const { fetch, calls } = fakeFetch([
      { json: completion(JSON.stringify({ speech: '', mood: 'sad', note: null })) },
      { json: completion(VALID_JSON) },
    ]);
    const { client } = makeClient(fetch);
    const result = await client.complete(testRequest());
    expect(result.ok).toBe(true);
    expect(result.repairReason).toBe('schema');
    const repair = (calls[1]!.body as { messages: Array<{ content: string }> }).messages[3]!.content;
    expect(repair).toContain('$.speech');
    expect(repair).toContain('$.mood');
  });

  it('fails with kind parse when the repair reply is still not JSON', async () => {
    const { fetch, calls } = fakeFetch([{ json: completion('nope') }, { json: completion('still nope') }]);
    const { client } = makeClient(fetch);
    const result = await client.complete(testRequest());
    expect(calls).toHaveLength(2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('parse');
    expect(result.raw).toBe('still nope');
    expect(result.attempts).toBe(2);
    expect(result.repairUsed).toBe(true);
  });

  it('fails with kind schema when both replies violate the schema', async () => {
    const bad = JSON.stringify({ speech: 'x', mood: 'sad', note: null });
    const { fetch, calls } = fakeFetch([{ json: completion(bad) }]);
    const { client, sink } = makeClient(fetch);
    const result = await client.complete(testRequest());
    expect(calls).toHaveLength(2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('schema');
    expect(result.error.message).toContain('$.mood');
    expect(sink.records[0]!.status).toBe('schema');
  });
});

describe('HTTP retries', () => {
  it('retries a 429 with backoff (no real wait) and succeeds', async () => {
    const { fetch, calls } = fakeFetch([
      { status: 429, json: { error: { code: 429, message: 'Rate limit exceeded' } } },
      { json: completion(VALID_JSON) },
    ]);
    const { client, sleeps, sink } = makeClient(fetch);
    const result = await client.complete(testRequest());
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(result.attempts).toBe(2);
    expect(sleeps).toEqual([1000]);
    const attempts = sink.attemptsOf(sink.records[0]!.callId);
    expect(attempts.map((a) => [a.kind, a.status, a.httpStatus ?? null])).toEqual([
      ['first', 'http', 429],
      ['http_retry', 'ok', null],
    ]);
    expect(attempts[0]).toMatchObject({ costUsd: 0, costSource: 'estimated', generationId: null, retryDelayMs: 1000 });
    // the unbilled 429 does not downgrade the reported cost of the call
    expect(result.usage.costSource).toBe('reported');
  });

  it('uses 1 s then 2 s backoff with ±20 % jitter and gives up after LLM_HTTP_RETRIES', async () => {
    const { fetch, calls } = fakeFetch([{ status: 503, text: 'Service Unavailable' }]);
    const low = makeClient(fetch, { random: () => 0 });
    const result = await low.client.complete(testRequest());
    expect(calls).toHaveLength(3);
    expect(low.sleeps).toEqual([800, 1600]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ kind: 'http', status: 503 });
    expect(result.attempts).toBe(3);

    const high = makeClient(fakeFetch([{ status: 500, text: 'x' }]).fetch, { random: () => 1 });
    await high.client.complete(testRequest());
    expect(high.sleeps).toEqual([1200, 2400]);
  });

  it('does not retry a non-retryable status', async () => {
    const { fetch, calls } = fakeFetch([{ status: 400, json: { error: { code: 400, message: 'bad schema' } } }]);
    const { client, sleeps } = makeClient(fetch);
    const result = await client.complete(testRequest());
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('HTTP 400: bad schema');
  });

  it('honours Retry-After and retries a network error', async () => {
    const { fetch } = fakeFetch([
      { status: 429, text: '{}', headers: { 'retry-after': '5' } },
      { throw: new TypeError('fetch failed') },
      { json: completion(VALID_JSON) },
    ]);
    const { client, sleeps } = makeClient(fetch);
    const result = await client.complete(testRequest());
    expect(result.ok).toBe(true);
    expect(sleeps).toEqual([5000, 2000]);
    // the network-error attempt's cost is unknown, so the call's cost is unknown (never 0)
    expect(result.usage.costUsd).toBeNull();
    expect(result.usage.costSource).toBe('none');
  });

  it('treats a 200 response carrying an error body as a retryable upstream error', async () => {
    const { fetch, calls } = fakeFetch([
      { json: { id: 'gen-x', error: { code: 502, message: 'upstream died' } } },
      { json: { id: 'gen-y', choices: [{ finish_reason: 'error', error: { code: 503, message: 'mid-stream' } }] } },
      { json: completion(VALID_JSON) },
    ]);
    const { client } = makeClient(fetch);
    const result = await client.complete(testRequest());
    expect(calls).toHaveLength(3);
    expect(result.ok).toBe(true);
  });
});

describe('timeouts, aborts and truncation', () => {
  it('times out an attempt and does not retry it', async () => {
    const { fetch, calls } = fakeFetch([{ hang: true }]);
    const { client, sleeps } = makeClient(fetch, { timeoutMs: 20 });
    const result = await client.complete(testRequest());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('timeout');
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(result.attempts).toBe(1);
    expect(result.usage).toMatchObject({ costUsd: null, costSource: 'none' });
  });

  it('never retries an external abort', async () => {
    const { fetch, calls } = fakeFetch([{ hang: true }]);
    const { client, sleeps, sink } = makeClient(fetch);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const result = await client.complete(testRequest({ signal: controller.signal }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('aborted');
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(sink.attempts.map((a) => a.status)).toEqual(['aborted']);
  });

  it('does not send anything when the signal is already aborted', async () => {
    const { fetch, calls } = fakeFetch([{ json: completion(VALID_JSON) }]);
    const { client } = makeClient(fetch);
    const controller = new AbortController();
    controller.abort();
    const result = await client.complete(testRequest({ signal: controller.signal }));
    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ ok: false, attempts: 0, error: { kind: 'aborted' } });
  });

  it('stops during retry backoff when aborted', async () => {
    const controller = new AbortController();
    const { fetch, calls } = fakeFetch([{ status: 429, text: '{}' }]);
    const { client } = makeClient(fetch, {
      sleep: async () => {
        controller.abort();
        throw new Error('aborted');
      },
    });
    const result = await client.complete(testRequest({ signal: controller.signal }));
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, error: { kind: 'aborted' } });
  });

  it('reports finish_reason=length as truncated without a repair retry', async () => {
    const { fetch, calls } = fakeFetch([
      { json: completion('{"speech": "主公', { finishReason: 'length', usage: { prompt_tokens: 10, completion_tokens: 700, cost: 0.0001, completion_tokens_details: { reasoning_tokens: 650 } } }) },
    ]);
    const { client } = makeClient(fetch);
    const result = await client.complete(testRequest());
    expect(calls).toHaveLength(1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('truncated');
    expect(result.error.message).toContain('max_tokens=700');
    expect(result.error.message).toContain('reasoning tokens 650');
    expect(result.raw).toBe('{"speech": "主公');
    expect(result.usage.reasoningTokens).toBe(650);
  });
});

describe('cost accounting', () => {
  it('prefers reported cost, else estimates from the price table, else unknown (null, never 0)', async () => {
    const reported = makeClient(fakeFetch([{ json: completion(VALID_JSON, { usage: { prompt_tokens: 1000, completion_tokens: 500, cost: 0.0042 } }) }]).fetch);
    expect((await reported.client.complete(testRequest())).usage).toEqual({
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.0042,
      costSource: 'reported',
    });

    const estimated = makeClient(fakeFetch([{ json: completion(VALID_JSON, { usage: { prompt_tokens: 1000, completion_tokens: 500 } }) }]).fetch);
    const est = (await estimated.client.complete(testRequest())).usage;
    expect(est.costSource).toBe('estimated');
    expect(est.costUsd).toBeCloseTo((1000 * 0.15 + 500 * 0.3) / 1e6, 12); // at the price bound

    const pro = makeClient(fakeFetch([{ json: completion(VALID_JSON, { usage: { prompt_tokens: 1000, completion_tokens: 500 } }) }]).fetch);
    const proUsage = (await pro.client.complete(testRequest({ model: 'deepseek/deepseek-v4-pro' }))).usage;
    expect(proUsage.costUsd).toBeCloseTo((1000 * 0.4 + 500 * 0.8) / 1e6, 12);

    const unknown = makeClient(fakeFetch([{ json: completion(VALID_JSON, { usage: { prompt_tokens: 1000, completion_tokens: 500 } }) }]).fetch);
    const unk = await unknown.client.complete(testRequest({ model: 'someone/unknown-model' }));
    expect(unk.usage).toMatchObject({ costUsd: null, costSource: 'none' });
    expect(unknown.sink.records[0]).toMatchObject({ costUsd: null, costSource: 'none' });
    expect(unknown.sink.attempts[0]).toMatchObject({ costUsd: null, costSource: 'none' });

    const noUsage = makeClient(fakeFetch([{ json: completion(VALID_JSON, { usage: null }) }]).fetch);
    expect((await noUsage.client.complete(testRequest())).usage).toMatchObject({ costUsd: null, costSource: 'none' });
  });
});

describe('guards', () => {
  it('fails fast with kind config when the input exceeds the per-role character cap', async () => {
    const { fetch, calls } = fakeFetch([{ json: completion(VALID_JSON) }]);
    const { client, sink } = makeClient(fetch, { maxInputChars: { character: 30 } });
    const result = await client.complete(testRequest());
    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ ok: false, attempts: 0, error: { kind: 'config' } });
    if (!result.ok) expect(result.error.message).toContain('input too large for role character');
    expect(sink.records[0]).toMatchObject({ status: 'config', attempts: 0, costUsd: 0, costSource: 'estimated' });
    expect(sink.attempts).toHaveLength(0);
  });

  it('fails fast with kind config for a schema strict mode cannot express', async () => {
    const { fetch, calls } = fakeFetch([{ json: completion(VALID_JSON) }]);
    const { client } = makeClient(fetch);
    const result = await client.complete({
      ...testRequest(),
      schema: z.object({ m: z.record(z.string(), z.string()) }),
    } as never);
    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ ok: false, error: { kind: 'config' } });
  });

  it('never throws, even when the sink throws', async () => {
    const { fetch } = fakeFetch([{ json: completion(VALID_JSON) }]);
    const { client } = makeClient(fetch, {
      sink: {
        record: () => {
          throw new Error('disk full');
        },
      },
    });
    await expect(client.complete(testRequest())).resolves.toMatchObject({ ok: true });
  });
});

describe('accounting evidence (review findings 5 and 6)', () => {
  it('usage {} or missing / invalid token counts without a reported cost are unknown, never estimated $0', async () => {
    for (const usage of [{}, { prompt_tokens: 10 }, { prompt_tokens: -1, completion_tokens: 5 }, { prompt_tokens: 1.5, completion_tokens: 5 }]) {
      const { client, sink } = makeClient(fakeFetch([{ json: completion(VALID_JSON, { usage }) }]).fetch);
      const r = await client.complete(testRequest());
      expect(r.ok, JSON.stringify(usage)).toBe(true);
      expect(r.usage, JSON.stringify(usage)).toMatchObject({ costUsd: null, costSource: 'none' });
      expect(sink.attempts[0]).toMatchObject({ costUsd: null, costSource: 'none' });
    }
  });

  it('malformed 200 envelopes are unknown-cost attempts (not unbilled) and are retried', async () => {
    const { fetch, calls } = fakeFetch([{ text: '<html>gateway</html>' }, { json: { id: 'gen-odd', object: 'chat.completion' } }, { json: completion(VALID_JSON) }]);
    const { client, sink } = makeClient(fetch);
    const r = await client.complete(testRequest());
    expect(calls).toHaveLength(3);
    expect(r.ok).toBe(true);
    expect(sink.attempts.map((a) => [a.status, a.costSource, a.costUsd])).toEqual([
      ['http', 'none', null],
      ['http', 'none', null],
      ['ok', 'reported', 0.00001],
    ]);
    expect(r.usage).toMatchObject({ costUsd: null, costSource: 'none' });
  });

  it('reads id, tokens and cost from error bodies before branching on the status', async () => {
    const body500 = { id: 'gen-500', provider: 'P1', error: { code: 500, message: 'boom' }, usage: { prompt_tokens: 40, completion_tokens: 7, cost: 0.01 } };
    const body200 = { id: 'gen-200', error: { code: 502, message: 'mid-generation' }, usage: { prompt_tokens: 40, completion_tokens: 0, cost: 0 } };
    const { fetch } = fakeFetch([{ status: 500, json: body500 }, { json: body200 }, { status: 503, json: { error: { code: 503, message: 'x' } } }]);
    const { client, sink } = makeClient(fetch);
    const r = await client.complete(testRequest());
    expect(r).toMatchObject({ ok: false, attempts: 3, error: { kind: 'http', status: 503 } });
    expect(sink.attempts.map((a) => [a.generationId, a.inputTokens, a.outputTokens, a.costUsd, a.costSource])).toEqual([
      ['gen-500', 40, 7, 0.01, 'reported'],
      ['gen-200', 40, 0, 0, 'reported'],
      [null, 0, 0, 0, 'estimated'],
    ]);
    expect(sink.attempts[0]!.provider).toBe('P1');
    expect(r.usage).toMatchObject({ costUsd: 0.01, costSource: 'reported' });
    expect(r.generationId).toBe('gen-200');
  });
});

describe('filtered output (review finding 8)', () => {
  it('content_filter with schema-valid JSON is a failure, without repair, keeping usage', async () => {
    const { fetch, calls } = fakeFetch([{ json: completion(VALID_JSON, { finishReason: 'content_filter', usage: { prompt_tokens: 50, completion_tokens: 9, cost: 0.0004 } }) }]);
    const { client, sink } = makeClient(fetch);
    const r = await client.complete(testRequest());
    expect(calls).toHaveLength(1);
    expect(r).toMatchObject({ ok: false, attempts: 1, repairUsed: false, error: { kind: 'filtered' } });
    expect(r.usage).toMatchObject({ inputTokens: 50, outputTokens: 9, costUsd: 0.0004, costSource: 'reported' });
    expect(sink.attempts[0]).toMatchObject({ status: 'filtered' });
  });

  it('an empty filtered reply and a model refusal are failures without repair', async () => {
    const empty = makeClient(fakeFetch([{ json: completion(null, { finishReason: 'content_filter' }) }]).fetch);
    expect(await empty.client.complete(testRequest())).toMatchObject({ ok: false, attempts: 1, error: { kind: 'filtered' } });
    const refusalBody = completion(null);
    ((refusalBody.choices as Array<{ message: Record<string, unknown> }>)[0]!.message).refusal = 'I cannot help with that.';
    const refused = makeClient(fakeFetch([{ json: refusalBody }]).fetch);
    const r = await refused.client.complete(testRequest());
    expect(r).toMatchObject({ ok: false, attempts: 1, error: { kind: 'filtered' } });
    if (!r.ok) expect(r.error.message).toContain('I cannot help with that.');
  });
});

describe('provider.max_price', () => {
  it('is sent at the price bound for priced models and omitted for unpriced ones', async () => {
    const { fetch, calls } = fakeFetch([{ json: completion(VALID_JSON) }]);
    const { client } = makeClient(fetch);
    await client.complete(testRequest({ model: 'deepseek/deepseek-v4-pro' }));
    await client.complete(testRequest({ model: 'someone/unpriced' }));
    expect((calls[0]!.body.provider as Record<string, unknown>).max_price).toEqual({ prompt: 0.4, completion: 0.8 });
    expect(calls[1]!.body.provider).toEqual({ require_parameters: true });
  });
});
