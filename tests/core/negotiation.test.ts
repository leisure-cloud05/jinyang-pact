import { describe, expect, it } from 'vitest';
import { GENERIC_FEEDBACK } from '../../src/core/feedback.js';
import { believedOfferStatus, believedThreadStatus, hasReceiptEvidence } from '../../src/core/knowledge.js';
import { negotiationStatus } from '../../src/core/negotiation.js';
import { deadlockOptions, exhaustionCheckpoint } from '../../src/core/pauses.js';
import { planPauses } from '../../src/core/plan.js';
import { runPrepare } from '../../src/core/system.js';
import type { WorldState } from '../../src/core/types.js';
import {
  A,
  DOC_TERMS,
  LI,
  SHI,
  T,
  YELU,
  advance,
  batch,
  config,
  decide,
  delivered,
  dispatched,
  initial,
  mutate,
  nextRound,
  outcomeOf,
  prepare,
  prop,
} from './helpers.js';

const PAIR = 'hedong-khitan' as const;

describe('dispatch → delivery → confirmation', () => {
  it('opens a thread, delivers at arrivalDay, confirms, and concludes when Shi learns', () => {
    const s1 = dispatched();
    expect(s1.commitments['cmt:1']).toMatchObject({ status: 'negotiating', liveOfferId: 'offer:1', pair: PAIR, parties: [SHI, YELU] });
    expect(s1.offers['offer:1']).toMatchObject({ status: 'in_transit', from: SHI, to: YELU, sentDay: 0, arrivalDay: 5, termsVersion: 1 });
    expect(s1.negotiation[PAIR]).toMatchObject({ segment: 1, segmentOpenedBy: 'first_offer', roundsInSegment: 0, offersTotal: 1 });
    expect(hasReceiptEvidence(s1, YELU, 'offer:1', 1)).toBe(false);

    const early = prop(YELU, A.confirm('cmt:1', 'offer:1', 1));
    const tooEarly = batch(s1, [early]);
    expect(outcomeOf(tooEarly, early)).toMatchObject({ status: 'rejected', rule: 'H08', feedback: GENERIC_FEEDBACK });

    const s2 = nextRound(s1);
    expect(s2.day).toBe(5);
    expect(s2.offers['offer:1']?.status).toBe('delivered');
    expect(hasReceiptEvidence(s2, YELU, 'offer:1', 1)).toBe(true);

    const confirm = prop(YELU, A.confirm('cmt:1', 'offer:1', 1));
    const r = batch(s2, [confirm]);
    expect(outcomeOf(r, confirm).status).toBe('committed');
    expect(r.state.commitments['cmt:1']).toMatchObject({ status: 'confirmed', confirmedDay: 5 });
    expect(r.state.commitments['cmt:1']?.consents).toMatchObject({
      [SHI]: { termsVersion: 1 },
      [YELU]: { termsVersion: 1, by: YELU },
    });
    expect(r.state.terminal).toBeNull(); // Shi has no evidence yet
    expect(believedThreadStatus(r.state, SHI, 'cmt:1')).toBe('negotiating');

    const s3 = advance(r.state);
    expect(s3.terminal).toBeNull();
    const s3p = prepare(s3);
    expect(s3p.terminal).toMatchObject({ kind: 'pact_concluded', round: 3, day: 10 });
    expect(believedThreadStatus(s3p, SHI, 'cmt:1')).toBe('confirmed');
  });
});

describe('counter-offers', () => {
  it('counter / counter / confirm moves the live offer and consents to the same termsVersion', () => {
    let s = delivered();
    const yCounter = prop(YELU, A.counter('offer:1', T({ vassal: true, filial: true, immediate_silk: 50000, aid_cavalry: 30000, aid_arrival_days: 20 })));
    s = batch(s, [yCounter]).state;
    expect(s.offers['offer:1']?.status).toBe('countered');
    expect(s.offers['offer:2']).toMatchObject({ from: YELU, to: SHI, termsVersion: 2, origin: 'counter', segmentRound: 1 });
    expect(s.commitments['cmt:1']).toMatchObject({ liveOfferId: 'offer:2', termsVersion: 2 });
    expect(s.commitments['cmt:1']?.consents[SHI]?.termsVersion).toBeNull();

    s = nextRound(s);
    const sCounter = prop(SHI, A.counter('offer:2', T({ vassal: true, immediate_silk: 50000, aid_cavalry: 30000, aid_arrival_days: 20 })));
    s = batch(s, [sCounter], { decisions: [decide(sCounter, 'major_commitment')] }).state;
    expect(s.offers['offer:3']).toMatchObject({ from: SHI, termsVersion: 3, segmentRound: 2 });
    expect(s.negotiation[PAIR]).toMatchObject({ roundsInSegment: 2, offersTotal: 3, deadlockPending: true });

    s = nextRound(s);
    const confirm = prop(YELU, A.confirm('cmt:1', 'offer:3', 3));
    s = batch(s, [confirm]).state;
    expect(s.commitments['cmt:1']?.status).toBe('confirmed');
    expect(s.commitments['cmt:1']?.consents[SHI]?.termsVersion).toBe(3);
    expect(s.commitments['cmt:1']?.consents[YELU]?.termsVersion).toBe(3);
    expect(s.negotiation[PAIR].deadlockPending).toBe(false);
    s = nextRound(s);
    expect(s.terminal).toMatchObject({ kind: 'pact_concluded', round: 5 });
  });

  it('a rejection closes the thread; talks_failed at the ADVANCE of the round Shi learns it', () => {
    let s = delivered();
    s = batch(s, [prop(YELU, A.reject('offer:1'))]).state;
    expect(s.commitments['cmt:1']?.status).toBe('rejected');
    expect(s.factions.hedong.reserved.silk).toBe(0);
    s = nextRound(s);
    expect(believedThreadStatus(s, SHI, 'cmt:1')).toBe('rejected');
    expect(s.terminal).toBeNull(); // not at PREPARE: Shi may still send a new offer this round
    s = advance(s);
    expect(s.terminal).toMatchObject({ kind: 'talks_failed', round: 3 });
  });
});

describe('negotiation segments (H13 v3.4 counting)', () => {
  /** Li and Yelü co-located so offers deliver immediately. */
  const together = (): WorldState =>
    mutate(initial(), (s) => {
      s.characters.li_congke.location = 'khitan_court';
    });
  const liTerms = T({ neutrality: true, marriage_alliance: true, immediate_silk: 100000 });

  it("rejects Li's fourth successive offer after three rejections (replacement threads count as rounds)", () => {
    let s = together();
    const offers: string[] = [];
    for (let i = 0; i < 3; i++) {
      const p = prop(LI, A.propose(YELU, liTerms));
      const r = batch(s, [p]);
      expect(outcomeOf(r, p).status).toBe('committed');
      s = r.state;
      const offerId = `offer:${i + 1}`;
      offers.push(offerId);
      expect(s.offers[offerId]?.status).toBe('delivered'); // co-located: delivered at once
      s = batch(s, [prop(YELU, A.reject(offerId))]).state;
    }
    expect(offers.map((id) => s.offers[id]?.segmentRound)).toEqual([0, 1, 2]);
    expect(s.negotiation['khitan-tang']).toMatchObject({ segment: 1, segmentOpenedBy: 'first_offer', roundsInSegment: 2, offersTotal: 3 });
    const fourth = prop(LI, A.propose(YELU, liTerms));
    const r = batch(s, [fourth]);
    expect(outcomeOf(r, fourth)).toMatchObject({ status: 'rejected', rule: 'H13', code: 'segment_exhausted' });
    expect(negotiationStatus(s, config(), 'khitan-tang').onlyConfirmOrReject).toBe(true);
  });

  it('rejects any offer beyond the global cap of 5 per pair', () => {
    const s = mutate(together(), (x) => {
      x.negotiation['khitan-tang'] = { segment: 3, segmentOpenedBy: 'd9', roundsInSegment: 0, offersTotal: 5, deadlockPending: false, segmentStartOffersTotal: 5 };
    });
    const p = prop(LI, A.propose(YELU, liTerms));
    expect(outcomeOf(batch(s, [p]), p)).toMatchObject({ status: 'rejected', rule: 'H13', code: 'global_cap' });
  });
});

describe('withdrawals', () => {
  it('an offer and its withdrawal arriving the same day: delivered, then withdrawn before the recipient can act', () => {
    let s = dispatched();
    const w = prop(SHI, A.withdraw('offer:1'));
    s = batch(s, [w]).state;
    expect(s.offers['offer:1']?.withdrawal).toEqual({ messageId: 'msg:3', effectiveDay: 5 });
    expect(s.factions.hedong.reserved.silk).toBe(50000); // still held until the withdrawal takes effect

    const step = runPrepare(advance(s), config());
    s = step.state;
    expect(step.events.map((e) => e.kind)).toEqual(['message_delivered', 'message_delivered', 'withdrawal_effective']);
    expect(s.offers['offer:1']?.status).toBe('withdrawn');
    expect(s.commitments['cmt:1']?.status).toBe('withdrawn');
    expect(s.factions.hedong.reserved.silk).toBe(0);
    expect(believedOfferStatus(s, YELU, 'offer:1')).toBe('withdrawn');
    const ack = Object.values(s.messages).find((m) => m.kind === 'withdrawal_result');
    expect(ack?.payload).toMatchObject({ kind: 'withdrawal_result', effective: true, offerId: 'offer:1' });
    expect(ack).toMatchObject({ from: YELU, to: SHI, status: 'in_transit', arrivalDay: 10 });

    const confirm = prop(YELU, A.confirm('cmt:1', 'offer:1', 1));
    const r = batch(s, [confirm]);
    expect(outcomeOf(r, confirm)).toMatchObject({ status: 'rejected', rule: 'H04' });
    expect(outcomeOf(r, confirm).feedback).not.toBe(GENERIC_FEEDBACK); // Yelü knows it was withdrawn

    s = nextRound(s);
    expect(believedThreadStatus(s, SHI, 'cmt:1')).toBe('withdrawn');
    expect(s.terminal).toBeNull();
    expect(advance(s).terminal).toMatchObject({ kind: 'talks_failed', round: 3 });
  });

  it('a withdrawal arriving after the answer is void; the pact stands and a late result is sent back', () => {
    let s = delivered();
    const w = prop(SHI, A.withdraw('offer:1'));
    const c = prop(YELU, A.confirm('cmt:1', 'offer:1', 1));
    const r = batch(s, [c, w]); // commit order puts Shi (priority 1) first anyway
    expect(outcomeOf(r, w).status).toBe('committed');
    expect(outcomeOf(r, c).status).toBe('committed');
    s = r.state;
    const step = runPrepare(advance(s), config());
    expect(step.events.map((e) => e.kind)).toEqual(['withdrawal_late', 'message_delivered', 'terminal']);
    s = step.state;
    expect(s.commitments['cmt:1']?.status).toBe('confirmed');
    expect(s.terminal?.kind).toBe('pact_concluded');
    const ack = Object.values(s.messages).find((m) => m.kind === 'withdrawal_result');
    expect(ack?.payload).toMatchObject({ effective: false });
  });

  it('rejects duplicate withdrawals, withdrawals by non-senders and withdrawals of answered offers', () => {
    let s = dispatched();
    s = batch(s, [prop(SHI, A.withdraw('offer:1'))]).state;
    const again = prop(SHI, A.withdraw('offer:1'));
    expect(outcomeOf(batch(s, [again]), again)).toMatchObject({ status: 'rejected', rule: 'H12' });

    let t = delivered();
    const byYelu = prop(YELU, A.withdraw('offer:1'));
    expect(outcomeOf(batch(t, [byYelu]), byYelu)).toMatchObject({ status: 'rejected', rule: 'H02' });
    t = nextRound(batch(t, [prop(YELU, A.reject('offer:1'))]).state);
    const late = prop(SHI, A.withdraw('offer:1'));
    expect(outcomeOf(batch(t, [late]), late)).toMatchObject({ status: 'rejected', rule: 'H04' });
  });
});

describe('no resurrection of answered or withdrawn offers', () => {
  it('a countered offer can never be confirmed', () => {
    let s = delivered();
    s = batch(s, [prop(YELU, A.counter('offer:1', DOC_TERMS))]).state;
    const old = prop(YELU, A.confirm('cmt:1', 'offer:1', 1));
    expect(outcomeOf(batch(s, [old]), old)).toMatchObject({ status: 'rejected', rule: 'H12' });
    const again = prop(YELU, A.reject('offer:1'));
    expect(outcomeOf(batch(s, [again]), again)).toMatchObject({ status: 'rejected', rule: 'H12' });
  });
});

describe('exhaustion checkpoint and deadlock control pause', () => {
  const terms = (extra: Partial<Parameters<typeof T>[0]> = {}) =>
    T({ vassal: true, immediate_silk: 50000, aid_cavalry: 30000, aid_arrival_days: 20, ...extra });

  /** Yelü opens, Shi counters (round 1), Yelü counters (round 2): in round 4 the live offer awaits Shi. */
  function awaitingShi(): WorldState {
    let s = initial();
    s = batch(s, [prop(YELU, A.propose(SHI, terms({ filial: true })))]).state;
    s = nextRound(s);
    const c1 = prop(SHI, A.counter('offer:1', terms()));
    s = batch(s, [c1], { decisions: [decide(c1, 'major_commitment')] }).state;
    s = nextRound(s);
    s = batch(s, [prop(YELU, A.counter('offer:2', terms({ cession: 'yanmen_north' })))]).state;
    return nextRound(s);
  }

  it('raises the control pause when the exhausted segment leaves Shi to move, unless he confirms', () => {
    const s = awaitingShi();
    expect(s.negotiation[PAIR]).toMatchObject({ roundsInSegment: 2, deadlockPending: true });
    const wait = prop(SHI, A.wait());
    const plan = planPauses(s, { kind: 'character', proposals: [wait], decisions: [] }, { config: config(), mode: 'full' });
    expect(plan.required).toHaveLength(1);
    expect(plan.required[0]).toMatchObject({ kind: 'control', category: 'negotiation_deadlock', pair: PAIR });
    expect(plan.required[0]?.checkpoint?.reason).toBe('live_offer_awaits');

    const confirm = prop(SHI, A.confirm('cmt:1', 'offer:3', 3));
    const plan2 = planPauses(s, { kind: 'character', proposals: [confirm], decisions: [] }, { config: config(), mode: 'full' });
    expect(plan2.required.map((r) => r.category)).toEqual(['major_commitment']);

    const baseline = planPauses(s, { kind: 'character', proposals: [wait], decisions: [] }, { config: config(), mode: 'baseline' });
    expect(baseline.required).toEqual([]);
  });

  it('an over-segment counter by Shi is rejected (H13) and raises the same control pause', () => {
    const s = awaitingShi();
    const over = prop(SHI, A.counter('offer:3', terms()));
    const plan = planPauses(s, { kind: 'character', proposals: [over], decisions: [] }, { config: config(), mode: 'full' });
    expect(plan.rejected).toEqual([{ proposalId: over.proposalId, rule: 'H13' }]);
    const control = plan.required.find((r) => r.category === 'negotiation_deadlock');
    expect(control?.proposalIds).toContain(over.proposalId);
    expect(control?.checkpoint?.reason).toBe('over_segment_attempt');
  });

  it('no pause while the counterparty is to move', () => {
    let s = delivered();
    s = batch(s, [prop(YELU, A.counter('offer:1', DOC_TERMS))]).state;
    s = nextRound(s);
    const c = prop(SHI, A.counter('offer:2', DOC_TERMS));
    s = batch(s, [c], { decisions: [decide(c, 'major_commitment')] }).state;
    expect(s.negotiation[PAIR].deadlockPending).toBe(true);
    s = nextRound(s);
    expect(exhaustionCheckpoint(s, config(), [{ actor: SHI, action: A.wait() }], false)).toBeNull();
  });

  it('adjust_goal opens a new segment recorded with the decision id; the next offer is its opening offer', () => {
    let s = awaitingShi();
    const resolution = batch(s, [], {
      kind: 'player',
      decisions: [
        {
          decisionId: 'dec-7',
          category: 'negotiation_deadlock',
          option: 'adjust_goal',
          proposalIds: [],
          pair: PAIR,
          goalLimits: { ...s.player.goal.limits, burden_max: 200 },
        },
      ],
    });
    expect(resolution.events.map((e) => e.kind)).toEqual(['goal_adjusted', 'deadlock_resolved']);
    const reset = resolution.events[1]!;
    expect(reset.decisionId).toBe('dec-7'); // the control id stays in the event log
    s = resolution.state;
    expect(s.player.goal.limits.burden_max).toBe(200);
    expect(s.negotiation[PAIR]).toMatchObject({ segment: 2, segmentOpenedBy: `event:${reset.version}`, roundsInSegment: 0, deadlockPending: false, segmentStartOffersTotal: 3 });
    expect(JSON.stringify(s)).not.toContain('dec-7'); // never in world state
    expect(exhaustionCheckpoint(s, config(), [], false)).toBeNull();

    const counter = prop(SHI, A.counter('offer:3', terms({ annual_silk: 100000 })));
    s = batch(s, [counter], { decisions: [decide(counter, 'major_commitment')] }).state;
    expect(s.offers['offer:4']).toMatchObject({ segment: 2, segmentRound: 0 });
    expect(s.negotiation[PAIR]).toMatchObject({ roundsInSegment: 0, offersTotal: 4 });
  });

  it('at the global cap no new segment opens and only urge_accept / urge_stop / ask are offered', () => {
    const s = mutate(awaitingShi(), (x) => {
      x.negotiation[PAIR].offersTotal = 5;
    });
    expect(deadlockOptions(s, config(), PAIR)).toEqual(['urge_accept', 'urge_stop', 'ask']);
    expect(deadlockOptions(awaitingShi(), config(), PAIR)).toEqual(['adjust_goal', 'urge_accept', 'urge_stop', 'ask']);
    const r = batch(s, [], {
      kind: 'player',
      decisions: [{ decisionId: 'dec-8', category: 'negotiation_deadlock', option: 'urge_stop', proposalIds: [], pair: PAIR }],
    });
    expect(r.state.negotiation[PAIR]).toMatchObject({ segment: 1, deadlockPending: false, offersTotal: 5 });
    expect(r.events[0]?.facts[0]?.data).toMatchObject({ segmentOpened: false });
  });

  it('Shi learning of a rejection after exhaustion triggers the checkpoint (closure_learned)', () => {
    let s = delivered();
    s = batch(s, [prop(YELU, A.counter('offer:1', DOC_TERMS))]).state;
    s = nextRound(s);
    const c = prop(SHI, A.counter('offer:2', DOC_TERMS));
    s = batch(s, [c], { decisions: [decide(c, 'major_commitment')] }).state;
    s = nextRound(s);
    s = batch(s, [prop(YELU, A.reject('offer:3'))]).state;
    expect(exhaustionCheckpoint(s, config(), [], false)).toBeNull(); // Shi does not know yet
    s = nextRound(s);
    expect(exhaustionCheckpoint(s, config(), [], false)).toMatchObject({ reason: 'closure_learned', commitmentId: 'cmt:1' });
  });
});
