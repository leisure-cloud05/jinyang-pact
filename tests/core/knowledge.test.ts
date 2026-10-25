import { describe, expect, it } from 'vitest';
import { caseInitialState } from '../../src/content/loader.js';
import { GENERIC_FEEDBACK } from '../../src/core/feedback.js';
import {
  believedOfferStatus,
  clauseHolders,
  currentBeliefs,
  filterTermsFor,
  hasReceiptEvidence,
  knowsClause,
  latestBelief,
  playerView,
} from '../../src/core/knowledge.js';
import {
  A,
  DOC_TERMS,
  LIU,
  SANG,
  SHI,
  T,
  YELU,
  batch,
  config,
  decide,
  dispatched,
  endorsed,
  fixture,
  initial,
  nextRound,
  outcomeOf,
  prop,
} from './helpers.js';

describe('nothing is known before arrivalDay', () => {
  it('the recipient has no assertion while the offer is in transit; delivery creates the snapshot', () => {
    const s1 = dispatched();
    expect(Object.values(s1.knowledge).some((k) => k.holder === YELU && k.subject === 'offer:1')).toBe(false);
    expect(believedOfferStatus(s1, SHI, 'offer:1')).toBe('sent');
    const s2 = nextRound(s1);
    const receipt = latestBelief(s2, YELU, 'offer:1', 'terms');
    expect(receipt).toMatchObject({ asOfDay: 5, evidence: { kind: 'message', ref: 'msg:1' } });
    expect(hasReceiptEvidence(s2, YELU, 'offer:1', 1)).toBe(true);
    expect((receipt?.value as { terms: { immediate_silk: number } }).terms.immediate_silk).toBe(50000);
  });

  it('assertions are immutable snapshots: later world changes do not rewrite them', () => {
    let s = nextRound(dispatched());
    s = batch(s, [prop(YELU, A.reject('offer:1'))]).state;
    // Yelü's receipt still says what he received; his *own* status belief was updated by his action.
    expect(believedOfferStatus(s, YELU, 'offer:1')).toBe('rejected');
    expect(latestBelief(s, YELU, 'offer:1', 'terms')?.value).toMatchObject({ termsVersion: 1 });
    // Shi still believes it was merely sent until the response arrives.
    expect(believedOfferStatus(s, SHI, 'offer:1')).toBe('sent');
  });
});

describe('feedback redaction (§8.6)', () => {
  it('a failure caused by a thread the actor does not know about gets generic feedback', () => {
    // Yelü opens a thread to Shi (in transit). Shi, unaware, proposes to Yelü in the same round.
    let s = initial();
    s = batch(s, [prop(YELU, A.propose(SHI, T({ vassal: true, filial: true, aid_cavalry: 20000, aid_arrival_days: 20 })))]).state;
    const shi = prop(SHI, A.propose(YELU, DOC_TERMS));
    const out = outcomeOf(batch(s, [shi], { decisions: [decide(shi, 'major_commitment')] }), shi);
    expect(out).toMatchObject({ status: 'rejected', rule: 'H04', feedback: GENERIC_FEEDBACK });
    expect(out.reason).toContain('cmt:1');
  });

  it('the same failure is explained when the actor knows the fact', () => {
    const s = dispatched();
    const shi = prop(SHI, A.propose(YELU, DOC_TERMS));
    const out = outcomeOf(batch(s, [shi], { decisions: [decide(shi, 'major_commitment')] }), shi);
    expect(out.rule).toBe('H04');
    expect(out.feedback).not.toBe(GENERIC_FEEDBACK);
    expect(out.feedback).toContain('already has a negotiating thread');
  });

  it('answering an offer before it arrives is rejected without revealing it', () => {
    const s = dispatched();
    const early = prop(YELU, A.counter('offer:1', DOC_TERMS));
    const out = outcomeOf(batch(s, [early]), early);
    expect(out).toMatchObject({ rule: 'H08', feedback: GENERIC_FEEDBACK });
    expect(out.reason).toContain('nothing is known before arrival');
  });
});

describe('observation and correspondence access', () => {
  it("co-located readers observe Shi's correspondence with secret clauses they do not know removed", () => {
    let s = caseInitialState(fixture(), 'FX3');
    s = endorsed(s, [prop(SHI, A.approve()), prop(SHI, A.dispatch())]).state;
    s = nextRound(s);
    s = batch(s, [prop(YELU, A.counter('offer:1', T({ vassal: true, filial: true, cession: 'yanmen_north', immediate_silk: 50000, aid_cavalry: 30000, aid_arrival_days: 20, secret_clauses: ['sc_private_tribute'] })))]).state;
    s = nextRound(s);
    for (const holder of [SHI, SANG, LIU, 'player'] as const) {
      expect(latestBelief(s, holder, 'offer:2', 'terms')).not.toBeNull();
    }
    const view = (holder: string) => JSON.stringify(latestBelief(s, holder as typeof SHI, 'offer:2', 'terms')?.value);
    expect(view(SHI)).toContain('JYP-CANARY-7F3A');
    expect(view(SANG)).toContain('JYP-CANARY-7F3A');
    expect(view(LIU)).not.toContain('JYP-CANARY-7F3A');
    expect(view('player')).not.toContain('JYP-CANARY-7F3A');
    expect(latestBelief(s, LIU, 'offer:2', 'terms')?.evidence.kind).toBe('observation');
    expect(clauseHolders(s, config(), 'sc_private_tribute').sort()).toEqual([SANG, SHI, YELU].sort());
    expect(knowsClause(s, config(), 'li_congke', 'sc_private_tribute')).toBe(false);
    const doc = s.documents['doc:1'];
    if (!doc) throw new Error('doc missing');
    expect(filterTermsFor(s, config(), LIU, doc.terms).secret_clauses).toEqual([]);
  });

  it('the player view shows only player-visible facts', () => {
    const s = caseInitialState(fixture(), 'FX3');
    const view = playerView(s, config());
    expect(view.documents).toHaveLength(1);
    expect(JSON.stringify(view)).not.toContain('JYP-CANARY');
    expect(view.resources.resources.grain).toBe(40);
    expect(view.beliefs.every((b) => b.holder === 'player')).toBe(true);
    expect(currentBeliefs(s, 'player').length).toBe(view.beliefs.length);
  });

  it('delivered letters and intel are claims with their credibility', () => {
    let s = dispatched(); // G08: intel to Li arrives day 5
    s = batch(s, [prop('li_congke', A.letter(SHI, 'Surrender.'))]).state;
    s = nextRound(s);
    const intel = Object.values(s.knowledge).find((k) => k.holder === 'li_congke' && k.predicate === 'claim' && k.evidence.kind === 'message');
    expect(intel).toMatchObject({ credibility: 0.6 });
    expect(JSON.stringify(intel?.value)).not.toContain('50000'); // no content of the request
    const letter = Object.values(s.knowledge).find((k) => k.holder === SHI && k.predicate === 'claim' && k.evidence.kind === 'message');
    expect(letter).toMatchObject({ credibility: 0.5, value: { from: 'li_congke', text: 'Surrender.' } });
  });
});
