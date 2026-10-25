/**
 * Mock Shi follows the clerk's advice (what his prompt shows under ADVICE ADDRESSED TO YOU): C3's policy withholds
 * his confirmation of the land-for-relief counter with `counter_draft` terms; he then counters with them, the talks
 * end inside the chapter. Runs the real engine (runCase) with the offline mock personas.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerMockPersonas } from '../../src/agents/mock-personas/index.js';
import { adviceKind } from '../../src/agents/mock-personas/personas.js';
import { runCase } from '../../src/engine/index.js';
import { MockLlmClient } from '../../src/llm/mock/index.js';
import type { Harness } from '../../src/harness/index.js';
import { content } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('mock personas follow advice', () => {
  it('classifies advice rows deterministically from payload and wording', () => {
    const base = { ref: 'dialogue:1', seq: 1, round: 3, from: 'player' as const, fromName: '书记' };
    expect(adviceKind({ ...base, text: '宁增岁帛', payload: { counterTerms: { vassal: true } } })).toBe('counter_draft');
    expect(adviceKind({ ...base, text: '契丹非地不允，而割地非我所能许。请罢议，据城自守。', payload: null })).toBe('urge_stop');
    expect(adviceKind({ ...base, text: 'The player urges you to accept the terms on the table.', payload: null })).toBe('urge_accept');
    expect(adviceKind({ ...base, text: '与所议不合。', payload: null })).toBe('objection');
  });

  it('C3 (full, mocks) reaches a valid terminal within 6 rounds once Shi follows the counter_draft advice', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'jinyang c3 advice '));
    dirs.push(dir);
    let t = Date.UTC(2026, 8, 30);
    const result = await runCase({
      caseId: 'C3',
      mode: 'full',
      rep: 1,
      llm: (sink) => {
        const mock = new MockLlmClient({ sink });
        registerMockPersonas(mock);
        return mock;
      },
      clock: () => (t += 1_000),
      content: content(),
      dbPath: path.join(dir, 'c3 run.sqlite'),
      keepOpen: true,
    });
    const harness = result.engine?.harness as Harness;
    try {
      expect(result.outcome, result.outcomeDetail ?? '').toMatch(/^valid_terminal:(pact_concluded|talks_failed)$/);
      expect(result.rounds).toBeLessThanOrEqual(6);
      // Shi's counter carries the advised terms (no land, 200,000 bolts a year).
      const counters = harness.repo
        .listSessionProposals(result.sessionId)
        .filter((p) => p.actor === 'shi_jingtang' && p.status === 'committed')
        .map((p) => p.action as { type: string; args: { response?: string; counterTerms?: { cession: string; annual_silk: number } | null } })
        .filter((a) => a.type === 'respond_to_offer' && a.args.response === 'counter');
      expect(counters.length).toBeGreaterThan(0);
      expect(counters[0]?.args.counterTerms).toMatchObject({ cession: 'none', annual_silk: 200_000 });
    } finally {
      harness.close();
    }
  }, 60_000);
});
