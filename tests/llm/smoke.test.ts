import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, runSmoke, SMOKE_CASES, SMOKE_ROLES } from '../../src/cli/smoke.js';
import { loadConfig } from '../../src/config/env.js';
import type { LlmAttemptRecord, LlmCallRecord } from '../../src/llm/types.js';
import { completion, FAKE_KEY, fakeFetch } from './helpers.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jy smoke '));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);
}

describe('smoke flow', () => {
  it('dry run (mock LLM) writes report.md, calls.jsonl and attempts.jsonl into a temp dir', async () => {
    const config = loadConfig({ env: { OPENROUTER_API_KEY: FAKE_KEY } });
    const logs: string[] = [];
    const outcome = await runSmoke({
      dry: true,
      config,
      outRoot: root,
      now: () => new Date('2026-09-28T01:02:03.456Z'),
      log: (l) => logs.push(l),
    });
    expect(outcome.dir).toBe(join(root, 'smoke-20260928T010203Z'));
    expect(outcome.allRolesSucceeded).toBe(true);
    expect(outcome.calls).toHaveLength(12);

    const report = readFileSync(outcome.reportPath, 'utf8');
    expect(report).toContain('DRY RUN (mock LLM)');
    expect(report).toContain('not findings');
    for (const role of SMOKE_ROLES) expect(report).toContain(`| ${role} | mock | 3/3 |`);
    expect(report).toContain('主公'); // Chinese narrative field in the sample output
    expect(report).toContain('OPENROUTER_API_KEY:  set');

    const character2 = outcome.calls.find((c) => c.role === 'character' && c.index === 2)!;
    expect(character2).toMatchObject({ ok: true, repairUsed: true, firstParseOk: false, attempts: 2 });
    expect(character2.attemptStatuses).toEqual(['first:parse', 'repair:ok']);
    const judge3 = outcome.calls.find((c) => c.role === 'judge' && c.index === 3)!;
    expect(judge3).toMatchObject({ ok: true, repairUsed: false, firstParseOk: true, firstSchemaOk: true, attempts: 2 });
    expect(judge3.attemptStatuses).toEqual(['first:http(429)', 'http_retry:ok']);

    const calls = readJsonl<LlmCallRecord>(outcome.jsonlPath);
    const attempts = readJsonl<LlmAttemptRecord>(outcome.attemptsPath);
    expect(calls).toHaveLength(12);
    expect(attempts).toHaveLength(14);
    for (const call of calls) {
      const own = attempts.filter((a) => a.callId === call.callId);
      expect(own).toHaveLength(call.attempts);
      expect(own.reduce((n, a) => n + a.inputTokens, 0)).toBe(call.inputTokens);
      expect(own.reduce((n, a) => n + a.outputTokens, 0)).toBe(call.outputTokens);
    }
    expect(attempts.every((a) => a.reconciled === false)).toBe(true);

    const everything = report + readFileSync(outcome.jsonlPath, 'utf8') + readFileSync(outcome.attemptsPath, 'utf8') + logs.join('\n');
    expect(everything).not.toContain(FAKE_KEY);
  });

  it('live path works against an injected fetch (no network) and writes no secrets', async () => {
    const config = loadConfig({ env: { LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEY: FAKE_KEY, NARRATIVE_LANG: 'en' } });
    const byName = Object.fromEntries(SMOKE_ROLES.map((r) => [SMOKE_CASES[r].schemaName, r]));
    let n = 0;
    const { fetch, calls } = fakeFetch((call) => {
      const name = ((call.body.response_format as { json_schema: { name: string } }).json_schema.name) as string;
      const role = byName[name]!;
      n += 1;
      return { json: completion(JSON.stringify(SMOKE_CASES[role].mockOutput('en')), { id: `gen-${n}` }) };
    });
    const outcome = await runSmoke({ dry: false, config, outRoot: root, attemptsPerRole: 1, fetch });
    expect(calls).toHaveLength(4);
    expect(calls.every((c) => c.headers.Authorization === `Bearer ${FAKE_KEY}`)).toBe(true);
    expect(outcome.allRolesSucceeded).toBe(true);
    const report = readFileSync(outcome.reportPath, 'utf8');
    expect(report).toContain('live (OpenRouter)');
    expect(report).toContain('gen-1');
    expect(report).toContain('(reported)');
    const files = report + readFileSync(outcome.jsonlPath, 'utf8') + readFileSync(outcome.attemptsPath, 'utf8');
    expect(files).not.toContain(FAKE_KEY);
  });

  it('refuses a live run when the provider is mock', async () => {
    const config = loadConfig({ env: {} });
    await expect(runSmoke({ dry: false, config, outRoot: root })).rejects.toThrow(/LLM_PROVIDER=openrouter/);
  });
});

describe('smoke CLI', () => {
  function io() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
  }

  it('requires an explicit --live or --dry', async () => {
    const a = io();
    expect(await main([], a.io)).toBe(1);
    expect(a.err.join('\n')).toContain('--live');
    const b = io();
    expect(await main(['--live', '--dry'], b.io)).toBe(1);
    const c = io();
    expect(await main(['--bogus'], c.io)).toBe(1);
    const d = io();
    expect(await main(['--help'], d.io)).toBe(0);
    expect(d.out.join('\n')).toContain('Usage');
  });

  it('refuses --live unless LLM_PROVIDER=openrouter and a key are configured', async () => {
    const saved = { p: process.env.LLM_PROVIDER, k: process.env.OPENROUTER_API_KEY };
    try {
      process.env.LLM_PROVIDER = 'mock';
      delete process.env.OPENROUTER_API_KEY;
      const r = io();
      expect(await main(['--live', '--no-env-file', '--out', root], r.io)).toBe(1);
      expect(r.err.join('\n')).toContain('LLM_PROVIDER is "mock"');
    } finally {
      if (saved.p === undefined) delete process.env.LLM_PROVIDER;
      else process.env.LLM_PROVIDER = saved.p;
      if (saved.k !== undefined) process.env.OPENROUTER_API_KEY = saved.k;
    }
  });

  it('runs a dry smoke end to end', async () => {
    const r = io();
    expect(await main(['--dry', '--no-env-file', '--attempts', '1', '--out', root], r.io)).toBe(0);
    expect(r.out.join('\n')).toMatch(/Smoke report: .*report\.md/);
  });
});
