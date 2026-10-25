/**
 * Validation of proposals against the hard constraints (PLAN §5). Pure: `validate(state, proposal, ctx)` returns
 * `{ok: true, ...}` or a `RuleFailure` with the rule id, the full reason and the (possibly redacted) feedback.
 *
 * Knowledge-dependent checks use the actor's assertions (H08); a failure whose cause the actor cannot know gets
 * generic feedback (§8.6). H05 (batch entry), H06 (idempotency) and H14 (time) are harness-level predicates
 * exported at the end of this module. H15 holds structurally: action schemas are strict (unknown keys ⇒ H01) and
 * no resolver copies model text into world state except letter text, which is an immutable message payload.
 */
import { own } from './ids.js';
import { isSystemActionType, parseAction, parseSystemAction, type Action, type ActionOf, type SystemAction } from './actions.js';
import { failure, type RuleFailure } from './feedback.js';
import {
  believedOfferStatus,
  believedThreadStatus,
  canAccessDocument,
  clauseLookupFor,
  coLocated,
  hasReceiptEvidence,
  isAlive,
  isCharId,
  knowsClause,
  knowsSubject,
  withdrawalBelief,
} from './knowledge.js';
import { checkConsentFeasible, deriveObligations, availableResource } from './obligations.js';
import { checkOfferCap, commitmentsOfPair, documentPair, documentSender, negotiatingThread, offersOfPair } from './negotiation.js';
import { findAuthorization, mandatoryCategory } from './pauses.js';
import { expandTermArgs, pairOf, validateSuggestion, validateTerms } from './terms.js';
import {
  ALLOCATION_TARGETS,
  ASSISTANCE_PAIR,
  BESIEGED_FACTION,
  PLAYER_FORBIDDEN_ACTIONS,
  type ActorId,
  type AnyAction,
  type CharId,
  type CoreConfig,
  type Document,
  type GateKind,
  type Mode,
  type Offer,
  type PairId,
  type PauseCategory,
  type TermSet,
  type WorldState,
} from './types.js';

export interface ValidationContext {
  config: CoreConfig;
  mode: Mode;
  /** A resolved endorse/delegate/let_it_happen decision exists for this proposal in its batch (H10). */
  decided?: boolean;
  /** Enforce H10 (default true). A dry run passes false and reads `requiresDecision` instead. */
  checkGate?: boolean;
}

export interface ValidationOk {
  ok: true;
  action: AnyAction;
  /** Mandatory pause category of the proposal (null if not critical). */
  category: PauseCategory | null;
  /** How H10 is satisfied (`ungated` = critical but no gate: baseline, or a dry run needing a decision). */
  gate: GateKind;
  authorizationId: string | null;
  /** Set in dry runs (`checkGate: false`) when a decision is still required. */
  requiresDecision: PauseCategory | null;
}

export type ValidationResult = ValidationOk | RuleFailure;

export interface ProposalLike {
  actor: ActorId;
  action: unknown;
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

function principalOfFaction(config: CoreConfig, state: WorldState, actor: CharId): boolean {
  return config.factions[state.characters[actor].faction].principal === actor;
}

function documentChecks(state: WorldState, actor: ActorId, docId: string): RuleFailure | Document {
  const doc = own(state.documents, docId);
  // Existence of objects the actor has no evidence about is never revealed (§8.6): same generic feedback.
  if (!doc) return failure('H04', `no document ${docId}`, { knownToActor: false });
  if (!canAccessDocument(state, actor, doc)) {
    return failure('H08', `${actor} has no access to ${docId} (not in accessibleBy or not with its holder ${doc.holder})`, {
      knownToActor: false,
    });
  }
  return doc;
}

/** Expands term args with the clauses the actor knows; hidden clauses of `preserved` stay. */
function expandForActor(
  state: WorldState,
  config: CoreConfig,
  actor: ActorId,
  args: Parameters<typeof expandTermArgs>[0],
  preserved: TermSet['secret_clauses'] = [],
): RuleFailure | TermSet {
  const expanded = expandTermArgs(args, clauseLookupFor(state, config, actor), preserved);
  if (!expanded.ok) {
    return failure('H08', `${actor} referenced secret clause(s) it does not know: ${expanded.unknownClauseIds.join(', ')}`, {
      knownToActor: false,
    });
  }
  return expanded.terms;
}

function termsProblems(terms: TermSet, pair: PairId, config: CoreConfig): RuleFailure | null {
  const problems = validateTerms(terms, pair, config.catalog);
  return problems.length > 0 ? failure('H01', `terms invalid for ${pair}: ${problems.join('; ')}`) : null;
}

export const H13_SEGMENT_EXHAUSTED = 'segment_exhausted';
export const H13_GLOBAL_CAP = 'global_cap';

function capCode(kind: 'global_cap' | 'segment'): string {
  return kind === 'segment' ? H13_SEGMENT_EXHAUSTED : H13_GLOBAL_CAP;
}

/** The actor knows every offer of the pair (so a cap/segment reason leaks nothing). */
function knowsAllOffers(state: WorldState, pair: PairId, holders: ActorId[]): boolean {
  return offersOfPair(state, pair).every((o) => holders.some((h) => knowsSubject(state, h, o.id)));
}

/** H04 (no second negotiating thread) + H13 (segment/global cap) for a new thread of `pair`. */
function newThreadChecks(state: WorldState, config: CoreConfig, pair: PairId, holders: ActorId[]): RuleFailure | null {
  const open = negotiatingThread(state, pair);
  if (open) {
    const known = holders.some((h) => believedThreadStatus(state, h, open.id) === 'negotiating');
    return failure('H04', `${pair} already has a negotiating thread ${open.id}; answer or withdraw its live offer instead`, {
      knownToActor: known,
    });
  }
  const cap = checkOfferCap(state, config, pair);
  if (!cap.ok) return failure('H13', cap.reason, { knownToActor: knowsAllOffers(state, pair, holders), code: capCode(cap.kind) });
  return null;
}

function consentChecks(
  state: WorldState,
  faction: WorldState['characters'][CharId]['faction'],
  terms: TermSet,
  pair: PairId,
  excludeCommitmentId: string | null,
): RuleFailure | null {
  const check = checkConsentFeasible(state, faction, deriveObligations(terms, pair), excludeCommitmentId);
  return check.ok ? null : failure('H07', check.reason);
}

// ---------------------------------------------------------------------------------------------------------------
// Per-action checks (after H01–H03 and the permission part of H02)
// ---------------------------------------------------------------------------------------------------------------

function checkSpeak(state: WorldState, actor: ActorId, a: ActionOf<'speak'>): RuleFailure | null {
  for (const listener of a.args.to) {
    if (listener === actor) continue;
    if (!isAlive(state, listener) || !coLocated(state, actor, listener)) {
      return failure('H08', `${listener} is not present to hear ${actor}`);
    }
  }
  return null;
}

function checkLetter(state: WorldState, actor: ActorId, a: ActionOf<'send_letter'>): RuleFailure | null {
  if (a.args.to === actor) return failure('H01', 'a letter needs another recipient');
  if (coLocated(state, actor, a.args.to)) return failure('H08', `${a.args.to} is present; speak instead of writing`);
  return null;
}

function checkRevise(state: WorldState, config: CoreConfig, actor: ActorId, a: ActionOf<'revise_document'>): RuleFailure | null {
  const doc = documentChecks(state, actor, a.args.docId);
  if ('ok' in doc) return doc;
  if (doc.status === 'sent' || doc.status === 'withdrawn') return failure('H11', `${doc.id} is ${doc.status} and immutable`);
  if (a.args.baseDocVersion !== doc.version) {
    return failure('H04', `stale document version: based on v${a.args.baseDocVersion}, current v${doc.version}`);
  }
  const pair = documentPair(state, config, doc);
  if (!pair) return failure('H01', `${doc.id} has no principal pair`);
  const hidden = doc.terms.secret_clauses.filter((c) => !knowsClause(state, config, actor, c.id));
  const terms = expandForActor(state, config, actor, a.args.terms, hidden);
  if ('ok' in terms) return terms;
  return termsProblems(terms, pair, config);
}

function checkSuggest(state: WorldState, config: CoreConfig, actor: ActorId, a: ActionOf<'suggest_revision'>): RuleFailure | null {
  const target = a.args.target;
  if (!target.id.startsWith(target.kind === 'document' ? 'doc:' : 'offer:')) {
    return failure('H01', `target ${target.id} is not a ${target.kind} id`);
  }
  if (target.kind === 'document') {
    const doc = documentChecks(state, actor, target.id);
    if ('ok' in doc) return doc;
  } else {
    if (!own(state.offers, target.id)) return failure('H04', `no offer ${target.id}`, { knownToActor: false });
    if (!knowsSubject(state, actor, target.id)) {
      return failure('H08', `${actor} has no knowledge of ${target.id}`, { knownToActor: false });
    }
  }
  const problems = validateSuggestion(a.args.terms, config.catalog);
  if (problems.length > 0) return failure('H01', `suggested terms invalid: ${problems.join('; ')}`);
  for (const id of a.args.terms.secret_clauses ?? []) {
    if (!knowsClause(state, config, actor, id)) {
      return failure('H08', `${actor} referenced secret clause ${id} it does not know`, { knownToActor: false });
    }
  }
  return null;
}

function checkApprove(state: WorldState, config: CoreConfig, actor: ActorId, a: ActionOf<'approve_document'>): RuleFailure | null {
  const doc = documentChecks(state, actor, a.args.docId);
  if ('ok' in doc) return doc;
  if (actor !== documentSender(state, config, doc)) return failure('H02', `only ${documentSender(state, config, doc)} may approve ${doc.id}`);
  if (doc.status === 'sent' || doc.status === 'withdrawn') return failure('H11', `${doc.id} is ${doc.status} and immutable`);
  if (a.args.docVersion !== doc.version) {
    return failure('H04', `stale document version: approving v${a.args.docVersion}, current v${doc.version}`);
  }
  if (doc.status !== 'draft') return failure('H04', `${doc.id} v${doc.version} is already ${doc.status}`);
  return null;
}

function checkTiming(state: WorldState, config: CoreConfig, actor: ActorId, a: ActionOf<'set_dispatch_timing'>): RuleFailure | null {
  const doc = documentChecks(state, actor, a.args.docId);
  if ('ok' in doc) return doc;
  if (doc.status === 'sent' || doc.status === 'withdrawn') return failure('H11', `${doc.id} is ${doc.status}; timing can no longer change`);
  if (a.args.mode === 'delay') {
    const { delay_rounds_min: min, delay_rounds_max: max } = config.params;
    if (a.args.rounds === null || a.args.rounds < min || a.args.rounds > max) {
      return failure('H01', `delay needs rounds between ${min} and ${max}`);
    }
  }
  return null;
}

function checkDispatch(state: WorldState, config: CoreConfig, actor: ActorId, a: ActionOf<'dispatch_document'>): RuleFailure | null {
  const doc = documentChecks(state, actor, a.args.docId);
  if ('ok' in doc) return doc;
  if (doc.status === 'sent') return failure('H12', `${doc.id} was already dispatched`);
  if (doc.status === 'withdrawn') return failure('H11', `${doc.id} was withdrawn`);
  if (a.args.docVersion !== doc.version) {
    return failure('H04', `stale document version: dispatching v${a.args.docVersion}, current v${doc.version}`);
  }
  if (doc.status !== 'approved' || doc.approval === null || doc.approval.version !== doc.version) {
    return failure('H11', `${doc.id} v${doc.version} is not approved; only the approved current version can be dispatched`);
  }
  if (doc.timing.mode === 'hold') return failure('H11', `${doc.id} is on hold`);
  if (doc.timing.mode === 'delay' && doc.timing.notBeforeRound !== null && state.round < doc.timing.notBeforeRound) {
    return failure('H11', `${doc.id} is delayed until round ${doc.timing.notBeforeRound}`);
  }
  const pair = documentPair(state, config, doc);
  if (!pair) return failure('H01', `${doc.id} has no principal pair`);
  const sender = documentSender(state, config, doc);
  const thread = newThreadChecks(state, config, pair, [actor, sender]);
  if (thread) return thread;
  const terms = termsProblems(doc.terms, pair, config);
  if (terms) return terms;
  return consentChecks(state, state.characters[sender].faction, doc.terms, pair, null);
}

function checkPropose(state: WorldState, config: CoreConfig, actor: ActorId, a: ActionOf<'propose_terms'>): RuleFailure | null {
  if (!isCharId(actor) || !principalOfFaction(config, state, actor)) return failure('H02', `${actor} is not a principal`);
  const to = a.args.to;
  if (config.factions[state.characters[to].faction].principal !== to) return failure('H01', `${to} is not a principal`);
  const pair = pairOf(state.characters[actor].faction, state.characters[to].faction);
  if (!pair) return failure('H01', `${actor} and ${to} are not a principal pair`);
  const thread = newThreadChecks(state, config, pair, [actor]);
  if (thread) return thread;
  const terms = expandForActor(state, config, actor, a.args.terms);
  if ('ok' in terms) return terms;
  const invalid = termsProblems(terms, pair, config);
  if (invalid) return invalid;
  return consentChecks(state, state.characters[actor].faction, terms, pair, null);
}

/** Common checks for answering an offer (respond/confirm). Returns the offer or a failure. */
function answerChecks(state: WorldState, actor: ActorId, offerId: string): RuleFailure | Offer {
  const offer = own(state.offers, offerId);
  if (!offer) return failure('H04', `no offer ${offerId}`, { knownToActor: false });
  if (!knowsSubject(state, actor, offerId)) {
    return failure('H08', `${actor} has not received ${offerId} (nothing is known before arrival)`, { knownToActor: false });
  }
  return offer;
}

function liveChecks(state: WorldState, actor: ActorId, offer: Offer): RuleFailure | null {
  if (!hasReceiptEvidence(state, actor, offer.id, offer.termsVersion)) {
    return failure('H08', `${actor} holds no receipt of ${offer.id} v${offer.termsVersion}`, { knownToActor: false });
  }
  if (offer.status === 'accepted' || offer.status === 'countered' || offer.status === 'rejected') {
    return failure('H12', `${offer.id} was already answered (${offer.status})`);
  }
  if (offer.status === 'withdrawn') {
    return failure('H04', `${offer.id} was withdrawn`, { knownToActor: believedOfferStatus(state, actor, offer.id) === 'withdrawn' });
  }
  const thread = own(state.commitments, offer.commitmentId);
  if (!thread || thread.status !== 'negotiating' || thread.liveOfferId !== offer.id) {
    return failure('H04', `${offer.id} is not the live offer of an open thread`, {
      knownToActor: thread ? believedThreadStatus(state, actor, thread.id) === thread.status : false,
    });
  }
  if (offer.status !== 'delivered') return failure('H08', `${offer.id} has not been delivered`, { knownToActor: false });
  return null;
}

function checkRespond(state: WorldState, config: CoreConfig, actor: ActorId, a: ActionOf<'respond_to_offer'>): RuleFailure | null {
  const offer = answerChecks(state, actor, a.args.offerId);
  if ('ok' in offer) return offer;
  if (actor !== offer.to) return failure('H02', `only ${offer.to}, the recipient of ${offer.id}, may answer it`);
  const live = liveChecks(state, actor, offer);
  if (live) return live;
  if (a.args.response === 'reject') return null;
  if (a.args.counterTerms === null) return failure('H01', 'a counter needs counterTerms');
  const thread = own(state.commitments, offer.commitmentId);
  if (!thread) return failure('H04', `no commitment ${offer.commitmentId}`);
  const terms = expandForActor(state, config, actor, a.args.counterTerms);
  if ('ok' in terms) return terms;
  const invalid = termsProblems(terms, thread.pair, config);
  if (invalid) return invalid;
  const cap = checkOfferCap(state, config, thread.pair);
  if (!cap.ok) return failure('H13', cap.reason, { code: capCode(cap.kind) });
  return consentChecks(state, state.characters[offer.to].faction, terms, thread.pair, thread.id);
}

function checkWithdraw(state: WorldState, actor: ActorId, a: ActionOf<'withdraw_offer'>): RuleFailure | null {
  const offer = own(state.offers, a.args.offerId);
  if (!offer) return failure('H04', `no offer ${a.args.offerId}`, { knownToActor: false });
  if (actor !== offer.from) {
    return knowsSubject(state, actor, offer.id)
      ? failure('H02', `only ${offer.from}, the sender of ${offer.id}, may withdraw it`)
      : failure('H08', `${actor} has no knowledge of ${offer.id}`, { knownToActor: false });
  }
  if (offer.withdrawal !== null || withdrawalBelief(state, actor, offer.id) !== null) {
    return failure('H12', `a withdrawal of ${offer.id} was already sent`);
  }
  const belief = believedOfferStatus(state, actor, offer.id);
  if (belief !== 'sent' && belief !== 'delivered') {
    return failure('H04', `per ${actor}'s knowledge ${offer.id} is no longer open (${belief ?? 'unknown'})`);
  }
  return null;
}

function checkConfirm(state: WorldState, config: CoreConfig, actor: ActorId, a: ActionOf<'confirm_commitment'>): RuleFailure | null {
  const thread = own(state.commitments, a.args.commitmentId);
  if (!thread) return failure('H04', `no commitment ${a.args.commitmentId}`, { knownToActor: false });
  if (!knowsSubject(state, actor, thread.id)) {
    return failure('H08', `${actor} has no evidence of ${thread.id}`, { knownToActor: false });
  }
  const offer = answerChecks(state, actor, a.args.offerId);
  if ('ok' in offer) return offer;
  if (offer.commitmentId !== thread.id) return failure('H04', `${offer.id} does not belong to ${thread.id}`);
  if (!isCharId(actor) || !thread.parties.includes(actor)) {
    return failure('H09', `${actor} is not a party of ${thread.id}; consent must come from the party itself`);
  }
  if (actor === offer.from) return failure('H09', `${actor} sent ${offer.id}; only its recipient can confirm it`);
  if (actor !== offer.to) return failure('H09', `${actor} is not the recipient of ${offer.id}`);
  const live = liveChecks(state, actor, offer);
  if (live) return live;
  if (a.args.termsVersion !== offer.termsVersion) {
    return failure('H04', `termsVersion mismatch: confirming v${a.args.termsVersion}, live offer is v${offer.termsVersion}`);
  }
  const senderConsent = thread.consents[offer.from];
  if (!senderConsent || senderConsent.termsVersion !== offer.termsVersion) {
    return failure('H09', `${offer.from} has not consented to v${offer.termsVersion}`);
  }
  return consentChecks(state, state.characters[actor].faction, offer.terms, thread.pair, thread.id);
}

function checkAllocate(state: WorldState, config: CoreConfig, actor: ActorId, a: ActionOf<'allocate_resources'>): RuleFailure | null {
  const { faction, resource, amount, purpose } = a.args;
  if (amount <= 0) return failure('H01', 'amount must be positive');
  const target = ALLOCATION_TARGETS[purpose];
  if (target.faction !== faction || target.resource !== resource) {
    return failure('H01', `${purpose} allocates ${target.faction} ${target.resource}`);
  }
  if (!isCharId(actor) || state.characters[actor].faction !== faction || !principalOfFaction(config, state, actor)) {
    return failure('H02', `only the principal of ${faction} may allocate its resources`);
  }
  const available = availableResource(state, faction, resource);
  if (available < amount) {
    return failure('H07', `${faction} has ${available} ${resource} available after reservations; ${amount} requested`);
  }
  return null;
}

function checkAbandon(state: WorldState, config: CoreConfig, actor: ActorId): RuleFailure | null {
  if (actor !== config.factions[BESIEGED_FACTION].principal) {
    return failure('H02', `only ${config.factions[BESIEGED_FACTION].principal} may abandon the request`);
  }
  if (state.flags.assistanceAbandoned) return failure('H04', 'the request was already abandoned');
  // §4: no confirmed hedong↔khitan thread (world state). If Shi has no evidence of the confirmation yet, the
  // rejection must not reveal it.
  const confirmed = commitmentsOfPair(state, ASSISTANCE_PAIR).find((t) => t.status === 'confirmed');
  if (confirmed) {
    return failure('H04', `${confirmed.id} is already confirmed; the pact stands`, {
      knownToActor: believedThreadStatus(state, actor, confirmed.id) === 'confirmed',
    });
  }
  return null;
}

function checkRevoke(state: WorldState, a: ActionOf<'revoke_authorization'>): RuleFailure | null {
  const auth = own(state.player.authorizations, a.args.authId);
  if (!auth) return failure('H04', `no authorization ${a.args.authId}`);
  if (auth.revoked) return failure('H04', `${a.args.authId} is already revoked`);
  return null;
}

function checkSystem(state: WorldState, actor: ActorId, a: SystemAction): RuleFailure | null {
  if (actor !== 'system') return failure('H02', `${a.type} is a system outcome`);
  if (state.terminal) return failure('H03', `the world is terminal (${state.terminal.kind})`);
  switch (a.type) {
    case 'mutiny_outbreak':
      return state.flags.mutinyOccurred ? failure('H04', 'a mutiny already occurred') : null;
    case 'character_death':
      return state.characters[a.args.charId].status === 'dead' ? failure('H04', `${a.args.charId} is already dead`) : null;
    case 'allegiance_change':
      return state.characters[a.args.charId].faction === a.args.faction
        ? failure('H04', `${a.args.charId} already belongs to ${a.args.faction}`)
        : null;
  }
}

/** H02–H13 for a parsed action (no H10). */
export function checkAction(state: WorldState, config: CoreConfig, actor: ActorId, action: AnyAction): RuleFailure | null {
  if (isSystemActionType(action.type)) return checkSystem(state, actor, action as SystemAction);
  const a = action as Action;
  if (actor === 'system') return failure('H02', 'the system does not perform character actions');
  if (state.terminal) return failure('H03', `the world is terminal (${state.terminal.kind})`);
  if (!isAlive(state, actor)) return failure('H03', `${actor} is ${isCharId(actor) ? state.characters[actor].status : 'unavailable'}`);
  if (actor === 'player') {
    if (PLAYER_FORBIDDEN_ACTIONS.includes(a.type)) {
      return failure('H02', `the player never performs ${a.type}: consent and principal decisions belong to the characters`);
    }
    if (!config.player.permissions.includes(a.type)) return failure('H02', `the player may not ${a.type}`);
  } else if (!config.characters[actor].permissions.includes(a.type)) {
    return failure('H02', `${actor} may not ${a.type}`);
  }
  switch (a.type) {
    case 'speak':
      return checkSpeak(state, actor, a);
    case 'send_letter':
      return checkLetter(state, actor, a);
    case 'revise_document':
      return checkRevise(state, config, actor, a);
    case 'suggest_revision':
      return checkSuggest(state, config, actor, a);
    case 'approve_document':
      return checkApprove(state, config, actor, a);
    case 'set_dispatch_timing':
      return checkTiming(state, config, actor, a);
    case 'dispatch_document':
      return checkDispatch(state, config, actor, a);
    case 'propose_terms':
      return checkPropose(state, config, actor, a);
    case 'respond_to_offer':
      return checkRespond(state, config, actor, a);
    case 'withdraw_offer':
      return checkWithdraw(state, actor, a);
    case 'confirm_commitment':
      return checkConfirm(state, config, actor, a);
    case 'allocate_resources':
      return checkAllocate(state, config, actor, a);
    case 'abandon_request':
      return checkAbandon(state, config, actor);
    case 'revoke_authorization':
      return checkRevoke(state, a);
    case 'wait':
      return null;
  }
}

/** H01: parses a raw action for its actor (the system proposes system outcomes, everyone else closed-set actions). */
export function parseProposalAction(actor: ActorId, raw: unknown): { ok: true; action: AnyAction } | RuleFailure {
  const typeField = typeof raw === 'object' && raw !== null ? (raw as { type?: unknown }).type : undefined;
  const parsed = actor === 'system' || isSystemActionType(typeField) ? parseSystemAction(raw) : parseAction(raw);
  if (!parsed.ok) return failure('H01', `invalid action: ${parsed.error}`);
  return { ok: true, action: parsed.value };
}

/** Full validation of one proposal against the current (evolving) state. */
export function validate(state: WorldState, proposal: ProposalLike, ctx: ValidationContext): ValidationResult {
  const parsed = parseProposalAction(proposal.actor, proposal.action);
  if (!parsed.ok) return parsed;
  const action = parsed.action;
  const failed = checkAction(state, ctx.config, proposal.actor, action);
  if (failed) return failed;

  const category = mandatoryCategory(state, ctx.config, proposal.actor, action);
  if (category === null) {
    return { ok: true, action, category, gate: 'not_required', authorizationId: null, requiresDecision: null };
  }
  if (ctx.mode === 'baseline') {
    return { ok: true, action, category, gate: 'ungated', authorizationId: null, requiresDecision: null };
  }
  if (proposal.actor === 'player') {
    return { ok: true, action, category, gate: 'player_initiated', authorizationId: null, requiresDecision: null };
  }
  if (ctx.decided) return { ok: true, action, category, gate: 'decision', authorizationId: null, requiresDecision: null };
  const auth = findAuthorization(state, ctx.config, proposal.actor, category, action);
  if (auth) return { ok: true, action, category, gate: 'authorization', authorizationId: auth.id, requiresDecision: null };
  if (ctx.checkGate === false) {
    return { ok: true, action, category, gate: 'ungated', authorizationId: null, requiresDecision: category };
  }
  return failure('H10', `${category} requires the player's decision (no endorsement or matching authorization)`, {
    feedback: 'This needs the player\'s decision and was not carried out.',
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Harness-level predicates
// ---------------------------------------------------------------------------------------------------------------

/** H05 batch entry check: epoch and base version must both still match (checked atomically at commit start). */
export function checkBatchEntry(
  batch: { epoch: number; baseVersion: number },
  sessionEpoch: number,
  worldVersion: number,
): RuleFailure | null {
  if (batch.epoch !== sessionEpoch) return failure('H05', `stale epoch: batch ${batch.epoch}, session ${sessionEpoch}`);
  if (batch.baseVersion !== worldVersion) {
    return failure('H05', `stale base version: batch ${batch.baseVersion}, world ${worldVersion}`);
  }
  return null;
}

/** H06: outcome of a request id lookup. */
export function checkIdempotency(
  stored: { payloadHash: string } | null,
  payloadHash: string,
): { kind: 'new' } | { kind: 'replay' } | RuleFailure {
  if (stored === null) return { kind: 'new' };
  if (stored.payloadHash === payloadHash) return { kind: 'replay' };
  return failure('H06', 'request id reused with a different payload');
}

/** H14: story time advances only with no open pause, no uncommitted batch and a non-terminal world. */
export function checkAdvance(
  state: WorldState,
  control: { openPauses: number; uncommittedBatches: number },
): RuleFailure | null {
  if (state.terminal) return failure('H03', `the world is terminal (${state.terminal.kind})`);
  if (control.openPauses > 0) return failure('H14', `${control.openPauses} pause(s) still open`);
  if (control.uncommittedBatches > 0) return failure('H14', `${control.uncommittedBatches} batch(es) not committed`);
  return null;
}
