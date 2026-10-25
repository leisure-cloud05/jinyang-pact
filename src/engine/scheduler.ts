/**
 * Scene scheduler (PLAN §10.3; conventions of content/README.md §5). Deterministic, pure, identical in every mode:
 * candidates by tier, filled in order up to the cap of 4, ties broken by the fixed order shi, sang, liu, yelu, li:
 *  1  pending offer responders: holders of a delivered live offer awaiting their answer (always included; at most
 *     one per principal pair);
 *  1b other delivery recipients: non-offer messages (letters, responses, intel, withdrawals and their results)
 *     delivered in this round or earlier and not yet acted on — i.e. the recipient has not been activated since
 *     the round of delivery; ordered by the oldest pending delivery, then the fixed order. Recipients skipped by the
 *     cap stay pending and so carry forward (they keep their older delivery round, hence precedence);
 *  2  characters addressed by the player this round;
 *  3  agenda owners at the player's scene whose trigger fires: `round_start` always; `document_revised` /
 *     `document_approved` / `suggestion_made` when such an event committed since the owner's last activation;
 *     `*_delivered` when the owner received such a message since then; `grain_below` / `morale_below` /
 *     `pressure_above` against `threshold` at SELECT;
 *  4  periodic activation: `(round − 1 − offset) mod every_rounds = 0` (Li: rounds 1, 3, 5).
 * Every activation (and every capped candidate) is reported with its tier and reason. Dead characters never act.
 */
import { compareIds } from '../core/ids.js';
import { hasReceiptEvidence } from '../core/knowledge.js';
import { BESIEGED_FACTION, CHAR_IDS, type CharId, type CoreConfig, type Message, type WorldState } from '../core/types.js';
import { MAX_ACTIVE } from './types.js';

export type Tier = '1' | '1b' | '2' | '3' | '4';
export const TIERS: readonly Tier[] = ['1', '1b', '2', '3', '4'];

export type AgendaEvent =
  | 'round_start'
  | 'offer_delivered'
  | 'response_delivered'
  | 'document_revised'
  | 'document_approved'
  | 'suggestion_made'
  | 'letter_delivered'
  | 'intel_delivered'
  | 'grain_below'
  | 'pressure_above'
  | 'morale_below';

export interface AgendaTriggerLike {
  id: string;
  on: AgendaEvent;
  threshold: number | null;
}

export interface SchedulerPersona {
  agendaTriggers: readonly AgendaTriggerLike[];
  periodicActivation: { every_rounds: number; offset: number } | null;
}

export interface LastActivation {
  round: number;
  /** World version at that SELECT. */
  version: number;
}

export interface SchedulerInput {
  /** State at SELECT (after PREPARE and the PLAYER step). */
  state: WorldState;
  config: CoreConfig;
  personas: Record<CharId, SchedulerPersona>;
  /** Characters the player addressed this round. */
  addressed: readonly CharId[];
  /** Last activation of each character in an earlier round (absent = never). */
  lastActivation: Partial<Record<CharId, LastActivation>>;
  /** Committed world events up to the SELECT state (version and kind). */
  events: ReadonlyArray<{ version: number; kind: string }>;
  cap?: number;
}

export interface Candidate {
  charId: CharId;
  tier: Tier;
  reason: string;
  /** Agenda triggers of this character that fire now (passed to its context). */
  agendaIds: string[];
}

export interface ScheduleResult {
  round: number;
  active: Candidate[];
  /** Candidates left out by the cap (logged; tier-1b recipients carry forward). */
  skipped: Candidate[];
  tiers: Record<Tier, CharId[]>;
}

const ORDER = (c: CharId): number => CHAR_IDS.indexOf(c);

function roundOfDay(day: number, roundDays: number): number {
  return Math.ceil(day / roundDays) + 1;
}

/**
 * Round in which a delivered message became actionable for its recipient: the PREPARE of the first round whose day
 * reaches its arrival day; a co-located message (arrival = sending day) is delivered during its round and becomes
 * actionable in the next one.
 */
export function deliveryRound(m: Pick<Message, 'arrivalDay' | 'sentDay'>, roundDays: number): number {
  return m.arrivalDay === m.sentDay ? roundOfDay(m.sentDay, roundDays) + 1 : roundOfDay(m.arrivalDay, roundDays);
}

function isChar(id: string): id is CharId {
  return (CHAR_IDS as readonly string[]).includes(id);
}

function alive(state: WorldState, c: CharId): boolean {
  return state.characters[c].status === 'alive';
}

const DELIVERED_KIND: Partial<Record<AgendaEvent, string>> = {
  offer_delivered: 'offer',
  response_delivered: 'response',
  letter_delivered: 'letter',
  intel_delivered: 'intel',
};

const EVENT_KIND: Partial<Record<AgendaEvent, string>> = {
  document_revised: 'revise_document',
  document_approved: 'approve_document',
  suggestion_made: 'suggest_revision',
};

/** Agenda triggers of `c` that fire at this SELECT (independent of the scene; tier 3 adds the scene condition). */
export function firedAgendas(input: SchedulerInput, c: CharId): string[] {
  const { state, config } = input;
  const round = state.round;
  const days = config.params.round_days;
  const last = input.lastActivation[c];
  const sinceRound = last?.round ?? 0;
  const sinceVersion = last?.version ?? -1;
  const resources = state.factions[BESIEGED_FACTION].resources;
  const fired: string[] = [];
  for (const t of input.personas[c].agendaTriggers) {
    let hit = false;
    const eventKind = EVENT_KIND[t.on];
    const messageKind = DELIVERED_KIND[t.on];
    if (t.on === 'round_start') hit = true;
    else if (eventKind) hit = input.events.some((e) => e.kind === eventKind && e.version > sinceVersion && e.version <= state.version);
    else if (messageKind) {
      hit = Object.values(state.messages).some((m) => {
        if (m.status !== 'delivered' || m.to !== c || m.kind !== messageKind) return false;
        const at = deliveryRound(m, days);
        return at > sinceRound && at <= round;
      });
    } else if (t.on === 'grain_below') hit = t.threshold !== null && resources.grain < t.threshold;
    else if (t.on === 'morale_below') hit = t.threshold !== null && state.siege.morale < t.threshold;
    else if (t.on === 'pressure_above') hit = t.threshold !== null && state.siege.pressure > t.threshold;
    if (hit) fired.push(t.id);
  }
  return fired;
}

export function schedule(input: SchedulerInput): ScheduleResult {
  const { state, config } = input;
  const round = state.round;
  const days = config.params.round_days;
  const cap = input.cap ?? MAX_ACTIVE;
  const reasons = new Map<CharId, { tier: Tier; reason: string }>();
  const tiers: Record<Tier, CharId[]> = { '1': [], '1b': [], '2': [], '3': [], '4': [] };
  const note = (tier: Tier, c: CharId, reason: string): void => {
    tiers[tier].push(c);
    if (!reasons.has(c)) reasons.set(c, { tier, reason });
  };

  // Tier 1: holders of a delivered live offer awaiting their answer (one live offer per negotiating thread/pair).
  const t1 = new Map<CharId, string>();
  for (const id of Object.keys(state.commitments).sort(compareIds)) {
    const thread = state.commitments[id];
    if (!thread || thread.status !== 'negotiating') continue;
    const offer = state.offers[thread.liveOfferId];
    if (!offer || offer.status !== 'delivered' || !alive(state, offer.to)) continue;
    if (!hasReceiptEvidence(state, offer.to, offer.id, offer.termsVersion)) continue;
    if (!t1.has(offer.to)) t1.set(offer.to, `pending offer ${offer.id} (${thread.pair}) awaits an answer`);
  }
  for (const c of CHAR_IDS) {
    const why = t1.get(c);
    if (why) note('1', c, why);
  }

  // Tier 1b: other delivery recipients not activated since the delivery (carry-forward).
  const pending = new Map<CharId, { from: number; ids: string[] }>();
  for (const id of Object.keys(state.messages).sort(compareIds)) {
    const m = state.messages[id];
    if (!m || m.status !== 'delivered' || m.kind === 'offer' || !isChar(m.to) || !alive(state, m.to)) continue;
    const from = deliveryRound(m, days);
    if (from > round || (input.lastActivation[m.to]?.round ?? 0) >= from) continue;
    const entry = pending.get(m.to) ?? { from, ids: [] };
    entry.from = Math.min(entry.from, from);
    entry.ids.push(`${m.id} (${m.kind})`);
    pending.set(m.to, entry);
  }
  for (const [c, p] of [...pending.entries()].sort((a, b) => a[1].from - b[1].from || ORDER(a[0]) - ORDER(b[0]))) {
    note('1b', c, `delivered since round ${p.from}, not yet acted on: ${p.ids.join(', ')}`);
  }

  // Tier 2: addressed by the player this round.
  const addressed = new Set(input.addressed);
  for (const c of CHAR_IDS) if (addressed.has(c) && alive(state, c)) note('2', c, 'addressed by the player this round');

  // Tier 3: agenda owners at the player's scene whose trigger fires.
  const agendaIds = new Map<CharId, string[]>();
  for (const c of CHAR_IDS) agendaIds.set(c, alive(state, c) ? firedAgendas(input, c) : []);
  for (const c of CHAR_IDS) {
    if (!alive(state, c) || state.characters[c].location !== state.player.location) continue;
    const fired = agendaIds.get(c) ?? [];
    if (fired.length > 0) note('3', c, `agenda at the player's scene: ${fired.join(', ')}`);
  }

  // Tier 4: periodic activation.
  for (const c of CHAR_IDS) {
    const p = input.personas[c].periodicActivation;
    if (!p || !alive(state, c)) continue;
    const k = round - 1 - p.offset;
    if (k >= 0 && k % p.every_rounds === 0) note('4', c, `periodic (every ${p.every_rounds} rounds, offset ${p.offset})`);
  }

  // Fill: tier 1 always; then 1b, 2, 3, 4 up to the cap.
  const selected: CharId[] = [...tiers['1']];
  const skipped: Candidate[] = [];
  const seenSkipped = new Set<CharId>();
  for (const tier of TIERS.slice(1)) {
    for (const c of tiers[tier]) {
      if (selected.includes(c)) continue;
      if (selected.length < cap) selected.push(c);
      else if (!seenSkipped.has(c)) {
        seenSkipped.add(c);
        skipped.push({ charId: c, tier, reason: `${reasonFor(tier, c, input, pending, t1)} (over the cap of ${cap})`, agendaIds: agendaIds.get(c) ?? [] });
      }
    }
  }
  const active: Candidate[] = selected.map((c) => {
    const r = reasons.get(c) as { tier: Tier; reason: string };
    return { charId: c, tier: r.tier, reason: r.reason, agendaIds: agendaIds.get(c) ?? [] };
  });
  return { round, active, skipped, tiers };
}

function reasonFor(
  tier: Tier,
  c: CharId,
  input: SchedulerInput,
  pending: Map<CharId, { from: number; ids: string[] }>,
  t1: Map<CharId, string>,
): string {
  switch (tier) {
    case '1':
      return t1.get(c) ?? 'pending offer';
    case '1b':
      return `delivered since round ${pending.get(c)?.from ?? '?'}, not yet acted on`;
    case '2':
      return 'addressed by the player this round';
    case '3':
      return 'agenda at the player\'s scene';
    case '4': {
      const p = input.personas[c].periodicActivation;
      return `periodic (every ${p?.every_rounds ?? '?'} rounds)`;
    }
  }
}
