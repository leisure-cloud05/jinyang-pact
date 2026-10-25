import { describe, expect, it } from 'vitest';
import { deriveObligations, poolClaims } from '../../src/core/obligations.js';
import { expandTermArgs } from '../../src/core/terms.js';
import {
  A,
  DOC_TERMS,
  LI,
  SANG,
  SHI,
  T,
  YELU,
  batch,
  decide,
  delivered,
  dispatched,
  initial,
  nextRound,
  outcomeOf,
  prop,
} from './helpers.js';

const liBid = T({ neutrality: true, marriage_alliance: true, immediate_silk: 100000 });

describe('obligations', () => {
  it('derives payer, trigger, resource and exclusivity per pair', () => {
    const expanded = expandTermArgs(T({ vassal: true, immediate_silk: 50000, aid_cavalry: 30000, aid_arrival_days: 20, annual_silk: 100000 }), () => null);
    if (!expanded.ok) throw new Error('expand failed');
    const obligations = deriveObligations(expanded.terms, 'hedong-khitan');
    expect(obligations.map((o) => [o.key, o.payer, o.trigger, o.resource, o.amount, o.exclusivityKey])).toEqual([
      ['vassal', 'hedong', 'standing', null, null, null],
      ['annual_silk', 'hedong', 'annual_after_confirm', 'silk', 100000, null],
      ['immediate_silk', 'hedong', 'on_confirm', 'silk', 50000, null],
      ['aid_cavalry', 'khitan', 'on_confirm', 'cavalry', 30000, 'khitan_stance'],
    ]);
    const tang = expandTermArgs(liBid, () => null);
    if (!tang.ok) throw new Error('expand failed');
    expect(deriveObligations(tang.terms, 'khitan-tang').map((o) => [o.key, o.payer, o.exclusivityKey])).toEqual([
      ['immediate_silk', 'tang', null],
      ['neutrality', 'khitan', 'khitan_stance'],
      ['marriage_alliance', 'tang', null],
    ]);
  });
});

describe('reservations (§4.2)', () => {
  it('consent holds, counter moves, confirm debits atomically', () => {
    const s1 = dispatched();
    expect(s1.factions.hedong.reserved.silk).toBe(50000);
    expect(s1.factions.hedong.resources.silk).toBe(120000);
    expect(Object.values(s1.reservations).map((r) => [r.faction, r.resource, r.amount, r.status])).toEqual([['hedong', 'silk', 50000, 'held']]);

    let s = nextRound(s1);
    s = batch(s, [prop(YELU, A.counter('offer:1', T({ vassal: true, filial: true, immediate_silk: 60000, aid_cavalry: 40000, aid_arrival_days: 15 })))]).state;
    expect(s.factions.hedong.reserved.silk).toBe(0);
    expect(s.factions.khitan.reserved.cavalry).toBe(40000);

    s = nextRound(s);
    const confirm = prop(SHI, A.confirm('cmt:1', 'offer:2', 2));
    s = batch(s, [confirm], { decisions: [decide(confirm, 'major_commitment')] }).state;
    expect(s.factions.hedong.resources.silk).toBe(60000);
    expect(s.factions.hedong.reserved.silk).toBe(0);
    expect(s.factions.khitan.resources.cavalry).toBe(10000);
    expect(s.factions.khitan.reserved.cavalry).toBe(0);
    expect(Object.values(s.reservations).filter((r) => r.status === 'debited').map((r) => r.obligationKey).sort()).toEqual(['aid_cavalry', 'immediate_silk']);
    expect(s.commitments['cmt:1']?.obligations.map((o) => o.key)).toEqual(['vassal', 'filial', 'immediate_silk', 'aid_cavalry']);
    expect(s.flags.khitanArrivalDay).toBe(10 + 15); // G09
  });

  it('rejection releases every reservation of the thread', () => {
    let s = delivered();
    s = batch(s, [prop(YELU, A.reject('offer:1'))]).state;
    expect(Object.values(s.reservations).every((r) => r.status === 'released')).toBe(true);
    expect(s.factions.hedong.reserved.silk).toBe(0);
  });

  it('an overdraft gift is rejected at dispatch (H07)', () => {
    let s = batch(initial(), [prop(SANG, A.revise(1, { ...DOC_TERMS, immediate_silk: 200000 }))]).state;
    s = batch(s, [prop(SHI, A.approve(2))]).state;
    const d = prop(SHI, A.dispatch(2));
    const r = batch(s, [d], { decisions: [decide(d, 'dispatch_request')] });
    expect(outcomeOf(r, d)).toMatchObject({ status: 'rejected', rule: 'H07' });
    expect(outcomeOf(r, d).reason).toContain('hedong lacks silk');
  });
});

describe('khitan_stance exclusivity', () => {
  /** R1: Shi dispatches, Li bids neutrality; R2: offer:1 at Yelü; R3: Li's bid (10 days) at Yelü. */
  function bothPending() {
    let s = dispatched();
    s = batch(s, [prop(LI, A.propose(YELU, liBid))]).state;
    s = nextRound(s);
    return s;
  }

  it('Yelü cannot hold aid-to-hedong and neutrality-to-tang at the same time', () => {
    let s = bothPending();
    // R2: Yelü counters Shi and keeps aid (claims the pool).
    s = batch(s, [prop(YELU, A.counter('offer:1', T({ vassal: true, filial: true, immediate_silk: 50000, aid_cavalry: 30000, aid_arrival_days: 20 })))]).state;
    expect(poolClaims(s, 'khitan_stance').map((r) => [r.commitmentId, r.status])).toEqual([['cmt:1', 'held']]);
    s = nextRound(s); // R3: Li's bid delivered to Yelü
    const neutral = prop(YELU, A.confirm('cmt:2', 'offer:2', 1));
    const r = batch(s, [neutral]);
    expect(outcomeOf(r, neutral)).toMatchObject({ status: 'rejected', rule: 'H07' });
    expect(outcomeOf(r, neutral).reason).toContain('khitan_stance');
  });

  it('once neutrality is confirmed, aid to Hedong can no longer be confirmed', () => {
    let s = bothPending();
    s = nextRound(s); // R3: both offers delivered to Yelü
    const neutral = prop(YELU, A.confirm('cmt:2', 'offer:2', 1));
    const aid = prop(YELU, A.confirm('cmt:1', 'offer:1', 1));
    const r = batch(s, [neutral, aid]);
    expect(outcomeOf(r, neutral).status).toBe('committed');
    expect(outcomeOf(r, aid)).toMatchObject({ status: 'rejected', rule: 'H07' });
    expect(r.state.factions.tang.resources.silk).toBe(100000);
  });
});
