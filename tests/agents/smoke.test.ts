/** The live-smoke gate uses the real agent prompts/schemas on fixed sample contexts; the dry run exercises them. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_SCHEMAS } from '../../src/agents/schemas.js';
import { DEFAULT_INPUT_CAPS } from '../../src/agents/call.js';
import { SAMPLE_CASE, buildAgentSamples } from '../../src/agents/samples.js';
import { SMOKE_CASES, SMOKE_ROLES, runSmoke } from '../../src/cli/smoke.js';
import { loadConfig } from '../../src/config/env.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jy agents smoke '));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('smoke gate with real agent schemas', () => {
  it('builds every role from real prompts and a dev config (never a frozen case), within the input caps', () => {
    expect(SAMPLE_CASE).toBe('D1');
    for (const lang of ['zh', 'en'] as const) {
      const samples = buildAgentSamples(lang);
      for (const role of SMOKE_ROLES) {
        const c = SMOKE_CASES[role];
        expect(c.schema).toBe(AGENT_SCHEMAS[role].schema);
        expect(c.schemaName).toBe(AGENT_SCHEMAS[role].name);
        expect(c.messages(lang)).toEqual(samples[role].messages);
        expect(c.meta(lang).agent).toBe(role);
        const size = c.messages(lang).reduce((n, m) => n + m.content.length, 0);
        expect(size, `${role}/${lang}`).toBeLessThanOrEqual(DEFAULT_INPUT_CAPS[role]);
      }
      expect(samples.character.messages[0]?.content).toContain('HOW THE WORLD WORKS');
      expect(samples.judge.messages[0]?.content).toContain('internal_disagreement');
      expect(samples.narrator.messages[0]?.content).toContain('Use NO numerals at all');
      expect(samples.mapper.messages[0]?.content).toContain('never approves');
    }
  });

  it('dry run: every role succeeds through the mock with the real schemas and persona outputs', async () => {
    const config = loadConfig({ env: {} });
    const outcome = await runSmoke({ dry: true, config, outRoot: root, attemptsPerRole: 1, now: () => new Date('2026-09-29T00:00:00Z') });
    expect(outcome.allRolesSucceeded).toBe(true);
    const report = readFileSync(outcome.reportPath, 'utf8');
    expect(report).toContain('"revise_document"'); // Sang's persona drafts generous terms
    expect(report).toContain('"goal_conflict"'); // the Judge flags the sixteen-prefecture draft against the D1 goal
    expect(report).toContain('"mentioned_facts"');
    expect(report).toContain('"kind": "action"');
  });
});
