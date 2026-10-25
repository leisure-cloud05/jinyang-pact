/**
 * Obligations derived from a TermSet and a principal pair, reservation feasibility (H07) and the
 * reservation state transitions of §4.2 (hold at consent, release on counter/reject/withdrawal, debit on confirm).
 */
import type { Draft } from './reducer.js';
import { compareIds, own } from './ids.js';
import { TERM_SEMANTICS, isDefaultValue, otherFaction, payerFor } from './terms.js';
import {
  SCALAR_TERM_KEYS,
  type FactionId,
  type Obligation,
  type PairId,
  type Reservation,
  type ResourceKey,
  type TermSet,
  type WorldState,
} from './types.js';

export function deriveObligations(terms: TermSet, pair: PairId): Obligation[] {
  const out: Obligation[] = [];
  for (const key of SCALAR_TERM_KEYS) {
    const sem = TERM_SEMANTICS[key];
    if (sem.trigger === 'parameter') continue;
    const value = terms[key];
    if (isDefaultValue(key, value)) continue;
    const payer = payerFor(key, pair);
    if (payer === null) continue;
    out.push({
      key,
      payer,
      beneficiary: otherFaction(pair, payer),
      trigger: sem.trigger,
      resource: sem.resource,
      amount: sem.type === 'integer' ? (value as number) : null,
      value,
      exclusivityKey: sem.exclusivityPool,
    });
  }
  const clausePayer = payerFor('secret_clauses', pair);
  if (clausePayer !== null) {
    for (const clause of terms.secret_clauses) {
      out.push({
        key: `secret:${clause.id}`,
        payer: clausePayer,
        beneficiary: otherFaction(pair, clausePayer),
        trigger: 'standing',
        resource: null,
        amount: null,
        value: clause.id,
        exclusivityKey: null,
      });
    }
  }
  return out;
}

/** Obligations of `payer` that consent reserves: on-confirm resource obligations and exclusivity-pool claims. */
export function reservableObligations(obligations: readonly Obligation[], payer: FactionId): Obligation[] {
  return obligations.filter(
    (o) =>
      o.payer === payer &&
      ((o.trigger === 'on_confirm' && o.resource !== null && (o.amount ?? 0) > 0) || o.exclusivityKey !== null),
  );
}

export function availableResource(state: WorldState, faction: FactionId, resource: ResourceKey): number {
  const f = state.factions[faction];
  return f.resources[resource] - f.reserved[resource];
}

function reservationList(state: WorldState): Reservation[] {
  return Object.keys(state.reservations)
    .sort(compareIds)
    .map((id) => own(state.reservations, id) as Reservation);
}

/** Held or debited claims on an exclusivity pool, optionally ignoring one thread. */
export function poolClaims(state: WorldState, poolKey: string, excludeCommitmentId: string | null = null): Reservation[] {
  return reservationList(state).filter(
    (r) =>
      r.exclusivityKey === poolKey &&
      (r.status === 'held' || r.status === 'debited') &&
      r.commitmentId !== excludeCommitmentId,
  );
}

export function heldReservations(state: WorldState, commitmentId: string): Reservation[] {
  return reservationList(state).filter((r) => r.commitmentId === commitmentId && r.status === 'held');
}

export type ConsentCheck = { ok: true } | { ok: false; kind: 'resources' | 'pool'; reason: string };

/**
 * H07 at consent: the consenting payer's on-confirm resources must be available (`available − reserved ≥ amount`)
 * and each exclusivity pool it would claim must be free of other threads' held/confirmed claims.
 */
export function checkConsentFeasible(
  state: WorldState,
  faction: FactionId,
  obligations: readonly Obligation[],
  excludeCommitmentId: string | null,
): ConsentCheck {
  const reservable = reservableObligations(obligations, faction);
  const need = new Map<ResourceKey, number>();
  for (const o of reservable) {
    if (o.trigger === 'on_confirm' && o.resource !== null && o.amount) {
      need.set(o.resource, (need.get(o.resource) ?? 0) + o.amount);
    }
  }
  for (const [resource, amount] of [...need.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const available = availableResource(state, faction, resource);
    if (available < amount) {
      return {
        ok: false,
        kind: 'resources',
        reason: `${faction} lacks ${resource}: needs ${amount}, available ${available} after reservations`,
      };
    }
  }
  for (const o of reservable) {
    if (o.exclusivityKey === null) continue;
    const claims = poolClaims(state, o.exclusivityKey, excludeCommitmentId);
    if (claims.length > 0) {
      const holder = claims[0] as Reservation;
      return {
        ok: false,
        kind: 'pool',
        reason: `${o.key} conflicts with ${holder.obligationKey} already ${holder.status === 'held' ? 'reserved' : 'confirmed'} in ${holder.commitmentId} (pool ${o.exclusivityKey})`,
      };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------------
// Draft mutations (§4.2)
// ---------------------------------------------------------------------------------------------------------------

/** Holds the payer's reservable obligations for an offer (no feasibility check: validation precedes it). */
export function holdReservations(
  d: Draft,
  commitmentId: string,
  offerId: string,
  faction: FactionId,
  obligations: readonly Obligation[],
): string[] {
  const ids: string[] = [];
  for (const o of reservableObligations(obligations, faction)) {
    const resource = o.trigger === 'on_confirm' ? o.resource : null;
    const amount = resource !== null ? (o.amount ?? 0) : 0;
    const id = d.nextId('rsv');
    const reservation: Reservation = {
      id,
      faction,
      resource,
      amount,
      commitmentId,
      offerId,
      obligationKey: o.key,
      exclusivityKey: o.exclusivityKey,
      status: 'held',
    };
    d.set(['reservations', id], reservation);
    if (resource !== null && amount > 0) {
      d.set(['factions', faction, 'reserved', resource], d.s.factions[faction].reserved[resource] + amount);
    }
    ids.push(id);
  }
  if (ids.length > 0) d.rule('H07');
  return ids;
}

export function releaseReservations(d: Draft, commitmentId: string): void {
  for (const r of heldReservations(d.s as WorldState, commitmentId)) {
    d.set(['reservations', r.id, 'status'], 'released');
    if (r.resource !== null && r.amount > 0) {
      d.set(['factions', r.faction, 'reserved', r.resource], d.s.factions[r.faction].reserved[r.resource] - r.amount);
    }
  }
}

/** Debits every held reservation of the thread atomically (balances may go negative only in baseline). */
export function debitReservations(d: Draft, commitmentId: string): void {
  for (const r of heldReservations(d.s as WorldState, commitmentId)) {
    d.set(['reservations', r.id, 'status'], 'debited');
    if (r.resource !== null && r.amount > 0) {
      const reserved = d.s.factions[r.faction].reserved[r.resource];
      const balance = d.s.factions[r.faction].resources[r.resource];
      d.set(['factions', r.faction, 'reserved', r.resource], reserved - r.amount);
      d.set(['factions', r.faction, 'resources', r.resource], balance - r.amount);
    }
  }
}
