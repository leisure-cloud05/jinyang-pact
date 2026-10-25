import { describe, expect, it } from 'vitest';
import { caseInitialState } from '../../src/content/loader.js';
import { planPauses } from '../../src/core/plan.js';
import {
  A,
  DOC_TERMS,
  LIU,
  SANG,
  SHI,
  T,
  batch,
  config,
  decide,
  dispatched,
  fixture,
  initial,
  nextRound,
  outcomeOf,
  prop,
} from './helpers.js';

describe('approval and dispatch', () => {
  it('approve → dispatch in one batch: approval atomically sets status, dispatch uses its event as consent', () => {
    const approve = prop(SHI, A.approve());
    const dispatch = prop(SHI, A.dispatch());
    const plan = planPauses(initial(), { kind: 'character', proposals: [approve, dispatch], decisions: [] }, { config: config(), mode: 'full' });
    expect(plan.wouldCommit).toEqual([approve.proposalId, dispatch.proposalId]);
    expect(plan.required.map((r) => [r.category, r.proposalIds])).toEqual([['dispatch_request', [dispatch.proposalId]]]);

    const r = batch(initial(), [approve, dispatch], { decisions: [decide(dispatch, 'dispatch_request')] });
    expect(outcomeOf(r, approve).status).toBe('committed');
    expect(outcomeOf(r, dispatch)).toMatchObject({ status: 'committed', gate: 'decision' });
    const approvalEvent = outcomeOf(r, approve).eventVersions[0];
    expect(approvalEvent).toBe(1);
    expect(r.state.documents['doc:1']).toMatchObject({ status: 'sent', sentOfferId: 'offer:1', approval: { version: 1, eventId: 1, by: SHI } });
    expect(r.state.offers['offer:1']?.consentEvidence).toBe('event:1');
    expect(r.state.commitments['cmt:1']?.consents[SHI]).toEqual({ termsVersion: 1, evidence: 'event:1', by: SHI });
  });

  it('editing after approval voids the approval', () => {
    let s = batch(initial(), [prop(SHI, A.approve())]).state;
    expect(s.documents['doc:1']?.status).toBe('approved');
    s = batch(s, [prop(SANG, A.revise(1, { ...DOC_TERMS, annual_silk: 100000 }))]).state;
    expect(s.documents['doc:1']).toMatchObject({ version: 2, status: 'draft', approval: null });
    expect(s.documents['doc:1']?.history.map((h) => [h.version, h.by])).toEqual([[1, SHI], [2, SANG]]);
    const d = prop(SHI, A.dispatch(2));
    expect(outcomeOf(batch(s, [d], { decisions: [decide(d, 'dispatch_request')] }), d)).toMatchObject({ status: 'rejected', rule: 'H11' });
    const stale = prop(SHI, A.dispatch(1));
    expect(outcomeOf(batch(s, [stale], { decisions: [decide(stale, 'dispatch_request')] }), stale)).toMatchObject({ rule: 'H04' });
  });

  it('a duplicate dispatch in the same batch is rejected (H12)', () => {
    const approve = prop(SHI, A.approve());
    const d1 = prop(SHI, A.dispatch());
    const d2 = prop(SHI, A.dispatch());
    const r = batch(initial(), [approve, d1, d2], { decisions: [decide(d1, 'dispatch_request'), decide(d2, 'dispatch_request')] });
    expect(outcomeOf(r, d1).status).toBe('committed');
    expect(outcomeOf(r, d2)).toMatchObject({ status: 'rejected', rule: 'H12' });
  });

  it('the player transmitting an approved request needs no pause (player_initiated)', () => {
    const s = batch(initial(), [prop(SHI, A.approve())]).state;
    const send = prop('player', A.dispatch());
    const plan = planPauses(s, { kind: 'player', proposals: [send], decisions: [] }, { config: config(), mode: 'full' });
    expect(plan.required).toEqual([]);
    const r = batch(s, [send], { kind: 'player' });
    expect(outcomeOf(r, send)).toMatchObject({ status: 'committed', gate: 'player_initiated' });
    // Consent is still Shi's approval event, whoever transmits.
    expect(r.state.offers['offer:1']?.from).toBe(SHI);
    expect(r.state.commitments['cmt:1']?.consents[SHI]?.evidence).toBe('event:1');
  });
});

describe('dispatch timing', () => {
  it('hold blocks dispatch', () => {
    let s = batch(initial(), [prop('player', A.timing('hold'))], { kind: 'player' }).state;
    s = batch(s, [prop(SHI, A.approve())]).state;
    const d = prop(SHI, A.dispatch());
    expect(outcomeOf(batch(s, [d], { decisions: [decide(d, 'dispatch_request')] }), d)).toMatchObject({ rule: 'H11' });
  });

  it('delay n rounds sets notBeforeRound = round + n', () => {
    let s = batch(initial(), [prop('player', A.timing('delay', 2))], { kind: 'player' }).state;
    s = batch(s, [prop(SHI, A.approve())]).state;
    expect(s.documents['doc:1']?.timing).toEqual({ mode: 'delay', notBeforeRound: 3 });
    const tryAt = (state: typeof s) => {
      const d = prop(SHI, A.dispatch());
      return outcomeOf(batch(state, [d], { decisions: [decide(d, 'dispatch_request')] }), d);
    };
    expect(tryAt(s)).toMatchObject({ rule: 'H11' });
    s = nextRound(s);
    expect(tryAt(s)).toMatchObject({ rule: 'H11' });
    s = nextRound(s);
    expect(s.round).toBe(3);
    expect(tryAt(s).status).toBe('committed');
  });

  it('rejects a delay outside 1–3 rounds (H01) and timing changes after sending (H11)', () => {
    const bad = prop('player', A.timing('delay', 4));
    expect(outcomeOf(batch(initial(), [bad], { kind: 'player' }), bad)).toMatchObject({ rule: 'H01' });
    const afterSend = prop('player', A.timing('hold'));
    expect(outcomeOf(batch(dispatched(), [afterSend], { kind: 'player' }), afterSend)).toMatchObject({ rule: 'H11' });
  });
});

describe('secret clauses in documents', () => {
  it('an editor who does not know a clause cannot remove it, and cannot reference it', () => {
    const s = caseInitialState(fixture(), 'FX3');
    const revise = prop('player', A.revise(1, T({ vassal: true, filial: true, immediate_silk: 40000, aid_cavalry: 30000, aid_arrival_days: 20 })));
    const r = batch(s, [revise], { kind: 'player' });
    expect(outcomeOf(r, revise).status).toBe('committed');
    expect(r.state.documents['doc:1']?.terms.secret_clauses.map((c) => c.id)).toEqual(['sc_private_tribute']);
    expect(r.state.documents['doc:1']?.terms.immediate_silk).toBe(40000);

    const liu = prop(LIU, A.suggest('document', 'doc:1', { secret_clauses: ['sc_private_tribute'] }));
    expect(outcomeOf(batch(s, [liu]), liu)).toMatchObject({ status: 'rejected', rule: 'H08' });
    const sang = prop(SANG, A.revise(1, T({ vassal: true, immediate_silk: 50000, aid_cavalry: 30000, aid_arrival_days: 20 })));
    const r2 = batch(s, [sang]);
    expect(r2.state.documents['doc:1']?.terms.secret_clauses).toEqual([]); // Sang knows it and removed it
  });
});
