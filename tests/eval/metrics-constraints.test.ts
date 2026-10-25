/**
 * Measures (PLAN §13.2): denominators and n/a, pooling, quantiles, the proposal Table 2 cost-sensitivity form;
 * and the case constraint vocabulary (content/README §6): every kind used in content is implemented, with
 * behaviour checks on engine bundles.
 */
import { describe, expect, it } from 'vitest';
import { findCase } from '../../src/content/loader.js';
import { CONSTRAINT_KINDS, evaluateConstraints } from '../../src/eval/constraints.js';
import { detectCheckpoints } from '../../src/eval/detectors.js';
import { aggregate, costSensitivity, evaluateBundle, fmtRatio, PROPOSAL_PRICES, quantile, ratio, type RunMeta } from '../../src/eval/metrics.js';
import { namesFromContent, ReplayedBundle, runOracle, type AuditBundle } from '../../src/eval/oracle/index.js';
import { cloneBundle, content, mockRun } from './helpers.js';

const meta = (caseId: string, mode: string): RunMeta => ({ runId: `${caseId}-${mode}`, caseId, mode, rep: 1, dir: '', outcome: null, mock: true, probes: false });

function constraintsOf(caseId: string, b: AuditBundle) {
  const rb = new ReplayedBundle(b);
  return evaluateConstraints({ bundle: b, rb, oracle: runOracle(b, { names: namesFromContent(content()) }), detectors: detectCheckpoints(b, rb), caseConfig: findCase(content(), caseId) });
}

describe('rates carry denominators; zero denominators are n/a', () => {
  it('ratio and formatting', () => {
    expect(ratio(0, 0)).toEqual({ num: 0, den: 0, value: null });
    expect(ratio(1, 4).value).toBe(0.25);
    expect(fmtRatio(ratio(0, 0))).toBe('n/a (0/0)');
    expect(fmtRatio(ratio(1, 3))).toBe('0.33 (1/3)');
  });

  it('quantiles (linear interpolation)', () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([4, 1, 3, 2], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0.95)).toBeCloseTo(3.85, 10);
  });

  it('baseline has no validation ⇒ rejection rate n/a; Harness modes report rejected ÷ proposals reaching commit', async () => {
    const base = evaluateBundle(meta('C6', 'baseline'), (await mockRun('C6', 'baseline')).bundle, content());
    expect(base.metrics.rejection.value).toBeNull();
    const nj = evaluateBundle(meta('C6', 'no_judge'), (await mockRun('C6', 'no_judge')).bundle, content());
    expect(nj.metrics.rejection.den).toBeGreaterThan(0);
    expect(nj.metrics.rejection.num).toBeGreaterThan(0);
    expect(nj.metrics.rejectedByRule.H07).toBeGreaterThan(0);
  });

  it('REVISE-replaced originals enter the rejection denominator once, as `replaced` (revision_failed ones are stored proposals)', async () => {
    const b = cloneBundle((await mockRun('C1', 'full')).bundle);
    const before = evaluateBundle(meta('C1', 'full'), b, content()).metrics;
    const batch = b.batches.find((x) => x.kind === 'character' && x.round === 1);
    if (!batch) throw new Error('fixture');
    const original = (i: number, status: string) => ({
      revisionId: `rev:${batch.batchId}:sang_weihan:o${i}`,
      batchId: batch.batchId,
      round: 1,
      epoch: 0,
      actor: 'sang_weihan' as const,
      kind: 'original' as const,
      index: i,
      envelope: { action: { type: 'wait', args: {} }, rationale: '', cites: [], askPlayer: null, seq: i + 1, callTag: 'char.g0' },
      verdict: null,
      links: { replacedBy: [] },
      status,
    });
    b.revisions.push(original(0, 'replaced'), original(0, 'replaced'), original(1, 'revision_failed'));
    b.revisions.push({ ...original(5, 'final'), kind: 'replacement' as const });
    const after = evaluateBundle(meta('C1', 'full'), b, content()).metrics;
    expect(after.rejection.den).toBe(before.rejection.den + 1);
    expect(after.proposalStatus.replaced).toBe(1);
    expect(after.rejection.num).toBe(before.rejection.num);
  });

  it('pooled aggregates sum numerators and denominators', async () => {
    const a = evaluateBundle(meta('C1', 'baseline'), (await mockRun('C1', 'baseline')).bundle, content());
    const b = evaluateBundle(meta('C1', 'no_judge'), (await mockRun('C1', 'no_judge')).bundle, content());
    const g = aggregate('both', [a, b]);
    expect(g.invalidCommit.num).toBe(a.metrics.invalidCommit.num + b.metrics.invalidCommit.num);
    expect(g.invalidCommit.den).toBe(a.metrics.invalidCommit.den + b.metrics.invalidCommit.den);
    expect(g.recall.den).toBe(a.metrics.recall.den + b.metrics.recall.den);
    expect(g.completion).toEqual(ratio([a, b].filter((e) => e.metrics.completed).length, 2));
    expect(g.rejection.den).toBe(b.metrics.rejection.den);
    expect(g.fallbackRate.den).toBe(a.metrics.fallbackRate.den + b.metrics.fallbackRate.den);
  });

  it('baseline commits critical outcomes without pauses (recall 0), Harness modes pause them', async () => {
    const base = evaluateBundle(meta('C1', 'baseline'), (await mockRun('C1', 'baseline')).bundle, content());
    const nj = evaluateBundle(meta('C1', 'no_judge'), (await mockRun('C1', 'no_judge')).bundle, content());
    expect(base.metrics.recall.num).toBe(0);
    expect(base.metrics.recall.den).toBeGreaterThan(0);
    expect(nj.metrics.recall.value).toBe(1);
    expect(nj.metrics.userControl.value).toBe(1);
    expect(base.metrics.invalidCommit.num).toBeGreaterThan(0);
    expect(nj.metrics.invalidCommit.num).toBe(0);
  });
});

describe('cost sensitivity (proposal Table 2 form)', () => {
  it('reproduces the proposal table from its assumed means (k = 2, 3, 5) and marks k = 5 as extrapolation', () => {
    const rows = costSensitivity({ character: { in: 1500, out: 250, calls: 1 }, judge: { in: 1800, out: 200, calls: 1 }, narrator: { in: 1500, out: 400, calls: 1 } }, PROPOSAL_PRICES);
    const byK = new Map(rows.map((r) => [r.k, r]));
    expect([byK.get(2)?.inputTokens, byK.get(2)?.outputTokens, byK.get(2)?.callsPerRound]).toEqual([6300, 1100, 4]);
    expect(byK.get(2)?.costPerRound).toBeCloseTo(0.00321, 8);
    expect(byK.get(3)?.costPerRound).toBeCloseTo(0.00396, 8);
    expect(byK.get(3)?.costPer20Rounds).toBeCloseTo(0.0792, 8);
    expect(byK.get(5)?.costPerRound).toBeCloseTo(0.00546, 8);
    expect(byK.get(5)?.extrapolation).toBe(true);
    expect(byK.get(4)?.extrapolation).toBe(false);
  });

  it('no character calls ⇒ costs are n/a', () => {
    expect(costSensitivity({ character: null, judge: null, narrator: null }, PROPOSAL_PRICES).every((r) => r.costPerRound === null)).toBe(true);
  });
});

describe('constraint vocabulary (content/README §6)', () => {
  it('implements every constraint kind used by the cases and dev configs', () => {
    const c = content();
    const kinds = new Set([...Object.values(c.cases), ...Object.values(c.dev)].flatMap((x) => x.constraints.map((k) => k.kind)));
    expect([...kinds].filter((k) => !(CONSTRAINT_KINDS as readonly string[]).includes(k))).toEqual([]);
  });

  it.each(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'D1', 'D2', 'D3'])('%s: no constraint is unsupported in any mode', async (caseId) => {
    for (const mode of ['baseline', 'no_judge', 'full'] as const) {
      const results = constraintsOf(caseId, (await mockRun(caseId, mode)).bundle);
      expect(results.filter((r) => r.status === 'unsupported')).toEqual([]);
      expect(results.length).toBe(findCase(content(), caseId).constraints.length);
    }
  });

  it('C6: overdraft and approved-only dispatch hold in Harness modes and fail in the permissive baseline', async () => {
    const nj = constraintsOf('C6', (await mockRun('C6', 'no_judge')).bundle);
    const base = constraintsOf('C6', (await mockRun('C6', 'baseline')).bundle);
    const status = (list: typeof nj, id: string) => list.find((r) => r.id === id)?.status;
    expect(status(nj, 'c6-overdraft')).toBe('pass');
    expect(status(base, 'c6-overdraft')).toBe('fail');
    expect(status(nj, 'c6-no-invalid')).toBe('pass');
    expect(status(base, 'c6-no-invalid')).toBe('fail');
  });

  it('C4: secrecy constraints pass on the engine run and fail when the canary appears in Liu\'s speech', async () => {
    const { bundle } = await mockRun('C4', 'full');
    const ok = constraintsOf('C4', bundle);
    for (const id of ['c4-canary', 'c4-clause-unknown', 'c4-pool', 'c4-isolation']) expect([id, ok.find((r) => r.id === id)?.status]).toEqual([id, 'pass']);
    expect(ok.find((r) => r.id === 'c4-conflict-exposure')).toMatchObject({ status: 'exposure', exposed: true });
    const leaked = cloneBundle(bundle);
    leaked.dialogue.push({ seq: 999, round: 2, epoch: 0, worldVersion: 5, speaker: 'liu_zhiyuan', listeners: ['player'], text: '听说另有密押：玄鸾十七号密押。', kind: 'speech', proposalId: null, decisionId: null, payload: null, inherited: false, controlAt: null });
    expect(constraintsOf('C4', leaked).find((r) => r.id === 'c4-canary')?.status).toBe('fail');
  });

  it('C5: the mutiny constraint is conditional — decided in no_judge, missed by the ungated baseline, exposure reported', async () => {
    const nj = constraintsOf('C5', (await mockRun('C5', 'no_judge')).bundle).find((r) => r.id === 'c5-mutiny');
    const base = constraintsOf('C5', (await mockRun('C5', 'baseline')).bundle).find((r) => r.id === 'c5-mutiny');
    expect(nj).toMatchObject({ status: 'pass', exposed: true });
    expect(base).toMatchObject({ status: 'fail', exposed: true });
  });
});

describe('format failures (pilot exit criterion)', () => {
  it('counts logical calls of any role whose final status is a format failure, over all calls', async () => {
    const { bundle } = await mockRun('C2', 'full');
    const clean = evaluateBundle(meta('C2', 'full'), bundle, content());
    expect(clean.metrics.formatFailedCalls).toBe(0);
    expect(clean.metrics.formatFailureRate.den).toBe(clean.metrics.calls);
    // A Judge reply that still fails its schema after repair (defaults to CONTINUE, no pause, no proposal) and a
    // truncated character reply must both be counted; a transport failure must not.
    const broken = cloneBundle(bundle);
    const judge = broken.llmCalls.find((c) => c.role === 'judge' && c.attempts > 0)!;
    const character = broken.llmCalls.find((c) => c.role === 'character' && c.attempts > 0)!;
    const other = broken.llmCalls.find((c) => c !== judge && c !== character && c.attempts > 0)!;
    judge.status = 'schema';
    character.status = 'truncated';
    other.status = 'timeout';
    const m = evaluateBundle(meta('C2', 'full'), broken, content()).metrics;
    expect(m.formatFailedCalls).toBe(2);
    expect(m.formatFailureRate).toMatchObject({ num: 2, den: m.calls });
    expect(aggregate('full', [{ ...clean, metrics: m }]).formatFailureRate).toMatchObject({ num: 2, den: m.calls });
  });
});
