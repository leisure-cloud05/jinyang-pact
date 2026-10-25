/**
 * Oracle view of a bundle: every world state rebuilt from the base snapshot by applying the stored changes (own
 * patch code), the independent negotiation-segment ledger per version, and control-history timing (epoch in force
 * at a control sequence number, when batches and pauses were closed).
 */
import type { CoreConfig, PairId, WorldState } from '../../core/types.js';
import type { AuditBundle, BBatch, BEvent, BPause } from './bundle.js';
import { EMPTY_SEGMENT, type SegmentState } from './checks.js';
import { applyPatchOps, byIdNum, deepEqual } from './patch.js';

export const QUALIFYING_DEADLOCK: ReadonlySet<string> = new Set(['adjust_goal', 'urge_accept', 'urge_stop']);

type Ledger = Record<PairId, SegmentState>;

function emptyLedger(): Ledger {
  return { 'hedong-khitan': { ...EMPTY_SEGMENT }, 'hedong-tang': { ...EMPTY_SEGMENT }, 'khitan-tang': { ...EMPTY_SEGMENT } };
}

/** Records one new offer of a pair (PLAN §4.1): the opening offer consumes no round; every later offer does. */
export function recordOffer(l: SegmentState): { next: SegmentState; round: number } {
  if (l.segment === 0) return { next: { segment: 1, roundsInSegment: 0, offersTotal: l.offersTotal + 1, openingNext: false }, round: 0 };
  if (l.openingNext) return { next: { ...l, offersTotal: l.offersTotal + 1, openingNext: false }, round: 0 };
  return { next: { ...l, roundsInSegment: l.roundsInSegment + 1, offersTotal: l.offersTotal + 1 }, round: l.roundsInSegment + 1 };
}

export function newOfferIds(pre: WorldState, post: WorldState): string[] {
  return Object.keys(post.offers)
    .filter((id) => !(id in pre.offers))
    .sort(byIdNum);
}

export class ReplayedBundle {
  readonly bundle: AuditBundle;
  readonly config: CoreConfig;
  readonly baseVersion: number;
  readonly integrity: string[] = [];
  readonly events: BEvent[];
  private readonly states = new Map<number, WorldState>();
  private readonly ledgers = new Map<number, Ledger>();
  /** Offer id → segment round it consumed per the independent ledger. */
  readonly offerRounds = new Map<string, { pair: PairId; segment: number; round: number; version: number }>();
  /** Event version → segment reset legitimately performed by that event (qualifying deadlock decision). */
  readonly resets = new Map<number, PairId>();
  readonly batchById: Map<string, BBatch>;
  lastVersion: number;

  constructor(bundle: AuditBundle) {
    this.bundle = bundle;
    this.config = bundle.session.config;
    this.batchById = new Map(bundle.batches.map((b) => [b.batchId, b]));
    const snaps = new Map(bundle.snapshots.map((s) => [s.version, s.state]));
    const base = snaps.get(bundle.session.baseVersion) ?? bundle.snapshots[0]?.state;
    if (!base) throw new Error(`bundle ${bundle.session.sessionId} has no base snapshot`);
    this.baseVersion = base.version;
    this.events = bundle.events.filter((e) => e.version > this.baseVersion && !e.inherited);
    this.states.set(base.version, base);
    let ledger = this.initialLedger(base);
    this.ledgers.set(base.version, ledger);
    let current = base;
    for (const e of this.events) {
      if (e.version !== current.version + 1) {
        this.integrity.push(`event ${e.version} does not follow version ${current.version}`);
        break;
      }
      let next: WorldState;
      try {
        next = applyPatchOps(current, e.changes);
      } catch (err) {
        this.integrity.push(`event ${e.version}: patch failed (${(err as Error).message})`);
        break;
      }
      if (next.version !== e.version) this.integrity.push(`event ${e.version}: produces state version ${next.version}`);
      ledger = this.advanceLedger(ledger, current, next, e);
      this.states.set(e.version, next);
      this.ledgers.set(e.version, ledger);
      current = next;
    }
    this.lastVersion = current.version;
    for (const [v, state] of snaps) {
      const rebuilt = this.states.get(v);
      if (rebuilt && !deepEqual(rebuilt, state)) this.integrity.push(`snapshot ${v} differs from the state rebuilt from events`);
    }
  }

  private initialLedger(base: WorldState): Ledger {
    const l = emptyLedger();
    const offers = Object.values(base.offers).sort((a, b) => byIdNum(a.id, b.id));
    for (const o of offers) {
      const pair = base.commitments[o.commitmentId]?.pair;
      if (!pair) continue;
      const r = recordOffer(l[pair]);
      l[pair] = r.next;
      this.offerRounds.set(o.id, { pair, segment: r.next.segment, round: r.round, version: base.version });
    }
    return l;
  }

  private advanceLedger(prev: Ledger, pre: WorldState, post: WorldState, e: BEvent): Ledger {
    const l: Ledger = { ...prev };
    if (e.kind === 'deadlock_resolved' && e.decisionId) {
      const d = this.bundle.decisions.find((x) => x.decisionId === e.decisionId);
      if (d && d.category === 'negotiation_deadlock' && QUALIFYING_DEADLOCK.has(d.option)) {
        const pair = d.pair ?? 'hedong-khitan';
        const cur = l[pair];
        if (cur.offersTotal < this.config.params.pair_offer_cap) {
          l[pair] = { segment: cur.segment + 1, roundsInSegment: 0, offersTotal: cur.offersTotal, openingNext: true };
          this.resets.set(e.version, pair);
        }
      }
    }
    for (const id of newOfferIds(pre, post)) {
      const o = post.offers[id];
      const pair = o ? post.commitments[o.commitmentId]?.pair : undefined;
      if (!pair) continue;
      const r = recordOffer(l[pair]);
      l[pair] = r.next;
      this.offerRounds.set(id, { pair, segment: r.next.segment, round: r.round, version: e.version });
    }
    return l;
  }

  has(version: number): boolean {
    return this.states.has(version);
  }

  stateAt(version: number): WorldState {
    const s = this.states.get(version);
    if (!s) throw new Error(`no state at version ${version}`);
    return s;
  }

  /** Segment bookkeeping at a version (before any offer of the next event). */
  segmentsAt(version: number): (pair: PairId) => SegmentState {
    const l = this.ledgers.get(version) ?? emptyLedger();
    return (pair) => l[pair];
  }

  finalState(): WorldState {
    return this.stateAt(this.lastVersion);
  }

  eventsOfBatch(batchId: string): BEvent[] {
    return this.events.filter((e) => e.batchId === batchId);
  }

  /** Epoch in force just before control sequence number `seq`. */
  epochAt(seq: number): number {
    let epoch = 0;
    for (const e of this.bundle.epochs) if (e.controlSeq < seq && e.epoch > epoch) epoch = e.epoch;
    return epoch;
  }

  /** Control sequence number at which a batch stopped being open (Infinity while open). */
  batchClosedAt(b: BBatch): number {
    if (b.status === 'committed') return b.commitSeq ?? b.controlSeq;
    if (b.status === 'stale' || b.status === 'obsolete') {
      const later = [
        ...this.bundle.epochs.filter((e) => e.controlSeq > b.controlSeq).map((e) => e.controlSeq),
        ...this.bundle.batches.filter((x) => x.controlSeq > b.controlSeq).map((x) => x.controlSeq),
        ...this.bundle.decisions.filter((d) => d.controlSeq > b.controlSeq && this.pauseBatch(d.pauseId) === b.batchId).map((d) => d.controlSeq),
      ];
      return later.length > 0 ? Math.min(...later) : Number.POSITIVE_INFINITY;
    }
    return Number.POSITIVE_INFINITY;
  }

  private pauseBatch(pauseId: string | null): string | null {
    if (!pauseId) return null;
    return this.bundle.pauses.find((p) => p.pauseId === pauseId)?.batchId ?? null;
  }

  /** Control sequence number at which a pause stopped being open (Infinity while open). */
  pauseClosedAt(p: BPause): number {
    if (p.status === 'resolved') {
      const d = this.bundle.decisions.find((x) => x.decisionId === p.decisionId);
      return d ? d.controlSeq : p.controlSeq;
    }
    if (p.status === 'obsolete') {
      const batch = p.batchId ? this.batchById.get(p.batchId) : undefined;
      const later = [
        ...this.bundle.epochs.filter((e) => e.controlSeq > p.controlSeq).map((e) => e.controlSeq),
        ...this.bundle.decisions.filter((d) => d.controlSeq > p.controlSeq && this.pauseBatch(d.pauseId) === p.batchId).map((d) => d.controlSeq),
        ...(batch ? [this.batchClosedAt(batch)] : []),
      ];
      return later.length > 0 ? Math.min(...later) : Number.POSITIVE_INFINITY;
    }
    return Number.POSITIVE_INFINITY;
  }
}
