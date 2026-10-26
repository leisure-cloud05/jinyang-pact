/**
 * Interaction ledger (PLAN §10.4) — pure. A persistent record of what needs a character's attention ("items"),
 * derived deterministically from committed records only:
 * - PREPARE commits: delivered messages (`delivery`) and delivered live offers awaiting an answer (`offer`);
 * - the player's dialogue: speech to characters (`address`) and decision advice (`advice`; withhold/counter-draft
 *   advice is folded into the withheld proposal's feedback);
 * - committed character steps: the recorded model outputs of that step's turns (interaction metadata: `request`,
 *   `reply`, `wait`, invalid-metadata `feedback`) and the step's proposal outcomes (`feedback` on rejected, withheld,
 *   unapplied and unreadable proposals).
 * Turns of a batch that never committed (stale, obsolete: an interrupt, an amendment, a crash) have no effect, so a
 * late output can never revive or close an item. Facts that close an item (an offer answered, a corrected action,
 * a closed object, a dead character) are checked against the committed world state at the happening's version.
 *
 * Item states: `open` (actionable when eligible: it triggers scheduling), `seen` (supplied to the model in a
 * committed turn that did not deal with it: shown again, no longer a trigger), `waiting` (a wait condition not yet
 * met), `resolved` (closure reason) and `obsolete`. Supplied ≠ responded ≠ resolved: an item is resolved only by a
 * validated model statement (`addressed`), a verified committed fact or an engine rule (superseded), never because
 * a character was selected, a call returned, an output was unreadable or the model chose to wait.
 *
 * The derivation is a fold over happenings in control order; the engine materializes it after every step and the
 * replay re-derives it from the recorded outputs and compares (src/engine/interaction-store.ts).
 */
import { actorLocation, hasReceiptEvidence, isAlive } from '../core/knowledge.js';
import { CHAR_IDS, type ActorId, type CharId, type CoreConfig, type FactionId, type Message, type Offer, type WorldState } from '../core/types.js';
import type { InteractionContextView, ItemView, RequestView } from '../agents/interaction-view.js';
import type { InteractionOutput, WaitOn } from '../agents/schemas.js';

export type { InteractionContextView, ItemView, RequestView } from '../agents/interaction-view.js';

export const INTERACTION_VERSION = 'interaction.v1';

export const ITEM_KINDS = ['offer', 'delivery', 'address', 'advice', 'request', 'reply', 'feedback', 'wait'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export type ItemStatus = 'open' | 'seen' | 'waiting' | 'resolved' | 'obsolete';
/** What the item's text is: another's claim, a verified harness record, or the character's own record. */
export type ItemBasis = 'claim' | 'verified' | 'own';

/** Scheduler tier of an actionable item (PLAN §10.3). */
export function itemTier(kind: ItemKind): '1' | '1b' | '1c' | '2' {
  if (kind === 'offer') return '1';
  if (kind === 'delivery') return '1b';
  if (kind === 'address') return '2';
  return '1c';
}

export interface ItemPosition {
  round: number;
  /** Step of the round (0 = before the round's first step: PREPARE / PLAYER). */
  step: number;
  /** Committed interaction steps of the run so far (for waiting-time measures). */
  gstep: number;
  /** Control position of the happening (ordering only). */
  pos: number;
}

export interface ItemAttempt {
  type: string;
  args: Record<string, unknown> | null;
  proposalId: string;
  status: string;
}

export interface WaitCondition {
  on: WaitOn;
  who: string | null;
  round: number | null;
  reason: string;
  /** Requests (item ids) a `reply` wait refers to. */
  requestItemIds: string[];
}

export interface ItemClosure {
  reason: string;
  by: 'model' | 'fact' | 'engine';
  ref: string | null;
  note: string | null;
  at: ItemPosition;
}

export type ItemEventKind =
  | 'created'
  | 'supplied'
  | 'responded'
  | 'seen'
  | 'unreadable'
  | 'call_failed'
  | 'backoff'
  | 'satisfied'
  | 'resolved'
  | 'obsolete';

export interface ItemEvent {
  ord: number;
  kind: ItemEventKind;
  at: ItemPosition;
  turnId: string | null;
  note: string | null;
  /** Status after the event. */
  status: ItemStatus;
}

export interface ItemSource {
  type: 'message' | 'offer' | 'dialogue' | 'turn' | 'proposal' | 'interaction';
  ref: string;
  turnId: string | null;
  dialogueSeq: number | null;
  proposalId: string | null;
  /** Replies: the request they answer, and how. */
  requestItemId: string | null;
  how: string | null;
}

export interface Item {
  itemId: string;
  /** Natural key (idempotent creation). */
  sourceKey: string;
  seq: number;
  kind: ItemKind;
  responsible: CharId;
  from: ActorId | null;
  topic: string | null;
  text: string;
  basis: ItemBasis;
  refs: string[];
  source: ItemSource;
  created: ItemPosition;
  eligibleFrom: { round: number; step: number };
  status: ItemStatus;
  supplied: number;
  responded: number;
  firstSupplied: ItemPosition | null;
  /** Unreadable / failed calls while supplied, in `failuresRound`. */
  failures: number;
  failuresRound: number;
  /** Not a trigger before this round (repetition / failure backoff). */
  backoffRound: number | null;
  repeatOf: string | null;
  repeats: number;
  waiting: WaitCondition | null;
  /** How a wait was satisfied (wait items). */
  satisfied: { how: string; ref: string | null; at: ItemPosition } | null;
  attempted: ItemAttempt | null;
  closure: ItemClosure | null;
  events: ItemEvent[];
}

export interface LedgerNote {
  kind: 'repeated_speech' | 'invalid_metadata';
  text: string;
  ref: string | null;
}

export interface LedgerCounters {
  metadataEntries: number;
  invalidMetadata: number;
  repeatedSpeech: number;
  repeatedInvalid: number;
}

export interface Ledger {
  version: string;
  items: Item[];
  nextSeq: number;
  gstep: number;
  stepsInRound: Record<string, number>;
  speeches: Partial<Record<CharId, Array<{ seq: number | null; norm: string; turnId: string; round: number }>>>;
  /** Control position of each character's last committed readable turn. */
  lastTurnPos: Partial<Record<CharId, number>>;
  /** Notes from each character's last committed readable turn (repetition, invalid metadata). */
  notes: Partial<Record<CharId, LedgerNote[]>>;
  counters: LedgerCounters;
}

// ---------------------------------------------------------------------------------------------------------------
// Inputs (built from persisted records by interaction-store.ts)
// ---------------------------------------------------------------------------------------------------------------

export interface ProposalFact {
  proposalId: string;
  actor: ActorId;
  seq: number;
  type: string;
  args: Record<string, unknown> | null;
  status: string;
  /** Actor-safe (redacted) feedback (PLAN §8.6). */
  feedback: string | null;
  code: string | null;
  /** The clerk's objection when withheld (advice dialogue of the withholding decision). */
  adviceText: string | null;
  adviceSeq: number | null;
}

export type TurnStatus = 'ok' | 'format_error' | 'error' | 'skipped';

export interface TurnInput {
  turnId: string;
  batchId: string;
  actor: CharId;
  status: TurnStatus;
  /** Item ids included in the turn's context. */
  supplied: string[];
  interaction: InteractionOutput | null;
  speech: string;
  /** Dialogue seq of the committed speech, if any. */
  speechSeq: number | null;
  proposals: ProposalFact[];
}

export type Happening =
  | { kind: 'prepare'; pos: number; round: number; version: number }
  | { kind: 'dialogue'; pos: number; round: number; seq: number; dialogueKind: 'speech' | 'advice'; text: string; listeners: ActorId[]; folded: boolean }
  | { kind: 'step'; pos: number; round: number; batchId: string; baseVersion: number; version: number; turns: TurnInput[]; proposals: ProposalFact[] }
  | { kind: 'advance'; pos: number; round: number; version: number };

export interface DeriveInputs {
  config: CoreConfig;
  maxRounds: number;
  lang: 'zh' | 'en';
  happenings: readonly Happening[];
  stateAt: (version: number) => WorldState;
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

export function isCharId(id: unknown): id is CharId {
  return typeof id === 'string' && (CHAR_IDS as readonly string[]).includes(id);
}

const CHAR_ORDER = (c: string): number => (CHAR_IDS as readonly string[]).indexOf(c);

export function emptyLedger(): Ledger {
  return {
    version: INTERACTION_VERSION,
    items: [],
    nextSeq: 1,
    gstep: 0,
    stepsInRound: {},
    speeches: {},
    lastTurnPos: {},
    notes: {},
    counters: { metadataEntries: 0, invalidMetadata: 0, repeatedSpeech: 0, repeatedInvalid: 0 },
  };
}

export function cloneLedger(l: Ledger): Ledger {
  return structuredClone(l);
}

export function isClosed(it: Item): boolean {
  return it.status === 'resolved' || it.status === 'obsolete';
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function normalizeSpeech(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

function normTopic(t: string | null): string {
  return (t ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

const FEEDBACK_STATUSES = new Set(['rejected', 'withheld', 'unapplied', 'format_error']);
const DOC_ACTIONS = new Set(['revise_document', 'approve_document', 'set_dispatch_timing', 'dispatch_document']);
const OFFER_ACTIONS = new Set(['respond_to_offer', 'withdraw_offer', 'confirm_commitment']);

/** Object references of an attempted action (what the feedback is about). */
export function primaryRefs(type: string, args: Record<string, unknown> | null): string[] {
  if (!args) return [];
  const s = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const out: Array<string | null> = [];
  if (DOC_ACTIONS.has(type)) out.push(s(args.docId));
  else if (type === 'suggest_revision') out.push(s((args.target as { id?: unknown } | undefined)?.id));
  else if (OFFER_ACTIONS.has(type)) out.push(s(args.offerId), s(args.commitmentId));
  else if (type === 'propose_terms' || type === 'send_letter') out.push(s(args.to));
  else if (type === 'allocate_resources') out.push(s(args.resource));
  else if (type === 'revoke_authorization') out.push(s(args.authId));
  return out.filter((x): x is string => x !== null);
}

/** Shallow, short form of an action's arguments (term sets summarized). */
export function compactArgs(args: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!args) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === 'terms' || k === 'counterTerms') out[k] = v === null ? null : '(term set)';
    else if (typeof v === 'string') out[k] = clip(v, 120);
    else out[k] = v;
  }
  return out;
}

function liveAwaiting(state: WorldState, offer: Offer | undefined): boolean {
  if (!offer || offer.status !== 'delivered') return false;
  const thread = state.commitments[offer.commitmentId];
  return thread !== undefined && thread.status === 'negotiating' && thread.liveOfferId === offer.id && isAlive(state, offer.to);
}

function principalOf(config: CoreConfig, faction: FactionId): CharId {
  return config.factions[faction].principal;
}

function sideOf(state: WorldState, actor: ActorId): FactionId | null {
  return isCharId(actor) ? state.characters[actor].faction : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------------------------------------------

class Builder {
  readonly L: Ledger;
  private readonly byId = new Map<string, Item>();
  private readonly byKey = new Map<string, Item>();

  constructor(
    base: Ledger | null,
    private readonly inputs: DeriveInputs,
  ) {
    this.L = base ? cloneLedger(base) : emptyLedger();
    for (const it of this.L.items) {
      this.byId.set(it.itemId, it);
      this.byKey.set(it.sourceKey, it);
    }
  }

  item(id: string): Item | undefined {
    return this.byId.get(id);
  }

  event(it: Item, kind: ItemEventKind, at: ItemPosition, turnId: string | null = null, note: string | null = null): void {
    it.events.push({ ord: it.events.length + 1, kind, at: { ...at }, turnId, note, status: it.status });
  }

  create(
    spec: Pick<Item, 'sourceKey' | 'kind' | 'responsible' | 'from' | 'topic' | 'text' | 'basis' | 'refs' | 'source' | 'eligibleFrom'> &
      Partial<Pick<Item, 'status' | 'waiting' | 'attempted' | 'repeatOf' | 'repeats' | 'backoffRound'>>,
    at: ItemPosition,
  ): Item | null {
    if (this.byKey.has(spec.sourceKey)) return null;
    const seq = this.L.nextSeq++;
    const it: Item = {
      itemId: `i${seq}`,
      seq,
      sourceKey: spec.sourceKey,
      kind: spec.kind,
      responsible: spec.responsible,
      from: spec.from,
      topic: spec.topic,
      text: spec.text,
      basis: spec.basis,
      refs: [...spec.refs],
      source: { ...spec.source },
      created: { ...at },
      eligibleFrom: { ...spec.eligibleFrom },
      status: spec.status ?? 'open',
      supplied: 0,
      responded: 0,
      firstSupplied: null,
      failures: 0,
      failuresRound: at.round,
      backoffRound: spec.backoffRound ?? null,
      repeatOf: spec.repeatOf ?? null,
      repeats: spec.repeats ?? 0,
      waiting: spec.waiting ?? null,
      satisfied: null,
      attempted: spec.attempted ?? null,
      closure: null,
      events: [],
    };
    this.L.items.push(it);
    this.byId.set(it.itemId, it);
    this.byKey.set(it.sourceKey, it);
    this.event(it, 'created', at);
    if (it.backoffRound !== null) this.event(it, 'backoff', at, null, `not a trigger before round ${it.backoffRound}`);
    return it;
  }

  close(it: Item, reason: string, by: ItemClosure['by'], ref: string | null, at: ItemPosition, note: string | null = null, turnId: string | null = null): void {
    if (isClosed(it)) return;
    it.status = 'resolved';
    it.closure = { reason, by, ref, note, at: { ...at } };
    this.event(it, 'resolved', at, turnId, reason);
  }

  obsolete(it: Item, reason: string, at: ItemPosition): void {
    if (isClosed(it)) return;
    it.status = 'obsolete';
    it.closure = { reason, by: 'engine', ref: null, note: null, at: { ...at } };
    this.event(it, 'obsolete', at, null, reason);
  }

  unresolved(): Item[] {
    return this.L.items.filter((i) => !isClosed(i));
  }

  // --- happenings -----------------------------------------------------------------------------------------------

  apply(h: Happening): void {
    switch (h.kind) {
      case 'prepare':
        return this.prepare(h);
      case 'dialogue':
        return this.dialogue(h);
      case 'step':
        return this.step(h);
      case 'advance':
        return this.factPass(this.inputs.stateAt(h.version), this.at(h.round, h.pos, (this.L.stepsInRound[String(h.round)] ?? 0)));
    }
  }

  at(round: number, pos: number, step: number): ItemPosition {
    return { round, step, gstep: this.L.gstep, pos };
  }

  private prepare(h: Extract<Happening, { kind: 'prepare' }>): void {
    const state = this.inputs.stateAt(h.version);
    const at = this.at(h.round, h.pos, 0);
    const eligibleFrom = { round: h.round, step: 1 };
    const created: Item[] = [];
    const messages = Object.values(state.messages).sort((a, b) => a.sendSeq - b.sendSeq);
    for (const m of messages) {
      if (m.status !== 'delivered' || !isCharId(m.to)) continue;
      if (m.kind === 'offer') continue;
      if (m.kind === 'response') {
        const counter = (m.payload as { counter?: { offerId: string } | null }).counter;
        if (counter && liveAwaiting(state, state.offers[counter.offerId])) continue; // the counter offer is its own item
      }
      const it = this.create(
        {
          sourceKey: `msg:${m.id}`,
          kind: 'delivery',
          responsible: m.to,
          from: m.from,
          topic: null,
          text: messageText(m, this.inputs.lang),
          basis: m.kind === 'letter' || m.kind === 'intel' ? 'claim' : 'verified',
          refs: messageRefs(m),
          source: { type: 'message', ref: m.id, turnId: null, dialogueSeq: null, proposalId: null, requestItemId: null, how: m.kind },
          eligibleFrom,
        },
        at,
      );
      if (it) created.push(it);
    }
    for (const offer of Object.values(state.offers).sort((a, b) => a.pairSeq - b.pairSeq || (a.id < b.id ? -1 : 1))) {
      if (!liveAwaiting(state, offer) || !hasReceiptEvidence(state, offer.to, offer.id, offer.termsVersion)) continue;
      const it = this.create(
        {
          sourceKey: `offer:${offer.id}@${offer.termsVersion}`,
          kind: 'offer',
          responsible: offer.to,
          from: offer.from,
          topic: offer.commitmentId,
          text: `offer ${offer.id} (terms version ${offer.termsVersion}) awaits your answer`,
          basis: 'verified',
          refs: [offer.id, offer.commitmentId],
          source: { type: 'offer', ref: offer.id, turnId: null, dialogueSeq: null, proposalId: null, requestItemId: null, how: offer.origin },
          eligibleFrom,
        },
        at,
      );
      if (it) created.push(it);
    }
    // Delivery waits are met by a new delivery from the awaited party.
    for (const it of created) this.meetWaits(it.responsible, 'delivery', it.from, it, at);
    // Round waits are met at the start of the awaited round.
    for (const w of this.unresolved()) {
      if (w.kind !== 'wait' || w.status !== 'waiting' || w.waiting?.on !== 'round') continue;
      if (w.waiting.round !== null && h.round >= w.waiting.round) {
        w.status = 'open';
        w.eligibleFrom = { round: h.round, step: 1 };
        w.satisfied = { how: 'round_reached', ref: null, at: { ...at } };
        this.event(w, 'satisfied', at, null, `round ${h.round}`);
      }
    }
    this.factPass(state, at);
  }

  private dialogue(h: Extract<Happening, { kind: 'dialogue' }>): void {
    const done = this.L.stepsInRound[String(h.round)] ?? 0;
    const at = this.at(h.round, h.pos, done);
    if (h.folded) return;
    for (const l of h.listeners) {
      if (!isCharId(l)) continue;
      const it = this.create(
        {
          sourceKey: `dlg:${h.seq}:${l}`,
          kind: h.dialogueKind === 'advice' ? 'advice' : 'address',
          responsible: l,
          from: 'player',
          topic: null,
          text: clip(h.text, 400),
          basis: 'claim',
          refs: [`dialogue:${h.seq}`],
          source: { type: 'dialogue', ref: `dialogue:${h.seq}`, turnId: null, dialogueSeq: h.seq, proposalId: null, requestItemId: null, how: h.dialogueKind },
          eligibleFrom: { round: h.round, step: done + 1 },
        },
        at,
      );
      if (it) this.meetWaits(l, 'player', 'player', it, at);
    }
  }

  private step(h: Extract<Happening, { kind: 'step' }>): void {
    const key = String(h.round);
    const s = (this.L.stepsInRound[key] ?? 0) + 1;
    this.L.stepsInRound[key] = s;
    this.L.gstep += 1;
    const at = this.at(h.round, h.pos, s);
    const base = this.inputs.stateAt(h.baseVersion);
    const after = this.inputs.stateAt(h.version);
    // 1. A committed action corrects earlier feedback on the same kind of action (and object) of that actor.
    for (const p of h.proposals) {
      if (p.status !== 'committed' || !isCharId(p.actor) || p.type === 'speak' || p.type === 'wait') continue;
      const refs = primaryRefs(p.type, p.args);
      for (const it of this.unresolved()) {
        if (it.kind !== 'feedback' || it.responsible !== p.actor || it.attempted?.type !== p.type) continue;
        const theirs = primaryRefs(it.attempted.type, it.attempted.args);
        if (theirs.length > 0 && refs.length > 0 && theirs[0] !== refs[0]) continue;
        this.close(it, 'corrected', 'fact', p.proposalId, at);
      }
    }
    // 2. The step's turns (recorded model outputs), in the fixed character order.
    const turns = [...h.turns].sort((a, b) => CHAR_ORDER(a.actor) - CHAR_ORDER(b.actor));
    for (const t of turns) this.turn(t, at, base, after, h.round, s);
    // 3. Feedback on this step's proposals.
    for (const p of h.proposals) {
      if (!isCharId(p.actor) || !FEEDBACK_STATUSES.has(p.status) || p.code === 'skipped') continue;
      this.feedback(p, at, h.round, s);
    }
    // 4. Facts after the commit.
    this.factPass(after, at);
  }

  private turn(t: TurnInput, at: ItemPosition, base: WorldState, after: WorldState, round: number, step: number): void {
    const actor = t.actor;
    const supplied = [...new Set(t.supplied)].map((id) => this.item(id)).filter((i): i is Item => i !== undefined && i.responsible === actor);
    for (const it of supplied) {
      if (isClosed(it)) continue;
      it.supplied += 1;
      it.firstSupplied ??= { ...at };
      this.event(it, 'supplied', at, t.turnId);
    }
    if (t.status !== 'ok') {
      for (const it of supplied) {
        if (isClosed(it) || it.status !== 'open') continue;
        if (it.failuresRound !== round) {
          it.failuresRound = round;
          it.failures = 0;
        }
        it.failures += 1;
        this.event(it, t.status === 'format_error' ? 'unreadable' : 'call_failed', at, t.turnId);
        if (it.failures >= 2 && (it.backoffRound === null || it.backoffRound <= round)) {
          it.backoffRound = round + 1;
          this.event(it, 'backoff', at, t.turnId, `${it.failures} failed turns in round ${round}`);
        }
      }
      return;
    }
    const L = this.L;
    const notes: LedgerNote[] = [];
    const problems: string[] = [];
    const handled = new Set<string>();
    const speech = t.speech.trim();
    const committed = t.proposals.filter((p) => p.status === 'committed' && p.type !== 'speak' && p.type !== 'wait');
    const meta = t.interaction ?? { addressed: [], requests: [], wait_for: null };
    const location = actorLocation(base, actor);
    const present = (c: CharId): boolean => isAlive(base, c) && actorLocation(base, c) === location;

    // addressed
    for (const a of meta.addressed) {
      L.counters.metadataEntries += 1;
      const id = a.item.trim();
      const it = this.item(id);
      const note = clip(a.note ?? '', 200) || null;
      if (handled.has(id)) continue;
      if (!it || it.responsible !== actor) {
        problems.push(`addressed "${id}": not one of your items`);
        continue;
      }
      if (!t.supplied.includes(id)) {
        problems.push(`addressed ${id}: it was not shown to you in this turn`);
        continue;
      }
      if (isClosed(it)) {
        problems.push(`addressed ${id}: already closed (${it.closure?.reason ?? it.status})`);
        continue;
      }
      const respond = (): void => {
        it.responded += 1;
        handled.add(id);
        this.event(it, 'responded', at, t.turnId, a.how);
      };
      switch (it.kind) {
        case 'request': {
          if (a.how === 'answered') {
            if (!speech) {
              problems.push(`addressed ${id} as answered, but your speech is empty: say your answer`);
              break;
            }
            respond();
            this.close(it, 'answered', 'model', t.turnId, at, note, t.turnId);
            this.reply(it, t, 'answered', clip(speech, 400), at, round, step);
          } else if (a.how === 'declined') {
            respond();
            this.close(it, 'declined', 'model', t.turnId, at, note, t.turnId);
            this.reply(it, t, 'declined', note ?? (speech ? clip(speech, 400) : 'declined'), at, round, step);
          } else if (a.how === 'acted') {
            if (committed.length === 0) {
              problems.push(`addressed ${id} as acted, but none of your actions took effect`);
              break;
            }
            respond();
            this.close(it, 'acted', 'fact', committed[0]?.proposalId ?? null, at, note, t.turnId);
            this.reply(it, t, 'acted', `acted: ${committed.map((p) => p.type).join(', ')}${speech ? ` — ${clip(speech, 300)}` : ''}`, at, round, step);
          } else {
            problems.push(`addressed ${id} (a request) as noted: answer it (speech), decline it or act on it`);
          }
          break;
        }
        case 'offer': {
          const offerId = it.refs[0] ?? '';
          if (a.how === 'acted' && !liveAwaiting(after, after.offers[offerId])) {
            respond();
          } else if (a.how === 'acted') {
            problems.push(`addressed ${id} as acted, but offer ${offerId} still awaits your answer (respond_to_offer or confirm_commitment)`);
          } else {
            problems.push(`addressed ${id}: an offer is answered only with respond_to_offer or confirm_commitment; leave it out until you answer`);
          }
          break;
        }
        case 'feedback': {
          if (a.how === 'acted') {
            if (committed.length === 0) {
              problems.push(`addressed ${id} as acted, but none of your actions took effect`);
              break;
            }
            respond();
            this.close(it, 'corrected', 'fact', committed[0]?.proposalId ?? null, at, note, t.turnId);
          } else {
            respond();
            this.close(it, a.how === 'declined' ? 'abandoned' : 'acknowledged', 'model', t.turnId, at, note, t.turnId);
          }
          break;
        }
        case 'wait': {
          respond();
          this.close(it, 'cancelled', 'model', t.turnId, at, note, t.turnId);
          break;
        }
        default: {
          respond();
          this.close(it, a.how, 'model', t.turnId, at, note, t.turnId);
        }
      }
    }

    // requests
    meta.requests.forEach((r, i) => {
      L.counters.metadataEntries += 1;
      const to = r.to.trim();
      const topic = clip(r.topic ?? '', 80);
      const question = clip(r.question ?? '', 300);
      if (!isCharId(to)) {
        problems.push(`request to "${to}": not a character in this game${to === 'player' ? ' (ask the clerk with ask_player)' : ''}`);
        return;
      }
      if (to === actor) {
        problems.push('request to yourself');
        return;
      }
      if (!present(to)) {
        problems.push(`request to ${to}: not present with you; write a letter (send_letter) instead`);
        return;
      }
      if (!speech) {
        problems.push(`request to ${to}: a request must be said aloud — put the question in your speech`);
        return;
      }
      if (!topic || !question) {
        problems.push(`request to ${to}: topic and question are required`);
        return;
      }
      const dup = this.unresolved().find((x) => x.kind === 'request' && x.from === actor && x.responsible === to && normTopic(x.topic) === normTopic(topic));
      if (dup) {
        problems.push(`request to ${to} about "${topic}": you already asked (${dup.itemId}, ${dup.status === 'seen' ? 'seen, not answered' : 'not yet answered'})`);
        return;
      }
      this.create(
        {
          sourceKey: `req:${t.turnId}:${i}`,
          kind: 'request',
          responsible: to,
          from: actor,
          topic,
          text: question,
          basis: 'claim',
          refs: t.speechSeq !== null ? [`dialogue:${t.speechSeq}`] : [],
          source: { type: 'turn', ref: t.turnId, turnId: t.turnId, dialogueSeq: t.speechSeq, proposalId: null, requestItemId: null, how: null },
          eligibleFrom: { round, step: step + 1 },
        },
        at,
      );
    });

    // wait_for
    if (meta.wait_for) {
      L.counters.metadataEntries += 1;
      const w = meta.wait_for;
      const who = w.who?.trim() ? w.who.trim() : null;
      let problem: string | null = null;
      let requestItemIds: string[] = [];
      if (w.on === 'reply' || w.on === 'delivery') {
        if (!who) problem = `"${w.on}" needs "who"`;
        else if (!isCharId(who)) {
          problem =
            `"${who}" is not a participant in this game: no message, answer or event from them will ever occur. ` +
            'If your character consults them, that is part of how you decide; decide now, or wait for something that can happen';
        } else if (who === actor) problem = 'you cannot wait for yourself';
        else if (!isAlive(base, who)) problem = `${who} is not alive`;
        else if (w.on === 'reply') {
          if (!present(who)) problem = `${who} is not present; a reply can come only from someone present (for others: "delivery")`;
          else {
            requestItemIds = this.unresolved()
              .filter((x) => x.kind === 'request' && x.from === actor && x.responsible === who)
              .map((x) => x.itemId);
            if (requestItemIds.length === 0) problem = `you have not asked ${who}; ${who} will not answer unless you ask (use requests)`;
          }
        } else if (present(who)) problem = `${who} is present: ask them (requests) instead of waiting for a delivery`;
        else if (!awaitsAnswerFrom(base, actor, who)) {
          problem = `nothing you sent to ${who} awaits an answer, so no message from ${who} is expected`;
        }
      } else if (w.on === 'round') {
        if (w.round === null || w.round <= round || w.round > this.inputs.maxRounds) {
          problem = `"round" needs a round between ${round + 1} and ${this.inputs.maxRounds}`;
        }
      } else if (w.on === 'player') {
        if (actorLocation(base, actor) !== base.player.location) problem = 'the clerk is not with you';
      }
      if (problem) problems.push(`wait_for: ${problem}`);
      else {
        for (const old of this.unresolved()) {
          if (old.kind === 'wait' && old.responsible === actor) this.close(old, 'superseded', 'engine', t.turnId, at, null, t.turnId);
        }
        this.create(
          {
            sourceKey: `wait:${t.turnId}`,
            kind: 'wait',
            responsible: actor,
            from: actor,
            topic: null,
            text: clip(w.reason ?? '', 200),
            basis: 'own',
            refs: requestItemIds,
            source: { type: 'turn', ref: t.turnId, turnId: t.turnId, dialogueSeq: null, proposalId: null, requestItemId: null, how: w.on },
            eligibleFrom: { round, step: step + 1 },
            status: 'waiting',
            waiting: { on: w.on, who, round: w.round, reason: clip(w.reason ?? '', 200), requestItemIds },
          },
          at,
        );
      }
    }

    // Supplied items the turn did not deal with: seen (offers stay open while they await an answer).
    for (const it of supplied) {
      if (isClosed(it) || handled.has(it.itemId)) continue;
      if (it.kind === 'offer') {
        this.event(it, 'seen', at, t.turnId);
      } else if (it.kind === 'wait') {
        if (it.status === 'open') this.close(it, 'supplied_after_condition', 'engine', t.turnId, at, null, t.turnId);
      } else if (it.status === 'open') {
        it.status = 'seen';
        this.event(it, 'seen', at, t.turnId);
        if (it.kind === 'request') this.noReply(it, at, round, step);
      }
    }

    // Repetition (speech) and invalid metadata notes.
    if (speech) {
      const norm = normalizeSpeech(speech);
      const list = (L.speeches[actor] ??= []);
      const prior = norm.length > 0 ? list.find((x) => x.norm === norm) : undefined;
      if (prior) {
        L.counters.repeatedSpeech += 1;
        notes.push({ kind: 'repeated_speech', text: `your last speech repeated what you said before (${prior.seq !== null ? `dialogue:${prior.seq}` : prior.turnId}); repeating it moves nothing forward`, ref: prior.seq !== null ? `dialogue:${prior.seq}` : null });
      }
      list.push({ seq: t.speechSeq, norm, turnId: t.turnId, round });
    }
    if (problems.length > 0) {
      L.counters.invalidMetadata += problems.length;
      const earlier = L.items.some((x) => x.kind === 'feedback' && x.source.type === 'interaction' && x.responsible === actor && x.created.round === round);
      this.create(
        {
          sourceKey: `meta:${t.turnId}`,
          kind: 'feedback',
          responsible: actor,
          from: 'system',
          topic: 'interaction',
          text: `Your interaction entries were not accepted (no effect): ${problems.join('; ')}`,
          basis: 'verified',
          refs: [],
          source: { type: 'interaction', ref: t.turnId, turnId: t.turnId, dialogueSeq: null, proposalId: null, requestItemId: null, how: null },
          eligibleFrom: { round, step: step + 1 },
          ...(earlier ? { backoffRound: round + 1 } : {}),
        },
        at,
      );
      notes.push({ kind: 'invalid_metadata', text: `${problems.length} interaction entr${problems.length === 1 ? 'y was' : 'ies were'} not accepted (see feedback)`, ref: null });
    }
    L.notes[actor] = notes;
    L.lastTurnPos[actor] = at.pos;
  }

  /** A reply to `request` for its asker; meets the asker's wait on this answerer. */
  private reply(request: Item, t: TurnInput, how: string, text: string, at: ItemPosition, round: number, step: number): void {
    const asker = request.from;
    if (!isCharId(asker)) return;
    const it = this.create(
      {
        sourceKey: `reply:${request.itemId}:${t.turnId}`,
        kind: 'reply',
        responsible: asker,
        from: t.actor,
        topic: request.topic,
        text,
        basis: 'claim',
        refs: [...(t.speechSeq !== null ? [`dialogue:${t.speechSeq}`] : []), request.itemId],
        source: { type: 'turn', ref: t.turnId, turnId: t.turnId, dialogueSeq: t.speechSeq, proposalId: null, requestItemId: request.itemId, how },
        eligibleFrom: { round, step: step + 1 },
      },
      at,
    );
    if (it) this.meetWaits(asker, 'reply', t.actor, it, at);
  }

  /** The answerer saw a request and did not deal with it: an asker waiting on that answerer is told. */
  private noReply(request: Item, at: ItemPosition, round: number, step: number): void {
    const asker = request.from;
    for (const w of this.unresolved()) {
      if (w.kind !== 'wait' || w.responsible !== asker || w.status !== 'waiting' || w.waiting?.on !== 'reply' || w.waiting.who !== request.responsible) continue;
      w.status = 'open';
      w.eligibleFrom = { round, step: step + 1 };
      w.satisfied = { how: 'no_reply', ref: request.itemId, at: { ...at } };
      this.event(w, 'satisfied', at, null, `${request.responsible} saw ${request.itemId} and did not answer`);
    }
  }

  /** Waits of `holder` on `on` from `who` are met by `item` (the item itself is the trigger). */
  private meetWaits(holder: CharId, on: WaitOn, who: ActorId | null, item: Item, at: ItemPosition): void {
    for (const w of this.unresolved()) {
      if (w.kind !== 'wait' || w.responsible !== holder || w.status !== 'waiting' || w.waiting?.on !== on) continue;
      if (on !== 'player' && w.waiting.who !== who) continue;
      w.satisfied = { how: 'condition_met', ref: item.itemId, at: { ...at } };
      this.event(w, 'satisfied', at, null, item.itemId);
      this.close(w, 'condition_met', 'fact', item.itemId, at);
    }
  }

  private feedback(p: ProposalFact, at: ItemPosition, round: number, step: number): void {
    const actor = p.actor as CharId;
    const key = `prop:${p.proposalId}`;
    if (p.status === 'format_error') {
      const earlier = this.L.items.some((x) => x.kind === 'feedback' && x.responsible === actor && x.attempted?.status === 'format_error' && x.created.round === round);
      this.create(
        {
          sourceKey: key,
          kind: 'feedback',
          responsible: actor,
          from: 'system',
          topic: 'format',
          text: 'Your last output could not be read (format error) and was treated as waiting. Reply with the JSON object only.',
          basis: 'verified',
          refs: [],
          source: { type: 'proposal', ref: p.proposalId, turnId: null, dialogueSeq: null, proposalId: p.proposalId, requestItemId: null, how: p.status },
          eligibleFrom: { round, step: step + 1 },
          attempted: { type: p.type, args: null, proposalId: p.proposalId, status: p.status },
          ...(earlier ? { backoffRound: round + 1 } : {}),
        },
        at,
      );
      return;
    }
    const text =
      p.status === 'withheld'
        ? `The clerk withheld it${p.adviceText ? `: ${clip(p.adviceText, 300)}` : '.'}`
        : (p.feedback ?? 'It could not be carried out as proposed.');
    const refs = primaryRefs(p.type, p.args);
    const signature = `${p.type}|${refs.join(',')}|${p.status}|${text}`;
    const prev = [...this.L.items].reverse().find((x) => x.kind === 'feedback' && x.responsible === actor && x.source.type === 'proposal' && x.attempted && signatureOf(x) === signature);
    if (prev) this.L.counters.repeatedInvalid += 1;
    const it = this.create(
      {
        sourceKey: key,
        kind: 'feedback',
        responsible: actor,
        from: 'system',
        topic: refs[0] ?? null,
        text,
        basis: 'verified',
        refs: [...refs, ...(p.adviceSeq !== null ? [`dialogue:${p.adviceSeq}`] : [])],
        source: { type: 'proposal', ref: p.proposalId, turnId: null, dialogueSeq: p.adviceSeq, proposalId: p.proposalId, requestItemId: null, how: p.status },
        eligibleFrom: { round, step: step + 1 },
        attempted: { type: p.type, args: compactArgs(p.args), proposalId: p.proposalId, status: p.status },
        ...(prev ? { repeatOf: prev.itemId, repeats: prev.repeats + 1, backoffRound: round + 1 } : {}),
      },
      at,
    );
    if (prev && it) this.close(prev, 'superseded_by_repeat', 'engine', it.itemId, at);
  }

  /** Closures that follow from committed facts at this point. */
  factPass(state: WorldState, at: ItemPosition): void {
    for (const it of this.unresolved()) {
      if (!isAlive(state, it.responsible)) {
        this.obsolete(it, 'the responsible character is no longer alive', at);
        continue;
      }
      if (it.kind === 'offer') {
        const offer = state.offers[it.refs[0] ?? ''];
        if (!liveAwaiting(state, offer)) {
          this.close(it, offer ? (offer.status === 'delivered' ? 'closed' : offer.status) : 'closed', 'fact', offer?.id ?? null, at);
        }
        continue;
      }
      if (it.kind === 'feedback' && it.attempted && it.source.type === 'proposal') {
        const { type, args } = it.attempted;
        const docId = DOC_ACTIONS.has(type) ? (args?.docId as string | undefined) : type === 'suggest_revision' ? ((args?.target as { id?: string } | undefined)?.id ?? undefined) : undefined;
        if (docId && state.documents[docId]?.status === 'sent') {
          this.close(it, 'object_closed', 'fact', docId, at, `${docId} has been sent`);
          continue;
        }
        const offerId = OFFER_ACTIONS.has(type) ? (args?.offerId as string | undefined) : undefined;
        if (offerId && type !== 'withdraw_offer' && state.offers[offerId] && !liveAwaiting(state, state.offers[offerId])) {
          this.close(it, 'object_closed', 'fact', offerId, at, `${offerId} no longer awaits an answer`);
        }
        continue;
      }
      if (it.kind === 'wait' && it.status === 'waiting' && it.waiting && (it.waiting.on === 'reply' || it.waiting.on === 'delivery')) {
        const who = it.waiting.who;
        if (isCharId(who) && !isAlive(state, who)) {
          this.close(it, 'impossible', 'fact', who, at, `${who} is no longer alive`);
          this.create(
            {
              sourceKey: `waitx:${it.itemId}`,
              kind: 'feedback',
              responsible: it.responsible,
              from: 'system',
              topic: 'interaction',
              text: `Your wait (${it.itemId}) cannot be met: ${who} is no longer alive. Reconsider.`,
              basis: 'verified',
              refs: [it.itemId],
              source: { type: 'interaction', ref: it.itemId, turnId: null, dialogueSeq: null, proposalId: null, requestItemId: null, how: 'impossible' },
              eligibleFrom: { round: at.round, step: at.step + 1 },
            },
            at,
          );
        }
      }
    }
  }
}

function signatureOf(it: Item): string {
  const a = it.attempted as ItemAttempt;
  return `${a.type}|${primaryRefs(a.type, a.args).join(',')}|${a.status}|${it.text}`;
}

/** Something `actor` sent to `who` still awaits `who`'s answer (in transit, a live offer, or no word back since). */
function awaitsAnswerFrom(state: WorldState, actor: CharId, who: CharId): boolean {
  const mine = Object.values(state.messages).filter((m) => m.from === actor && m.to === who);
  for (const m of mine) {
    if (m.status === 'in_transit') return true;
    if (m.kind === 'offer') {
      const offerId = (m.payload as { offerId?: string }).offerId;
      if (offerId && liveAwaiting(state, state.offers[offerId])) return true;
    }
    const answered = Object.values(state.messages).some((x) => x.from === who && x.to === actor && x.status === 'delivered' && x.sentDay >= m.sentDay);
    if (!answered) return true;
  }
  return false;
}

function messageRefs(m: Message): string[] {
  const p = m.payload as { offerId?: string; commitmentId?: string };
  return [m.id, ...(p.offerId ? [p.offerId] : []), ...(p.commitmentId ? [p.commitmentId] : [])];
}

function messageText(m: Message, lang: 'zh' | 'en'): string {
  const p = m.payload;
  switch (p.kind) {
    case 'letter':
      return `letter: ${clip(p.text, 300)}`;
    case 'intel':
      return `intelligence report: ${clip(lang === 'zh' ? p.text.zh : p.text.en, 200)}`;
    case 'response':
      return `answer to your offer ${p.offerId}: ${p.response}${p.reason ? ` — ${clip(p.reason, 200)}` : ''}`;
    case 'withdrawal':
      return `withdrawal of offer ${p.offerId}`;
    case 'withdrawal_result':
      return `withdrawal of your offer ${p.offerId}: ${p.effective ? 'effective' : 'too late (already answered)'}`;
    case 'offer':
      return `offer ${p.offerId}`;
  }
}

/** Derives the ledger from a base (branch inheritance; null for a root session) and the happenings in order. */
export function deriveLedger(base: Ledger | null, inputs: DeriveInputs): Ledger {
  const b = new Builder(base, inputs);
  for (const h of inputs.happenings) b.apply(h);
  return b.L;
}

/** Items of a ledger whose position is before `cut` round (branching at a round start). */
export function ledgerBefore(ledger: Ledger, round: number): Ledger {
  const L = cloneLedger(ledger);
  const items: Item[] = [];
  for (const it of L.items) {
    if (it.created.round >= round) continue;
    const events = it.events.filter((e) => e.at.round < round);
    const last = events.at(-1);
    const keep: Item = { ...it, events };
    if (last) keep.status = last.status;
    if (it.closure && it.closure.at.round >= round) keep.closure = null;
    if (it.satisfied && it.satisfied.at.round >= round) keep.satisfied = null;
    if (it.firstSupplied && it.firstSupplied.round >= round) keep.firstSupplied = null;
    keep.supplied = events.filter((e) => e.kind === 'supplied').length;
    keep.responded = events.filter((e) => e.kind === 'responded').length;
    items.push(keep);
  }
  L.items = items;
  L.stepsInRound = Object.fromEntries(Object.entries(L.stepsInRound).filter(([r]) => Number(r) < round));
  L.gstep = Object.values(L.stepsInRound).reduce((a, b) => a + b, 0);
  for (const c of CHAR_IDS) {
    const list = L.speeches[c];
    if (list) L.speeches[c] = list.filter((s) => s.round < round);
  }
  // Control positions belong to the parent session: the child starts its own (closures shown again once).
  L.lastTurnPos = {};
  L.notes = {};
  return L;
}

// ---------------------------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------------------------

function before(round: number, step: number, from: { round: number; step: number }): boolean {
  return round < from.round || (round === from.round && step < from.step);
}

/** Whether an item triggers scheduling at (round, step). */
export function isActionable(it: Item, state: WorldState, round: number, step: number): boolean {
  if (it.status !== 'open') return false;
  if (!isAlive(state, it.responsible)) return false;
  if (it.backoffRound !== null && round < it.backoffRound) return false;
  if (before(round, step, it.eligibleFrom)) return false;
  if (it.kind === 'offer' && step > 1 && it.supplied > 0) return false;
  return true;
}

export function actionableItems(ledger: Ledger, state: WorldState, round: number, step: number): Item[] {
  return ledger.items.filter((it) => isActionable(it, state, round, step)).sort((a, b) => a.seq - b.seq);
}

const KIND_PRIORITY: Record<ItemKind, number> = { request: 0, reply: 1, feedback: 2, offer: 3, wait: 4, advice: 5, address: 6, delivery: 7 };

function viewOf(it: Item, state: WorldState, round: number, step: number): ItemView {
  return {
    id: it.itemId,
    kind: it.kind,
    from: it.from,
    topic: it.topic,
    text: it.text,
    basis: it.basis,
    status: it.status,
    since: `r${it.created.round}.s${it.created.step}`,
    shown: it.supplied,
    refs: [...it.refs],
    now: isActionable(it, state, round, step),
    attempted: it.attempted,
    repeats: it.repeats,
    how: it.source.how,
    waiting: it.waiting,
    satisfied: it.satisfied ? `${it.satisfied.how}${it.satisfied.ref ? ` (${it.satisfied.ref})` : ''}` : null,
  };
}

/** What a character's context shows of the ledger (structured; the context builder renders names). */
export function interactionViewFor(
  ledger: Ledger,
  charId: CharId,
  opts: { state: WorldState; round: number; step: number; maxSteps: number; activation?: { tier: string; reason: string } | null },
): InteractionContextView {
  const { state, round, step } = opts;
  const mine = ledger.items.filter((it) => it.responsible === charId && !isClosed(it));
  const items = mine
    .filter((it) => it.kind !== 'wait')
    .map((it) => viewOf(it, state, round, step))
    .sort((a, b) => Number(b.now) - Number(a.now) || KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] || Number(a.id.slice(1)) - Number(b.id.slice(1)));
  const waitItem = mine.find((it) => it.kind === 'wait') ?? null;
  const waiting = waitItem ? viewOf(waitItem, state, round, step) : null;
  const myRequests: RequestView[] = [];
  for (const it of ledger.items) {
    if (it.kind !== 'request' || it.from !== charId) continue;
    const recent = !isClosed(it) || (it.closure !== null && it.closure.at.round >= round - 1);
    if (!recent) continue;
    const reply = ledger.items.find((r) => r.kind === 'reply' && r.source.requestItemId === it.itemId);
    const status: RequestView['status'] = !isClosed(it)
      ? it.status === 'seen'
        ? 'seen_unanswered'
        : 'awaiting'
      : it.closure?.reason === 'answered' || it.closure?.reason === 'declined' || it.closure?.reason === 'acted'
        ? it.closure.reason
        : 'closed';
    myRequests.push({ id: it.itemId, to: it.responsible, topic: it.topic, question: it.text, status, reply: reply ? reply.itemId : null });
  }
  const last = ledger.lastTurnPos[charId] ?? -1;
  const resolvedSinceLastTurn = ledger.items
    .filter(
      (it) =>
        it.responsible === charId &&
        it.closure !== null &&
        it.closure.by !== 'model' &&
        it.closure.at.pos >= last &&
        it.closure.at.round >= round - 1 &&
        it.kind !== 'wait',
    )
    .slice(-8)
    .map((it) => ({ id: it.itemId, kind: it.kind, text: clip(it.text, 160), closure: `${it.closure?.reason ?? ''}${it.closure?.note ? `: ${it.closure.note}` : ''}` }));
  const notes = (ledger.notes[charId] ?? []).map((n) => n.text);
  for (const it of mine) {
    if (it.kind === 'offer' && it.supplied >= 2) notes.push(`${it.itemId}: this offer has been before you ${it.supplied} times; its sender is still waiting for your answer`);
  }
  const triggeredBy = items.filter((i) => i.now).map((i) => i.id);
  if (waiting?.now) triggeredBy.push(waiting.id);
  return {
    round,
    step,
    maxSteps: opts.maxSteps,
    activation: opts.activation ?? null,
    triggeredBy,
    items,
    myRequests,
    waiting,
    resolvedSinceLastTurn,
    notes,
    supplied: [...items.map((i) => i.id), ...(waiting ? [waiting.id] : [])],
  };
}

export interface LedgerStats {
  created: number;
  byKind: Record<string, number>;
  /** Items supplied to the responsible character at least once. */
  supplied: number;
  responded: number;
  resolved: number;
  obsolete: number;
  unresolved: number;
  unresolvedByKind: Record<string, number>;
  resolvedBy: Record<string, number>;
  /** Interaction steps from creation to first supply / to closure (supplied or closed items only). */
  stepsToSupply: number[];
  stepsToClose: number[];
  steps: number;
  stepsByRound: Record<string, number>;
  counters: LedgerCounters;
}

export function ledgerStats(ledger: Ledger): LedgerStats {
  const count = (list: readonly Item[], key: (i: Item) => string): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const i of list) out[key(i)] = (out[key(i)] ?? 0) + 1;
    return out;
  };
  const items = ledger.items;
  const open = items.filter((i) => !isClosed(i));
  return {
    created: items.length,
    byKind: count(items, (i) => i.kind),
    supplied: items.filter((i) => i.supplied > 0).length,
    responded: items.filter((i) => i.responded > 0).length,
    resolved: items.filter((i) => i.status === 'resolved').length,
    obsolete: items.filter((i) => i.status === 'obsolete').length,
    unresolved: open.length,
    unresolvedByKind: count(open, (i) => i.kind),
    resolvedBy: count(
      items.filter((i) => i.status === 'resolved'),
      (i) => i.closure?.reason ?? '?',
    ),
    stepsToSupply: items.filter((i) => i.firstSupplied).map((i) => (i.firstSupplied as ItemPosition).gstep - i.created.gstep),
    stepsToClose: items.filter((i) => i.closure).map((i) => (i.closure as ItemClosure).at.gstep - i.created.gstep),
    steps: ledger.gstep,
    stepsByRound: { ...ledger.stepsInRound },
    counters: { ...ledger.counters },
  };
}

/** Principal of the character's faction (used by views). */
export function principalFor(config: CoreConfig, state: WorldState, actor: ActorId): CharId | null {
  const side = sideOf(state, actor);
  return side ? principalOf(config, side) : null;
}
