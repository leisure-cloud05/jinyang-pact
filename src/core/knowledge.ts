/**
 * Knowledge (PLAN §3.3): structured, versioned assertions. A holder's belief about (subject, predicate) is its
 * latest assertion (highest id = most recently acquired). Validation of knowledge-dependent actions (H08) reads
 * these assertions, never the live world object. Messages create assertions only when delivered.
 *
 * Subject conventions: `offer:N` (predicates `terms`, `status`), `cmt:N` (`status`), `offer:N/withdrawal`
 * (`status`: pending | effective | late), `doc:N` (`content`), `msg:N` (`claim` for letters and intel).
 */
import type { Draft } from './reducer.js';
import { compareIds, own } from './ids.js';
import {
  ASSISTANCE_PAIR,
  PERSON_IDS,
  type ActorId,
  type CharId,
  type CoreConfig,
  type Document,
  type EvidenceKind,
  type FactionId,
  type JsonValue,
  type KnowledgeItem,
  type KnowledgePredicate,
  type LocId,
  type Offer,
  type SecretClause,
  type TermSet,
  type WorldState,
} from './types.js';

// ---------------------------------------------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------------------------------------------

export function isCharId(actor: ActorId): actor is CharId {
  return actor !== 'player' && actor !== 'system';
}

export function actorLocation(state: WorldState, actor: ActorId): LocId | null {
  if (actor === 'player') return state.player.location;
  if (actor === 'system') return null;
  return state.characters[actor].location;
}

export function isAlive(state: WorldState, actor: ActorId): boolean {
  if (!isCharId(actor)) return true;
  return state.characters[actor].status === 'alive';
}

export function actorFaction(state: WorldState, config: CoreConfig, actor: ActorId): FactionId | null {
  if (actor === 'player') return config.player.faction;
  if (actor === 'system') return null;
  return state.characters[actor].faction;
}

export function coLocated(state: WorldState, a: ActorId, b: ActorId): boolean {
  const la = actorLocation(state, a);
  return la !== null && la === actorLocation(state, b);
}

/** Alive persons (characters and player) at a location, in canonical order. */
export function presentAt(state: WorldState, loc: LocId): ActorId[] {
  return PERSON_IDS.filter((p) => isAlive(state, p) && actorLocation(state, p) === loc);
}

export function isPlayerSide(state: WorldState, config: CoreConfig, actor: ActorId): boolean {
  if (actor === 'player') return true;
  if (actor === 'system') return false;
  return state.characters[actor].faction === config.player.faction;
}

// ---------------------------------------------------------------------------------------------------------------
// Beliefs
// ---------------------------------------------------------------------------------------------------------------

export function knowledgeOf(state: WorldState, holder: ActorId): KnowledgeItem[] {
  return Object.keys(state.knowledge)
    .sort(compareIds)
    .map((id) => own(state.knowledge, id) as KnowledgeItem)
    .filter((k) => k.holder === holder);
}

export function latestBelief(
  state: WorldState,
  holder: ActorId,
  subject: string,
  predicate: KnowledgePredicate,
): KnowledgeItem | null {
  let best: KnowledgeItem | null = null;
  for (const item of Object.values(state.knowledge)) {
    if (item.holder !== holder || item.subject !== subject || item.predicate !== predicate) continue;
    if (best === null || compareIds(item.id, best.id) > 0) best = item;
  }
  return best;
}

/** Latest assertion per (subject, predicate), in id order. */
export function currentBeliefs(state: WorldState, holder: ActorId): KnowledgeItem[] {
  const latest = new Map<string, KnowledgeItem>();
  for (const item of knowledgeOf(state, holder)) latest.set(`${item.subject}\u0000${item.predicate}`, item);
  return [...latest.values()].sort((a, b) => compareIds(a.id, b.id));
}

export function believedStatus(state: WorldState, holder: ActorId, subject: string): string | null {
  const item = latestBelief(state, holder, subject, 'status');
  return item && typeof item.value === 'string' ? item.value : null;
}

export function believedOfferStatus(state: WorldState, holder: ActorId, offerId: string): string | null {
  return believedStatus(state, holder, offerId);
}

export function believedThreadStatus(state: WorldState, holder: ActorId, commitmentId: string): string | null {
  return believedStatus(state, holder, commitmentId);
}

export function withdrawalBelief(state: WorldState, holder: ActorId, offerId: string): string | null {
  return believedStatus(state, holder, `${offerId}/withdrawal`);
}

function termsVersionOf(value: JsonValue): number | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const tv = value.termsVersion;
    return typeof tv === 'number' ? tv : null;
  }
  return null;
}

/** Receipt evidence of an offer's terms at a given termsVersion (H08). */
export function hasReceiptEvidence(state: WorldState, holder: ActorId, offerId: string, termsVersion: number): boolean {
  return Object.values(state.knowledge).some(
    (k) => k.holder === holder && k.subject === offerId && k.predicate === 'terms' && termsVersionOf(k.value) === termsVersion,
  );
}

export function knowsSubject(state: WorldState, holder: ActorId, subject: string): boolean {
  return Object.values(state.knowledge).some((k) => k.holder === holder && k.subject === subject);
}

export interface NewBelief {
  holder: ActorId;
  subject: string;
  predicate: KnowledgePredicate;
  value: unknown;
  evidence: { kind: EvidenceKind; ref: string };
  credibility?: number;
  visibility?: KnowledgeItem['visibility'];
}

/** Adds an assertion acquired now (asOfDay = current day). */
export function addBelief(d: Draft, belief: NewBelief): string {
  const id = d.nextId('k');
  const item: KnowledgeItem = {
    id,
    holder: belief.holder,
    subject: belief.subject,
    predicate: belief.predicate,
    value: belief.value as JsonValue,
    asOfDay: d.s.day,
    evidence: belief.evidence,
    credibility: belief.credibility ?? 1,
    visibility: belief.visibility ?? 'private',
  };
  d.set(['knowledge', id], item);
  return id;
}

// ---------------------------------------------------------------------------------------------------------------
// Secret clauses
// ---------------------------------------------------------------------------------------------------------------

function clauseIdsInValue(value: JsonValue): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const terms = value.terms;
  if (typeof terms !== 'object' || terms === null || Array.isArray(terms)) return [];
  const clauses = terms.secret_clauses;
  if (!Array.isArray(clauses)) return [];
  return clauses
    .map((c) => (typeof c === 'object' && c !== null && !Array.isArray(c) && typeof c.id === 'string' ? c.id : null))
    .filter((id): id is string => id !== null);
}

/** An actor knows a clause if listed in its `knownBy` or if it received/observed terms containing it. */
export function knowsClause(state: WorldState, config: CoreConfig, actor: ActorId, clauseId: string): boolean {
  const def = own(config.catalog.secretClauses, clauseId);
  if (def && def.knownBy.includes(actor)) return true;
  return Object.values(state.knowledge).some((k) => k.holder === actor && clauseIdsInValue(k.value).includes(clauseId));
}

export function clauseFromCatalog(config: CoreConfig, clauseId: string): SecretClause | null {
  const def = own(config.catalog.secretClauses, clauseId);
  return def ? { id: def.id, text: def.text, canary: def.canary, knownBy: [...def.knownBy] } : null;
}

/** Clause resolver for an actor's term args: only clauses the actor knows resolve. */
export function clauseLookupFor(state: WorldState, config: CoreConfig, actor: ActorId): (id: string) => SecretClause | null {
  return (id) => (knowsClause(state, config, actor, id) ? clauseFromCatalog(config, id) : null);
}

/** Term set as seen by `actor`: secret clauses it does not know are removed. */
export function filterTermsFor(state: WorldState, config: CoreConfig, actor: ActorId, terms: TermSet): TermSet {
  return { ...terms, secret_clauses: terms.secret_clauses.filter((c) => knowsClause(state, config, actor, c.id)) };
}

/** Everyone who holds a clause (knownBy or via assertions) — for leakage evaluation. */
export function clauseHolders(state: WorldState, config: CoreConfig, clauseId: string): ActorId[] {
  return PERSON_IDS.filter((p) => knowsClause(state, config, p, clauseId));
}

// ---------------------------------------------------------------------------------------------------------------
// Access and observation
// ---------------------------------------------------------------------------------------------------------------

/** Documents are physically with their holder: access needs `accessibleBy` and co-location with the holder. */
export function canAccessDocument(state: WorldState, actor: ActorId, doc: Document): boolean {
  return doc.accessibleBy.includes(actor) && isAlive(state, actor) && coLocated(state, actor, doc.holder);
}

/** Configured readers of a principal's correspondence who are alive and co-located with the principal now. */
export function correspondenceReaders(state: WorldState, config: CoreConfig, principal: CharId): ActorId[] {
  const readers = config.correspondence[principal] ?? [];
  return readers.filter((r) => r !== principal && isAlive(state, r) && coLocated(state, r, principal));
}

/** Observers of a document event: accessible, alive, co-located with the holder. */
export function documentObservers(state: WorldState, doc: Document): ActorId[] {
  return PERSON_IDS.filter((p) => canAccessDocument(state, p, doc));
}

export function documentView(state: WorldState, config: CoreConfig, actor: ActorId, doc: Document): Record<string, unknown> {
  return {
    docId: doc.id,
    version: doc.version,
    status: doc.status,
    terms: filterTermsFor(state, config, actor, doc.terms),
    note: doc.note,
    timing: doc.timing,
    approval: doc.approval,
    to: doc.to,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// What the player sees
// ---------------------------------------------------------------------------------------------------------------

/** Negotiation of the assistance pair as far as the player's own assertions reveal it. */
export interface PlayerNegotiationView {
  offers: Array<{
    offerId: string;
    commitmentId: string;
    from: string;
    to: string;
    termsVersion: number;
    believedStatus: string | null;
    segment: number;
    segmentRound: number;
  }>;
  /** Latest segment the player knows of (from known offers, or a segment the player's own decision opened). */
  segment: number;
  /** Rounds used in that segment among the offers the player knows. */
  roundsUsed: number;
}

export interface PlayerView {
  round: number;
  day: number;
  location: LocId;
  siege: WorldState['siege'];
  resources: WorldState['factions'][FactionId];
  documents: Record<string, unknown>[];
  beliefs: KnowledgeItem[];
  goal: WorldState['player']['goal'];
  authorizations: WorldState['player']['authorizations'];
  assistanceAbandoned: boolean;
  negotiation: PlayerNegotiationView;
  terminal: WorldState['terminal'];
}

function playerNegotiation(state: WorldState): PlayerNegotiationView {
  const offers = Object.keys(state.offers)
    .sort(compareIds)
    .map((id) => own(state.offers, id) as Offer)
    .filter((o) => own(state.commitments, o.commitmentId)?.pair === ASSISTANCE_PAIR && knowsSubject(state, 'player', o.id))
    .map((o) => ({
      offerId: o.id,
      commitmentId: o.commitmentId,
      from: o.from,
      to: o.to,
      termsVersion: o.termsVersion,
      believedStatus: believedOfferStatus(state, 'player', o.id),
      segment: o.segment,
      segmentRound: o.segmentRound,
    }));
  const n = state.negotiation[ASSISTANCE_PAIR];
  let segment = offers.reduce((m, o) => Math.max(m, o.segment), 0);
  // A segment opened by a (player's) deadlock decision is known to the player even before any offer in it.
  if (n.segmentOpenedBy !== null && n.segmentOpenedBy !== 'first_offer' && n.segment > segment) segment = n.segment;
  const roundsUsed = offers.filter((o) => o.segment === segment).reduce((m, o) => Math.max(m, o.segmentRound), 0);
  return { offers, segment, roundsUsed };
}

/** Player-visible facts: own faction's resources and siege, accessible documents, own assertions. */
export function playerView(state: WorldState, config: CoreConfig): PlayerView {
  const docs = Object.keys(state.documents)
    .sort(compareIds)
    .map((id) => own(state.documents, id) as Document)
    .filter((doc) => canAccessDocument(state, 'player', doc))
    .map((doc) => documentView(state, config, 'player', doc));
  return structuredClone({
    round: state.round,
    day: state.day,
    location: state.player.location,
    siege: state.siege,
    resources: state.factions[config.player.faction],
    documents: docs,
    beliefs: currentBeliefs(state, 'player'),
    goal: state.player.goal,
    authorizations: state.player.authorizations,
    assistanceAbandoned: state.flags.assistanceAbandoned,
    negotiation: playerNegotiation(state),
    terminal: state.terminal,
  });
}
