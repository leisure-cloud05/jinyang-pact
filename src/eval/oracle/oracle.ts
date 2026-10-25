/**
 * Independent oracle (PLAN §13.3): re-checks H01–H16 and G01–G12 on an audit bundle, mode-aware (baseline
 * commits are checked exactly like Harness-mode commits — that is where violations show up).
 *
 * Output: one finding per applied committed action event with every violated rule (committed speech, which writes
 * only dialogue, is checked and reported separately — it is not an applied action event of §13.2);
 * system/control findings (H05, H06, H10 on decision effects, H13 restarts, H14, H15, G01–G12); narration findings
 * (H16) on displayed and raw text; and integrity problems of the bundle itself.
 */
import type { ActorId, CoreConfig, PairId, PauseCategory, WorldState } from '../../core/types.js';
import { WORLD_ACTION_TYPES, type OAction, type OSystemAction } from './actions.js';
import type { AuditBundle, BBatch, BEvent, BProposal } from './bundle.js';
import { checkValidity, coveringAuthorization, criticalCategory, type Violation } from './checks.js';
import { checkNarration, DEFAULT_LEXICON, type NarrationLexicon, type NarrationResult } from './narration.js';
import { deepEqual } from './patch.js';
import { QUALIFYING_DEADLOCK, ReplayedBundle } from './replay.js';
import { available, believedStatus, consentNeeds, locationOf, principalOf, shiOf, threadsOf, HEDONG_KHITAN } from './world.js';

export const PROCEED_OPTIONS: ReadonlySet<string> = new Set(['endorse', 'delegate', 'let_it_happen']);
export const WITHHOLD_OPTIONS: ReadonlySet<string> = new Set(['withhold', 'counter_draft', 'urge_payment']);

const KNOWN_EVENT_KINDS: ReadonlySet<string> = new Set([
  ...WORLD_ACTION_TYPES,
  'mutiny_outbreak',
  'character_death',
  'allegiance_change',
  'message_delivered',
  'withdrawal_effective',
  'withdrawal_late',
  'advance',
  'mutiny_averted_for_now',
  'terminal',
  'authorization_granted',
  'goal_adjusted',
  'deadlock_resolved',
]);

export type GateHow = 'player_initiated' | 'decision' | 'authorization' | 'not_required' | 'missing';

export interface ActionFinding {
  proposalId: string;
  batchId: string;
  batchKind: string;
  actor: ActorId;
  source: string;
  type: string;
  round: number;
  /** World event of the action (null for committed speech, which only writes dialogue). */
  eventVersion: number | null;
  category: PauseCategory | null;
  gate: GateHow;
  probe: boolean;
  violations: Violation[];
}

export interface Finding extends Violation {
  eventVersion?: number;
  batchId?: string;
}

export interface OracleReport {
  sessionId: string;
  mode: string;
  caseId: string | null;
  /** Applied committed action events (the §13.2 invalid-commit denominator). */
  actions: ActionFinding[];
  /** Committed speech (dialogue only, no world event): checked (H08 listeners), reported separately. */
  speech: ActionFinding[];
  unapplied: Array<{ proposalId: string; actor: string; type: string; reason: string | null; probe: boolean }>;
  /** Judge-REVISE originals (revisions.jsonl): checked at their batch state; never executed, never counted as applied. */
  replacedOriginals: Array<{ revisionId: string; batchId: string; actor: string; type: string; violations: Violation[] }>;
  system: Finding[];
  narration: NarrationResult[];
  integrity: string[];
  counts: {
    applied: number;
    invalid: number;
    speech: number;
    speechInvalid: number;
    byRule: Record<string, number>;
    systemByRule: Record<string, number>;
    narrationDisplayedHits: number;
    narrationRawHits: number;
  };
}

export interface OracleOptions {
  names?: NarrationLexicon;
}

function actionType(raw: unknown): string {
  return typeof raw === 'object' && raw !== null && typeof (raw as { type?: unknown }).type === 'string' ? ((raw as { type: string }).type) : '?';
}

function tally(list: readonly Violation[], into: Record<string, number>): void {
  for (const x of list) into[x.rule] = (into[x.rule] ?? 0) + 1;
}

/** Phase in which the terminal check follows an event of this batch kind (PLAN G12). */
function phaseOf(kind: string | undefined): 'prepare' | 'advance' | 'outcome' | 'action' {
  if (kind === 'system_prepare') return 'prepare';
  if (kind === 'system_advance') return 'advance';
  if (kind === 'system_outcome') return 'outcome';
  return 'action';
}

/** G12 terminal conditions, first satisfied wins (independent re-implementation). */
export function terminalCondition(s: WorldState, c: CoreConfig, phase: string, offersTotal: number): string | null {
  const p = c.params;
  const grain = s.factions.hedong.resources.grain;
  if (grain <= p.fall_grain_max || s.siege.pressure >= p.fall_pressure_min) return 'jinyang_falls';
  const shi = shiOf(c);
  const threads = threadsOf(s, HEDONG_KHITAN);
  if (threads.some((t) => t.status === 'confirmed' && believedStatus(s, shi, t.id) === 'confirmed')) return 'pact_concluded';
  const open = threads.some((t) => t.status === 'negotiating' || t.status === 'confirmed');
  const closedFor = (id: string) => ['rejected', 'withdrawn'].includes(believedStatus(s, shi, id) ?? '');
  if (s.flags.assistanceAbandoned && !open && threads.every((t) => closedFor(t.id))) return 'no_assistance';
  const latest = threads[threads.length - 1];
  if (!s.flags.assistanceAbandoned && latest && !open && closedFor(latest.id) && (offersTotal >= p.pair_offer_cap || phase === 'advance')) return 'talks_failed';
  return null;
}

/** G11 forecast from a state (same five-day transition, let_it_happen at a mutiny). */
export function projectFall(s: WorldState, c: CoreConfig): number | null {
  const p = c.params;
  let n = { day: s.day, grain: s.factions.hedong.resources.grain, pressure: s.siege.pressure, morale: s.siege.morale, mutiny: s.flags.mutinyOccurred };
  const falls = () => n.grain <= p.fall_grain_max || n.pressure >= p.fall_pressure_min;
  if (falls()) return n.day;
  for (let i = 0; i < p.projection_max_steps; i++) {
    const grain = Math.max(0, n.grain - p.grain_per_advance);
    const pressure = Math.min(p.pressure_cap, n.pressure + p.pressure_per_advance);
    const decay = grain < p.morale_low_grain || pressure > p.morale_high_pressure;
    n = { ...n, day: n.day + p.round_days, grain, pressure, morale: decay ? Math.max(0, n.morale - p.morale_decay) : n.morale };
    if (falls()) return n.day;
    if (!n.mutiny && n.grain <= p.mutiny_grain_max && n.morale <= p.mutiny_morale_max) {
      n = { ...n, morale: 0, pressure: Math.min(p.pressure_cap, n.pressure + p.mutiny_pressure_add), mutiny: true };
      if (falls()) return n.day;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Per-event invariants (post-state)
// ---------------------------------------------------------------------------------------------------------------

function travel(c: CoreConfig, from: string | null, to: string | null): number {
  if (!from || !to) return 0;
  return (c.travel as Record<string, Record<string, number>>)[from]?.[to] ?? 0;
}

/**
 * Reservation reconciliation (PLAN §4.2, H07), from the plan's rules only:
 * (1) each faction's `reserved` total equals the sum of its held reservation records;
 * (2) the live offer of every negotiating thread is backed by held reservations of its sender's on-confirm resource
 *     obligations (exact amounts) and exclusivity-pool claims;
 * (3) no held reservation outside a negotiating thread's live offer;
 * (4) with `pre`: a thread confirmed by this event debited both parties' obligations of the accepted offer — debited
 *     records with the exact amounts, and the faction balances lowered by exactly those amounts.
 */
export function reservationProblems(s: WorldState, c: CoreConfig, pre: WorldState | null): string[] {
  const out: string[] = [];
  const records = Object.values(s.reservations);
  for (const f of ['hedong', 'khitan', 'tang'] as const) {
    for (const r of ['grain', 'silk', 'cavalry', 'reserve_troops'] as const) {
      const held = records.filter((x) => x.status === 'held' && x.faction === f && x.resource === r).reduce((n, x) => n + x.amount, 0);
      if (s.factions[f].reserved[r] !== held) out.push(`reserved ${f} ${r} = ${s.factions[f].reserved[r]} but held reservations sum to ${held}`);
    }
  }
  for (const t of Object.values(s.commitments)) {
    if (t.status !== 'negotiating') continue;
    const o = s.offers[t.liveOfferId];
    const faction = o ? s.characters[o.from]?.faction : undefined;
    if (!o || !faction) continue;
    const needs = consentNeeds(o.terms, t.pair, faction);
    const held = records.filter((x) => x.status === 'held' && x.commitmentId === t.id && x.offerId === o.id && x.faction === faction);
    for (const [r, amount] of needs.resources) {
      const sum = held.filter((x) => x.resource === r).reduce((n, x) => n + x.amount, 0);
      if (sum !== amount) out.push(`consent of ${o.from} to ${o.id} needs ${amount} ${r} reserved, held ${sum}`);
    }
    for (const pool of needs.pools) if (!held.some((x) => x.exclusivityKey === pool)) out.push(`consent of ${o.from} to ${o.id} holds no ${pool} claim`);
  }
  for (const x of records) {
    if (x.status !== 'held') continue;
    const t = s.commitments[x.commitmentId];
    if (!t || t.status !== 'negotiating' || t.liveOfferId !== x.offerId) out.push(`reservation ${x.id} still held for ${x.commitmentId}/${x.offerId} (${t?.status ?? 'missing thread'})`);
  }
  if (pre) {
    const decrease = new Map<string, number>();
    for (const t of Object.values(s.commitments)) {
      if (t.status !== 'confirmed' || pre.commitments[t.id]?.status === 'confirmed') continue;
      const o = s.offers[t.liveOfferId];
      if (!o) continue;
      for (const party of t.parties) {
        const faction = s.characters[party]?.faction;
        if (!faction) continue;
        const needs = consentNeeds(o.terms, t.pair, faction);
        const debited = records.filter((x) => x.status === 'debited' && x.commitmentId === t.id && x.offerId === o.id && x.faction === faction);
        for (const [r, amount] of needs.resources) {
          const sum = debited.filter((x) => x.resource === r).reduce((n, x) => n + x.amount, 0);
          if (sum !== amount) out.push(`confirmation of ${t.id} debited ${sum} ${r} from ${faction}, obligation ${amount}`);
          decrease.set(`${faction}|${r}`, (decrease.get(`${faction}|${r}`) ?? 0) + amount);
        }
      }
    }
    for (const [key, amount] of decrease) {
      const [f, r] = key.split('|') as ['hedong' | 'khitan' | 'tang', 'silk' | 'cavalry'];
      const actual = pre.factions[f].resources[r] - s.factions[f].resources[r];
      if (actual !== amount) out.push(`confirmation lowered ${f} ${r} by ${actual}, obligations ${amount}`);
    }
  }
  return out;
}

/** Invariants of one committed event: H07, H08, H09, H11, G02 (whatever the event's origin). */
export function eventInvariants(pre: WorldState, post: WorldState, c: CoreConfig): Violation[] {
  const out: Violation[] = [];
  // H07: balances and the exclusivity pool never get worse than non-negative / one claim.
  for (const f of ['hedong', 'khitan', 'tang'] as const) {
    for (const r of ['grain', 'silk', 'cavalry', 'reserve_troops'] as const) {
      const b = post.factions[f].resources[r];
      const avail = available(post, f, r);
      if ((b < 0 && b < pre.factions[f].resources[r]) || (avail < 0 && avail < available(pre, f, r))) {
        out.push({ rule: 'H07', detail: `${f} ${r}: balance ${b}, available ${avail}` });
      }
    }
  }
  const claims = (s: WorldState) => {
    const ids = new Set<string>();
    for (const r of Object.values(s.reservations)) if (r.exclusivityKey === 'khitan_stance' && (r.status === 'held' || r.status === 'debited')) ids.add(r.commitmentId);
    return ids.size;
  };
  if (claims(post) > 1 && claims(post) > claims(pre)) out.push({ rule: 'H07', detail: `khitan_stance backs ${claims(post)} threads` });
  // H07: obligations ↔ reservation records ↔ reserved totals ↔ confirmation debits (independent reconciliation).
  const before = new Set(reservationProblems(pre, c, null));
  for (const p of reservationProblems(post, c, pre)) if (!before.has(p)) out.push({ rule: 'H07', detail: p });
  // H09: every newly recorded consent is the party's own; a thread confirms only on one termsVersion.
  for (const t of Object.values(post.commitments)) {
    const before = pre.commitments[t.id];
    for (const [party, consent] of Object.entries(t.consents)) {
      if (consent.termsVersion === null) continue;
      if (before && deepEqual(before.consents[party], consent)) continue;
      if (consent.by !== null && consent.by !== undefined && consent.by !== party) {
        out.push({ rule: 'H09', detail: `consent of ${party} to ${t.id} v${consent.termsVersion} recorded by ${consent.by}` });
      }
    }
    if (t.status === 'confirmed' && before?.status !== 'confirmed') {
      const bad = t.parties.filter((p) => t.consents[p]?.termsVersion !== t.termsVersion);
      if (bad.length > 0) out.push({ rule: 'H09', detail: `${t.id} confirmed without consent of ${bad.join(', ')} to v${t.termsVersion}` });
    }
  }
  // H11: sent documents are immutable; a new version voids the approval.
  for (const d of Object.values(post.documents)) {
    const before = pre.documents[d.id];
    if (before?.status === 'sent' && !deepEqual(before, d)) out.push({ rule: 'H11', detail: `sent document ${d.id} changed` });
    if (before && d.version !== before.version && d.approval !== null && d.approval.version !== d.version) {
      out.push({ rule: 'H11', detail: `${d.id} edited to v${d.version} but approval of v${d.approval.version} kept` });
    }
  }
  // H08 / G02: deliveries and message-based assertions never precede arrival.
  for (const m of Object.values(post.messages)) {
    const before = pre.messages[m.id];
    if (m.status === 'delivered' && before?.status !== 'delivered' && pre.day < m.arrivalDay) {
      out.push({ rule: 'H08', detail: `${m.id} delivered on day ${pre.day} before its arrival day ${m.arrivalDay}` });
    }
    if (!before) {
      const expected = m.from === 'system' ? m.sentDay + c.params.intel_delay_days : m.sentDay + travel(c, locationOf(pre, m.from), locationOf(pre, m.to));
      if (m.sentDay !== pre.day) out.push({ rule: 'G02', detail: `${m.id} sent on day ${m.sentDay}, world day ${pre.day}` });
      if (m.arrivalDay !== expected) out.push({ rule: 'G02', detail: `${m.id} arrives day ${m.arrivalDay}, expected ${expected}` });
    }
  }
  for (const k of Object.values(post.knowledge)) {
    if (k.id in pre.knowledge || k.evidence.kind !== 'message') continue;
    const m = post.messages[k.evidence.ref];
    if (!m || m.status !== 'delivered' || k.asOfDay < m.arrivalDay) {
      out.push({ rule: 'H08', detail: `${k.holder} knows ${k.subject} from ${k.evidence.ref} before its arrival` });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------------------------------------------------

export function runOracle(bundle: AuditBundle, opts: OracleOptions = {}): OracleReport {
  const rb = new ReplayedBundle(bundle);
  const c = rb.config;
  const names = opts.names ?? DEFAULT_LEXICON;
  const system: Finding[] = [];
  const actions: ActionFinding[] = [];
  const speech: ActionFinding[] = [];
  const unapplied: OracleReport['unapplied'] = [];
  const batchFindings = new Map<string, Violation[]>();
  const addBatch = (id: string, x: Violation) => batchFindings.set(id, [...(batchFindings.get(id) ?? []), x]);
  const decisions = bundle.decisions;
  const eventByVersion = new Map(rb.events.map((e) => [e.version, e]));

  // ---- H05 / H06: batch entry and single commit ----------------------------------------------------------
  for (const b of bundle.batches) {
    const evs = rb.eventsOfBatch(b.batchId);
    if (b.status === 'committed') {
      const commitSeq = b.commitSeq ?? Number.POSITIVE_INFINITY;
      const epoch = rb.epochAt(commitSeq);
      if (b.epoch !== epoch) addBatch(b.batchId, { rule: 'H05', detail: `batch ${b.batchId} of epoch ${b.epoch} committed in epoch ${epoch}` });
      if (evs.length > 0 && (evs[0] as BEvent).version !== b.baseVersion + 1) {
        addBatch(b.batchId, { rule: 'H05', detail: `batch ${b.batchId} based on v${b.baseVersion} committed at v${(evs[0] as BEvent).version - 1}` });
      }
      if (evs.length === 0 && b.committedVersion !== null && b.committedVersion !== b.baseVersion) {
        addBatch(b.batchId, { rule: 'H05', detail: `empty batch ${b.batchId} based on v${b.baseVersion} committed at v${b.committedVersion}` });
      }
      for (let i = 1; i < evs.length; i++) {
        if ((evs[i] as BEvent).version !== (evs[i - 1] as BEvent).version + 1) {
          addBatch(b.batchId, { rule: 'H06', detail: `batch ${b.batchId} committed in more than one transaction` });
          break;
        }
      }
    } else if (evs.length > 0) {
      addBatch(b.batchId, { rule: 'H05', detail: `${b.status} batch ${b.batchId} has committed events` });
    }
  }
  for (const [id, list] of batchFindings) for (const x of list) system.push({ ...x, batchId: id });
  const byRequest = new Map<string, Set<string>>();
  for (const r of bundle.requests) byRequest.set(r.requestId, new Set([...(byRequest.get(r.requestId) ?? []), r.payloadHash]));
  for (const [id, hashes] of byRequest) if (hashes.size > 1) system.push({ rule: 'H06', detail: `request ${id} used with ${hashes.size} different payloads` });
  const decisionsByRequest = new Map<string, number>();
  for (const d of decisions) if (d.requestId) decisionsByRequest.set(d.requestId, (decisionsByRequest.get(d.requestId) ?? 0) + 1);
  for (const [id, n] of decisionsByRequest) if (n > 1) system.push({ rule: 'H06', detail: `request ${id} produced ${n} decisions` });

  // ---- Applied actions ---------------------------------------------------------------------------------
  const dialogueByProposal = new Map(bundle.dialogue.filter((d) => d.proposalId).map((d) => [d.proposalId as string, d]));
  for (const p of bundle.proposals) {
    const type = actionType(p.action);
    if (p.status === 'unapplied') {
      unapplied.push({ proposalId: p.proposalId, actor: p.actor, type, reason: p.reason, probe: p.probe });
      continue;
    }
    if (p.status !== 'committed' || type === 'wait') continue;
    const batch = rb.batchById.get(p.batchId);
    const ev = p.eventVersions.find((v) => eventByVersion.get(v)?.kind !== 'terminal') ?? null;
    let pre: WorldState;
    let post: WorldState | null = null;
    if (ev !== null) {
      if (!rb.has(ev - 1) || !rb.has(ev)) continue;
      pre = rb.stateAt(ev - 1);
      post = rb.stateAt(ev);
    } else {
      const row = dialogueByProposal.get(p.proposalId);
      const v = row ? row.worldVersion : (batch?.committedVersion ?? batch?.baseVersion ?? rb.baseVersion);
      if (!rb.has(v)) continue;
      pre = rb.stateAt(v);
      if (type !== 'speak') {
        system.push({ rule: 'H15', detail: `committed ${type} ${p.proposalId} left no event` });
        continue;
      }
    }
    const finding = checkAction(rb, p, batch, pre, post, ev, batchFindings.get(p.batchId) ?? []);
    if (ev === null) speech.push(finding);
    else actions.push(finding);
  }

  // ---- Decision-effect events --------------------------------------------------------------------------
  for (const e of rb.events) {
    if (!['authorization_granted', 'goal_adjusted', 'deadlock_resolved'].includes(e.kind)) continue;
    const d = decisions.find((x) => x.decisionId === e.decisionId);
    const want = e.kind === 'authorization_granted' ? ['delegate'] : e.kind === 'goal_adjusted' ? ['adjust_goal'] : [...QUALIFYING_DEADLOCK];
    if (!d || !want.includes(d.option) || (d.batchId !== e.batchId)) {
      system.push({ rule: e.kind === 'deadlock_resolved' ? 'H13' : 'H10', detail: `${e.kind} at v${e.version} without a matching resolved decision`, eventVersion: e.version });
    }
  }

  // ---- Per-event system checks (H13 restarts, H14, H15, G01–G09, G12) --------------------------------
  const actionEvents = new Set(actions.map((a) => a.eventVersion).filter((v): v is number => v !== null));
  for (const e of rb.events) {
    if (!rb.has(e.version) || !rb.has(e.version - 1)) continue;
    const pre = rb.stateAt(e.version - 1);
    const post = rb.stateAt(e.version);
    const at = (x: Violation): Finding => ({ ...x, eventVersion: e.version, ...(e.batchId ? { batchId: e.batchId } : {}) });
    if (!KNOWN_EVENT_KINDS.has(e.kind)) system.push(at({ rule: 'H15', detail: `event kind ${e.kind} is outside the closed set` }));
    if (!actionEvents.has(e.version)) for (const x of eventInvariants(pre, post, c)) system.push(at(x));
    // H13: the world's segment counter only moves forward through a qualifying decision.
    for (const pair of ['hedong-khitan', 'hedong-tang', 'khitan-tang'] as PairId[]) {
      const a = pre.negotiation?.[pair];
      const b = post.negotiation?.[pair];
      if (a && b && b.segment > a.segment && a.segment > 0 && rb.resets.get(e.version) !== pair) {
        system.push(at({ rule: 'H13', detail: `${pair} segment ${a.segment}→${b.segment} without a qualifying deadlock decision` }));
      }
    }
    // H14 / G01: time moves only in ADVANCE, by one round of round_days.
    const batch = e.batchId ? rb.batchById.get(e.batchId) : undefined;
    if (e.kind !== 'advance' && (post.day !== pre.day || post.round !== pre.round)) system.push(at({ rule: 'H14', detail: `day/round changed by ${e.kind}` }));
    if (post.day !== (post.round - 1) * c.params.round_days) system.push(at({ rule: 'G01', detail: `round ${post.round} on day ${post.day}` }));
    if (e.kind === 'advance') checkAdvance(rb, e, batch, pre, post, system);
    if (e.kind === 'mutiny_outbreak') {
      const p = c.params;
      if (!(pre.factions.hedong.resources.grain <= p.mutiny_grain_max && pre.siege.morale <= p.mutiny_morale_max && !pre.flags.mutinyOccurred)) {
        system.push(at({ rule: 'G06', detail: 'mutiny outbreak without its condition' }));
      }
      if (post.siege.morale !== 0 || post.siege.pressure !== Math.min(p.pressure_cap, pre.siege.pressure + p.mutiny_pressure_add) || !post.flags.mutinyOccurred) {
        system.push(at({ rule: 'G06', detail: 'mutiny outbreak effects differ from G06' }));
      }
    }
    if (e.kind === 'mutiny_averted_for_now' && e.changes.some((ch) => ch.path !== '/version')) system.push(at({ rule: 'G06', detail: 'mutiny_averted_for_now changed the world' }));
  }
  checkTerminals(rb, system);
  checkMutinyStaging(rb, system);
  checkTimeGate(rb, system);

  // ---- H15: model prose never enters world state -------------------------------------------------------
  const finalJson = JSON.stringify(rb.finalState());
  for (const n of bundle.narrations) {
    for (const sentence of (n.raw ?? '').split(/[。！？\n.!?]/).map((x) => x.trim()).filter((x) => x.length >= 10)) {
      if (finalJson.includes(sentence)) system.push({ rule: 'H15', detail: `narration prose written to world state: "${sentence.slice(0, 40)}"` });
    }
  }

  // ---- H16 -----------------------------------------------------------------------------------------------
  const narration: NarrationResult[] = [];
  for (const n of bundle.narrations) {
    const versions = n.eventVersions.filter((v) => rb.has(v));
    const top = versions.length > 0 ? Math.max(...versions) : null;
    if (top === null) continue;
    const facts = n.eventVersions.flatMap((v) => (eventByVersion.get(v)?.facts ?? []).filter((f) => f.scene === n.scene));
    const days = [...new Set(n.eventVersions.map((v) => eventByVersion.get(v)?.day).filter((d): d is number => d !== undefined))];
    narration.push(checkNarration({ narration: n, state: rb.stateAt(top), facts, days }, c, names));
  }

  const replacedOriginals: OracleReport['replacedOriginals'] = [];
  for (const r of bundle.revisions) {
    if (r.kind !== 'original' || r.status === 'revision_failed') continue;
    const batch = rb.batchById.get(r.batchId);
    if (!batch || !rb.has(batch.baseVersion)) continue;
    const v = checkValidity(rb.stateAt(batch.baseVersion), { config: c, segments: rb.segmentsAt(batch.baseVersion) }, r.actor, r.envelope.action);
    replacedOriginals.push({ revisionId: r.revisionId, batchId: r.batchId, actor: r.actor, type: actionType(r.envelope.action), violations: v.violations });
  }

  const byRule: Record<string, number> = {};
  for (const a of actions) tally(a.violations, byRule);
  const systemByRule: Record<string, number> = {};
  tally(system, systemByRule);
  return {
    sessionId: bundle.session.sessionId,
    mode: bundle.session.mode,
    caseId: bundle.session.caseId,
    actions,
    speech,
    unapplied,
    replacedOriginals,
    system,
    narration,
    integrity: rb.integrity,
    counts: {
      applied: actions.length,
      invalid: actions.filter((a) => a.violations.length > 0).length,
      speech: speech.length,
      speechInvalid: speech.filter((a) => a.violations.length > 0).length,
      byRule,
      systemByRule,
      narrationDisplayedHits: narration.reduce((n, r) => n + r.displayed.length, 0),
      narrationRawHits: narration.reduce((n, r) => n + r.raw.length, 0),
    },
  };
}

function checkAction(
  rb: ReplayedBundle,
  p: BProposal,
  batch: BBatch | undefined,
  pre: WorldState,
  post: WorldState | null,
  ev: number | null,
  batchViolations: readonly Violation[],
): ActionFinding {
  const c = rb.config;
  const bundle = rb.bundle;
  const segments = ev !== null ? rb.segmentsAt(ev - 1) : rb.segmentsAt(pre.version);
  const validity = checkValidity(pre, { config: c, segments }, p.actor, p.action);
  const violations: Violation[] = [...validity.violations, ...batchViolations];
  let category: PauseCategory | null = null;
  let gate: GateHow = 'not_required';
  if (validity.parsed) {
    const action = validity.parsed.action as OAction | OSystemAction;
    category = criticalCategory(pre, c, p.actor, action);
    if (category) {
      const mine = bundle.decisions.filter((d) => d.batchId === p.batchId && d.proposalIds.includes(p.proposalId));
      const before = (seq: number) => batch?.commitSeq === null || batch?.commitSeq === undefined || seq < batch.commitSeq;
      if (mine.some((d) => WITHHOLD_OPTIONS.has(d.option) && before(d.controlSeq))) {
        violations.push({ rule: 'H10', detail: `${p.proposalId} committed although the player withheld it` });
      }
      if (p.actor === 'player') gate = 'player_initiated';
      else if (mine.some((d) => PROCEED_OPTIONS.has(d.option) && before(d.controlSeq))) gate = 'decision';
      else if (coveringAuthorization(pre, c, p.actor, category, action)) gate = 'authorization';
      else {
        gate = 'missing';
        violations.push({ rule: 'H10', detail: `${category} ${p.proposalId} committed without a resolved decision, authorization or player initiative` });
      }
    }
    if (post !== null) {
      violations.push(...eventInvariants(pre, post, c));
      violations.push(...effectChecks(pre, post, c, action));
    }
  }
  const seen = new Set<string>();
  return {
    proposalId: p.proposalId,
    batchId: p.batchId,
    batchKind: batch?.kind ?? '?',
    actor: p.actor,
    source: p.source,
    type: actionType(p.action),
    round: p.round,
    eventVersion: ev,
    category,
    gate,
    probe: p.probe,
    violations: violations.filter((x) => {
      const k = `${x.rule}|${x.detail}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }),
  };
}

/** G04/G05 allocation effects, G08 intelligence, G09 relief day, H13 on new offers (independent ledger). */
function effectChecks(pre: WorldState, post: WorldState, c: CoreConfig, a: OAction | OSystemAction): Violation[] {
  const out: Violation[] = [];
  const p = c.params;
  if (a.type === 'allocate_resources') {
    const f = a.args.faction;
    if (post.factions[f].resources[a.args.resource] !== pre.factions[f].resources[a.args.resource] - a.args.amount) {
      out.push({ rule: a.args.purpose === 'intensify_siege' ? 'G04' : 'G05', detail: 'allocation not debited' });
    }
    if (a.args.purpose === 'intensify_siege' && f === 'tang' && a.args.resource === 'reserve_troops') {
      const want = Math.min(p.pressure_cap, pre.siege.pressure + p.intensify_pressure_per_step * Math.floor(a.args.amount / p.intensify_troops_step));
      if (post.siege.pressure !== want) out.push({ rule: 'G04', detail: `pressure ${post.siege.pressure}, expected ${want}` });
    }
    if (a.args.purpose === 'pay_troops' && f === 'hedong' && a.args.resource === 'silk') {
      const want = Math.min(p.morale_cap, pre.siege.morale + p.pay_morale_per_step * Math.floor(a.args.amount / p.pay_silk_step));
      if (post.siege.morale !== want) out.push({ rule: 'G05', detail: `morale ${post.siege.morale}, expected ${want}` });
    }
  }
  if (a.type === 'dispatch_document') {
    const li = principalOf(c, 'tang');
    const intel = Object.values(post.messages).filter((m) => !(m.id in pre.messages) && m.kind === 'intel');
    const ok = intel.some((m) => m.to === li && m.from === 'system' && m.arrivalDay === pre.day + p.intel_delay_days && !('terms' in (m.payload as object)));
    if (!ok) out.push({ rule: 'G08', detail: 'dispatch without the G08 intelligence message' });
  }
  if (a.type === 'confirm_commitment') {
    const offer = pre.offers[a.args.offerId];
    const thread = offer ? pre.commitments[offer.commitmentId] : undefined;
    if (offer && thread?.pair === HEDONG_KHITAN && offer.terms.aid_cavalry > 0 && post.flags.khitanArrivalDay !== pre.day + offer.terms.aid_arrival_days) {
      out.push({ rule: 'G09', detail: `khitanArrivalDay ${String(post.flags.khitanArrivalDay)}, expected ${pre.day + offer.terms.aid_arrival_days}` });
    }
  }
  return out;
}

function checkAdvance(rb: ReplayedBundle, e: BEvent, batch: BBatch | undefined, pre: WorldState, post: WorldState, out: Finding[]): void {
  const p = rb.config.params;
  const at = (rule: string, detail: string): Finding => ({ rule: rule as Violation['rule'], detail, eventVersion: e.version });
  if (batch?.kind !== 'system_advance') out.push(at('H14', `advance outside an ADVANCE batch (${batch?.kind ?? 'none'})`));
  if (post.day !== pre.day + p.round_days || post.round !== pre.round + 1) out.push(at('G01', `advance ${pre.day}→${post.day}, round ${pre.round}→${post.round}`));
  const grain = Math.max(0, pre.factions.hedong.resources.grain - p.grain_per_advance);
  if (post.factions.hedong.resources.grain !== grain) out.push(at('G03', `grain ${post.factions.hedong.resources.grain}, expected ${grain}`));
  const pressure = Math.min(p.pressure_cap, pre.siege.pressure + p.pressure_per_advance);
  if (post.siege.pressure !== pressure) out.push(at('G04', `pressure ${post.siege.pressure}, expected ${pressure}`));
  const decay = grain < p.morale_low_grain || pressure > p.morale_high_pressure;
  const morale = decay ? Math.max(0, pre.siege.morale - p.morale_decay) : pre.siege.morale;
  if (post.siege.morale !== morale) out.push(at('G05', `morale ${post.siege.morale}, expected ${morale}`));
  const allowed = new Set(['/day', '/round', '/factions/hedong/resources/grain', '/siege/pressure', '/siege/morale', '/version']);
  const extra = e.changes.filter((ch) => !allowed.has(ch.path));
  if (extra.length > 0) out.push(at('G01', `advance changed ${extra.map((x) => x.path).join(', ')}`));
}

/** G06: a mutiny is staged exactly when its condition holds after an ADVANCE (G12: not after a fall). */
function checkMutinyStaging(rb: ReplayedBundle, out: Finding[]): void {
  const p = rb.config.params;
  const batches = rb.bundle.batches;
  for (const e of rb.events) {
    if (e.kind !== 'advance' || !rb.has(e.version)) continue;
    const post = rb.stateAt(e.version);
    const next = rb.events.find((x) => x.version === e.version + 1);
    const fell = next?.kind === 'terminal' && next.batchId === e.batchId;
    const due = !fell && post.terminal === null && !post.flags.mutinyOccurred && post.factions.hedong.resources.grain <= p.mutiny_grain_max && post.siege.morale <= p.mutiny_morale_max;
    const advBatch = e.batchId ? rb.batchById.get(e.batchId) : undefined;
    if (!advBatch) continue;
    // The staging window closes at the next PREPARE or ADVANCE (the outcome belongs to this ADVANCE only).
    const closes = batches.find((b) => (b.kind === 'system_prepare' || b.kind === 'system_advance') && b.controlSeq > advBatch.controlSeq);
    const staged = batches.some((b) => b.kind === 'system_outcome' && b.controlSeq > advBatch.controlSeq && (!closes || b.controlSeq < closes.controlSeq));
    if (due && !staged) out.push({ rule: 'G06', detail: `mutiny condition after ADVANCE v${e.version} but no staged outcome`, eventVersion: e.version });
    if (!due && staged) out.push({ rule: 'G06', detail: `mutiny staged after ADVANCE v${e.version} without its condition`, eventVersion: e.version });
  }
}

/** H14: at the start of each ADVANCE no pause is open and no other batch is uncommitted. */
function checkTimeGate(rb: ReplayedBundle, out: Finding[]): void {
  for (const b of rb.bundle.batches) {
    if (b.kind !== 'system_advance') continue;
    const t = b.controlSeq;
    const openPauses = rb.bundle.pauses.filter((p) => p.controlSeq < t && rb.pauseClosedAt(p) > t);
    const openBatches = rb.bundle.batches.filter((x) => x.batchId !== b.batchId && x.controlSeq < t && rb.batchClosedAt(x) > t);
    if (openPauses.length > 0) out.push({ rule: 'H14', detail: `ADVANCE ${b.batchId} while pause(s) ${openPauses.map((p) => p.pauseId).join(', ')} open`, batchId: b.batchId });
    if (openBatches.length > 0) out.push({ rule: 'H14', detail: `ADVANCE ${b.batchId} while batch(es) ${openBatches.map((x) => x.batchId).join(', ')} uncommitted`, batchId: b.batchId });
  }
}

/** G07/G11/G12: terminal precedence, no missed terminal, frozen world after a terminal. */
function checkTerminals(rb: ReplayedBundle, out: Finding[]): void {
  const c = rb.config;
  const events = rb.events;
  let terminalAt: number | null = rb.stateAt(rb.baseVersion).terminal ? rb.baseVersion : null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i] as BEvent;
    if (!rb.has(e.version) || !rb.has(e.version - 1)) break;
    if (terminalAt !== null) {
      out.push({ rule: 'G12', detail: `event ${e.version} (${e.kind}) after the terminal at v${terminalAt}`, eventVersion: e.version });
      continue;
    }
    const batch = e.batchId ? rb.batchById.get(e.batchId) : undefined;
    const phase = phaseOf(batch?.kind);
    const offersAt = (v: number) => rb.segmentsAt(v)('hedong-khitan').offersTotal;
    if (e.kind === 'terminal') {
      const pre = rb.stateAt(e.version - 1);
      const want = terminalCondition(pre, c, phase, offersAt(e.version - 1));
      const got = rb.stateAt(e.version).terminal;
      if (want === null) out.push({ rule: 'G12', detail: `terminal ${got?.kind ?? '?'} without a satisfied condition`, eventVersion: e.version });
      else if (got?.kind !== want) out.push({ rule: want === 'jinyang_falls' ? 'G07' : 'G12', detail: `terminal ${got?.kind ?? '?'} but ${want} has precedence`, eventVersion: e.version });
      if (got?.kind === 'no_assistance') {
        const detail = got.detail as Record<string, unknown>;
        const fallDay = projectFall(pre, c);
        if (detail.projected !== true || detail.fallDay !== fallDay || !Array.isArray(detail.assumptions)) {
          out.push({ rule: 'G11', detail: `no_assistance projection ${String(detail.fallDay)} (expected fall day ${String(fallDay)}, projected: true)`, eventVersion: e.version });
        }
      }
      terminalAt = e.version;
      continue;
    }
    const next = events[i + 1];
    const checkpoint = phase !== 'prepare' || !next || next.batchId !== e.batchId || next.kind === 'terminal';
    if (!checkpoint) continue;
    const post = rb.stateAt(e.version);
    const want = terminalCondition(post, c, phase, offersAt(e.version));
    if (want !== null && !(next && next.kind === 'terminal' && next.batchId === e.batchId)) {
      out.push({ rule: want === 'jinyang_falls' ? 'G07' : 'G12', detail: `${want} holds after v${e.version} but no terminal was committed`, eventVersion: e.version });
    }
  }
}
