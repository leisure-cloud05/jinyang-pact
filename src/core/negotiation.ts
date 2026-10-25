/**
 * Negotiation segments and pair bookkeeping (PLAN v3.4 §4.1, H13, G10).
 *
 * Per principal pair the world keeps `negotiation[pair] = {segment, segmentOpenedBy, roundsInSegment, offersTotal,
 * deadlockPending, segmentStartOffersTotal}`:
 * - every committed offer (dispatch, propose_terms, counter) increments `offersTotal`;
 * - it increments `roundsInSegment` unless it is the segment's opening offer — the pair's first offer ever (which
 *   opens segment 1, `segmentOpenedBy = 'first_offer'`) or the first offer after a qualifying reset. Replacement
 *   threads after a rejection/withdrawal therefore count as rounds;
 * - a new segment opens only through a resolved `negotiation_deadlock` decision (adjust_goal / urge_accept /
 *   urge_stop), recorded as `segmentOpenedBy = event:N`, unless the global cap is reached (`openNewSegmentEffect`);
 * - H13: `roundsInSegment ≤ segment_round_cap` (2) and `offersTotal ≤ pair_offer_cap` (5);
 * - `deadlockPending` is set when an offer uses the segment's last round and cleared by agreement (confirmation)
 *   or by a qualifying deadlock decision.
 */
import type { Draft } from './reducer.js';
import { compareIds, own } from './ids.js';
import { pairOf } from './terms.js';
import {
  PAIR_IDS,
  type CharId,
  type Commitment,
  type CoreConfig,
  type Document,
  type NegotiationState,
  type Offer,
  type PairId,
  type WorldState,
} from './types.js';

export function initialNegotiation(): Record<PairId, NegotiationState> {
  const out = {} as Record<PairId, NegotiationState>;
  for (const pair of PAIR_IDS) {
    out[pair] = {
      segment: 0,
      segmentOpenedBy: null,
      roundsInSegment: 0,
      offersTotal: 0,
      deadlockPending: false,
      segmentStartOffersTotal: 0,
    };
  }
  return out;
}

/** The consenting sender of a dispatched document: the principal of the holder's faction (Shi for doc:1). */
export function documentSender(state: WorldState, config: CoreConfig, doc: Document): CharId {
  return config.factions[state.characters[doc.holder].faction].principal;
}

export function documentPair(state: WorldState, config: CoreConfig, doc: Document): PairId | null {
  const sender = documentSender(state, config, doc);
  return pairOf(state.characters[sender].faction, state.characters[doc.to].faction);
}

/** True if the pair's next offer would be the opening offer of its (current or first) segment. */
export function nextOfferIsOpening(n: NegotiationState): boolean {
  return n.segment === 0 || n.offersTotal === n.segmentStartOffersTotal;
}

export type OfferCapCheck = { ok: true; round: number } | { ok: false; kind: 'global_cap' | 'segment'; reason: string };

/** H13 for one more offer of the pair. `round` is the segment round the offer would consume (0 = opening). */
export function checkOfferCap(state: WorldState, config: CoreConfig, pair: PairId): OfferCapCheck {
  const n = state.negotiation[pair];
  const p = config.params;
  if (n.offersTotal >= p.pair_offer_cap) {
    return { ok: false, kind: 'global_cap', reason: `${pair} already has ${n.offersTotal} offers (cap ${p.pair_offer_cap})` };
  }
  if (nextOfferIsOpening(n)) return { ok: true, round: 0 };
  if (n.roundsInSegment >= p.segment_round_cap) {
    return {
      ok: false,
      kind: 'segment',
      reason: `negotiation segment ${n.segment} of ${pair} has used its ${p.segment_round_cap} rounds; only confirm or reject remain`,
    };
  }
  return { ok: true, round: n.roundsInSegment + 1 };
}

export interface NegotiationStatus {
  pair: PairId;
  segment: number;
  roundsInSegment: number;
  roundsRemaining: number;
  offersTotal: number;
  offersRemaining: number;
  deadlockPending: boolean;
  /** Only confirm/reject remain for the live offer (segment exhausted or global cap reached). */
  onlyConfirmOrReject: boolean;
  globalCapReached: boolean;
}

export function negotiationStatus(state: WorldState, config: CoreConfig, pair: PairId): NegotiationStatus {
  const n = state.negotiation[pair];
  const opening = nextOfferIsOpening(n);
  const roundsRemaining = opening ? config.params.segment_round_cap : Math.max(0, config.params.segment_round_cap - n.roundsInSegment);
  const offersRemaining = Math.max(0, config.params.pair_offer_cap - n.offersTotal);
  return {
    pair,
    segment: n.segment,
    roundsInSegment: n.roundsInSegment,
    roundsRemaining,
    offersTotal: n.offersTotal,
    offersRemaining,
    deadlockPending: n.deadlockPending,
    onlyConfirmOrReject: offersRemaining === 0 || (!opening && roundsRemaining === 0),
    globalCapReached: offersRemaining === 0,
  };
}

export function commitmentsOfPair(state: WorldState, pair: PairId): Commitment[] {
  return Object.keys(state.commitments)
    .sort(compareIds)
    .map((id) => own(state.commitments, id) as Commitment)
    .filter((c) => c.pair === pair);
}

export function negotiatingThread(state: WorldState, pair: PairId): Commitment | null {
  return commitmentsOfPair(state, pair).find((c) => c.status === 'negotiating') ?? null;
}

export function latestThread(state: WorldState, pair: PairId): Commitment | null {
  const threads = commitmentsOfPair(state, pair);
  return threads[threads.length - 1] ?? null;
}

export function offersOfPair(state: WorldState, pair: PairId): Offer[] {
  return Object.keys(state.offers)
    .sort(compareIds)
    .map((id) => own(state.offers, id) as Offer)
    .filter((o) => own(state.commitments, o.commitmentId)?.pair === pair);
}

// ---------------------------------------------------------------------------------------------------------------
// Draft mutations
// ---------------------------------------------------------------------------------------------------------------

/** Records a committed offer of the pair; returns its bookkeeping (no cap check: validation precedes it). */
export function recordOffer(d: Draft, pair: PairId): { pairSeq: number; segment: number; segmentRound: number } {
  const n = d.s.negotiation[pair];
  let next: NegotiationState;
  let segmentRound: number;
  if (n.segment === 0) {
    next = { ...n, segment: 1, segmentOpenedBy: 'first_offer', segmentStartOffersTotal: 0, roundsInSegment: 0 };
    segmentRound = 0;
  } else if (n.offersTotal === n.segmentStartOffersTotal) {
    next = { ...n };
    segmentRound = 0;
  } else {
    next = { ...n, roundsInSegment: n.roundsInSegment + 1 };
    segmentRound = next.roundsInSegment;
  }
  next.offersTotal = n.offersTotal + 1;
  d.set(['negotiation', pair], next);
  d.rule('H13', 'G10');
  return { pairSeq: next.offersTotal, segment: next.segment, segmentRound };
}

/** Sets `deadlockPending` once an offer has used the segment's last round (called after `recordOffer`). */
export function markDeadlockIfExhausted(d: Draft, pair: PairId, roundCap: number): void {
  const n = d.s.negotiation[pair];
  if (n.roundsInSegment >= roundCap && !n.deadlockPending) d.set(['negotiation', pair, 'deadlockPending'], true);
}

/** Agreement clears a pending deadlock. */
export function clearDeadlock(d: Draft, pair: PairId): void {
  if (d.s.negotiation[pair].deadlockPending) d.set(['negotiation', pair, 'deadlockPending'], false);
}

/**
 * World effect of a resolved qualifying `negotiation_deadlock` decision: opens a new segment recorded as
 * `event:N` (this reset event), unless the global cap is reached (then only the pending deadlock is cleared).
 * Returns whether a segment was opened.
 */
export function openNewSegment(d: Draft, config: CoreConfig, pair: PairId): boolean {
  const n = d.s.negotiation[pair];
  if (n.offersTotal >= config.params.pair_offer_cap) {
    d.set(['negotiation', pair], { ...n, deadlockPending: false });
    return false;
  }
  d.set(['negotiation', pair], {
    ...n,
    segment: n.segment + 1,
    segmentOpenedBy: `event:${d.eventId}`,
    roundsInSegment: 0,
    deadlockPending: false,
    segmentStartOffersTotal: n.offersTotal,
  } satisfies NegotiationState);
  return true;
}
