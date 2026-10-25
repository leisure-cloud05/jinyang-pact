/**
 * End-to-end runs (offline, mock personas, misbehaviour 0) of every reference-trace config (C1–C6, D1–D3) in
 * `full` and `no_judge`, and of every config in `baseline`. Mock personas may deviate from the reference traces, so
 * the tests assert run outcomes, invariants (no invalid, ungated or stale commit), the decidable case constraints
 * and replay (patch + rederive) — not trace equality.
 */
import { describe, expect, it } from 'vitest';
import { findCase } from '../../src/content/loader.js';
import type { Mode } from '../../src/core/types.js';
import { checkConstraints, content, invariantProblems, negativeBalances, run, snapshots } from './helpers.js';

const CONFIGS = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'D1', 'D2', 'D3'] as const;
const HARNESS_MODES: Mode[] = ['full', 'no_judge'];

/**
 * D1 ends at max_rounds by design (no dispatch; PLAN/README). Every other config reaches a valid terminal.
 */
function expectedOutcome(caseId: string, _mode: Mode): 'valid_terminal' | 'max_rounds' {
  return caseId === 'D1' ? 'max_rounds' : 'valid_terminal';
}

describe.each(CONFIGS)('%s end to end', (caseId) => {
  const config = findCase(content(), caseId);

  it.each(HARNESS_MODES)('%s: reaches its expected outcome with no invalid commit, constraints hold, replay passes', async (mode) => {
    const r = await run(caseId, mode);
    const want = expectedOutcome(caseId, mode);
    if (want === 'valid_terminal') {
      expect(r.outcome, `${caseId} ${mode}`).toMatch(/^valid_terminal:/);
      expect(config.valid_terminals).toContain(r.terminal?.kind);
    } else {
      expect(r.outcome).toBe('max_rounds');
      expect(r.terminal).toBeNull();
    }
    expect(r.rounds).toBeLessThanOrEqual(config.max_rounds);
    expect(r.rounds).toBeLessThanOrEqual(6);
    expect(r.calls).toBeLessThanOrEqual(100);
    expect(invariantProblems(r.harness, r.sessionId)).toEqual([]);
    const constraints = checkConstraints(r.harness, r.sessionId, caseId, mode).filter(
      (c) => !(c.kind === 'terminal_in' && want === 'max_rounds'),
    );
    expect(constraints.filter((c) => c.status === 'fail')).toEqual([]);
    const patch = r.harness.replay(r.sessionId, 'patch');
    const rederive = r.harness.replay(r.sessionId, 'rederive');
    expect(patch.mismatches).toEqual([]);
    expect(rederive.mismatches).toEqual([]);
    expect(patch.ok && rederive.ok).toBe(true);
    // Every committed character batch is narrated (header + prose or template fallback).
    const pending = r.harness.repo.committedBatches(r.sessionId).filter((b) => b.kind === 'character' && b.narrationStatus !== 'done' && b.narrationStatus !== 'none');
    expect(pending).toEqual([]);
    // Session metadata.
    const session = r.harness.getSession(r.sessionId);
    expect(session.mode).toBe(mode);
    expect(session.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(session.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.engine?.records.findRun(r.sessionId)?.models.character).toBe('mock');
  });

  it('baseline: completes permissively (no mandatory or control pauses) and replays', async () => {
    const r = await run(caseId, 'baseline');
    expect(r.outcome === 'max_rounds' || r.outcome?.startsWith('valid_terminal:') || r.outcome?.startsWith('invalid_terminal:')).toBe(true);
    expect(r.rounds).toBeLessThanOrEqual(config.max_rounds);
    const categories = Object.keys(r.pauses);
    expect(categories.filter((c) => c !== 'prompt_request' && c !== 'user_requested' && c !== 'error_recovery')).toEqual([]);
    expect(r.harness.replay(r.sessionId, 'patch').ok).toBe(true);
    expect(r.harness.replay(r.sessionId, 'rederive').mismatches).toEqual([]);
  });
});

describe('Harness vs baseline on the same config', () => {
  it('C6: the overdrawn gift is rejected in Harness modes (H07) but committed by the permissive baseline', async () => {
    const harnessRun = await run('C6', 'no_judge');
    const rejected = harnessRun.harness.repo
      .listSessionProposals(harnessRun.sessionId)
      .filter((p) => p.status === 'rejected' && p.rule === 'H07');
    expect(rejected.length).toBeGreaterThan(0);
    expect(negativeBalances(snapshots(harnessRun.harness, harnessRun.sessionId))).toEqual([]);

    const baseline = await run('C6', 'baseline');
    expect(negativeBalances(snapshots(baseline.harness, baseline.sessionId)).length).toBeGreaterThan(0);
    const ungated = baseline.harness.repo.listSessionProposals(baseline.sessionId).filter((p) => p.status === 'committed' && p.gate === 'ungated');
    expect(ungated.length).toBeGreaterThan(0);
  });

  it('C2: the Judge withholds a goal-conflicting revision that no_judge lets through', async () => {
    const full = await run('C2', 'full');
    const noJudge = await run('C2', 'no_judge');
    expect(full.pauses.goal_conflict ?? 0).toBeGreaterThan(0);
    expect(noJudge.pauses.goal_conflict ?? 0).toBe(0);
    expect(full.outcome).toBe('valid_terminal:pact_concluded');
  });
});
