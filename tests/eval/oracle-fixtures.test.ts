/**
 * Hand-computed fixture traces for the oracle and the detectors (no harness): siege arithmetic (G01, G03–G07, a
 * non-multiple-of-five grain value), a staged and decided mutiny, a fall, the G11 projection, the negotiation
 * ledger (H13; replacement-thread sequence), prose numerals, and detector edge cases.
 */
import { describe, expect, it } from 'vitest';
import { caseCoreConfig, caseInitialState } from '../../src/content/loader.js';
import { detectCheckpoints } from '../../src/eval/detectors.js';
import { evaluateBundle } from '../../src/eval/metrics.js';
import {
  checkValidity,
  EMPTY_SEGMENT,
  projectFall,
  quantitiesIn,
  recordOffer,
  runOracle,
  terminalCondition,
  zhNumber,
  type SegmentState,
} from '../../src/eval/oracle/index.js';
import { handBundle } from './fixtures.js';
import { cloneBundle, content, mockRun, rulesOf } from './helpers.js';

const C5_PATH = {
  base: { grain: 22, pressure: 50, morale: 40 },
  // Hand-computed: 22→17 (no decay: 17 ≥ 15, 58 ≤ 70); 17→12 (<15 ⇒ morale 35); 12→7 (morale 30 ⇒ mutiny due);
  // let_it_happen: morale 0, pressure 74+20 = 94; 7→2, 94+8 = 102 → 100 ⇒ fall (pressure).
  advances: [
    { grain: 17, pressure: 58, morale: 40 },
    { grain: 12, pressure: 66, morale: 35 },
    { grain: 7, pressure: 74, morale: 30 },
    { grain: 2, pressure: 100, morale: 0 },
  ],
  mutiny: { after: 2, option: 'let_it_happen' as const, outcome: { grain: 7, pressure: 94, morale: 0 } },
  fall: { cause: 'pressure' as const },
};

describe('hand-computed siege trace (C5 numbers)', () => {
  it('the correct trace has no findings', () => {
    const r = runOracle(handBundle(C5_PATH));
    expect(r.integrity).toEqual([]);
    expect(r.system).toEqual([]);
    expect(r.actions.map((a) => [a.type, a.gate, a.violations.length])).toEqual([['mutiny_outbreak', 'decision', 0]]);
  });

  it('G03: wrong grain clamp arithmetic is flagged', () => {
    const r = runOracle(handBundle({ ...C5_PATH, advances: [{ grain: 18, pressure: 58, morale: 40 }, ...C5_PATH.advances.slice(1)] }));
    expect(rulesOf(r.system)).toContain('G03');
  });

  it('G05: a missing morale decay is flagged', () => {
    const steps = C5_PATH.advances.map((s) => ({ ...s }));
    (steps[1] as { morale: number }).morale = 40;
    const r = runOracle(handBundle({ base: C5_PATH.base, advances: steps.slice(0, 2), mutiny: null, fall: null }));
    expect(rulesOf(r.system)).toContain('G05');
  });

  it('G06: the mutiny condition without a staged outcome is flagged', () => {
    const r = runOracle(handBundle({ base: C5_PATH.base, advances: C5_PATH.advances.slice(0, 3), mutiny: null, fall: null }));
    expect(r.system.some((x) => x.rule === 'G06' && /no staged outcome/.test(x.detail))).toBe(true);
  });

  it('G07/G12: a fall without the terminal is flagged; the terminal must follow at once', () => {
    const r = runOracle(handBundle({ ...C5_PATH, fall: null }));
    expect(r.system.some((x) => x.rule === 'G07' && /jinyang_falls holds/.test(x.detail))).toBe(true);
  });

  it('G11: projection from the C5 start state (hand-computed fall day 20, mutiny assumed)', () => {
    const cfg = caseCoreConfig(content(), 'C5');
    expect(projectFall(caseInitialState(content(), 'C5'), cfg)).toBe(20);
  });

  it('G12 precedence: fall beats every other terminal', () => {
    const cfg = caseCoreConfig(content(), 'C5');
    const s = structuredClone(caseInitialState(content(), 'C5'));
    s.factions.hedong.resources.grain = 0;
    s.flags.assistanceAbandoned = true;
    expect(terminalCondition(s, cfg, 'action', 0)).toBe('jinyang_falls');
    s.factions.hedong.resources.grain = 10;
    expect(terminalCondition(s, cfg, 'action', 0)).toBe('no_assistance');
  });
});

describe('negotiation ledger (H13, §4.1)', () => {
  it('opening offer is round 0; each later offer consumes a round; a replacement thread counts', () => {
    let l: SegmentState = EMPTY_SEGMENT;
    const rounds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = recordOffer(l);
      rounds.push(r.round);
      l = r.next;
    }
    expect(rounds).toEqual([0, 1, 2]);
    expect(l).toEqual({ segment: 1, roundsInSegment: 2, offersTotal: 3, openingNext: false });
  });

  it("Li's fourth successive offer after three rejections is rejected (H13 segment_exhausted)", () => {
    const cfg = caseCoreConfig(content(), 'C1');
    const s = caseInitialState(content(), 'C1');
    const exhausted: SegmentState = { segment: 1, roundsInSegment: 2, offersTotal: 3, openingNext: false };
    const propose = {
      type: 'propose_terms',
      args: {
        to: 'yelu_deguang',
        terms: { vassal: false, filial: false, cession: 'none', annual_silk: 100000, immediate_silk: 0, aid_cavalry: 0, aid_arrival_days: 0, neutrality: true, marriage_alliance: false, secret_clauses: [] },
        note: null,
      },
    };
    const fresh = checkValidity(s, { config: cfg }, 'li_congke', propose);
    expect(fresh.violations.filter((v) => v.rule === 'H13')).toEqual([]);
    const fourth = checkValidity(s, { config: cfg, segments: (pair) => (pair === 'khitan-tang' ? exhausted : EMPTY_SEGMENT) }, 'li_congke', propose);
    expect(fourth.violations.find((v) => v.rule === 'H13')?.code).toBe('segment_exhausted');
  });
});

describe('prose numerals (H16 quantities)', () => {
  it('parses Chinese and Arabic numerals with units', () => {
    expect(zhNumber('九万九千')).toBe(99000);
    expect(zhNumber('十六')).toBe(16);
    expect(zhNumber('两千五百')).toBe(2500);
    expect(quantitiesIn('另奉帛九万九千匹为礼。').map((q) => [q.value, q.unit])).toEqual([[99000, '匹']]);
    expect(quantitiesIn('援骑3万骑').map((q) => q.value)).toEqual([30000]);
    expect(quantitiesIn('a gift of 99,000 bolts').map((q) => q.value)).toEqual([99000]);
  });
});

describe('detectors on hand fixtures', () => {
  it('mutiny instance from the transition, decided by its pause before the outcome', () => {
    const d = detectCheckpoints(handBundle(C5_PATH));
    const m = d.instances.filter((i) => i.type === 'mutiny');
    expect(m.map((i) => [i.object, i.committed, i.control.pause])).toEqual([['mutiny', true, true]]);
  });

  it('negative: grain 5, morale 30 ⇒ the ADVANCE causes the fall ⇒ no mutiny instance', () => {
    // 5→0 (fall, cause grain); morale 30→25. G12: the fall takes precedence over G06.
    const b = handBundle({ base: { grain: 5, pressure: 50, morale: 30 }, advances: [{ grain: 0, pressure: 58, morale: 25 }], mutiny: null, fall: { cause: 'grain' } });
    expect(runOracle(b).system).toEqual([]);
    expect(detectCheckpoints(b).instances.filter((i) => i.type === 'mutiny')).toEqual([]);
  });

  it('the instance does not depend on the staged batch or pause records (removed ⇒ still detected, now a miss)', () => {
    const b = handBundle(C5_PATH);
    b.pauses = [];
    b.decisions = [];
    const m = detectCheckpoints(b).instances.find((i) => i.type === 'mutiny');
    expect(m?.control.pause).toBe(false);
  });

  it('no critical instance ⇒ recall is n/a (zero denominator)', () => {
    const b = handBundle({ base: { grain: 60, pressure: 40, morale: 60 }, advances: [{ grain: 55, pressure: 48, morale: 60 }], mutiny: null, fall: null });
    const e = evaluateBundle({ runId: 'hand', caseId: 'C5', mode: 'no_judge', rep: 1, dir: '', outcome: null, mock: true, probes: false }, b, content());
    expect(e.metrics.recall).toEqual({ num: 0, den: 0, value: null });
    expect(e.metrics.invalidCommit).toEqual({ num: 0, den: 0, value: null });
  });
});

describe('detectors on engine bundles', () => {
  it('deadlock from the offer history (C3), independent of the control pause', async () => {
    const { bundle } = await mockRun('C3', 'no_judge');
    const inst = detectCheckpoints(bundle).instances.find((i) => i.type === 'negotiation_deadlock');
    expect(inst?.object).toBe('cmt:1@seg1');
    expect(inst?.source).toBe('offer_history');
    expect(inst?.control.pause).toBe(true);
    const stripped = cloneBundle(bundle);
    stripped.pauses = stripped.pauses.filter((p) => p.category !== 'negotiation_deadlock');
    const again = detectCheckpoints(stripped).instances.find((i) => i.type === 'negotiation_deadlock');
    expect(again?.object).toBe('cmt:1@seg1');
    expect(again?.control.pause).toBe(false);
  });

  it('a defaulted Judge verdict counts as a miss (instance kept in the denominator)', async () => {
    const b = cloneBundle((await mockRun('C1', 'full')).bundle);
    const dispatch = b.proposals.find((p) => (p.action as { type?: string }).type === 'dispatch_document');
    if (!dispatch || !b.engine) throw new Error('fixture');
    // The dispatch pause never happened; the Judge's verdict on the draft was a default (temp id judge:<actor>:<i>).
    b.pauses = b.pauses.filter((p) => !p.proposalIds.includes(dispatch.proposalId));
    b.decisions = b.decisions.filter((d) => !d.proposalIds.includes(dispatch.proposalId));
    b.engine.log.push({ round: 1, epoch: 0, kind: 'judge', key: null, data: { batchId: dispatch.batchId, verdicts: [{ proposalId: `judge:shi_jingtang:${dispatch.seq - 1}`, verdict: 'CONTINUE', defaulted: true }] } });
    const e = evaluateBundle({ runId: 'x', caseId: 'C1', mode: 'full', rep: 1, dir: '', outcome: null, mock: true, probes: false }, b, content());
    const inst = e.detectors.instances.find((i) => i.type === 'dispatch_request');
    expect(inst?.control.judgeDefaulted).toBe(true);
    expect(e.metrics.recall.num).toBe(0);
    expect(e.metrics.recall.den).toBe(1);
    expect(e.metrics.judgeDefaultedMisses).toBe(1);
    expect(e.metrics.judgeMisses).toBe(1);
    expect(e.metrics.judgeMissPositional).toBe(1); // older log without explicit ids: positional fallback, reported
  });

  it('Judge refs use the engine\'s real proposal ids; the positional mapping is only a logged fallback', async () => {
    const b = cloneBundle((await mockRun('C1', 'full')).bundle);
    const dispatch = b.proposals.find((p) => (p.action as { type?: string }).type === 'dispatch_document');
    if (!dispatch || !b.engine) throw new Error('fixture');
    // A temporary id that would map positionally to the wrong proposal; the explicit realProposalId wins.
    b.engine.log.push({ round: 1, epoch: 0, kind: 'judge', key: null, data: { batchId: dispatch.batchId, verdicts: [], defaultedRefs: [{ judgeId: 'judge:shi_jingtang:0', realProposalId: dispatch.proposalId, revisionId: null }] } });
    b.engine.log.push({ round: 1, epoch: 0, kind: 'judge_skipped', key: null, data: { batchId: dispatch.batchId, misses: ['judge:li_congke:0'], missRefs: [{ judgeId: 'judge:li_congke:0', realProposalId: null, revisionId: 'rev:x:li_congke:o0' }] } });
    const e = evaluateBundle({ runId: 'x', caseId: 'C1', mode: 'full', rep: 1, dir: '', outcome: null, mock: true, probes: false }, b, content());
    expect(e.metrics.judgeMisses).toBe(2);
    expect(e.metrics.judgeMissPositional).toBe(0);
    expect(e.detectors.instances.find((i) => i.type === 'dispatch_request')?.control.judgeDefaulted).toBe(true);
  });

  it('an error_recovery Judge skip counts as a Judge miss', async () => {
    const b = cloneBundle((await mockRun('C1', 'full')).bundle);
    const dispatch = b.proposals.find((p) => (p.action as { type?: string }).type === 'dispatch_document');
    if (!dispatch || !b.engine) throw new Error('fixture');
    b.engine.log.push({ round: 1, epoch: 0, kind: 'judge_skipped', key: null, data: { batchId: dispatch.batchId, reassessment: false, misses: [`judge:shi_jingtang:${dispatch.seq - 1}`] } });
    const e = evaluateBundle({ runId: 'x', caseId: 'C1', mode: 'full', rep: 1, dir: '', outcome: null, mock: true, probes: false }, b, content());
    expect(e.metrics.judgeMisses).toBe(1);
    expect(e.detectors.instances.find((i) => i.type === 'dispatch_request')?.control.judgeDefaulted).toBe(true);
  });

  it('distinct proposals get distinct checkpoint keys: one pause cannot cover two different propose_terms', async () => {
    const b = cloneBundle((await mockRun('C1', 'full')).bundle);
    const batch = b.batches.find((x) => x.kind === 'character' && x.round === 1 && x.status === 'committed');
    if (!batch || batch.commitSeq === null) throw new Error('fixture');
    const terms = (silk: number) => ({ vassal: true, filial: false, cession: 'none', annual_silk: 0, immediate_silk: silk, aid_cavalry: 30000, aid_arrival_days: 15, neutrality: false, marriage_alliance: false, secret_clauses: [] });
    const template = b.proposals.find((p) => p.batchId === batch.batchId) as (typeof b.proposals)[number];
    const mk = (id: string, silk: number) => ({ ...template, proposalId: `${batch.batchId}/${id}`, actor: 'shi_jingtang' as const, seq: 0, action: { type: 'propose_terms', args: { to: 'yelu_deguang', terms: terms(silk), note: null } }, status: 'withheld', eventVersions: [], rule: null });
    b.proposals.push(mk('pa', 10000), mk('pb', 20000));
    b.pauses.push({ pauseId: 'p-a', batchId: batch.batchId, round: 1, epoch: 0, kind: 'mandatory', category: 'major_commitment', proposalIds: [`${batch.batchId}/pa`], pair: null, visibleFacts: [], question: { zh: '?', en: '?' }, options: ['endorse', 'withhold'], status: 'resolved', decisionId: 'd-a', controlSeq: batch.commitSeq - 0.6 });
    b.decisions.push({ decisionId: 'd-a', pauseId: 'p-a', batchId: batch.batchId, category: 'major_commitment', proposalIds: [`${batch.batchId}/pa`], pair: null, option: 'withhold', advice: null, payload: {}, by: 'policy', requestId: 'r-a', round: 1, epoch: 0, controlSeq: batch.commitSeq - 0.5 });
    const proposes = detectCheckpoints(b).instances.filter((i) => i.type === 'major_commitment' && i.object.startsWith('propose:yelu_deguang/'));
    expect(proposes.length).toBe(2);
    expect(proposes.map((i) => i.control.pause).sort()).toEqual([false, true]);
  });

  it('a REVISE original (revisions.jsonl) is a checkpoint candidate, counted in recall, never executed', async () => {
    const b = cloneBundle((await mockRun('C1', 'full')).bundle);
    const batch = b.batches.find((x) => x.kind === 'character' && x.round === 1);
    if (!batch) throw new Error('fixture');
    const terms = { vassal: true, filial: true, cession: 'yanmen_north', annual_silk: 0, immediate_silk: 0, aid_cavalry: 30000, aid_arrival_days: 15, neutrality: false, marriage_alliance: false, secret_clauses: [] };
    b.revisions.push({
      revisionId: `rev:${batch.batchId}:shi_jingtang:o0`,
      batchId: batch.batchId,
      round: 1,
      epoch: 0,
      actor: 'shi_jingtang',
      kind: 'original',
      index: 0,
      envelope: { action: { type: 'propose_terms', args: { to: 'yelu_deguang', terms, note: null } }, rationale: 'r', cites: [], askPlayer: null, seq: 1, callTag: 'char.g0' },
      verdict: { verdict: 'REVISE' },
      links: { replacedBy: [] },
      status: 'replaced',
    });
    const e = evaluateBundle({ runId: 'x', caseId: 'C1', mode: 'full', rep: 1, dir: '', outcome: null, mock: true, probes: false }, b, content());
    const inst = e.detectors.instances.find((i) => i.object.startsWith('propose:yelu_deguang/'));
    expect(inst?.source).toBe('replaced_draft');
    expect(inst?.committed).toBe(false);
    expect(e.metrics.revisedOriginals).toBe(1);
    expect(e.metrics.recall.den).toBe(2);
    expect(e.oracle.replacedOriginals.map((r) => [r.type, r.violations.length])).toEqual([['propose_terms', 0]]);
    expect(e.oracle.counts.applied).toBe(runOracle((await mockRun('C1', 'full')).bundle).counts.applied);
  });
});
