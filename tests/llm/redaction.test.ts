import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeConfig, loadConfig } from '../../src/config/env.js';
import { redactSecrets, REDACTED, registerSecret, SecretValue } from '../../src/llm/redact.js';
import { JsonlSink, MemorySink, MultiSink } from '../../src/llm/usage.js';
import { completion, FAKE_KEY, fakeFetch, makeClient, testRequest, VALID_JSON } from './helpers.js';

describe('redactSecrets', () => {
  it('removes registered secrets, Bearer tokens and sk-or- keys, idempotently', () => {
    registerSecret('custom-secret-value-123');
    const text = `a custom-secret-value-123 b Authorization: Bearer abc.DEF-123_xyz= c sk-or-v1-deadbeef d`;
    const once = redactSecrets(text);
    expect(once).toBe(`a ${REDACTED} b Authorization: Bearer ${REDACTED} c ${REDACTED} d`);
    expect(redactSecrets(once)).toBe(once);
    expect(redactSecrets('the bearer of the letter; Bearer of news')).toBe('the bearer of the letter; Bearer of news');
    expect(redactSecrets('no secrets here')).toBe('no secrets here');
    expect(redactSecrets('explicit xyz-extra-secret', ['xyz-extra-secret'])).toBe(`explicit ${REDACTED}`);
  });

  it('SecretValue never prints its value', () => {
    const secret = new SecretValue('not-an-sk-shaped-secret-42');
    expect(String(secret)).toBe(REDACTED);
    expect(JSON.stringify({ secret })).toBe(`{"secret":"${REDACTED}"}`);
    expect(inspect({ secret })).not.toContain('not-an-sk-shaped-secret-42');
    expect(secret.reveal()).toBe('not-an-sk-shaped-secret-42');
    expect(redactSecrets('leak not-an-sk-shaped-secret-42')).toBe(`leak ${REDACTED}`);
  });
});

describe('the API key never leaks', () => {
  let dir: string;
  const consoleOutput: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jy-redact-'));
    consoleOutput.length = 0;
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleOutput.push(args.map(String).join(' '));
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function jsonlSink() {
    const memory = new MemorySink();
    const jsonl = new JsonlSink(join(dir, 'calls.jsonl'));
    return { memory, jsonl, sink: new MultiSink(memory, jsonl) };
  }

  function filesText(jsonl: JsonlSink): string {
    const read = (p: string) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return '';
      }
    };
    return read(jsonl.filePath) + read(jsonl.attemptsPath);
  }

  it('from errors, logs and JSONL when a server echoes the Authorization header', async () => {
    const echo = `{"error":{"code":401,"message":"bad header Authorization: Bearer ${FAKE_KEY} (key ${FAKE_KEY})"}}`;
    const { fetch, calls } = fakeFetch([{ status: 401, text: echo }]);
    const { sink, jsonl, memory } = jsonlSink();
    const { client, logs } = makeClient(fetch, { sink });
    const result = await client.complete(testRequest());

    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${FAKE_KEY}`); // it was sent...
    expect(result.ok).toBe(false);
    const everything = [JSON.stringify(result), logs.join('\n'), filesText(jsonl), JSON.stringify(memory.records), JSON.stringify(memory.attempts), consoleOutput.join('\n')].join('\n');
    expect(everything).not.toContain(FAKE_KEY); // ...but never written or returned
    expect(everything).not.toContain('0000fake1111');
    if (!result.ok) expect(result.error.message).toContain(REDACTED);
  });

  it('from network errors that embed the header value (e.g. an invalid-header TypeError)', async () => {
    const { fetch } = fakeFetch([{ throw: new TypeError(`Headers.append: "Bearer ${FAKE_KEY}\r" is an invalid header value.`) }]);
    const { sink, jsonl } = jsonlSink();
    const { client, logs } = makeClient(fetch, { sink, httpRetries: 1 });
    const result = await client.complete(testRequest());
    expect(result).toMatchObject({ ok: false, error: { kind: 'network' } });
    const everything = [JSON.stringify(result), logs.join('\n'), filesText(jsonl), consoleOutput.join('\n')].join('\n');
    expect(everything).not.toContain(FAKE_KEY);
    expect(logs.length).toBeGreaterThan(0);
  });

  it('from stored raw responses when the model output contains the key', async () => {
    const leaky = JSON.stringify({ speech: `my key is ${FAKE_KEY}`, mood: 'calm', note: `Bearer ${FAKE_KEY}` });
    const { fetch } = fakeFetch([{ json: completion(leaky) }, { json: completion('garbage ' + FAKE_KEY) }]);
    const { sink, jsonl } = jsonlSink();
    const { client } = makeClient(fetch, { sink });
    const ok = await client.complete(testRequest());
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.raw).not.toContain(FAKE_KEY);
    const failed = await client.complete(testRequest());
    expect(JSON.stringify(failed)).not.toContain(FAKE_KEY);
    expect(filesText(jsonl)).not.toContain(FAKE_KEY);
    expect(filesText(jsonl)).toContain('"status":"ok"');
  });

  it('from config objects, config summaries and config errors', () => {
    const config = loadConfig({ env: { LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEY: FAKE_KEY } });
    expect(config.openrouterApiKey?.reveal()).toBe(FAKE_KEY);
    expect(JSON.stringify(config)).not.toContain(FAKE_KEY);
    expect(inspect(config, { depth: 10 })).not.toContain(FAKE_KEY);
    const summary = describeConfig(config);
    expect(summary).toContain('OPENROUTER_API_KEY:  set');
    expect(summary).not.toContain(FAKE_KEY);
    expect(() => loadConfig({ env: { OPENROUTER_API_KEY: FAKE_KEY, LLM_PROVIDER: 'bogus' } })).toThrow(/LLM_PROVIDER/);
    try {
      loadConfig({ env: { OPENROUTER_API_KEY: FAKE_KEY, LLM_TIMEOUT_MS: 'soon' } });
    } catch (err) {
      expect((err as Error).message).not.toContain(FAKE_KEY);
    }
  });

  it('never returns a secret anywhere in a successful result: value, raw, provider, generation id (finding 1)', async () => {
    const leaky = JSON.stringify({ speech: `echo ${FAKE_KEY}`, mood: 'calm', note: `Authorization: Bearer ${FAKE_KEY}` });
    const body = { ...completion(leaky, { id: `gen-${FAKE_KEY}` }), provider: `prov ${FAKE_KEY}` };
    const { fetch } = fakeFetch([{ json: body }]);
    const { sink, jsonl, memory } = jsonlSink();
    const { client } = makeClient(fetch, { sink });
    const result = await client.complete(testRequest());
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
    if (result.ok) {
      expect(result.value.speech).toBe(`echo ${REDACTED}`);
      expect(result.value.note).toBe(`Authorization: Bearer ${REDACTED}`);
    }
    expect(filesText(jsonl) + JSON.stringify(memory.records) + JSON.stringify(memory.attempts)).not.toContain(FAKE_KEY);
  });

  it('ConfigError never contains a key pasted into the wrong variable (finding 2)', () => {
    const custom = 'my-own-provider-secret-value-0123456789';
    const cases: Array<Record<string, string>> = [
      { LLM_TIMEOUT_MS: FAKE_KEY },
      { OPENROUTER_API_KEY: FAKE_KEY, LLM_TIMEOUT_MS: FAKE_KEY },
      { OPENROUTER_API_KEY: custom, LLM_PROVIDER: custom },
      { OPENROUTER_API_KEY: custom, NARRATIVE_LANG: custom, LLM_PRICE_BOUNDS: `${custom}=x` },
    ];
    for (const env of cases) {
      let message = '';
      try {
        loadConfig({ env });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message, JSON.stringify(Object.keys(env))).toMatch(/Invalid configuration/);
      expect(message).not.toContain(FAKE_KEY);
      expect(message).not.toContain(custom);
    }
  });

  it('an escaped key (\\u0073k-or-...) cannot be recovered from raw, failures or the repair echo (re-review 1)', async () => {
    const escapedKey = '\\u0073' + FAKE_KEY.slice(1); // JSON escape for the leading "s"
    expect(escapedKey).not.toContain(FAKE_KEY);
    const valid = `{"speech":"${escapedKey}","mood":"calm","note":null}`;
    const decodes = (text: string | undefined) => (text ?? '').replace(/\\u([0-9a-fA-F]{4})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));

    // success: raw is canonical JSON of the redacted decoded strings
    const ok = await makeClient(fakeFetch([{ json: completion(valid) }]).fetch).client.complete(testRequest());
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect((JSON.parse(ok.raw) as { speech: string }).speech).toBe(REDACTED);
      expect(ok.value.speech).toBe(REDACTED);
    }
    expect(decodes(JSON.stringify(ok))).not.toContain(FAKE_KEY);

    // parse failure twice (truncated JSON): raw suppressed; the repair echo sent upstream is redacted too
    const broken = `{"speech":"${escapedKey}`;
    const f1 = fakeFetch([{ json: completion(broken) }]);
    const parseFail = await makeClient(f1.fetch).client.complete(testRequest());
    expect(parseFail).toMatchObject({ ok: false, error: { kind: 'parse' } });
    expect(decodes(JSON.stringify(parseFail))).not.toContain(FAKE_KEY);
    const echoed = (f1.calls[1]!.body.messages as Array<{ role: string; content: string }>)[2]!;
    expect(echoed.role).toBe('assistant');
    expect(decodes(echoed.content)).not.toContain(FAKE_KEY);

    // schema failure twice: raw is the redacted canonical JSON
    const invalid = `{"speech":"${escapedKey}","mood":"sad","note":null}`;
    const schemaFail = await makeClient(fakeFetch([{ json: completion(invalid) }]).fetch).client.complete(testRequest());
    expect(schemaFail).toMatchObject({ ok: false, error: { kind: 'schema' } });
    expect(decodes(JSON.stringify(schemaFail))).not.toContain(FAKE_KEY);
    if (!schemaFail.ok) expect(JSON.parse(schemaFail.raw ?? '{}')).toEqual({ speech: REDACTED, mood: 'sad', note: null });
  });

  it('custom sinks receive sanitized call and attempt records (re-review 2)', async () => {
    const captured: unknown[] = [];
    const custom = { record: (call: unknown, attempts: readonly unknown[]) => captured.push(call, ...attempts) };
    const body = { ...completion(VALID_JSON, { id: `gen-${FAKE_KEY}` }), provider: `prov-${FAKE_KEY}` };
    const { client } = makeClient(fakeFetch([{ status: 500, json: { id: `gen-${FAKE_KEY}`, provider: FAKE_KEY, error: { code: 500, message: 'x' } } }, { json: body }]).fetch, {
      sink: custom,
    });
    await client.complete(testRequest({ callTag: `tag-${FAKE_KEY}` }));
    expect(captured.length).toBe(3);
    expect(JSON.stringify(captured)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(captured)).toContain(REDACTED);

    // budget refusals reach custom sinks sanitized too
    const { BudgetedClient } = await import('../../src/llm/budget.js');
    const refusedSink: unknown[] = [];
    const budget = new BudgetedClient(client, { maxCallsPerSession: 1, maxUsdPerSession: 1 }, {
      resolveModel: () => 'deepseek/deepseek-v4-flash',
      sink: { record: (call: unknown) => refusedSink.push(call) },
    });
    await budget.complete(testRequest({ sessionId: FAKE_KEY })).catch(() => undefined);
    await budget.complete(testRequest({ sessionId: FAKE_KEY }));
    expect(refusedSink.length).toBe(1);
    expect(JSON.stringify(refusedSink)).not.toContain(FAKE_KEY);
  });

  it('a successful call writes nothing secret either', async () => {
    const { fetch } = fakeFetch([{ json: completion(VALID_JSON) }]);
    const { sink, jsonl } = jsonlSink();
    const { client } = makeClient(fetch, { sink });
    await client.complete(testRequest());
    expect(filesText(jsonl)).not.toContain(FAKE_KEY);
    expect(consoleOutput.join('\n')).not.toContain(FAKE_KEY);
  });
});
