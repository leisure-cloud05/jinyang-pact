/**
 * Authorized character context (PLAN §9.2). Everything a character model sees is built here, from:
 * - its persona (character config, possibly case-overridden);
 * - its own knowledge assertions (latest belief per subject/predicate), never the live world object — except
 *   documents it can physically access now (core `canAccessDocument`: accessibleBy + co-located with the holder);
 * - dialogue rows where it was a listener (or the speaker), advice addressed to it, last round's redacted feedback;
 * - live offers / threads as its assertions describe them, with the negotiation-segment status derived from the
 *   offers it knows (after an exhausted segment only confirm/reject remain);
 * - source entries with `learnable_by {holder: <char>, when: initial}`, serialized with only the character-safe
 *   fields (`original_zh`, `gloss_en`, `event_time` without its commentary note, `location`, `persons`, plus the
 *   entry id as citation key) — never credibility/retrospective notes, derived_from or conflicts_with.
 * Secret-clause text appears only inside a document or offer the character can see, and only for clauses it
 * knows (core `knowsClause`: knownBy or received terms containing it). The scenario start note describes Hedong's
 * internal business and is shown to Hedong characters only.
 *
 * Deterministic truncation to the budget: oldest dialogue first, then lower-priority sources, then the oldest
 * general beliefs. The structured object is what mock personas read (`meta`), the serialization is what the
 * model reads; both come from the same builder.
 */
import { compareIds, own } from '../core/ids.js';
import {
  actorLocation,
  canAccessDocument,
  currentBeliefs,
  filterTermsFor,
  isAlive,
  knowsClause,
  latestBelief,
  presentAt,
} from '../core/knowledge.js';
import { TERM_SEMANTICS, pairOf, payerFor } from '../core/terms.js';
import { CESSION_VALUES, LOC_IDS, PAIR_IDS, SCALAR_TERM_KEYS } from '../core/types.js';
import type {
  ActionType,
  ActorId,
  CharId,
  CoreConfig,
  Document,
  FactionId,
  JsonValue,
  KnowledgeItem,
  LocId,
  Offer,
  PairId,
  TermLimits,
  WorldState,
} from '../core/types.js';
import { preferenceFor, type CharacterConfig } from '../content/schema.js';
import { believedResources } from './ledger.js';
import { actorName, buildNames, loc, locationName, type AgentNames } from './names.js';
import { itemLine, type InteractionContextView } from './interaction-view.js';
import type { AgentContent, DialogueRow, FeedbackRow, Lang } from './types.js';
import { asTermSet, isLocalized, jsonLine, sanitizeJson, sha256Hex, stripMetaNote, termsView, type TermsView } from './util.js';

export const CHARACTER_CONTEXT_VERSION = 'ctx.character.v2';
/** Budget for the serialized context when the caller gives none (the agent computes it from the input cap). */
export const DEFAULT_CHARACTER_CONTEXT_BUDGET = 17_500;
export const DEFAULT_MAX_DIALOGUE = 40;
export const DEFAULT_MAX_ADVICE = 8;

export interface CharacterContextInput {
  content: AgentContent;
  /** Rules configuration (the case's clause library applied). */
  config: CoreConfig;
  state: WorldState;
  charId: CharId;
  lang: Lang;
  /** Persona to use (e.g. a case's effective character); defaults to `content.characters[charId]`. */
  persona?: CharacterConfig;
  /** All dialogue rows of the session so far (filtered here to what the character heard). */
  dialogue?: readonly DialogueRow[];
  /**
   * Redacted feedback on this character's proposals (legacy path, used only when no `interaction` view is given; no
   * age filter: unresolved feedback is never dropped because it is old).
   */
  feedback?: readonly FeedbackRow[];
  /**
   * The interaction view (PLAN §10.4): why the character is called now and the unresolved items it is responsible
   * for (feedback included). Pinned: never truncated away; dialogue rows it refers to are pinned too.
   */
  interaction?: InteractionContextView | null;
  /** Budget in characters for the serialized context. */
  maxChars?: number;
  maxDialogue?: number;
  /** Agenda ids activated by the scene scheduler; omitted/null = derived from the character's own view. */
  activeAgendaIds?: readonly string[] | null;
  names?: AgentNames;
}

export interface PreferenceView {
  kind: 'reservation' | 'tolerance';
  pair: PairId;
  /** Only the constrained keys (null limits are omitted). */
  limits: Partial<TermLimits>;
  note: string | null;
}

export interface PersonaView {
  id: CharId;
  name: string;
  title: string;
  faction: FactionId;
  factionName: string;
  principal: boolean;
  location: LocId;
  locationName: string;
  permissions: ActionType[];
  goals: string[];
  privateMemory: string[];
  voice: string;
  /**
   * Private bottom lines per principal pair (Yelü/Li reservation, Shi tolerance; core-schema `preferenceFor`):
   * persona preferences, never enforced by the harness.
   */
  preferences: PreferenceView[];
  agendas: { id: string; text: string }[];
}

export interface CatalogEntryView {
  key: string;
  label: string;
  type: 'boolean' | 'integer' | 'enum';
  min: number | null;
  max: number | null;
  step: number | null;
  burden_weight: number;
  burden_unit: number | null;
  burden_by_value: Record<string, number> | null;
  values: { value: string; label: string }[] | null;
  /** Relevant pairs and who pays the term in each. */
  pairs: { pair: PairId; paidBy: FactionId | null }[];
}

export interface DocumentContextView {
  docId: string;
  holder: CharId;
  to: CharId;
  pair: PairId | null;
  version: number;
  status: Document['status'];
  approvedVersion: number | null;
  timing: Document['timing'];
  note: string;
  terms: TermsView;
  /** `observed` = physically accessible now; `last_known` = from the character's latest content assertion. */
  basis: 'observed' | 'last_known';
  asOfDay: number | null;
}

export interface SuggestionView {
  id: string;
  by: ActorId;
  byName: string;
  target: { kind: 'document' | 'offer'; id: string };
  targetVersion: number;
  changes: Record<string, JsonValue>;
  reason: string;
  round: number;
}

export interface OfferContextView {
  offerId: string;
  commitmentId: string;
  from: CharId;
  to: CharId;
  termsVersion: number;
  terms: TermsView;
  /** Believed status: sent | delivered | accepted | countered | rejected | withdrawn. */
  status: string | null;
  /** Believed status of a withdrawal of this offer: pending | effective | late. */
  withdrawal: string | null;
  asOfDay: number;
  segment: number;
  segmentRound: number;
  /** This character holds it, delivered and unanswered, and may confirm / counter / reject it. */
  awaitingMyAnswer: boolean;
  /** Delivered and unanswered, addressed to someone else (e.g. Sang observing Shi's correspondence). */
  awaitingAnswerFrom: CharId | null;
  /** Ids to copy into confirm_commitment / respond_to_offer. */
  ref: string;
}

export interface NegotiationContextView {
  pair: PairId;
  counterparty: CharId;
  counterpartyName: string;
  segment: number;
  roundsUsed: number;
  roundsRemaining: number;
  offersKnown: number;
  offersRemaining: number;
  nextOfferIsOpening: boolean;
  onlyConfirmOrReject: boolean;
  negotiatingThread: string | null;
  threads: { commitmentId: string; status: string | null; offers: OfferContextView[] }[];
}

export interface MessageView {
  ref: string;
  kind: 'letter' | 'intel';
  messageId: string;
  from: string;
  fromName: string;
  text: string;
  asOfDay: number;
  credibility: number;
}

export interface BeliefView {
  ref: string;
  subject: string;
  predicate: KnowledgeItem['predicate'];
  value: JsonValue;
  assumption: boolean;
  asOfDay: number;
  evidence: KnowledgeItem['evidence']['kind'];
  source: string | null;
  credibility: number;
}

export interface DialogueView {
  ref: string;
  seq: number;
  round: number;
  speaker: ActorId;
  speakerName: string;
  to: string[];
  kind: DialogueRow['kind'];
  text: string;
}

export interface AdviceView {
  ref: string;
  seq: number;
  round: number;
  from: ActorId;
  fromName: string;
  text: string;
  payload: JsonValue;
}

export interface SourceView {
  id: string;
  original_zh: string;
  gloss_en: string;
  event_time: { year: number; month: number | null; leap: boolean };
  location: string | null;
  persons: string[];
}

export interface CharacterContext {
  version: string;
  lang: Lang;
  self: PersonaView;
  time: { round: number; day: number; maxRounds: number; roundDays: number };
  scene: { location: LocId; locationName: string; present: { id: ActorId; name: string; role: string }[] };
  travel: { to: LocId; name: string; days: number }[];
  rules: {
    round_days: number;
    segment_round_cap: number;
    pair_offer_cap: number;
    delay_rounds_min: number;
    delay_rounds_max: number;
  };
  catalog: CatalogEntryView[];
  resources: { faction: FactionId; available: Record<string, number>; reserved: Record<string, number> };
  siege: { grain?: number; pressure: number; morale?: number } | null;
  background: string | null;
  documents: DocumentContextView[];
  suggestions: SuggestionView[];
  negotiations: NegotiationContextView[];
  messages: MessageView[];
  beliefs: BeliefView[];
  advice: AdviceView[];
  feedback: FeedbackRow[];
  dialogue: DialogueView[];
  sources: SourceView[];
  /** Interaction view with display names of the actors it mentions (null on the legacy path). */
  interaction: (InteractionContextView & { names: Record<string, string> }) | null;
}

export interface TruncationReport {
  budget: number;
  length: number;
  dialogueDropped: number;
  sourcesDropped: number;
  beliefsDropped: number;
  memoriesDropped: number;
  /** Dialogue rows kept because an unresolved item refers to them. */
  dialoguePinned: number;
  /** Items shown in compact form (id, kind, short text and the ref of the full text) to fit the budget. */
  itemsCompacted: number;
  overBudget: boolean;
}

export interface BuiltCharacterContext {
  context: CharacterContext;
  text: string;
  /** SHA-256 of `text`. */
  hash: string;
  /** Ids the character may cite (everything else is stripped from `cites` and counted). */
  citeKeys: string[];
  truncation: TruncationReport;
}

// ---------------------------------------------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------------------------------------------

function limitsView(limits: Record<string, unknown>): Partial<TermLimits> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(limits)) {
    if (k === 'note' || v === null || v === undefined) continue;
    out[k] = v;
  }
  return out as Partial<TermLimits>;
}

/** Pairs a faction takes part in that have at least one applicable term. */
export function relevantPairs(config: CoreConfig, faction: FactionId): PairId[] {
  return PAIR_IDS.filter(
    (pair) =>
      pair.split('-').includes(faction) &&
      SCALAR_TERM_KEYS.some((k) => config.catalog.terms[k].applicable_pairs.includes(pair)),
  );
}

function counterpartOf(config: CoreConfig, pair: PairId, faction: FactionId): CharId {
  const [a, b] = pair.split('-') as [FactionId, FactionId];
  return config.factions[a === faction ? b : a].principal;
}

function catalogView(content: AgentContent, config: CoreConfig, pairs: PairId[], lang: Lang): CatalogEntryView[] {
  const out: CatalogEntryView[] = [];
  for (const key of SCALAR_TERM_KEYS) {
    const entry = config.catalog.terms[key];
    const applicable = pairs.filter((p) => entry.applicable_pairs.includes(p));
    if (applicable.length === 0) continue;
    const raw = content.scenario.terms_catalog.terms.find((t) => t.key === key);
    const values =
      key === 'cession'
        ? CESSION_VALUES.map((v) => {
            const label = raw?.value_labels?.[v];
            return { value: v, label: label ? loc(label, lang) : v };
          })
        : null;
    out.push({
      key,
      label: loc(entry.label, lang),
      type: raw?.type ?? TERM_SEMANTICS[key].type,
      min: entry.min,
      max: entry.max,
      step: entry.step,
      burden_weight: entry.burden_weight,
      burden_unit: entry.burden_unit,
      burden_by_value: entry.burden_by_value,
      values,
      pairs: applicable.map((pair) => ({ pair, paidBy: payerFor(key, pair) })),
    });
  }
  return out;
}

function documentPairOf(state: WorldState, config: CoreConfig, doc: Document): PairId | null {
  const holderFaction = state.characters[doc.holder].faction;
  const sender = config.factions[holderFaction].principal;
  return pairOf(state.characters[sender].faction, state.characters[doc.to].faction);
}

function documentsFor(state: WorldState, config: CoreConfig, charId: CharId, lang: Lang): DocumentContextView[] {
  const out: DocumentContextView[] = [];
  for (const id of Object.keys(state.documents).sort(compareIds)) {
    const doc = own(state.documents, id) as Document;
    const pair = documentPairOf(state, config, doc);
    if (canAccessDocument(state, charId, doc)) {
      out.push({
        docId: doc.id,
        holder: doc.holder,
        to: doc.to,
        pair,
        version: doc.version,
        status: doc.status,
        approvedVersion: doc.approval?.version ?? null,
        timing: { ...doc.timing },
        note: doc.note,
        terms: termsView(filterTermsFor(state, config, charId, doc.terms), config.catalog, pair, lang),
        basis: 'observed',
        asOfDay: null,
      });
      continue;
    }
    const belief = latestBelief(state, charId, doc.id, 'content');
    const value = belief?.value;
    if (!belief || typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const terms = asTermSet(value.terms);
    if (!terms) continue;
    const approval = value.approval as { version?: number } | null | undefined;
    out.push({
      docId: doc.id,
      holder: doc.holder,
      to: doc.to,
      pair,
      version: typeof value.version === 'number' ? value.version : doc.version,
      status: (typeof value.status === 'string' ? value.status : doc.status) as Document['status'],
      approvedVersion: approval && typeof approval.version === 'number' ? approval.version : null,
      timing: (value.timing as unknown as Document['timing']) ?? { mode: 'now', notBeforeRound: null },
      note: typeof value.note === 'string' ? value.note : '',
      terms: termsView(filterTermsFor(state, config, charId, terms), config.catalog, pair, lang),
      basis: 'last_known',
      asOfDay: belief.asOfDay,
    });
  }
  return out;
}

function suggestionsFor(state: WorldState, config: CoreConfig, charId: CharId, names: AgentNames, lang: Lang): SuggestionView[] {
  const faction = state.characters[charId].faction;
  const out: SuggestionView[] = [];
  for (const id of Object.keys(state.suggestions).sort(compareIds)) {
    const s = own(state.suggestions, id);
    if (!s) continue;
    const byFaction = s.by === 'player' ? config.player.faction : s.by === 'system' ? null : state.characters[s.by].faction;
    if (byFaction !== faction) continue;
    let visible = false;
    if (s.target.kind === 'document') {
      const doc = own(state.documents, s.target.id);
      visible = doc !== undefined && canAccessDocument(state, charId, doc);
    } else {
      visible = latestBelief(state, charId, s.target.id, 'terms') !== null;
    }
    if (!visible) continue;
    const changes: Record<string, JsonValue> = {};
    for (const key of SCALAR_TERM_KEYS) {
      const v = s.terms[key];
      if (v !== null) changes[key] = v;
    }
    if (s.terms.secret_clauses !== null) {
      changes.secret_clauses = s.terms.secret_clauses.filter((c) => knowsClause(state, config, charId, c));
    }
    out.push({
      id: s.id,
      by: s.by,
      byName: actorName(names, s.by, lang),
      target: { ...s.target },
      targetVersion: s.targetVersion,
      changes,
      reason: s.reason,
      round: s.round,
    });
  }
  return out;
}

interface KnownOffer {
  offer: Offer;
  pair: PairId;
  view: OfferContextView;
}

function knownOffers(state: WorldState, config: CoreConfig, charId: CharId, lang: Lang): KnownOffer[] {
  const out: KnownOffer[] = [];
  for (const id of Object.keys(state.offers).sort(compareIds)) {
    const offer = own(state.offers, id) as Offer;
    const termsBelief = latestBelief(state, charId, offer.id, 'terms');
    if (!termsBelief) continue;
    const thread = own(state.commitments, offer.commitmentId);
    if (!thread) continue;
    const v = termsBelief.value;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) continue;
    const terms = asTermSet(v.terms);
    if (!terms) continue;
    const status = latestBelief(state, charId, offer.id, 'status');
    const withdrawal = latestBelief(state, charId, `${offer.id}/withdrawal`, 'status');
    const threadStatus = latestBelief(state, charId, offer.commitmentId, 'status');
    const statusValue = typeof status?.value === 'string' ? status.value : null;
    const threadValue = typeof threadStatus?.value === 'string' ? threadStatus.value : null;
    const from = (typeof v.from === 'string' ? v.from : offer.from) as CharId;
    const to = (typeof v.to === 'string' ? v.to : offer.to) as CharId;
    const termsVersion = typeof v.termsVersion === 'number' ? v.termsVersion : offer.termsVersion;
    const open = statusValue === 'delivered' && (threadValue === null || threadValue === 'negotiating') && withdrawal?.value !== 'effective';
    out.push({
      offer,
      pair: thread.pair,
      view: {
        offerId: offer.id,
        commitmentId: offer.commitmentId,
        from,
        to,
        termsVersion,
        terms: termsView(filterTermsFor(state, config, charId, terms), config.catalog, thread.pair, lang),
        status: statusValue,
        withdrawal: typeof withdrawal?.value === 'string' ? withdrawal.value : null,
        asOfDay: termsBelief.asOfDay,
        segment: offer.segment,
        segmentRound: offer.segmentRound,
        awaitingMyAnswer: open && to === charId,
        awaitingAnswerFrom: open && to !== charId ? to : null,
        ref: `commitmentId=${offer.commitmentId} offerId=${offer.id} termsVersion=${termsVersion}`,
      },
    });
  }
  return out;
}

function negotiationsFor(
  state: WorldState,
  config: CoreConfig,
  charId: CharId,
  names: AgentNames,
  lang: Lang,
  offers: KnownOffer[],
): NegotiationContextView[] {
  const faction = state.characters[charId].faction;
  const playerSide = faction === config.player.faction;
  const pairs = relevantPairs(config, faction);
  for (const o of offers) if (!pairs.includes(o.pair)) pairs.push(o.pair);
  const out: NegotiationContextView[] = [];
  const cap = config.params.segment_round_cap;
  const pairCap = config.params.pair_offer_cap;
  for (const pair of PAIR_IDS.filter((p) => pairs.includes(p))) {
    const mine = offers.filter((o) => o.pair === pair);
    const principal = config.factions[faction].principal;
    // Non-principals only follow their principal's negotiations through what they observed.
    if (charId !== principal && mine.length === 0) continue;
    let segment = mine.reduce((m, o) => Math.max(m, o.offer.segment), 0);
    let roundsUsed = mine.filter((o) => o.offer.segment === segment).reduce((m, o) => Math.max(m, o.offer.segmentRound), 0);
    let hasOpening = mine.some((o) => o.offer.segment === segment);
    const n = state.negotiation[pair];
    // A segment opened by the player's own deadlock decision is known on the player's side before any offer in it.
    if (playerSide && n.segment > segment && n.segmentOpenedBy !== null && n.segmentOpenedBy !== 'first_offer') {
      segment = n.segment;
      roundsUsed = 0;
      hasOpening = false;
    }
    const nextOfferIsOpening = segment === 0 || !hasOpening;
    const roundsRemaining = nextOfferIsOpening ? cap : Math.max(0, cap - roundsUsed);
    const offersRemaining = Math.max(0, pairCap - mine.length);
    const threadIds = [...new Set(mine.map((o) => o.offer.commitmentId))].sort(compareIds);
    const threads = threadIds.map((cmtId) => {
      const belief = latestBelief(state, charId, cmtId, 'status');
      return {
        commitmentId: cmtId,
        status: typeof belief?.value === 'string' ? belief.value : null,
        offers: mine.filter((o) => o.offer.commitmentId === cmtId).map((o) => o.view),
      };
    });
    const counterparty = counterpartOf(config, pair, faction);
    out.push({
      pair,
      counterparty,
      counterpartyName: actorName(names, counterparty, lang),
      segment,
      roundsUsed: nextOfferIsOpening ? 0 : roundsUsed,
      roundsRemaining,
      offersKnown: mine.length,
      offersRemaining,
      nextOfferIsOpening,
      onlyConfirmOrReject: offersRemaining === 0 || (!nextOfferIsOpening && roundsRemaining === 0),
      negotiatingThread: threads.find((t) => t.status === 'negotiating')?.commitmentId ?? null,
      threads,
    });
  }
  return out;
}

const NEGOTIATION_SUBJECT = /^(?:offer:\d+(?:\/withdrawal)?|cmt:\d+)$/;
const MESSAGE_SUBJECT = /^msg:\d+$/;

function messagesAndBeliefs(
  state: WorldState,
  charId: CharId,
  names: AgentNames,
  lang: Lang,
  observedDocs: Set<string>,
): { messages: MessageView[]; beliefs: BeliefView[] } {
  const messages: MessageView[] = [];
  const beliefs: BeliefView[] = [];
  for (const k of currentBeliefs(state, charId)) {
    if (NEGOTIATION_SUBJECT.test(k.subject)) continue;
    if (k.predicate === 'content' && observedDocs.has(k.subject)) continue;
    if (k.predicate === 'content' && /^doc:\d+$/.test(k.subject)) continue; // rendered under documents (last_known)
    const v = k.value;
    if (MESSAGE_SUBJECT.test(k.subject) && k.predicate === 'claim' && typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const intel = typeof v.topic === 'string';
      const text = isLocalized(v.text) ? loc(v.text, lang) : typeof v.text === 'string' ? v.text : '';
      const from = intel ? 'system' : typeof v.from === 'string' ? v.from : 'unknown';
      messages.push({
        ref: k.id,
        kind: intel ? 'intel' : 'letter',
        messageId: k.subject,
        from: intel ? 'intelligence' : from,
        fromName: intel ? (lang === 'zh' ? '探报' : 'intelligence report') : actorName(names, from, lang),
        text,
        asOfDay: k.asOfDay,
        credibility: k.credibility,
      });
      continue;
    }
    const assumption = typeof v === 'object' && v !== null && !Array.isArray(v) && v.assumption === true;
    let value = sanitizeJson(v, lang);
    if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'assumption' in value) {
      const { assumption: _drop, ...rest } = value;
      value = Object.keys(rest).length === 1 && typeof rest.text === 'string' ? rest.text : rest;
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 1 && typeof value.text === 'string') {
      value = value.text;
    }
    beliefs.push({
      ref: k.id,
      subject: k.subject,
      predicate: k.predicate,
      value,
      assumption,
      asOfDay: k.asOfDay,
      evidence: k.evidence.kind,
      source: k.evidence.kind === 'source' ? k.evidence.ref : null,
      credibility: k.credibility,
    });
  }
  return { messages, beliefs };
}

/** Agenda activation from the character's own view (the engine's scheduler may pass explicit ids instead). */
function derivedAgendaActive(
  trigger: CharacterConfig['agendaTriggers'][number],
  ctx: Pick<CharacterContext, 'documents' | 'negotiations' | 'messages' | 'suggestions' | 'siege'>,
): boolean {
  const offers = ctx.negotiations.flatMap((n) => n.threads.flatMap((t) => t.offers));
  switch (trigger.on) {
    case 'round_start':
      return true;
    case 'offer_delivered':
      return offers.some((o) => o.awaitingMyAnswer || o.awaitingAnswerFrom !== null);
    case 'response_delivered':
      return offers.some((o) => o.status === 'accepted' || o.status === 'countered' || o.status === 'rejected');
    case 'document_revised':
      return ctx.documents.some((d) => d.basis === 'observed' && d.version > 1);
    case 'document_approved':
      return ctx.documents.some((d) => d.basis === 'observed' && d.status === 'approved');
    case 'suggestion_made':
      return ctx.suggestions.length > 0;
    case 'letter_delivered':
      return ctx.messages.some((m) => m.kind === 'letter');
    case 'intel_delivered':
      return ctx.messages.some((m) => m.kind === 'intel');
    case 'grain_below':
      return ctx.siege?.grain !== undefined && trigger.threshold !== null && ctx.siege.grain < trigger.threshold;
    case 'pressure_above':
      return ctx.siege !== null && trigger.threshold !== null && ctx.siege.pressure > trigger.threshold;
    case 'morale_below':
      return ctx.siege?.morale !== undefined && trigger.threshold !== null && ctx.siege.morale < trigger.threshold;
    default:
      return false;
  }
}

function sourceTier(persona: CharacterConfig, id: string): number {
  if (persona.initial_knowledge.some((k) => k.source_ref === id)) return 0;
  if (persona.private_memory.some((m) => (m.source_refs ?? []).includes(id))) return 0;
  if (persona.source_refs.includes(id)) return 1;
  return 2;
}

function sourcesFor(content: AgentContent, persona: CharacterConfig, charId: CharId): SourceView[] {
  const entries = Object.values(content.sources).filter((e) =>
    e.learnable_by.some((l) => l.holder === charId && l.when === 'initial'),
  );
  entries.sort(
    (a, b) =>
      sourceTier(persona, a.id) - sourceTier(persona, b.id) ||
      b.credibility - a.credibility ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return entries.map((e) => ({
    id: e.id,
    original_zh: e.original_zh,
    gloss_en: e.gloss_en,
    event_time: { year: e.event_time.year, month: e.event_time.month, leap: e.event_time.leap },
    location: e.location,
    persons: [...e.persons],
  }));
}

// ---------------------------------------------------------------------------------------------------------------
// Serialization and truncation
// ---------------------------------------------------------------------------------------------------------------

function section(title: string, items: readonly unknown[], empty = '(none)'): string {
  const body = items.length === 0 ? empty : items.map((i) => jsonLine(i)).join('\n');
  return `=== ${title} ===\n${body}`;
}

function interactionSections(ctx: CharacterContext, compact: ReadonlySet<string>): string[] {
  const view = ctx.interaction;
  if (!view) return [];
  const nameOf = (id: ActorId): string => view.names[id] ?? id;
  const now = {
    round: view.round,
    step: `${view.step} of at most ${view.maxSteps} this round`,
    reason: view.activation?.reason ?? 'scheduled',
    itemsNeedingAttentionNow: view.triggeredBy,
  };
  const parts = [
    section('WHY YOU ARE CALLED NOW', [now]),
    section(
      'ITEMS FOR YOU (unresolved; most urgent first — list those you deal with in interaction.addressed)',
      view.items.map((i) => itemLine(i, nameOf, compact.has(i.id))),
    ),
  ];
  const own = {
    requestsYouMade: view.myRequests.map((r) => ({ id: r.id, to: nameOf(r.to), toId: r.to, topic: r.topic, question: r.question, status: r.status, reply: r.reply })),
    yourWait: view.waiting ? itemLine(view.waiting, nameOf) : null,
  };
  if (own.requestsYouMade.length > 0 || own.yourWait) parts.push(section('YOUR REQUESTS AND WAIT', [own]));
  if (view.resolvedSinceLastTurn.length > 0) parts.push(section('RESOLVED SINCE YOUR LAST TURN (by facts; for your information)', view.resolvedSinceLastTurn));
  if (view.notes.length > 0) parts.push(section('NOTES ON YOUR RECENT TURNS', view.notes));
  return parts;
}

/** Deterministic text form of the context (what the model reads). */
export function serializeCharacterContext(ctx: CharacterContext, opts: { compact?: ReadonlySet<string> } = {}): string {
  const parts = [
    ...interactionSections(ctx, opts.compact ?? new Set()),
    section('YOU (persona)', [ctx.self]),
    section('TIME AND PLACE', [{ ...ctx.time, ...ctx.scene, travel: ctx.travel }]),
    section('RULE PARAMETERS', [ctx.rules]),
    section('TERMS CATALOG (keys you may use in terms; burden = what the paying side carries)', ctx.catalog),
    section('YOUR FACTION RESOURCES', [ctx.siege ? { ...ctx.resources, siege: ctx.siege } : ctx.resources]),
  ];
  if (ctx.background !== null) parts.push(section('BACKGROUND (note written for the clerk at the chapter start)', [ctx.background]));
  parts.push(
    section('DOCUMENTS YOU CAN SEE', ctx.documents),
    section('OPEN SUGGESTIONS (non-binding)', ctx.suggestions),
    section('NEGOTIATIONS AS YOU KNOW THEM', ctx.negotiations),
    section('LETTERS AND REPORTS RECEIVED (claims, not verified facts)', ctx.messages),
    section('WHAT YOU KNOW (your assertions; cite by ref)', ctx.beliefs),
    section('ADVICE ADDRESSED TO YOU', ctx.advice),
  );
  // With an interaction view, feedback is part of ITEMS FOR YOU (unresolved feedback persists there).
  if (!ctx.interaction) parts.push(section('FEEDBACK ON YOUR PROPOSALS', ctx.feedback));
  parts.push(
    section('DIALOGUE YOU HEARD (oldest first; what others said is their claim)', ctx.dialogue),
    section('HISTORICAL SOURCES YOU KNOW (cite by id)', ctx.sources),
  );
  return parts.join('\n\n');
}

function citeKeysOf(ctx: CharacterContext): string[] {
  const keys = new Set<string>();
  for (const s of ctx.sources) keys.add(s.id);
  for (const b of ctx.beliefs) keys.add(b.ref);
  for (const m of ctx.messages) {
    keys.add(m.ref);
    keys.add(m.messageId);
  }
  for (const d of ctx.documents) keys.add(d.docId);
  for (const n of ctx.negotiations) {
    for (const t of n.threads) {
      keys.add(t.commitmentId);
      for (const o of t.offers) keys.add(o.offerId);
    }
  }
  for (const s of ctx.suggestions) keys.add(s.id);
  for (const d of ctx.dialogue) keys.add(d.ref);
  for (const a of ctx.advice) keys.add(a.ref);
  return [...keys].sort();
}

/**
 * Deterministic truncation: oldest dialogue first (rows an unresolved item refers to are pinned), then
 * lower-priority sources, oldest beliefs, private memories; finally items already seen are shown in compact form
 * (oldest first) with the ref of their full text. Unresolved items are never dropped. Everything is reported.
 */
function fitToBudget(ctx: CharacterContext, budget: number): { text: string; report: TruncationReport } {
  const report: TruncationReport = {
    budget,
    length: 0,
    dialogueDropped: 0,
    sourcesDropped: 0,
    beliefsDropped: 0,
    memoriesDropped: 0,
    dialoguePinned: 0,
    itemsCompacted: 0,
    overBudget: false,
  };
  const compact = new Set<string>();
  const render = (): string => serializeCharacterContext(ctx, { compact });
  const pinned = new Set<string>();
  for (const it of [...(ctx.interaction?.items ?? []), ...(ctx.interaction?.waiting ? [ctx.interaction.waiting] : [])]) {
    for (const r of it.refs) if (r.startsWith('dialogue:')) pinned.add(r);
  }
  let text = render();
  const over = (): boolean => text.length > budget;
  while (over()) {
    const i = ctx.dialogue.findIndex((d) => !pinned.has(d.ref));
    if (i < 0) break;
    ctx.dialogue.splice(i, 1);
    report.dialogueDropped += 1;
    text = render();
  }
  report.dialoguePinned = ctx.dialogue.filter((d) => pinned.has(d.ref)).length;
  while (over() && ctx.sources.length > 0) {
    ctx.sources.pop();
    report.sourcesDropped += 1;
    text = render();
  }
  while (over() && ctx.beliefs.length > 0) {
    ctx.beliefs.shift();
    report.beliefsDropped += 1;
    text = render();
  }
  while (over() && ctx.self.privateMemory.length > 0) {
    ctx.self.privateMemory.shift();
    report.memoriesDropped += 1;
    text = render();
  }
  const compactable = [...(ctx.interaction?.items ?? [])].filter((i) => !i.now).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  for (const it of compactable) {
    if (!over()) break;
    compact.add(it.id);
    report.itemsCompacted += 1;
    text = render();
  }
  report.length = text.length;
  report.overBudget = over();
  return { text, report };
}

// ---------------------------------------------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------------------------------------------

export function buildCharacterContext(input: CharacterContextInput): BuiltCharacterContext {
  const { content, config, state, charId, lang } = input;
  const persona = input.persona ?? content.characters[charId];
  const names = input.names ?? buildNames(content, { [charId]: persona });
  const me = state.characters[charId];
  const faction = me.faction;
  const location = actorLocation(state, charId) ?? me.location;
  const pairs = relevantPairs(config, faction);
  const ledger = believedResources(state, charId, faction);

  const preferences: PreferenceView[] = [];
  for (const kind of ['reservation', 'tolerance'] as const) {
    for (const pair of pairs) {
      const pref = preferenceFor(persona[kind], pair);
      if (!pref) continue;
      const limits = limitsView(pref as unknown as Record<string, unknown>);
      const note = pref.note ? stripMetaNote(loc(pref.note, lang)) : null;
      if (Object.keys(limits).length === 0 && note === null) continue;
      preferences.push({ kind, pair, limits, note });
    }
  }

  const present = presentAt(state, location)
    .filter((p) => p !== charId)
    .map((p) => ({
      id: p,
      name: actorName(names, p, lang),
      role:
        p === 'player'
          ? lang === 'zh'
            ? '书记（玩家）'
            : 'the clerk (the player)'
          : p === 'system'
            ? ''
            : loc(names.characters[p].title, lang),
    }));

  const siege: CharacterContext['siege'] =
    faction === 'hedong'
      ? { grain: ledger.available.grain, pressure: state.siege.pressure, morale: state.siege.morale }
      : faction === 'tang'
        ? { pressure: state.siege.pressure }
        : null;

  const documents = documentsFor(state, config, charId, lang);
  const observedDocs = new Set(documents.filter((d) => d.basis === 'observed').map((d) => d.docId));
  const offers = knownOffers(state, config, charId, lang);
  const negotiations = negotiationsFor(state, config, charId, names, lang, offers);
  const { messages, beliefs } = messagesAndBeliefs(state, charId, names, lang, observedDocs);
  const suggestions = suggestionsFor(state, config, charId, names, lang);

  const heard = (input.dialogue ?? [])
    .filter((r) => r.speaker === charId || r.listeners.includes(charId))
    .sort((a, b) => a.seq - b.seq);
  // The last N rows heard, plus older rows an unresolved item refers to (retrieved by reference, PLAN §9.2).
  const pinnedSeqs = new Set<number>();
  for (const it of [...(input.interaction?.items ?? []), ...(input.interaction?.waiting ? [input.interaction.waiting] : [])]) {
    for (const r of it.refs) if (/^dialogue:\d+$/.test(r)) pinnedSeqs.add(Number(r.slice('dialogue:'.length)));
  }
  const spoken = heard.filter((r) => r.kind !== 'advice' || r.speaker === charId);
  const recentFrom = Math.max(0, spoken.length - (input.maxDialogue ?? DEFAULT_MAX_DIALOGUE));
  const dialogue: DialogueView[] = spoken
    .filter((r, i) => i >= recentFrom || pinnedSeqs.has(r.seq))
    .map((r) => ({
      ref: `dialogue:${r.seq}`,
      seq: r.seq,
      round: r.round,
      speaker: r.speaker,
      speakerName: actorName(names, r.speaker, lang),
      to: r.listeners.map((l) => actorName(names, l, lang)),
      kind: r.kind,
      text: r.text,
    }));
  const advice: AdviceView[] = heard
    .filter((r) => r.kind === 'advice' && r.speaker !== charId && r.listeners.includes(charId))
    .slice(-DEFAULT_MAX_ADVICE)
    .map((r) => ({
      ref: `dialogue:${r.seq}`,
      seq: r.seq,
      round: r.round,
      from: r.speaker,
      fromName: actorName(names, r.speaker, lang),
      text: r.text,
      payload: r.payload === undefined ? null : sanitizeJson(r.payload, lang),
    }));
  // Legacy feedback rows (no age filter); with an interaction view, unresolved feedback lives in its items.
  const feedback = input.interaction
    ? []
    : (input.feedback ?? []).map((f) => ({ ...f })).sort((a, b) => a.round - b.round || a.seq - b.seq);
  let interaction: CharacterContext['interaction'] = null;
  if (input.interaction) {
    const view = structuredClone(input.interaction);
    const ids = new Set<string>();
    for (const it of [...view.items, ...(view.waiting ? [view.waiting] : [])]) if (it.from) ids.add(it.from);
    for (const r of view.myRequests) ids.add(r.to);
    const nameMap: Record<string, string> = {};
    for (const id of [...ids].sort()) nameMap[id] = actorName(names, id as ActorId, lang);
    interaction = { ...view, names: nameMap };
  }

  const partial = { documents, negotiations, messages, suggestions, siege };
  const agendaIds = input.activeAgendaIds ?? null;
  const agendas = persona.agendaTriggers
    .filter((t) => (agendaIds ? agendaIds.includes(t.id) : derivedAgendaActive(t, partial)))
    .map((t) => ({ id: t.id, text: loc(t.agenda, lang) }));

  const context: CharacterContext = {
    version: CHARACTER_CONTEXT_VERSION,
    lang,
    self: {
      id: charId,
      name: loc(persona.name, lang),
      title: loc(persona.title, lang),
      faction,
      factionName: loc(names.factions[faction], lang),
      principal: persona.principal,
      location,
      locationName: locationName(names, location, lang),
      permissions: [...config.characters[charId].permissions],
      goals: persona.goals.map((g) => loc(g, lang)),
      privateMemory: persona.private_memory.map((m) => loc(m, lang)),
      voice: loc(persona.voice, lang),
      preferences,
      agendas,
    },
    time: { round: state.round, day: state.day, maxRounds: config.params.max_rounds, roundDays: config.params.round_days },
    scene: { location, locationName: locationName(names, location, lang), present },
    travel: LOC_IDS.filter((l) => l !== location).map((l) => ({
      to: l,
      name: locationName(names, l, lang),
      days: config.travel[location][l],
    })),
    rules: {
      round_days: config.params.round_days,
      segment_round_cap: config.params.segment_round_cap,
      pair_offer_cap: config.params.pair_offer_cap,
      delay_rounds_min: config.params.delay_rounds_min,
      delay_rounds_max: config.params.delay_rounds_max,
    },
    catalog: catalogView(content, config, pairs, lang),
    resources: {
      faction,
      // Believed ledger: remote debits/releases count only once the character holds evidence of them.
      available: { ...ledger.available },
      reserved: { ...ledger.reserved },
    },
    siege,
    background: faction === config.player.faction ? loc(content.scenario.start_note, lang) : null,
    documents,
    suggestions,
    negotiations,
    messages,
    beliefs,
    advice,
    feedback,
    dialogue,
    sources: sourcesFor(content, persona, charId),
    interaction,
  };
  if (!isAlive(state, charId)) context.self.agendas = [];

  const budget = input.maxChars ?? DEFAULT_CHARACTER_CONTEXT_BUDGET;
  const { text, report } = fitToBudget(context, budget);
  return { context, text, hash: sha256Hex(text), citeKeys: citeKeysOf(context), truncation: report };
}
