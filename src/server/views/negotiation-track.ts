/**
 * Negotiation track (play UI): the assistance negotiation as the clerk knows it, laid out on the road between
 * Jinyang and the far court. Only the clerk's own assertions (what it was told, and on which day) and public facts
 * (courier days, the round cap) go in: a letter still believed sent is placed by its schedule — the clerk cannot see
 * it delivered — and a reply appears once it has reached headquarters.
 */
import { knowledgeOf, latestBelief, withdrawalBelief } from '../../core/knowledge.js';
import { otherFaction } from '../../core/terms.js';
import { ASSISTANCE_PAIR, BESIEGED_FACTION, type CharId } from '../../core/types.js';
import type { NegotiationTrackView, OfferCardView, OfferKnown, OfferStage, TrackEndView } from '../api-types.js';
import type { SessionCtx } from '../context.js';
import { nameOf, placeOf, termsFor } from './common.js';

/** The clerk's belief decides the stage; a letter still believed sent is on the road until its due day. */
export function offerStage(direction: 'out' | 'in', believed: string | null, day: number, dueDay: number | null): OfferStage {
  switch (believed) {
    case 'countered':
      return 'countered';
    case 'accepted':
      return 'confirmed';
    case 'rejected':
      return 'rejected';
    case 'withdrawn':
      return 'withdrawn';
    default:
      if (direction === 'in') return 'received';
      return dueDay !== null && day < dueDay ? 'proposed' : 'awaiting';
  }
}

/** 0 at Jinyang, 1 at the far court: a letter on the road moves by its schedule; an answered one stays where it was answered. */
export function offerPosition(direction: 'out' | 'in', stage: OfferStage, day: number, sinceDay: number, travelDays: number): number {
  if (direction === 'in') return 0;
  if (stage !== 'proposed') return 1;
  return travelDays > 0 ? Math.min(1, Math.max(0, (day - sinceDay) / travelDays)) : 1;
}

function trackEnd(ctx: SessionCtx, charId: CharId): TrackEndView {
  return { charId, name: nameOf(ctx.names, charId), place: placeOf(ctx.names, ctx.state.characters[charId].location) };
}

/** `offers`: the clerk's known offers of the assistance pair (`world.negotiation.offers`). */
export function negotiationTrack(ctx: SessionCtx, offers: readonly OfferKnown[]): NegotiationTrackView {
  const { state, config } = ctx;
  const near = config.factions[BESIEGED_FACTION].principal;
  const far = config.factions[otherFaction(ASSISTANCE_PAIR, BESIEGED_FACTION)].principal;
  const travelDays = config.travel[state.characters[near].location][state.characters[far].location];
  const notes = knowledgeOf(state, 'player');
  const cards = offers.map((o): OfferCardView => {
    const direction = o.from === far ? 'in' : 'out';
    const sinceDay = Math.min(state.day, ...notes.filter((k) => k.subject === o.offerId).map((k) => k.asOfDay));
    const dueDay = direction === 'out' ? sinceDay + travelDays : null;
    const stage = offerStage(direction, o.believedStatus, state.day, dueDay);
    const told = latestBelief(state, 'player', o.offerId, 'terms')?.value;
    const raw = told !== null && typeof told === 'object' && !Array.isArray(told) ? told.terms : null;
    return {
      offerId: o.offerId,
      direction,
      from: o.from,
      to: o.to,
      termsVersion: o.termsVersion,
      stage,
      believedStatus: o.believedStatus,
      sinceDay,
      statusDay: latestBelief(state, 'player', o.offerId, 'status')?.asOfDay ?? null,
      dueDay,
      position: offerPosition(direction, stage, state.day, sinceDay, travelDays),
      withdrawal: withdrawalBelief(state, 'player', o.offerId),
      terms: termsFor(raw, state, config, 'player'),
      segment: o.segment,
      segmentRound: o.segmentRound,
    };
  });
  return { near: trackEnd(ctx, near), far: trackEnd(ctx, far), travelDays, cards, roundCap: config.params.segment_round_cap };
}
