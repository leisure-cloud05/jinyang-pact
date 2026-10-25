/**
 * Action resolution (PLAN §4, §4.1, §4.2): computes an action's effects as RFC-6902 patch operations plus
 * language-neutral narration facts. Resolution assumes validation already passed (Harness modes) or deliberately
 * skipped it (baseline permissive executor, §4.3); it only fails when effects are inapplicable (a referenced
 * object is missing or arguments cannot be interpreted), which the permissive executor records as `unapplied`.
 *
 * Also exports message delivery (used by PREPARE and by same-location sends) and decision world-effects.
 */
import { own } from './ids.js';
import { isSystemActionType, type Action, type ActionOf, type SystemAction } from './actions.js';
import {
  addBelief,
  actorLocation,
  clauseFromCatalog,
  clauseLookupFor,
  correspondenceReaders,
  documentObservers,
  documentView,
  filterTermsFor,
  isCharId,
  knowsClause,
  presentAt,
} from './knowledge.js';
import { debitReservations, deriveObligations, holdReservations, releaseReservations } from './obligations.js';
import {
  clearDeadlock,
  commitmentsOfPair,
  documentPair,
  documentSender,
  markDeadlockIfExhausted,
  openNewSegment,
  recordOffer,
} from './negotiation.js';
import { Draft, PatchError } from './reducer.js';
import { siegeMutinyOutbreak, siegeNumbers } from './siege.js';
import { expandTermArgs, pairOf } from './terms.js';
import {
  ALLOCATION_TARGETS,
  ASSISTANCE_PAIR,
  BESIEGED_FACTION,
  BESIEGER_FACTION,
  SCALAR_TERM_KEYS,
  type ActorId,
  type AnyAction,
  type AuthorizationGrant,
  type CharId,
  type Commitment,
  type CoreConfig,
  type Document,
  type EffectDraft,
  type EventKind,
  type EvidenceKind,
  type JsonValue,
  type KnowledgePredicate,
  type LocId,
  type Message,
  type MessageKind,
  type MessagePayload,
  type Offer,
  type PairId,
  type TermLimits,
  type TermSet,
  type WorldState,
} from './types.js';

export interface ResolveOptions {
  config: CoreConfig;
  /** Baseline permissive executor (§4.3): apply natural effects without H02–H14 checks. */
  permissive?: boolean;
}

export interface DialogueDraft {
  speaker: ActorId;
  listeners: ActorId[];
  text: string;
  kind: 'speech' | 'advice' | 'question' | 'answer';
}

export type ResolveResult =
  | { ok: true; effect: EffectDraft | null; dialogue: DialogueDraft | null }
  | { ok: false; reason: string };

class Inapplicable extends Error {}

function need<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Inapplicable(what);
  return value;
}

// ---------------------------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------------------------

function sceneOf(state: Readonly<WorldState>, config: CoreConfig, actor: ActorId): LocId {
  return actorLocation(state as WorldState, actor) ?? state.characters[config.factions[BESIEGED_FACTION].principal].location;
}

function fact(d: Draft, _config: CoreConfig, scene: LocId, kind: string, actor: ActorId | null, data: Record<string, unknown>): void {
  d.fact({ scene, kind, actor, audience: presentAt(d.s as WorldState, scene), data: data as Record<string, JsonValue> });
}

/** Scalar terms plus clause ids (clause text never goes into facts). */
function factTerms(terms: TermSet): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SCALAR_TERM_KEYS) out[key] = terms[key];
  out.secret_clause_ids = terms.secret_clauses.map((c) => c.id);
  return out;
}

function travelDays(config: CoreConfig, from: LocId | null, to: LocId | null): number {
  if (from === null || to === null) return 0;
  return config.travel[from][to];
}

interface BeliefSpec {
  subject: string;
  predicate: KnowledgePredicate;
  value: Record<string, unknown> | string;
  /** If set, `value.terms` is added, filtered per observer (holders see the full terms). */
  terms?: TermSet;
}

function withTerms(state: Readonly<WorldState>, config: CoreConfig, viewer: ActorId, spec: BeliefSpec, filter: boolean): unknown {
  if (!spec.terms || typeof spec.value === 'string') return spec.value;
  const terms = filter ? filterTermsFor(state as WorldState, config, viewer, spec.terms) : spec.terms;
  return { ...spec.value, terms };
}

/**
 * Gives `holder` (the negotiating party itself) the assertions in `specs` with full terms, and every other
 * recipient — the holder's co-located correspondence readers (observation) and a different operator `alsoOwn`
 * (own_action, e.g. the player transmitting Shi's document) — copies whose secret clauses are filtered by that
 * recipient's existing knowledge: operating or observing never grants access to hidden clauses.
 */
function tell(
  d: Draft,
  config: CoreConfig,
  holder: ActorId,
  specs: BeliefSpec[],
  evidence: { kind: EvidenceKind; ref: string },
  alsoOwn: ActorId | null = null,
): void {
  for (const spec of specs) {
    addBelief(d, { holder, subject: spec.subject, predicate: spec.predicate, value: withTerms(d.s, config, holder, spec, false), evidence });
  }
  const observers: ActorId[] = isCharId(holder) ? correspondenceReaders(d.s as WorldState, config, holder) : [];
  for (const observer of observers) {
    const own = observer === alsoOwn;
    for (const spec of specs) {
      addBelief(d, {
        holder: observer,
        subject: spec.subject,
        predicate: spec.predicate,
        value: withTerms(d.base, config, observer, spec, true),
        evidence: own ? { kind: 'own_action', ref: `event:${d.eventId}` } : { kind: 'observation', ref: evidence.ref },
        visibility: 'faction',
      });
    }
  }
  if (alsoOwn !== null && alsoOwn !== holder && !observers.includes(alsoOwn)) {
    for (const spec of specs) {
      addBelief(d, {
        holder: alsoOwn,
        subject: spec.subject,
        predicate: spec.predicate,
        value: withTerms(d.base, config, alsoOwn, spec, true),
        evidence: { kind: 'own_action', ref: `event:${d.eventId}` },
      });
    }
  }
}

/** Evidence for an actor's own action, or observation if the party is not the actor (player transmits for Shi). */
function actionEvidence(d: Draft, party: ActorId, actor: ActorId): { kind: EvidenceKind; ref: string } {
  return { kind: party === actor ? 'own_action' : 'observation', ref: `event:${d.eventId}` };
}

function observeDocument(d: Draft, config: CoreConfig, doc: Document, actor: ActorId): void {
  const current = own(d.s.documents, doc.id) as Document;
  for (const observer of documentObservers(d.s as WorldState, current)) {
    addBelief(d, {
      holder: observer,
      subject: current.id,
      predicate: 'content',
      value: documentView(d.s as WorldState, config, observer, current),
      evidence: { kind: observer === actor ? 'own_action' : 'observation', ref: `event:${d.eventId}` },
      visibility: 'faction',
    });
  }
}

interface PostSpec {
  from: ActorId;
  to: ActorId;
  kind: MessageKind;
  payload: MessagePayload;
  arrivalDay: number;
  /** Pre-start messages: sent before the chapter began (default: today). */
  sentDay?: number;
  /** Deliver at once when it arrives today (default true; pre-start messages wait for PREPARE). */
  immediate?: boolean;
}

/** Posts a message whose id was allocated beforehand; a message arriving today (co-located) is delivered at once. */
function postMessage(d: Draft, config: CoreConfig, msgId: string, spec: PostSpec): Message {
  const sendSeq = d.nextSendSeq();
  const message: Message = {
    id: msgId,
    from: spec.from,
    to: spec.to,
    kind: spec.kind,
    payload: spec.payload,
    sentDay: spec.sentDay ?? d.s.day,
    arrivalDay: spec.arrivalDay,
    sendSeq,
    status: 'in_transit',
  };
  d.set(['messages', msgId], message);
  d.rule('G02');
  if (spec.immediate !== false && spec.arrivalDay <= d.s.day) applyDelivery(d, config, msgId);
  return message;
}

function arrivalBetween(d: Draft, config: CoreConfig, from: ActorId, to: ActorId): number {
  return d.s.day + travelDays(config, actorLocation(d.s as WorldState, from), actorLocation(d.s as WorldState, to));
}

function catalogLookup(config: CoreConfig): (id: string) => ReturnType<typeof clauseFromCatalog> {
  return (id) => clauseFromCatalog(config, id);
}

function expandFor(
  d: Draft,
  opts: ResolveOptions,
  actor: ActorId,
  args: Parameters<typeof expandTermArgs>[0],
  preserved: TermSet['secret_clauses'] = [],
): TermSet {
  const lookup = opts.permissive ? catalogLookup(opts.config) : clauseLookupFor(d.base, opts.config, actor);
  const expanded = expandTermArgs(args, lookup, preserved);
  if (!expanded.ok) throw new Inapplicable(`unknown secret clause ${expanded.unknownClauseIds.join(', ')}`);
  return expanded.terms;
}

// ---------------------------------------------------------------------------------------------------------------
// Negotiation primitives (shared by actions and abandon_request)
// ---------------------------------------------------------------------------------------------------------------

function rejectLiveOffer(d: Draft, config: CoreConfig, offer: Offer, actor: ActorId, reason: string): void {
  const thread = need(own(d.s.commitments, offer.commitmentId), `commitment ${offer.commitmentId}`);
  const party = offer.to;
  d.set(['offers', offer.id, 'status'], 'rejected');
  d.set(['commitments', thread.id, 'status'], 'rejected');
  releaseReservations(d, thread.id);
  const msgId = d.nextId('msg');
  tell(
    d,
    config,
    party,
    [
      { subject: offer.id, predicate: 'status', value: 'rejected' },
      { subject: thread.id, predicate: 'status', value: 'rejected' },
    ],
    actionEvidence(d, party, actor),
    actor,
  );
  postMessage(d, config, msgId, {
    from: party,
    to: offer.from,
    kind: 'response',
    payload: {
      kind: 'response',
      commitmentId: thread.id,
      offerId: offer.id,
      termsVersion: offer.termsVersion,
      response: 'reject',
      reason,
      counter: null,
    },
    arrivalDay: arrivalBetween(d, config, party, offer.from),
  });
  fact(d, config, sceneOf(d.s, config, party), 'offer_rejected', actor, {
    offerId: offer.id,
    commitmentId: thread.id,
    by: party,
    to: offer.from,
  });
  d.rule('H12');
}

function sendWithdrawal(d: Draft, config: CoreConfig, offer: Offer, actor: ActorId): void {
  const msgId = d.nextId('msg');
  const arrivalDay = arrivalBetween(d, config, offer.from, offer.to);
  d.set(['offers', offer.id, 'withdrawal'], { messageId: msgId, effectiveDay: arrivalDay });
  tell(
    d,
    config,
    offer.from,
    [{ subject: `${offer.id}/withdrawal`, predicate: 'status', value: 'pending' }],
    actionEvidence(d, offer.from, actor),
    actor,
  );
  postMessage(d, config, msgId, {
    from: offer.from,
    to: offer.to,
    kind: 'withdrawal',
    payload: { kind: 'withdrawal', commitmentId: offer.commitmentId, offerId: offer.id },
    arrivalDay,
  });
  fact(d, config, sceneOf(d.s, config, offer.from), 'withdrawal_sent', actor, {
    offerId: offer.id,
    commitmentId: offer.commitmentId,
    to: offer.to,
    arrivalDay,
  });
}

interface OpenThreadSpec {
  sender: CharId;
  to: CharId;
  pair: PairId;
  terms: TermSet;
  consentEvidence: string;
  consentBy: ActorId;
  note: string;
  /** Pre-start offers: explicit send/arrival days, `pre-start` evidence, no immediate delivery. */
  preStart?: { sentDay: number; arrivalDay: number };
}

/** Opens a thread with its first offer, holds the sender's reservations and posts the offer message. */
function openThread(d: Draft, opts: ResolveOptions, actor: ActorId, spec: OpenThreadSpec): { cmtId: string; offerId: string; arrivalDay: number } {
  const config = opts.config;
  const cmtId = d.nextId('cmt');
  const offerId = d.nextId('offer');
  const msgId = d.nextId('msg');
  const seq = recordOffer(d, spec.pair);
  markDeadlockIfExhausted(d, spec.pair, config.params.segment_round_cap);
  const arrivalDay = spec.preStart?.arrivalDay ?? arrivalBetween(d, config, spec.sender, spec.to);
  const sentDay = spec.preStart?.sentDay ?? d.s.day;
  const thread: Commitment = {
    id: cmtId,
    parties: [spec.sender, spec.to],
    pair: spec.pair,
    status: 'negotiating',
    liveOfferId: offerId,
    termsVersion: 1,
    consents: {
      [spec.sender]: { termsVersion: 1, evidence: spec.consentEvidence, by: spec.consentBy },
      [spec.to]: { termsVersion: null, evidence: null, by: null },
    },
    secret: spec.terms.secret_clauses.length > 0,
    confirmedDay: null,
    openedDay: sentDay,
    offerIds: [offerId],
    obligations: [],
  };
  const offer: Offer = {
    id: offerId,
    commitmentId: cmtId,
    from: spec.sender,
    to: spec.to,
    terms: spec.terms,
    termsVersion: 1,
    consentEvidence: spec.consentEvidence,
    sentDay,
    arrivalDay,
    messageId: msgId,
    status: 'in_transit',
    withdrawal: null,
    pairSeq: seq.pairSeq,
    origin: 'opening',
    segment: seq.segment,
    segmentRound: seq.segmentRound,
  };
  d.set(['commitments', cmtId], thread);
  d.set(['offers', offerId], offer);
  holdReservations(d, cmtId, offerId, d.s.characters[spec.sender].faction, deriveObligations(spec.terms, spec.pair));
  tell(
    d,
    config,
    spec.sender,
    [
      { subject: offerId, predicate: 'terms', value: { commitmentId: cmtId, termsVersion: 1, from: spec.sender, to: spec.to }, terms: spec.terms },
      { subject: offerId, predicate: 'status', value: 'sent' },
      { subject: cmtId, predicate: 'status', value: 'negotiating' },
    ],
    spec.preStart ? { kind: 'initial', ref: 'pre-start' } : actionEvidence(d, spec.sender, actor),
    spec.preStart ? null : actor,
  );
  postMessage(d, config, msgId, {
    sentDay,
    immediate: spec.preStart === undefined,
    from: spec.sender,
    to: spec.to,
    kind: 'offer',
    payload: {
      kind: 'offer',
      offerId,
      commitmentId: cmtId,
      termsVersion: 1,
      terms: spec.terms,
      from: spec.sender,
      to: spec.to,
      note: spec.note,
    },
    arrivalDay,
  });
  return { cmtId, offerId, arrivalDay };
}

// ---------------------------------------------------------------------------------------------------------------
// Delivery (PREPARE; same-location sends)
// ---------------------------------------------------------------------------------------------------------------

/** Delivers one message inside a draft; returns the event kind it represents. */
export function applyDelivery(d: Draft, config: CoreConfig, msgId: string): EventKind {
  const msg = need(own(d.s.messages, msgId), `message ${msgId}`);
  d.set(['messages', msgId, 'status'], 'delivered');
  const evidence = { kind: 'message' as const, ref: msgId };
  const scene = sceneOf(d.s, config, msg.to);
  const p = msg.payload;
  switch (p.kind) {
    case 'offer': {
      const offer = own(d.s.offers, p.offerId);
      if (offer && offer.status === 'in_transit') d.set(['offers', p.offerId, 'status'], 'delivered');
      const now = own(d.s.offers, p.offerId)?.status === 'withdrawn' ? 'withdrawn' : 'delivered';
      tell(d, config, p.to, [
        { subject: p.offerId, predicate: 'terms', value: { commitmentId: p.commitmentId, termsVersion: p.termsVersion, from: p.from, to: p.to }, terms: p.terms },
        { subject: p.offerId, predicate: 'status', value: now },
        { subject: p.commitmentId, predicate: 'status', value: now === 'withdrawn' ? 'withdrawn' : 'negotiating' },
      ], evidence);
      fact(d, config, scene, 'offer_delivered', null, { offerId: p.offerId, commitmentId: p.commitmentId, from: p.from, to: p.to, terms: factTerms(p.terms) });
      d.rule('H08');
      return 'message_delivered';
    }
    case 'response': {
      const answered = p.response === 'accept' ? 'accepted' : p.response === 'counter' ? 'countered' : 'rejected';
      const threadStatus = p.response === 'accept' ? 'confirmed' : p.response === 'counter' ? 'negotiating' : 'rejected';
      const specs: BeliefSpec[] = [
        { subject: p.offerId, predicate: 'status', value: answered },
        { subject: p.commitmentId, predicate: 'status', value: threadStatus },
      ];
      if (p.counter) {
        const counter = own(d.s.offers, p.counter.offerId);
        if (counter && counter.status === 'in_transit') d.set(['offers', p.counter.offerId, 'status'], 'delivered');
        specs.push(
          { subject: p.counter.offerId, predicate: 'terms', value: { commitmentId: p.commitmentId, termsVersion: p.counter.termsVersion, from: msg.from, to: msg.to }, terms: p.counter.terms },
          { subject: p.counter.offerId, predicate: 'status', value: own(d.s.offers, p.counter.offerId)?.status === 'withdrawn' ? 'withdrawn' : 'delivered' },
        );
      }
      tell(d, config, msg.to, specs, evidence);
      fact(d, config, scene, 'response_delivered', null, {
        offerId: p.offerId,
        commitmentId: p.commitmentId,
        response: p.response,
        from: msg.from,
        to: msg.to,
        counterOfferId: p.counter?.offerId ?? null,
        counterTerms: p.counter ? factTerms(p.counter.terms) : null,
      });
      d.rule('H08');
      return 'message_delivered';
    }
    case 'withdrawal': {
      const offer = need(own(d.s.offers, p.offerId), `offer ${p.offerId}`);
      const thread = need(own(d.s.commitments, p.commitmentId), `commitment ${p.commitmentId}`);
      const effective = offer.status === 'in_transit' || offer.status === 'delivered';
      if (effective) {
        d.set(['offers', offer.id, 'status'], 'withdrawn');
        if (thread.status === 'negotiating' && thread.liveOfferId === offer.id) {
          d.set(['commitments', thread.id, 'status'], 'withdrawn');
        }
        releaseReservations(d, thread.id);
        tell(d, config, msg.to, [
          { subject: offer.id, predicate: 'status', value: 'withdrawn' },
          { subject: thread.id, predicate: 'status', value: 'withdrawn' },
        ], evidence);
      } else {
        tell(d, config, msg.to, [{ subject: `${offer.id}/withdrawal`, predicate: 'status', value: 'late' }], evidence);
      }
      const resultId = d.nextId('msg');
      postMessage(d, config, resultId, {
        from: msg.to,
        to: msg.from,
        kind: 'withdrawal_result',
        payload: { kind: 'withdrawal_result', commitmentId: thread.id, offerId: offer.id, effective },
        arrivalDay: arrivalBetween(d, config, msg.to, msg.from),
      });
      fact(d, config, scene, effective ? 'withdrawal_effective' : 'withdrawal_late', null, {
        offerId: offer.id,
        commitmentId: thread.id,
        from: msg.from,
        to: msg.to,
      });
      d.rule('H12');
      return effective ? 'withdrawal_effective' : 'withdrawal_late';
    }
    case 'withdrawal_result': {
      const specs: BeliefSpec[] = [
        { subject: `${p.offerId}/withdrawal`, predicate: 'status', value: p.effective ? 'effective' : 'late' },
      ];
      if (p.effective) {
        specs.push(
          { subject: p.offerId, predicate: 'status', value: 'withdrawn' },
          { subject: p.commitmentId, predicate: 'status', value: 'withdrawn' },
        );
      }
      tell(d, config, msg.to, specs, evidence);
      fact(d, config, scene, 'withdrawal_result_delivered', null, { offerId: p.offerId, commitmentId: p.commitmentId, effective: p.effective, to: msg.to });
      return 'message_delivered';
    }
    case 'letter': {
      tell(d, config, msg.to, [{ subject: msgId, predicate: 'claim', value: { from: msg.from, text: p.text } }], evidence);
      for (const k of Object.values(d.s.knowledge)) {
        if (k.subject === msgId && k.evidence.ref === msgId && k.credibility !== config.params.letter_credibility) {
          d.set(['knowledge', k.id, 'credibility'], config.params.letter_credibility);
        }
      }
      fact(d, config, scene, 'letter_delivered', null, { messageId: msgId, from: msg.from, to: msg.to });
      return 'message_delivered';
    }
    case 'intel': {
      addBelief(d, {
        holder: msg.to,
        subject: msgId,
        predicate: 'claim',
        value: { topic: p.topic, text: p.text },
        evidence,
        credibility: p.credibility,
      });
      fact(d, config, scene, 'intel_delivered', null, { messageId: msgId, to: msg.to, topic: p.topic });
      d.rule('G08');
      return 'message_delivered';
    }
  }
}

/** One PREPARE delivery event. */
export function deliveryEffect(state: WorldState, config: CoreConfig, msgId: string): EffectDraft {
  const d = new Draft(state);
  const kind = applyDelivery(d, config, msgId);
  d.rule('G02');
  return d.build(kind, 'system');
}

// ---------------------------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------------------------

function docOf(d: Draft, docId: string): Document {
  return need(own(d.s.documents, docId), `document ${docId}`);
}

function resolveRevise(d: Draft, opts: ResolveOptions, actor: ActorId, a: ActionOf<'revise_document'>): void {
  const config = opts.config;
  const doc = docOf(d, a.args.docId);
  need(documentPair(d.s as WorldState, config, doc), 'document pair');
  const hidden = doc.terms.secret_clauses.filter((c) => !knowsClause(d.base, config, actor, c.id));
  const terms = expandFor(d, opts, actor, a.args.terms, hidden);
  const version = doc.version + 1;
  d.set(['documents', doc.id, 'terms'], terms);
  d.set(['documents', doc.id, 'note'], a.args.note);
  d.set(['documents', doc.id, 'version'], version);
  d.set(['documents', doc.id, 'status'], 'draft');
  d.set(['documents', doc.id, 'approval'], null);
  d.push(['documents', doc.id, 'history'], { version, by: actor, round: d.s.round });
  observeDocument(d, config, doc, actor);
  fact(d, config, sceneOf(d.s, config, doc.holder), 'document_revised', actor, {
    docId: doc.id,
    version,
    approvalVoided: doc.approval !== null,
    terms: factTerms(terms),
  });
  d.rule('H01', 'H04', 'H08', 'H11');
}

function resolveSuggest(d: Draft, opts: ResolveOptions, actor: ActorId, a: ActionOf<'suggest_revision'>): void {
  const target = a.args.target;
  let targetVersion: number;
  if (target.kind === 'document') targetVersion = docOf(d, target.id).version;
  else targetVersion = need(own(d.s.offers, target.id), `offer ${target.id}`).termsVersion;
  const id = d.nextId('sug');
  d.set(['suggestions', id], {
    id,
    by: actor,
    target: { kind: target.kind, id: target.id },
    targetVersion,
    terms: a.args.terms,
    reason: a.args.reason,
    round: d.s.round,
    day: d.s.day,
  });
  fact(d, opts.config, sceneOf(d.s, opts.config, actor), 'suggestion_made', actor, {
    suggestionId: id,
    targetKind: target.kind,
    targetId: target.id,
    targetVersion,
  });
  d.rule('H08');
}

function resolveApprove(d: Draft, opts: ResolveOptions, actor: ActorId, a: ActionOf<'approve_document'>): void {
  const doc = docOf(d, a.args.docId);
  d.set(['documents', doc.id, 'status'], 'approved');
  d.set(['documents', doc.id, 'approval'], { version: doc.version, eventId: d.eventId, by: actor });
  observeDocument(d, opts.config, doc, actor);
  fact(d, opts.config, sceneOf(d.s, opts.config, doc.holder), 'document_approved', actor, { docId: doc.id, version: doc.version });
  d.rule('H04', 'H11');
}

function resolveTiming(d: Draft, opts: ResolveOptions, actor: ActorId, a: ActionOf<'set_dispatch_timing'>): void {
  const doc = docOf(d, a.args.docId);
  const rounds = a.args.rounds ?? opts.config.params.delay_rounds_min;
  const notBeforeRound = a.args.mode === 'delay' ? d.s.round + rounds : null;
  d.set(['documents', doc.id, 'timing'], { mode: a.args.mode, notBeforeRound });
  observeDocument(d, opts.config, doc, actor);
  fact(d, opts.config, sceneOf(d.s, opts.config, doc.holder), 'dispatch_timing_set', actor, {
    docId: doc.id,
    mode: a.args.mode,
    notBeforeRound,
  });
  d.rule('H11');
}

function resolveDispatch(d: Draft, opts: ResolveOptions, actor: ActorId, a: ActionOf<'dispatch_document'>): void {
  const config = opts.config;
  const doc = docOf(d, a.args.docId);
  const pair = need(documentPair(d.s as WorldState, config, doc), 'document pair');
  const sender = documentSender(d.s as WorldState, config, doc);
  const consentEvidence = doc.approval ? `event:${doc.approval.eventId}` : `event:${d.eventId}`;
  const opened = openThread(d, opts, actor, {
    sender,
    to: doc.to,
    pair,
    terms: doc.terms,
    consentEvidence,
    consentBy: doc.approval?.by ?? actor,
    note: doc.note,
  });
  d.set(['documents', doc.id, 'status'], 'sent');
  d.set(['documents', doc.id, 'sentOfferId'], opened.offerId);
  observeDocument(d, config, doc, actor);
  // G08: Tang intelligence learns that an envoy left (no content).
  const tangPrincipal = config.factions[BESIEGER_FACTION].principal;
  const intelId = d.nextId('msg');
  postMessage(d, config, intelId, {
    from: 'system',
    to: tangPrincipal,
    kind: 'intel',
    payload: {
      kind: 'intel',
      topic: 'envoy_departed',
      text: { zh: '有使者自晋阳北去。', en: 'An envoy has left Jinyang, heading north.' },
      credibility: config.params.intel_credibility,
    },
    arrivalDay: d.s.day + config.params.intel_delay_days,
  });
  fact(d, config, sceneOf(d.s, config, doc.holder), 'document_dispatched', actor, {
    docId: doc.id,
    docVersion: doc.version,
    offerId: opened.offerId,
    commitmentId: opened.cmtId,
    from: sender,
    to: doc.to,
    arrivalDay: opened.arrivalDay,
  });
  d.rule('H04', 'H07', 'H08', 'H10', 'H11', 'H12', 'H13', 'G08');
}

function resolvePropose(d: Draft, opts: ResolveOptions, actor: ActorId, a: ActionOf<'propose_terms'>): void {
  const config = opts.config;
  // On-behalf (baseline only): the player's proposal is attributed to its faction principal.
  const sender: CharId = isCharId(actor) ? actor : config.factions[config.player.faction].principal;
  const pair = need(pairOf(d.s.characters[sender].faction, d.s.characters[a.args.to].faction), 'principal pair');
  const terms = expandFor(d, opts, actor, a.args.terms);
  const opened = openThread(d, opts, actor, {
    sender,
    to: a.args.to,
    pair,
    terms,
    consentEvidence: `event:${d.eventId}`,
    consentBy: actor,
    note: a.args.note ?? '',
  });
  fact(d, config, sceneOf(d.s, config, sender), 'terms_proposed', actor, {
    offerId: opened.offerId,
    commitmentId: opened.cmtId,
    from: sender,
    to: a.args.to,
    arrivalDay: opened.arrivalDay,
    terms: factTerms(terms),
  });
  d.rule('H04', 'H07', 'H10', 'H13');
}

function resolveRespond(d: Draft, opts: ResolveOptions, actor: ActorId, a: ActionOf<'respond_to_offer'>): void {
  const config = opts.config;
  const offer = need(own(d.s.offers, a.args.offerId), `offer ${a.args.offerId}`);
  const thread = need(own(d.s.commitments, offer.commitmentId), `commitment ${offer.commitmentId}`);
  const party = offer.to; // the answering party (== actor except for baseline on-behalf answers)
  if (a.args.response === 'reject') {
    rejectLiveOffer(d, config, offer, actor, a.args.reason);
    d.rule('H04', 'H08', 'H10');
    return;
  }
  const terms = expandFor(d, opts, actor, need(a.args.counterTerms, 'counterTerms'));
  d.set(['offers', offer.id, 'status'], 'countered');
  releaseReservations(d, thread.id);
  const newOfferId = d.nextId('offer');
  const msgId = d.nextId('msg');
  const termsVersion = thread.termsVersion + 1;
  const seq = recordOffer(d, thread.pair);
  markDeadlockIfExhausted(d, thread.pair, config.params.segment_round_cap);
  const arrivalDay = arrivalBetween(d, config, party, offer.from);
  const evidence = `event:${d.eventId}`;
  const counter: Offer = {
    id: newOfferId,
    commitmentId: thread.id,
    from: party,
    to: offer.from,
    terms,
    termsVersion,
    consentEvidence: evidence,
    sentDay: d.s.day,
    arrivalDay,
    messageId: msgId,
    status: 'in_transit',
    withdrawal: null,
    pairSeq: seq.pairSeq,
    origin: 'counter',
    segment: seq.segment,
    segmentRound: seq.segmentRound,
  };
  d.set(['offers', newOfferId], counter);
  d.set(['commitments', thread.id, 'liveOfferId'], newOfferId);
  d.set(['commitments', thread.id, 'termsVersion'], termsVersion);
  d.set(['commitments', thread.id, 'consents'], {
    [party]: { termsVersion, evidence, by: actor },
    [offer.from]: { termsVersion: null, evidence: null, by: null },
  });
  d.push(['commitments', thread.id, 'offerIds'], newOfferId);
  holdReservations(d, thread.id, newOfferId, d.s.characters[party].faction, deriveObligations(terms, thread.pair));
  tell(
    d,
    config,
    party,
    [
      { subject: offer.id, predicate: 'status', value: 'countered' },
      { subject: newOfferId, predicate: 'terms', value: { commitmentId: thread.id, termsVersion, from: party, to: offer.from }, terms },
      { subject: newOfferId, predicate: 'status', value: 'sent' },
      { subject: thread.id, predicate: 'status', value: 'negotiating' },
    ],
    actionEvidence(d, party, actor),
    actor,
  );
  postMessage(d, config, msgId, {
    from: party,
    to: offer.from,
    kind: 'response',
    payload: {
      kind: 'response',
      commitmentId: thread.id,
      offerId: offer.id,
      termsVersion: offer.termsVersion,
      response: 'counter',
      reason: a.args.reason,
      counter: { offerId: newOfferId, termsVersion, terms },
    },
    arrivalDay,
  });
  fact(d, config, sceneOf(d.s, config, party), 'offer_countered', actor, {
    offerId: offer.id,
    counterOfferId: newOfferId,
    commitmentId: thread.id,
    by: party,
    to: offer.from,
    termsVersion,
    arrivalDay,
    terms: factTerms(terms),
  });
  d.rule('H04', 'H07', 'H08', 'H10', 'H12', 'H13');
}

function resolveWithdraw(d: Draft, opts: ResolveOptions, actor: ActorId, a: ActionOf<'withdraw_offer'>): void {
  const offer = need(own(d.s.offers, a.args.offerId), `offer ${a.args.offerId}`);
  need(own(d.s.commitments, offer.commitmentId), `commitment ${offer.commitmentId}`);
  sendWithdrawal(d, opts.config, offer, actor);
  d.rule('H04', 'H08', 'H12');
}

function resolveConfirm(d: Draft, opts: ResolveOptions, actor: ActorId, a: ActionOf<'confirm_commitment'>): void {
  const config = opts.config;
  const thread = need(own(d.s.commitments, a.args.commitmentId), `commitment ${a.args.commitmentId}`);
  const offer = need(own(d.s.offers, a.args.offerId), `offer ${a.args.offerId}`);
  const party = offer.to; // pending party; consent attributed to `actor` in the record
  const evidence = `event:${d.eventId}`;
  d.set(['offers', offer.id, 'status'], 'accepted');
  d.set(['commitments', thread.id, 'status'], 'confirmed');
  d.set(['commitments', thread.id, 'consents', party], { termsVersion: a.args.termsVersion, evidence, by: actor });
  d.set(['commitments', thread.id, 'confirmedDay'], d.s.day);
  const obligations = deriveObligations(offer.terms, thread.pair);
  holdReservations(d, thread.id, offer.id, d.s.characters[party].faction, obligations);
  debitReservations(d, thread.id);
  d.set(['commitments', thread.id, 'obligations'], obligations);
  clearDeadlock(d, thread.pair);
  if (thread.pair === ASSISTANCE_PAIR && offer.terms.aid_cavalry > 0) {
    d.set(['flags', 'khitanArrivalDay'], d.s.day + offer.terms.aid_arrival_days);
    d.rule('G09');
  }
  tell(
    d,
    config,
    party,
    [
      { subject: offer.id, predicate: 'status', value: 'accepted' },
      { subject: thread.id, predicate: 'status', value: 'confirmed' },
    ],
    actionEvidence(d, party, actor),
    actor,
  );
  const msgId = d.nextId('msg');
  postMessage(d, config, msgId, {
    from: party,
    to: offer.from,
    kind: 'response',
    payload: {
      kind: 'response',
      commitmentId: thread.id,
      offerId: offer.id,
      termsVersion: offer.termsVersion,
      response: 'accept',
      reason: '',
      counter: null,
    },
    arrivalDay: arrivalBetween(d, config, party, offer.from),
  });
  fact(d, config, sceneOf(d.s, config, party), 'commitment_confirmed', actor, {
    commitmentId: thread.id,
    offerId: offer.id,
    termsVersion: a.args.termsVersion,
    by: party,
    to: offer.from,
    khitanArrivalDay: d.s.flags.khitanArrivalDay,
    terms: factTerms(offer.terms),
  });
  d.rule('H04', 'H07', 'H08', 'H09', 'H10', 'H12');
}

function resolveAllocate(d: Draft, opts: ResolveOptions, actor: ActorId, a: ActionOf<'allocate_resources'>): void {
  const p = opts.config.params;
  const { faction, resource, amount, purpose } = a.args;
  d.set(['factions', faction, 'resources', resource], d.s.factions[faction].resources[resource] - amount);
  const target = ALLOCATION_TARGETS[purpose];
  let effect: Record<string, number> = {};
  if (target.faction === faction && target.resource === resource) {
    if (purpose === 'intensify_siege') {
      const pressure = Math.min(p.pressure_cap, d.s.siege.pressure + p.intensify_pressure_per_step * Math.floor(amount / p.intensify_troops_step));
      d.set(['siege', 'pressure'], pressure);
      effect = { pressure };
      d.rule('G04');
    } else {
      const morale = Math.min(p.morale_cap, d.s.siege.morale + p.pay_morale_per_step * Math.floor(amount / p.pay_silk_step));
      d.set(['siege', 'morale'], morale);
      effect = { morale };
      d.rule('G05');
    }
  }
  fact(d, opts.config, sceneOf(d.s, opts.config, actor), 'resources_allocated', actor, { faction, resource, amount, purpose, ...effect });
  d.rule('H07');
}

function resolveAbandon(d: Draft, opts: ResolveOptions, actor: ActorId): void {
  const config = opts.config;
  const shi = config.factions[BESIEGED_FACTION].principal;
  d.set(['flags', 'assistanceAbandoned'], true);
  for (const thread of commitmentsOfPair(d.s as WorldState, ASSISTANCE_PAIR)) {
    if (thread.status !== 'negotiating') continue;
    const live = need(own(d.s.offers, thread.liveOfferId), `offer ${thread.liveOfferId}`);
    if (live.from === shi && (live.status === 'in_transit' || live.status === 'delivered') && live.withdrawal === null) {
      sendWithdrawal(d, config, live, actor);
    } else if (live.to === shi && live.status === 'delivered') {
      rejectLiveOffer(d, config, live, actor, 'assistance request abandoned');
    }
  }
  for (const id of Object.keys(d.s.documents).sort()) {
    const doc = own(d.s.documents, id) as Document;
    if ((doc.status === 'draft' || doc.status === 'approved') && documentSender(d.s as WorldState, config, doc) === shi) {
      d.set(['documents', id, 'status'], 'withdrawn');
      observeDocument(d, config, doc, actor);
    }
  }
  fact(d, config, sceneOf(d.s, config, shi), 'assistance_abandoned', actor, { by: shi });
  d.rule('H04', 'H10');
}

function resolveRevoke(d: Draft, opts: ResolveOptions, actor: ActorId, a: ActionOf<'revoke_authorization'>): void {
  need(own(d.s.player.authorizations, a.args.authId), `authorization ${a.args.authId}`);
  d.set(['player', 'authorizations', a.args.authId, 'revoked'], true);
  fact(d, opts.config, sceneOf(d.s, opts.config, actor), 'authorization_revoked', actor, { authId: a.args.authId });
  d.rule('H04');
}

function resolveLetter(d: Draft, opts: ResolveOptions, actor: ActorId, a: ActionOf<'send_letter'>): void {
  const msgId = d.nextId('msg');
  const arrivalDay = arrivalBetween(d, opts.config, actor, a.args.to);
  postMessage(d, opts.config, msgId, {
    from: actor,
    to: a.args.to,
    kind: 'letter',
    payload: { kind: 'letter', text: a.args.text },
    arrivalDay,
  });
  fact(d, opts.config, sceneOf(d.s, opts.config, actor), 'letter_sent', actor, { messageId: msgId, to: a.args.to, arrivalDay });
  d.rule('H08');
}

function resolveSystem(d: Draft, opts: ResolveOptions, action: SystemAction): void {
  const config = opts.config;
  const scene = d.s.characters[config.factions[BESIEGED_FACTION].principal].location;
  switch (action.type) {
    case 'mutiny_outbreak': {
      const n = siegeMutinyOutbreak(siegeNumbers(d.s as WorldState), config.params);
      d.set(['siege', 'morale'], n.morale);
      d.set(['siege', 'pressure'], n.pressure);
      d.set(['flags', 'mutinyOccurred'], true);
      fact(d, config, scene, 'mutiny_outbreak', 'system', { morale: n.morale, pressure: n.pressure });
      d.rule('G06');
      return;
    }
    case 'character_death': {
      need(d.s.characters[action.args.charId], 'character');
      d.set(['characters', action.args.charId, 'status'], 'dead');
      fact(d, config, d.s.characters[action.args.charId].location, 'character_death', 'system', { charId: action.args.charId });
      return;
    }
    case 'allegiance_change': {
      need(d.s.characters[action.args.charId], 'character');
      d.set(['characters', action.args.charId, 'faction'], action.args.faction);
      fact(d, config, d.s.characters[action.args.charId].location, 'allegiance_change', 'system', {
        charId: action.args.charId,
        faction: action.args.faction,
      });
      return;
    }
  }
}

/**
 * Resolves one parsed action against `state`. Returns the effect (null for dialogue-only actions: speak, wait)
 * or `{ok:false}` when the effects are inapplicable.
 */
export function resolveAction(state: WorldState, actor: ActorId, action: AnyAction, opts: ResolveOptions): ResolveResult {
  const d = new Draft(state);
  try {
    if (isSystemActionType(action.type)) {
      resolveSystem(d, opts, action as SystemAction);
      return { ok: true, effect: d.build(action.type as EventKind, 'system'), dialogue: null };
    }
    const a = action as Action;
    switch (a.type) {
      case 'speak': {
        const listeners = [...new Set(a.args.to)].filter((l) => l !== actor);
        return { ok: true, effect: null, dialogue: { speaker: actor, listeners, text: a.args.text, kind: 'speech' } };
      }
      case 'wait':
        return { ok: true, effect: null, dialogue: null };
      case 'send_letter':
        resolveLetter(d, opts, actor, a);
        break;
      case 'revise_document':
        resolveRevise(d, opts, actor, a);
        break;
      case 'suggest_revision':
        resolveSuggest(d, opts, actor, a);
        break;
      case 'approve_document':
        resolveApprove(d, opts, actor, a);
        break;
      case 'set_dispatch_timing':
        resolveTiming(d, opts, actor, a);
        break;
      case 'dispatch_document':
        resolveDispatch(d, opts, actor, a);
        break;
      case 'propose_terms':
        resolvePropose(d, opts, actor, a);
        break;
      case 'respond_to_offer':
        resolveRespond(d, opts, actor, a);
        break;
      case 'withdraw_offer':
        resolveWithdraw(d, opts, actor, a);
        break;
      case 'confirm_commitment':
        resolveConfirm(d, opts, actor, a);
        break;
      case 'allocate_resources':
        resolveAllocate(d, opts, actor, a);
        break;
      case 'abandon_request':
        resolveAbandon(d, opts, actor);
        break;
      case 'revoke_authorization':
        resolveRevoke(d, opts, actor, a);
        break;
    }
    return { ok: true, effect: d.build(a.type as EventKind, actor), dialogue: null };
  } catch (err) {
    if (err instanceof Inapplicable) return { ok: false, reason: `inapplicable: ${err.message}` };
    if (err instanceof PatchError) return { ok: false, reason: `inapplicable: ${err.message}` };
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Pre-start messages (PLAN §12.4 `initial_overrides.in_transit`)
// ---------------------------------------------------------------------------------------------------------------

export type PreStartSpec =
  | { kind: 'offer'; from: CharId; to: CharId; terms: TermSet; note: string; sentDay: number; arrivalDay: number }
  | { kind: 'letter'; from: CharId; to: CharId; text: string; sentDay: number; arrivalDay: number };

/**
 * Builds a message already on the road when the chapter starts, exactly like a committed send: an offer opens its
 * thread (negotiation counters, the sender's reservations, the sender side's `terms`/`status` assertions with
 * `initial` evidence) and both kinds wait in transit for the PREPARE of the first round whose day ≥ arrivalDay.
 * Validation (principals, pair, terms, caps, feasibility) is the caller's (content loader's) job.
 */
export function seedPreStart(d: Draft, config: CoreConfig, spec: PreStartSpec): string {
  if (spec.kind === 'letter') {
    const msgId = d.nextId('msg');
    postMessage(d, config, msgId, {
      from: spec.from,
      to: spec.to,
      kind: 'letter',
      payload: { kind: 'letter', text: spec.text },
      sentDay: spec.sentDay,
      arrivalDay: spec.arrivalDay,
      immediate: false,
    });
    return msgId;
  }
  const pair = need(pairOf(d.s.characters[spec.from].faction, d.s.characters[spec.to].faction), 'principal pair');
  const opened = openThread(d, { config }, spec.from, {
    sender: spec.from,
    to: spec.to,
    pair,
    terms: spec.terms,
    consentEvidence: 'pre-start',
    consentBy: spec.from,
    note: spec.note,
    preStart: { sentDay: spec.sentDay, arrivalDay: spec.arrivalDay },
  });
  return opened.offerId;
}

// ---------------------------------------------------------------------------------------------------------------
// Decision world-effects (§7) — applied inside the batch commit after the H05 entry check
// ---------------------------------------------------------------------------------------------------------------

export function authorizationEffect(state: WorldState, config: CoreConfig, grant: AuthorizationGrant): { effect: EffectDraft; authId: string } {
  const d = new Draft(state);
  const id = d.nextId('auth');
  d.set(['player', 'authorizations', id], {
    id,
    grantee: grant.grantee,
    categories: [...grant.categories],
    limits: grant.limits,
    grantedRound: state.round,
    expiresRound: grant.expiresRound,
    revoked: false,
  });
  fact(d, config, state.player.location, 'authorization_granted', 'player', {
    authId: id,
    grantee: grant.grantee,
    categories: [...grant.categories],
    expiresRound: grant.expiresRound,
  });
  d.rule('H10');
  return { effect: d.build('authorization_granted', 'player'), authId: id };
}

export function goalEffect(state: WorldState, config: CoreConfig, limits: TermLimits): EffectDraft {
  const d = new Draft(state);
  d.set(['player', 'goal', 'limits'], limits);
  fact(d, config, state.player.location, 'goal_adjusted', 'player', {});
  return d.build('goal_adjusted', 'player');
}

/**
 * World effect of a resolved qualifying `negotiation_deadlock` decision (adjust_goal / urge_accept / urge_stop):
 * opens a new segment recorded as `event:N` (this event; the decision id stays in the event log, never in world
 * state), unless the global cap is reached (then it only clears the pending deadlock so the checkpoint is not
 * raised again). Part of the regenerating `player` batch (§7).
 */
export function openNewSegmentEffect(state: WorldState, config: CoreConfig, pair: PairId, decisionId: string): EffectDraft {
  const d = new Draft(state);
  const opened = openNewSegment(d, config, pair);
  fact(d, config, state.player.location, 'deadlock_resolved', 'player', {
    pair,
    segmentOpened: opened,
    segment: d.s.negotiation[pair].segment,
    decisionId,
  });
  d.rule('H13', 'G10');
  return d.build('deadlock_resolved', 'player');
}
