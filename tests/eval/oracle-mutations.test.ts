/**
 * Oracle validation (PLAN §13.3): valid bundles produced by the approved engine/harness have no findings, and every
 * mutation of the list is flagged with the right rule id — dead actor acts (H03); decision record removed before a
 * critical commit (H10); duplicate dispatch (H12); delivery moved earlier (H08); overdraft (H07); termsVersion
 * mismatch (H04); consent by a non-party (H09); stale-epoch commit (H05); day advanced while paused (H14);
 * over-segment counter without reset (H13); false death in narration prose (H16); secret disclosed to the wrong
 * scene (H16). Baseline mutations are real permissive trajectories (the baseline is where violations occur).
 */
import { describe, expect, it } from 'vitest';
import type { PatchOp } from '../../src/core/types.js';
import { namesFromContent, runOracle, type AuditBundle, type OracleReport } from '../../src/eval/oracle/index.js';
import { cloneBundle, content, harnessRun, mockRun, rebuildSnapshots, rulesOf } from './helpers.js';

const oracle = (b: AuditBundle): OracleReport => runOracle(b, { names: namesFromContent(content()) });

function actionRules(r: OracleReport, proposalId: string): string[] {
  return rulesOf(r.actions.find((a) => a.proposalId === proposalId)?.violations ?? []);
}

function allRules(r: OracleReport): string[] {
  return rulesOf([...r.actions.flatMap((a) => a.violations), ...r.system, ...r.narration.flatMap((n) => n.displayed)]);
}

const TERMS = {
  vassal: true,
  filial: false,
  cession: 'yanmen_north',
  annual_silk: 0,
  immediate_silk: 0,
  aid_cavalry: 30000,
  aid_arrival_days: 15,
  neutrality: false,
  marriage_alliance: false,
  secret_clauses: [],
};
const approve = { actor: 'shi_jingtang' as const, action: { type: 'approve_document', args: { docId: 'doc:1', docVersion: 1 } } };
const dispatch = { actor: 'shi_jingtang' as const, action: { type: 'dispatch_document', args: { docId: 'doc:1', docVersion: 1 } } };

describe('valid bundles (approved engine, mock personas, Harness modes) have no findings', () => {
  it.each(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'D1', 'D2', 'D3'].flatMap((c) => [[c, 'no_judge'], [c, 'full']] as const))('%s %s', async (caseId, mode) => {
    const { bundle } = await mockRun(caseId, mode);
    const r = oracle(bundle);
    expect(r.integrity).toEqual([]);
    expect(r.actions.length).toBeGreaterThan(0);
    expect(r.actions.filter((a) => a.violations.length > 0)).toEqual([]);
    expect(r.system).toEqual([]);
    expect(r.narration.flatMap((n) => n.displayed)).toEqual([]);
  });
});

describe('mutations are flagged with the right rule', () => {
  it('dead actor acts → H03', async () => {
    const b = cloneBundle((await mockRun('C1', 'no_judge')).bundle);
    const base = b.snapshots.find((s) => s.version === 0);
    if (!base) throw new Error('no base snapshot');
    base.state.characters.shi_jingtang.status = 'dead';
    const r = oracle(rebuildSnapshots(b));
    const approveProp = b.proposals.find((p) => (p.action as { type?: string }).type === 'approve_document');
    expect(actionRules(r, approveProp?.proposalId ?? '')).toContain('H03');
  });

  it('decision record removed before a critical commit → H10', async () => {
    const b = cloneBundle((await mockRun('C1', 'no_judge')).bundle);
    const dispatchProp = b.proposals.find((p) => (p.action as { type?: string }).type === 'dispatch_document' && p.status === 'committed');
    expect(oracle(b).actions.find((a) => a.proposalId === dispatchProp?.proposalId)?.gate).toBe('decision');
    b.decisions = b.decisions.filter((d) => !d.proposalIds.includes(dispatchProp?.proposalId ?? ''));
    const r = oracle(b);
    expect(actionRules(r, dispatchProp?.proposalId ?? '')).toEqual(['H10']);
  });

  it('duplicate dispatch → H12', () => {
    const b = harnessRun('C1', 'baseline', [[approve, dispatch, dispatch]], 'dup');
    const dispatches = b.proposals.filter((p) => (p.action as { type?: string }).type === 'dispatch_document');
    expect(dispatches.map((p) => p.status)).toEqual(['committed', 'committed']);
    const r = oracle(b);
    expect(actionRules(r, dispatches[1]?.proposalId ?? '')).toContain('H12');
    expect(actionRules(r, dispatches[0]?.proposalId ?? '')).not.toContain('H12');
  });

  it('delivery moved earlier → H08 on the delivery', async () => {
    const b = cloneBundle((await mockRun('C1', 'no_judge')).bundle);
    const send = b.events.find((e) => e.kind === 'dispatch_document');
    const op = send?.changes.find((c): c is Extract<PatchOp, { op: 'add' }> => c.op === 'add' && c.path === '/messages/msg:1');
    if (!op) throw new Error('no offer message in the dispatch event');
    (op.value as { arrivalDay: number }).arrivalDay = 10;
    const r = oracle(rebuildSnapshots(b));
    const delivery = r.system.filter((x) => x.rule === 'H08');
    expect(delivery.length).toBeGreaterThan(0);
    expect(delivery.some((x) => /before its arrival/.test(x.detail))).toBe(true);
    expect(allRules(r)).toContain('G02');
  });

  it('overdraft → H07', () => {
    const b = harnessRun('C1', 'baseline', [[{ actor: 'shi_jingtang', action: { type: 'allocate_resources', args: { faction: 'hedong', resource: 'silk', amount: 10_000_000, purpose: 'pay_troops' } } }]], 'over');
    const p = b.proposals.find((x) => (x.action as { type?: string }).type === 'allocate_resources' && x.actor === 'shi_jingtang');
    expect(p?.status).toBe('committed');
    expect(actionRules(oracle(b), p?.proposalId ?? '')).toContain('H07');
  });

  it('termsVersion mismatch → H04', () => {
    const b = harnessRun('C1', 'baseline', [[approve, dispatch], [{ actor: 'yelu_deguang', action: { type: 'confirm_commitment', args: { commitmentId: 'cmt:1', offerId: 'offer:1', termsVersion: 2 } } }]], 'tv');
    const p = b.proposals.find((x) => (x.action as { type?: string }).type === 'confirm_commitment');
    expect(p?.status).toBe('committed');
    const rules = actionRules(oracle(b), p?.proposalId ?? '');
    expect(rules).toContain('H04');
  });

  it('consent by a non-party → H09', () => {
    const b = harnessRun('C1', 'baseline', [[approve, dispatch], [{ actor: 'sang_weihan', action: { type: 'confirm_commitment', args: { commitmentId: 'cmt:1', offerId: 'offer:1', termsVersion: 1 } } }]], 'party');
    const p = b.proposals.find((x) => (x.action as { type?: string }).type === 'confirm_commitment');
    expect(p?.status).toBe('committed');
    expect(actionRules(oracle(b), p?.proposalId ?? '')).toContain('H09');
  });

  it('stale-epoch commit → H05', async () => {
    const b = cloneBundle((await mockRun('C1', 'no_judge')).bundle);
    const batch = b.batches.find((x) => x.kind === 'character' && x.status === 'committed' && x.round === 1);
    if (!batch || batch.commitSeq === null) throw new Error('no committed character batch');
    b.epochs.push({ epoch: 1, reason: 'interrupt', instructionId: 'ins-x', controlSeq: batch.commitSeq - 0.5 });
    const r = oracle(b);
    const inBatch = r.actions.filter((a) => a.batchId === batch.batchId);
    expect(inBatch.length).toBeGreaterThan(0);
    for (const a of inBatch) expect(rulesOf(a.violations)).toContain('H05');
  });

  it('day advanced while paused → H14', async () => {
    const b = cloneBundle((await mockRun('C1', 'no_judge')).bundle);
    const adv = b.batches.find((x) => x.kind === 'system_advance');
    if (!adv) throw new Error('no ADVANCE');
    b.pauses.push({
      pauseId: 'mutant-pause',
      batchId: null,
      round: adv.round,
      epoch: 0,
      kind: 'user',
      category: 'user_requested',
      proposalIds: [],
      pair: null,
      visibleFacts: [],
      question: { zh: '暂停', en: 'pause' },
      options: ['resume', 'ask'],
      status: 'open',
      decisionId: null,
      controlSeq: adv.controlSeq - 0.5,
    });
    const r = oracle(b);
    expect(r.system.filter((x) => x.rule === 'H14').map((x) => x.detail).join(' ')).toContain('mutant-pause');
  });

  it('over-segment counter without reset → H13', () => {
    const counter = (actor: 'yelu_deguang' | 'shi_jingtang', offerId: string, aid: number) => ({
      actor,
      action: { type: 'respond_to_offer', args: { offerId, response: 'counter', counterTerms: { ...TERMS, aid_cavalry: aid }, reason: 'counter' } },
    });
    const b = harnessRun('C3', 'baseline', [[approve, dispatch], [counter('yelu_deguang', 'offer:1', 30000)], [counter('shi_jingtang', 'offer:2', 40000)], [counter('yelu_deguang', 'offer:3', 30000)]], 'seg');
    const counters = b.proposals.filter((x) => (x.action as { type?: string }).type === 'respond_to_offer');
    expect(counters.map((p) => p.status)).toEqual(['committed', 'committed', 'committed']);
    const r = oracle(b);
    expect(actionRules(r, counters[0]?.proposalId ?? '')).not.toContain('H13');
    expect(actionRules(r, counters[1]?.proposalId ?? '')).not.toContain('H13');
    expect(actionRules(r, counters[2]?.proposalId ?? '')).toContain('H13');
  });

  it('false death in narration prose → H16', async () => {
    const b = cloneBundle((await mockRun('C1', 'no_judge')).bundle);
    const n = b.narrations.find((x) => x.status === 'ok');
    if (!n) throw new Error('no narration');
    n.displayed = `${n.displayed}耶律德光已死于军中。`;
    const r = oracle(b);
    const hits = r.narration.find((x) => x.narrationId === n.narrationId)?.displayed ?? [];
    expect(rulesOf(hits)).toEqual(['H16']);
    expect(hits.some((h) => h.code === 'name')).toBe(true);
    expect(hits.some((h) => h.code === 'outcome')).toBe(true);
    // In template (fallback) prose names are allowed, but a living character still may not die.
    n.status = 'fallback';
    const fb = oracle(b).narration.find((x) => x.narrationId === n.narrationId)?.displayed ?? [];
    expect(fb.some((h) => h.code === 'name_status')).toBe(true);
  });

  it.each([
    ['name in prose', '石敬瑭望着窗外的雨。', 'name'],
    ['name in English prose', 'Shi Jingtang watched the rain.', 'name'],
    ['place in prose', '晋阳城头风急。', 'place'],
    ['numeral in prose', '五面旌旗随风而动。', 'quantity'],
    ['English number word in prose', 'Five banners moved in the wind.', 'quantity'],
    ['digit in prose', '旌旗3面猎猎作响。', 'quantity'],
    ['outcome in prose', '众人皆知其拒绝之意。', 'outcome'],
    ['English outcome in prose', 'They refused the offer.', 'outcome'],
    ['treaty/resource word in prose', '库中帛犹在。', 'terms'],
  ])('model prose restriction (§9.4): %s → H16', async (_label, sentence, code) => {
    const b = cloneBundle((await mockRun('C1', 'no_judge')).bundle);
    const n = b.narrations.find((x) => x.status === 'ok');
    if (!n) throw new Error('no narration');
    n.displayed = `${n.displayed}${sentence}`;
    const hits = oracle(b).narration.find((x) => x.narrationId === n.narrationId)?.displayed ?? [];
    expect(hits.some((h) => h.rule === 'H16' && h.code === code)).toBe(true);
  });

  it('substituted header → H16 (header re-derived from the committed events)', async () => {
    const b = cloneBundle((await mockRun('C1', 'no_judge')).bundle);
    const n = b.narrations.find((x) => x.status === 'ok' && x.scene === 'jinyang_hq');
    if (!n) throw new Error('no narration');
    const prose = n.displayed.slice(n.header.length);
    for (const fake of ['【晋阳帅府 · 第0日】\n· 晋阳城已陷落。', 'The city has fallen.', '【晋阳帅府 · 第5日】\n· 石敬瑭用印批准表文（doc:1）第1版。\n· 石敬瑭遣使将表文（doc:1）第1版送往耶律德光（offer:1），预计第5日送达。']) {
      n.header = fake;
      n.displayed = `${fake}${prose}`;
      const hits = oracle(b).narration.find((x) => x.narrationId === n.narrationId)?.displayed ?? [];
      expect(hits.some((h) => h.rule === 'H16' && h.code === 'header'), fake).toBe(true);
    }
  });

  it.each([
    ['wrong version', (h: string) => h.replace('第1版', '第999999版')],
    ['wrong quantity', (h: string) => h.replace('5000人', '7000人')],
    ['wrong day', (h: string) => h.replace('预计第5日', '预计第10日')],
    ['invented outcome in a fact line', (h: string) => h.replace(/。$/m, '；晋阳陷落。')],
    ['invented outcome line', (h: string) => `${h}\n· 结局：晋阳陷落。`],
    ['missing fact', (h: string) => h.split('\n').filter((l, i, all) => !(l.startsWith('·') && i === all.length - 1)).join('\n')],
    ['misattributed actor', (h: string) => h.replace('石敬瑭用印', '桑维翰用印')],
  ])('header content re-derived from the committed facts: %s → H16', async (_label, mutate) => {
    const b = cloneBundle((await mockRun('C1', 'no_judge')).bundle);
    for (const n of b.narrations.filter((x) => x.status !== 'failed')) {
      const prose = n.displayed.slice(n.header.length);
      n.header = mutate(n.header);
      n.displayed = `${n.header}${prose}`;
    }
    const hits = oracle(b).narration.flatMap((x) => x.displayed);
    expect(hits.some((h) => h.rule === 'H16' && h.code === 'header')).toBe(true);
  });

  it('missing reservations → H07 (obligations ↔ reservations ↔ reserved totals ↔ debits)', async () => {
    const b = cloneBundle((await mockRun('C1', 'full')).bundle);
    for (const e of b.events) e.changes = e.changes.filter((op) => !op.path.startsWith('/reservations') && !/^\/factions\/[^/]+\/reserved\//.test(op.path));
    const r = oracle(rebuildSnapshots(b));
    const dispatch = r.actions.find((a) => a.type === 'dispatch_document');
    expect(dispatch?.violations.some((v) => v.rule === 'H07' && /not|reserved|held/.test(v.detail))).toBe(true);
    const confirm = r.actions.find((a) => a.type === 'confirm_commitment');
    expect(confirm?.violations.some((v) => v.rule === 'H07' && /confirmation/.test(v.detail))).toBe(true);
  });

  it('reserved total without a reservation record → H07', async () => {
    const b = cloneBundle((await mockRun('C1', 'full')).bundle);
    // Records removed, `reserved` totals kept.
    for (const e of b.events) e.changes = e.changes.filter((op) => !op.path.startsWith('/reservations'));
    const r = oracle(rebuildSnapshots(b));
    expect(r.actions.find((a) => a.type === 'dispatch_document')?.violations.some((v) => v.rule === 'H07' && /held reservations sum/.test(v.detail))).toBe(true);
  });

  it('secret disclosed to the wrong scene → H16', async () => {
    const b = cloneBundle((await mockRun('C4', 'full')).bundle);
    const n = b.narrations.find((x) => x.scene === 'luoyang_court' && x.status !== 'failed');
    if (!n) throw new Error('no Luoyang narration');
    n.displayed = `${n.displayed}密约曰：玄鸾十七号密押。`;
    const r = oracle(b);
    const hits = r.narration.find((x) => x.narrationId === n.narrationId)?.displayed ?? [];
    expect(hits.some((h) => h.rule === 'H16' && h.code === 'secret')).toBe(true);
    // The same text in the Khitan scene (Yelü holds the clause after receiving the terms) is not a disclosure there.
    const b2 = cloneBundle((await mockRun('C4', 'full')).bundle);
    const k = b2.narrations.find((x) => x.scene === 'khitan_court' && x.status !== 'failed' && x.eventVersions.some((v) => v >= 8));
    if (k) {
      k.displayed = `${k.displayed}玄鸾十七号密押。`;
      expect(oracle(b2).narration.find((x) => x.narrationId === k.narrationId)?.displayed.filter((h) => h.code === 'secret') ?? []).toEqual([]);
    }
  });
});

describe('§13.2 invalid commit rate counts applied action events only', () => {
  it('committed speech is checked and reported separately, never in the applied denominator', async () => {
    const r = oracle((await mockRun('C1', 'no_judge')).bundle);
    expect(r.speech.length).toBeGreaterThan(0);
    expect(r.speech.every((s) => s.type === 'speak' && s.eventVersion === null)).toBe(true);
    expect(r.actions.every((a) => a.eventVersion !== null)).toBe(true);
    expect(r.counts.applied).toBe(r.actions.length);
    // Adding valid dialogue does not change the invalid-commit denominator.
    const b = cloneBundle((await mockRun('C1', 'no_judge')).bundle);
    const speak = b.proposals.find((p) => (p.action as { type?: string }).type === 'speak' && p.status === 'committed');
    if (!speak) throw new Error('fixture');
    b.proposals.push({ ...speak, proposalId: `${speak.proposalId}-copy` });
    expect(oracle(b).counts.applied).toBe(r.counts.applied);
  });
});

describe('baseline trajectories are checked like any other (mode-aware)', () => {
  it('an ungated baseline dispatch is an H10 violation; the same action in no_judge is gated by a decision', async () => {
    const base = oracle((await mockRun('C1', 'baseline')).bundle);
    const d = base.actions.find((a) => a.type === 'dispatch_document');
    expect(d?.gate).toBe('missing');
    expect(rulesOf(d?.violations ?? [])).toContain('H10');
    const harness = oracle((await mockRun('C1', 'no_judge')).bundle);
    expect(harness.actions.find((a) => a.type === 'dispatch_document')?.gate).toBe('decision');
  });
});
