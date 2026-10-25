import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  createLlmClient,
  describeConfig,
  liveOptInProblem,
  loadConfig,
} from '../../src/config/env.js';
import { BudgetedClient } from '../../src/llm/budget.js';
import { MemorySink } from '../../src/llm/usage.js';
import { completion, FAKE_KEY, fakeFetch, testRequest, VALID_JSON } from './helpers.js';

describe('loadConfig', () => {
  it('applies provider exclusions and reasoning off to real request construction without networking', async () => {
    expect(loadConfig({ env: {} }).providerIgnore).toEqual([]);
    const config = loadConfig({ env: {
      LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEY: FAKE_KEY,
      OPENROUTER_REASONING: 'off',
      OPENROUTER_PROVIDER_IGNORE: ' Atlas-Cloud, deepinfra,atlas-cloud, ',
    } });
    expect(config.providerIgnore).toEqual(['atlas-cloud', 'deepinfra']);
    expect(describeConfig(config)).toContain('Provider ignore:     atlas-cloud, deepinfra');
    const { fetch, calls } = fakeFetch([{ json: completion(VALID_JSON) }]);
    const result = await createLlmClient(config, new MemorySink(), { fetch }).complete(testRequest());
    expect(result.ok).toBe(true);
    expect(calls[0]?.body.provider).toEqual({
      require_parameters: true,
      max_price: { prompt: 0.15, completion: 0.3 },
      ignore: ['atlas-cloud', 'deepinfra'],
    });
    expect(calls[0]?.body.reasoning).toEqual({ enabled: false });
  });

  it('uses PLAN §9 defaults on an empty environment', () => {
    const c = loadConfig({ env: {} });
    expect(c.provider).toBe('mock');
    expect(c.openrouterApiKey).toBeNull();
    expect(c.envFile).toBeNull();
    expect(Object.values(c.models).every((m) => m === 'deepseek/deepseek-v4-flash')).toBe(true);
    expect(c.temperatures).toMatchObject({ character: 0.7, judge: 0.2, narrator: 0.7, mapper: 0.2 });
    expect(c.maxTokens).toMatchObject({ character: 700, judge: 500, narrator: 900, mapper: 300 });
    expect(c.maxInputChars).toMatchObject({ character: 32000, judge: 16000, narrator: 12000, mapper: 8000 });
    expect(c.timeoutMs).toBe(60000);
    expect(c.httpRetries).toBe(2);
    expect(c.responseFormat).toBe('json_schema');
    expect(c.reasoning).toBe('off');
    expect(c.budget).toEqual({ maxCallsPerSession: 100, maxUsdPerSession: 0.5 });
    expect(c.narrativeLang).toBe('zh');
  });

  it('reads overrides, including global and per-role numeric settings', () => {
    const c = loadConfig({
      env: {
        LLM_PROVIDER: 'OpenRouter',
        OPENROUTER_API_KEY: `  ${FAKE_KEY}  `,
        MODEL_JUDGE: 'deepseek/deepseek-v4-pro',
        LLM_TEMPERATURE: '0.5',
        LLM_TEMPERATURE_JUDGE: '0.1',
        LLM_MAX_TOKENS_CHARACTER: '1000',
        LLM_MAX_INPUT_CHARS: '5000',
        LLM_TIMEOUT_MS: '30000',
        LLM_HTTP_RETRIES: '0',
        LLM_RESPONSE_FORMAT: 'json_object',
        OPENROUTER_REASONING: 'HIGH',
        BUDGET_MAX_CALLS_PER_SESSION: '12',
        BUDGET_MAX_USD_PER_SESSION: '0.05',
        NARRATIVE_LANG: 'en',
      },
    });
    expect(c.provider).toBe('openrouter');
    expect(c.openrouterApiKey?.reveal()).toBe(FAKE_KEY);
    expect(c.models.judge).toBe('deepseek/deepseek-v4-pro');
    expect(c.models.character).toBe('deepseek/deepseek-v4-flash');
    expect(c.temperatures).toMatchObject({ character: 0.5, narrator: 0.5, judge: 0.1 });
    expect(c.maxTokens).toMatchObject({ character: 1000, judge: 500 });
    expect(c.maxInputChars).toMatchObject({ character: 5000, mapper: 5000 });
    expect(c.timeoutMs).toBe(30000);
    expect(c.httpRetries).toBe(0);
    expect(c.responseFormat).toBe('json_object');
    expect(c.reasoning).toBe('high');
    expect(c.budget).toEqual({ maxCallsPerSession: 12, maxUsdPerSession: 0.05 });
    expect(c.narrativeLang).toBe('en');
  });

  it('reports every invalid value at once', () => {
    let error: unknown;
    try {
      loadConfig({ env: { LLM_PROVIDER: 'gpt', LLM_TEMPERATURE: '3', LLM_HTTP_RETRIES: '1.5', NARRATIVE_LANG: 'fr', LLM_MAX_TOKENS: 'lots' } });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    for (const name of ['LLM_PROVIDER', 'LLM_TEMPERATURE', 'LLM_HTTP_RETRIES', 'NARRATIVE_LANG', 'LLM_MAX_TOKENS']) {
      expect(message).toContain(name);
    }
    expect(message.match(/LLM_TEMPERATURE /g)).toHaveLength(1);
  });

  it('loads an env file with process.loadEnvFile; shell variables take precedence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jy-env-'));
    const file = join(dir, 'test.env');
    writeFileSync(file, `OPENROUTER_REASONING=medium\nNARRATIVE_LANG=en\nLLM_HTTP_RETRIES=5\n`);
    const saved = {
      OPENROUTER_REASONING: process.env.OPENROUTER_REASONING,
      NARRATIVE_LANG: process.env.NARRATIVE_LANG,
      LLM_HTTP_RETRIES: process.env.LLM_HTTP_RETRIES,
    };
    try {
      delete process.env.OPENROUTER_REASONING;
      delete process.env.LLM_HTTP_RETRIES;
      process.env.NARRATIVE_LANG = 'zh';
      const c = loadConfig({ envFile: file });
      expect(c.envFile).toEqual({ path: file, loaded: true });
      expect(c.reasoning).toBe('medium');
      expect(c.httpRetries).toBe(5);
      expect(c.narrativeLang).toBe('zh');
      const missing = loadConfig({ envFile: join(dir, 'absent.env'), env: {} });
      expect(missing.envFile).toEqual({ path: join(dir, 'absent.env'), loaded: false });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('describeConfig and live opt-in', () => {
  it('shows the key only as set / missing', () => {
    expect(describeConfig(loadConfig({ env: {} }))).toContain('OPENROUTER_API_KEY:  missing');
    const text = describeConfig(loadConfig({ env: { OPENROUTER_API_KEY: FAKE_KEY } }));
    expect(text).toContain('OPENROUTER_API_KEY:  set');
    expect(text).not.toContain(FAKE_KEY);
    expect(text).toContain('Budget per session:  100 calls, $0.5');
  });

  it('requires --live, LLM_PROVIDER=openrouter and a key', () => {
    const ready = loadConfig({ env: { LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEY: FAKE_KEY } });
    expect(liveOptInProblem(ready, { live: true })).toBeNull();
    expect(liveOptInProblem(ready, { live: false })).toContain('--live');
    const mock = loadConfig({ env: { OPENROUTER_API_KEY: FAKE_KEY } });
    expect(liveOptInProblem(mock, { live: true })).toContain('LLM_PROVIDER');
    const noKey = loadConfig({ env: { LLM_PROVIDER: 'openrouter' } });
    expect(liveOptInProblem(noKey, { live: true })).toContain('OPENROUTER_API_KEY is missing');
  });
});

describe('createLlmClient', () => {
  it('builds a budgeted mock client for the mock provider', async () => {
    const sink = new MemorySink();
    const config = loadConfig({ env: { BUDGET_MAX_CALLS_PER_SESSION: '1' } });
    const client = createLlmClient(config, sink, {
      mockSetup: (mock) => mock.register('character', () => ({ speech: '可。', mood: 'calm', note: null })),
    });
    expect(client).toBeInstanceOf(BudgetedClient);
    expect(await client.complete(testRequest())).toMatchObject({ ok: true, model: 'mock' });
    expect(await client.complete(testRequest())).toMatchObject({ ok: false, error: { kind: 'budget' } });
    expect(sink.records.map((r) => r.status)).toEqual(['ok', 'budget']);
  });

  it('refuses to build an OpenRouter client without a key', () => {
    const config = loadConfig({ env: { LLM_PROVIDER: 'openrouter' } });
    expect(() => createLlmClient(config, new MemorySink())).toThrow(/OPENROUTER_API_KEY/);
  });
});

describe('price bounds', () => {
  it('defaults to the documented bounds and merges LLM_PRICE_BOUNDS', () => {
    const d = loadConfig({ env: {} });
    expect(d.prices['deepseek/deepseek-v4-flash']).toMatchObject({ inputUsdPerMTok: 0.15, outputUsdPerMTok: 0.3 });
    expect(d.prices['deepseek/deepseek-v4-pro']).toMatchObject({ inputUsdPerMTok: 0.4, outputUsdPerMTok: 0.8 });
    const c = loadConfig({ env: { MODEL_RATER: 'qwen/qwen3-max', LLM_PRICE_BOUNDS: 'qwen/qwen3-max=1.2/6, deepseek/deepseek-v4-flash=0.1/0.2' } });
    expect(c.prices['qwen/qwen3-max']).toMatchObject({ inputUsdPerMTok: 1.2, outputUsdPerMTok: 6 });
    expect(c.prices['deepseek/deepseek-v4-flash']).toMatchObject({ inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.2 });
    expect(describeConfig(c)).toContain('qwen/qwen3-max 1.2/6');
    expect(describeConfig(loadConfig({ env: { MODEL_JUDGE: 'x/unpriced' } }))).toContain('x/unpriced MISSING');
    expect(() => loadConfig({ env: { LLM_PRICE_BOUNDS: 'qwen/qwen3-max=1.2' } })).toThrow(/LLM_PRICE_BOUNDS/);
    expect(() => loadConfig({ env: { LLM_PRICE_BOUNDS: 'qwen/qwen3-max=0/1' } })).toThrow(/LLM_PRICE_BOUNDS/);
  });

  it('does not echo long values in configuration errors', () => {
    expect(() => loadConfig({ env: { LLM_TIMEOUT_MS: 'x'.repeat(40) } })).toThrow(/a 40-character value \(not shown\)/);
  });

  it('the live factory refuses unpriced models (config) and sends max_price for priced ones', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fetch = async (_url: string, init: { body: string }) => {
      calls.push(JSON.parse(init.body) as Record<string, unknown>);
      const body = {
        id: 'gen-1',
        choices: [{ message: { content: JSON.stringify({ speech: 'x', mood: 'calm', note: null }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.000001 },
      };
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
    };
    const config = loadConfig({ env: { LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEY: FAKE_KEY, MODEL_JUDGE: 'x/unpriced' } });
    const client = createLlmClient(config, new MemorySink(), { fetch });
    const refused = await client.complete(testRequest({ role: 'judge' }));
    expect(refused).toMatchObject({ ok: false, attempts: 0, error: { kind: 'config' } });
    expect(calls).toHaveLength(0);
    const ok = await client.complete(testRequest());
    expect(ok.ok).toBe(true);
    expect(calls[0]!.provider).toEqual({ require_parameters: true, max_price: { prompt: 0.15, completion: 0.3 } });
  });
});
