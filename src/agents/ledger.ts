/**
 * Believed resource ledger (PLAN §3.3/§9.2 knowledge isolation; Codex review 19, finding 1). The world's faction
 * balances change remotely: a counterparty's confirmation debits the sender's reservations, its counter or
 * rejection releases them, an effective withdrawal releases them when it arrives. A holder may only see those
 * changes once it holds evidence of them. This ledger starts from the world balances and reverts every
 * reservation change of the faction that the holder has no evidence of:
 * - `debited` without a belief that the thread was confirmed / the offer accepted ⇒ still held (stock and
 *   reserved restored);
 * - `released` without a belief that the offer was answered/withdrawn or the thread closed ⇒ still held.
 * Held reservations are always created by the faction's own consent, so they are known.
 * (Core has no "believed resources" helper; implemented here and flagged for WP-A.)
 */
import { compareIds, own } from '../core/ids.js';
import { latestBelief } from '../core/knowledge.js';
import { RESOURCE_KEYS } from '../core/types.js';
import type { ActorId, FactionId, Reservation, ResourceMap, WorldState } from '../core/types.js';

export interface BelievedLedger {
  faction: FactionId;
  available: ResourceMap;
  reserved: ResourceMap;
  /** Reservations whose world status the holder does not know yet (shown as held). */
  unknownChanges: { reservationId: string; worldStatus: Reservation['status'] }[];
}

const CLOSED_OFFER = new Set(['accepted', 'countered', 'rejected', 'withdrawn']);
const CLOSED_THREAD = new Set(['confirmed', 'rejected', 'withdrawn']);

function statusBelief(state: WorldState, holder: ActorId, subject: string): string | null {
  const b = latestBelief(state, holder, subject, 'status');
  return typeof b?.value === 'string' ? b.value : null;
}

/** What `holder` can know of reservation `r`'s current status. */
export function believedReservationStatus(state: WorldState, holder: ActorId, r: Reservation): Reservation['status'] {
  if (r.status === 'held') return 'held';
  const offer = statusBelief(state, holder, r.offerId);
  const thread = statusBelief(state, holder, r.commitmentId);
  if (r.status === 'debited') return thread === 'confirmed' || offer === 'accepted' ? 'debited' : 'held';
  return (offer !== null && CLOSED_OFFER.has(offer)) || (thread !== null && CLOSED_THREAD.has(thread)) ? 'released' : 'held';
}

export function believedResources(state: WorldState, holder: ActorId, faction: FactionId): BelievedLedger {
  const available = { ...state.factions[faction].resources };
  const reserved = { ...state.factions[faction].reserved };
  const unknownChanges: BelievedLedger['unknownChanges'] = [];
  for (const id of Object.keys(state.reservations).sort(compareIds)) {
    const r = own(state.reservations, id) as Reservation;
    if (r.faction !== faction || r.resource === null || r.amount <= 0 || r.status === 'held') continue;
    if (believedReservationStatus(state, holder, r) !== 'held') continue;
    unknownChanges.push({ reservationId: r.id, worldStatus: r.status });
    reserved[r.resource] += r.amount;
    if (r.status === 'debited') available[r.resource] += r.amount;
  }
  for (const key of RESOURCE_KEYS) {
    available[key] = Math.round(available[key]);
    reserved[key] = Math.round(reserved[key]);
  }
  return { faction, available, reserved, unknownChanges };
}
