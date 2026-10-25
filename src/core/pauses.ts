/**
 * Pause categories, feasible decision options (PLAN §7), mandatory classification of critical proposals (§4 `P`)
 * and Authorization matching (H10).
 */
import { isSystemActionType, type Action, type SystemAction } from './actions.js';
import { compareIds, own } from './ids.js';
import { believedThreadStatus, clauseLookupFor, hasReceiptEvidence, isCharId, isPlayerSide } from './knowledge.js';
import { commitmentsOfPair, documentPair, latestThread, negotiatingThread } from './negotiation.js';
import { expandTermArgs, pairOf, withinLimits } from './terms.js';
import {
  ASSISTANCE_PAIR,
  BESIEGED_FACTION,
  MANDATORY_CATEGORIES,
  SEMANTIC_CATEGORIES,
  type ActorId,
  type AnyAction,
  type Authorization,
  type CoreConfig,
  type DecisionOption,
  type PairId,
  type PauseCategory,
  type PauseKind,
  type TermSet,
  type WorldState,
} from './types.js';

const SEMANTIC_OPTIONS: DecisionOption[] = ['endorse', 'withhold', 'amend', 'counter_draft', 'ask'];

/** Feasible options per category (UI and scripted policies may only choose these). */
export const FEASIBLE_OPTIONS: Record<PauseCategory, readonly DecisionOption[]> = {
  dispatch_request: ['endorse', 'withhold', 'amend', 'delegate', 'ask'],
  major_commitment: ['endorse', 'withhold', 'counter_draft', 'delegate', 'ask'],
  strategic_turn: ['endorse', 'withhold', 'ask'],
  mutiny: ['let_it_happen', 'urge_payment', 'ask'],
  negotiation_deadlock: ['adjust_goal', 'urge_accept', 'urge_stop', 'ask'],
  death: ['endorse', 'withhold', 'ask'],
  allegiance: ['endorse', 'withhold', 'ask'],
  internal_disagreement: SEMANTIC_OPTIONS,
  goal_conflict: SEMANTIC_OPTIONS,
  risky_delay: SEMANTIC_OPTIONS,
  ambiguity: SEMANTIC_OPTIONS,
  prompt_request: SEMANTIC_OPTIONS,
  user_requested: ['resume', 'ask'],
  error_recovery: ['retry', 'skip_actor', 'stop'],
};

/** Options for a concrete pause: `amend` only if a document is involved, `counter_draft` only if an offer is. */
export function feasibleOptions(
  category: PauseCategory,
  involvement: { document: boolean; offer: boolean } = { document: true, offer: true },
): DecisionOption[] {
  const options = [...FEASIBLE_OPTIONS[category]];
  if (!isSemanticOrPrompt(category)) return options;
  return options.filter(
    (o) => (o !== 'amend' || involvement.document) && (o !== 'counter_draft' || involvement.offer),
  );
}

export function isOptionFeasible(category: PauseCategory, option: DecisionOption): boolean {
  return FEASIBLE_OPTIONS[category].includes(option);
}

export function isSemanticOrPrompt(category: PauseCategory): boolean {
  return SEMANTIC_CATEGORIES.includes(category) || category === 'prompt_request';
}

export function isMandatoryCategory(category: PauseCategory): boolean {
  return MANDATORY_CATEGORIES.includes(category);
}

export function pauseKindOf(category: PauseCategory): PauseKind {
  if (category === 'negotiation_deadlock') return 'control';
  if (MANDATORY_CATEGORIES.includes(category)) return 'mandatory';
  if (SEMANTIC_CATEGORIES.includes(category)) return 'semantic';
  if (category === 'prompt_request') return 'prompt';
  if (category === 'user_requested') return 'user';
  return 'error';
}

/** Decisions that let a proposal/outcome proceed (H10). */
export const PROCEED_OPTIONS: readonly DecisionOption[] = ['endorse', 'delegate', 'let_it_happen'];
/** Decisions that keep a proposal from committing (it becomes `withheld`). */
export const WITHHOLD_OPTIONS: readonly DecisionOption[] = ['withhold', 'counter_draft', 'urge_payment'];

/**
 * Mandatory pause category of a proposal (§4 `P` column; §6 system outcomes), or null if not critical.
 * Character/player actions are critical only when the actor is player-side.
 */
export function mandatoryCategory(
  state: WorldState,
  config: CoreConfig,
  actor: ActorId,
  action: AnyAction,
): PauseCategory | null {
  if (isSystemActionType(action.type)) {
    const system = action as SystemAction;
    if (system.type === 'mutiny_outbreak') return 'mutiny';
    if (system.type === 'character_death') return 'death';
    return 'allegiance';
  }
  if (!isPlayerSide(state, config, actor)) return null;
  const a = action as Action;
  switch (a.type) {
    case 'dispatch_document':
      return 'dispatch_request';
    case 'propose_terms':
    case 'confirm_commitment':
      return 'major_commitment';
    case 'respond_to_offer':
      return a.args.response === 'counter' ? 'major_commitment' : 'strategic_turn';
    case 'abandon_request':
      return 'strategic_turn';
    default:
      return null;
  }
}

/** Terms a critical proposal would commit to, with their pair (for authorization limits and goal checks). */
export function proposalTerms(
  state: WorldState,
  config: CoreConfig,
  actor: ActorId,
  action: AnyAction,
): { pair: PairId; terms: TermSet } | null {
  if (isSystemActionType(action.type)) return null;
  const a = action as Action;
  const lookup = clauseLookupFor(state, config, actor);
  switch (a.type) {
    case 'dispatch_document': {
      const doc = own(state.documents, a.args.docId);
      const pair = doc ? documentPair(state, config, doc) : null;
      return doc && pair ? { pair, terms: doc.terms } : null;
    }
    case 'propose_terms': {
      if (!isCharId(actor)) return null;
      const pair = pairOf(state.characters[actor].faction, state.characters[a.args.to].faction);
      const expanded = expandTermArgs(a.args.terms, lookup);
      return pair && expanded.ok ? { pair, terms: expanded.terms } : null;
    }
    case 'respond_to_offer': {
      const offer = own(state.offers, a.args.offerId);
      const thread = offer ? own(state.commitments, offer.commitmentId) : undefined;
      if (!offer || !thread) return null;
      if (a.args.response === 'reject' || a.args.counterTerms === null) return { pair: thread.pair, terms: offer.terms };
      const expanded = expandTermArgs(a.args.counterTerms, lookup);
      return expanded.ok ? { pair: thread.pair, terms: expanded.terms } : null;
    }
    case 'confirm_commitment': {
      const offer = own(state.offers, a.args.offerId);
      const thread = offer ? own(state.commitments, offer.commitmentId) : undefined;
      return offer && thread ? { pair: thread.pair, terms: offer.terms } : null;
    }
    default:
      return null;
  }
}

export function isAuthorizationActive(auth: Authorization, round: number): boolean {
  return !auth.revoked && auth.grantedRound <= round && (auth.expiresRound === null || round <= auth.expiresRound);
}

/** First active Authorization (by id) covering this critical proposal: grantee, category, round, terms within limits. */
export function findAuthorization(
  state: WorldState,
  config: CoreConfig,
  actor: ActorId,
  category: PauseCategory,
  action: AnyAction,
): Authorization | null {
  if (!isCharId(actor)) return null;
  const terms = proposalTerms(state, config, actor, action);
  const ids = Object.keys(state.player.authorizations).sort(compareIds);
  for (const id of ids) {
    const auth = own(state.player.authorizations, id) as Authorization;
    if (auth.grantee !== actor || !auth.categories.includes(category)) continue;
    if (!isAuthorizationActive(auth, state.round)) continue;
    if (terms && !withinLimits(terms.terms, auth.limits, config.catalog, terms.pair).ok) continue;
    return auth;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Negotiation exhaustion checkpoint (§4.1 v3.4)
// ---------------------------------------------------------------------------------------------------------------

export type ExhaustionReason = 'live_offer_awaits' | 'closure_learned' | 'over_segment_attempt';

export interface ExhaustionCheckpoint {
  pair: PairId;
  reason: ExhaustionReason;
  offerId: string | null;
  commitmentId: string | null;
}

function isConfirmOf(action: unknown, offer: { id: string; commitmentId: string; termsVersion: number }): boolean {
  if (typeof action !== 'object' || action === null) return false;
  const a = action as { type?: unknown; args?: { offerId?: unknown; commitmentId?: unknown; termsVersion?: unknown } };
  return (
    a.type === 'confirm_commitment' &&
    a.args?.offerId === offer.id &&
    a.args.commitmentId === offer.commitmentId &&
    a.args.termsVersion === offer.termsVersion
  );
}

/**
 * Exhaustion checkpoint predicate for the hedong↔khitan pair (the only pair with a user), evaluated at ASSESS on
 * the character batch's base state (Harness modes; the caller checks the mode):
 * - a player-side party attempted an over-segment offer in this batch (`overSegmentAttempt`), or
 * - the segment has used both rounds without agreement (`deadlockPending`) and it is Shi's side's move: Shi holds
 *   the delivered live offer and none of his *eligible* proposals this round confirms it (same thread, offer and
 *   termsVersion), or Shi has learned that the latest thread was rejected/withdrawn.
 * If the counterparty is to move, no checkpoint is raised. `eligibleProposals` must contain only proposals that
 * would commit in the batch's dry run (withheld or invalid proposals never suppress the checkpoint).
 */
export function exhaustionCheckpoint(
  state: WorldState,
  config: CoreConfig,
  eligibleProposals: ReadonlyArray<{ actor: ActorId; action: unknown }>,
  overSegmentAttempt: boolean,
): ExhaustionCheckpoint | null {
  const pair = ASSISTANCE_PAIR;
  const shi = config.factions[BESIEGED_FACTION].principal;
  const thread = negotiatingThread(state, pair);
  if (overSegmentAttempt) {
    return { pair, reason: 'over_segment_attempt', offerId: thread?.liveOfferId ?? null, commitmentId: thread?.id ?? null };
  }
  const n = state.negotiation[pair];
  if (!n.deadlockPending) return null;
  if (commitmentsOfPair(state, pair).some((t) => t.status === 'confirmed')) return null;
  if (thread) {
    const live = own(state.offers, thread.liveOfferId);
    if (!live || live.status !== 'delivered' || live.to !== shi) return null;
    if (!hasReceiptEvidence(state, shi, live.id, live.termsVersion)) return null;
    const confirming = eligibleProposals.some((p) => p.actor === shi && isConfirmOf(p.action, live));
    return confirming ? null : { pair, reason: 'live_offer_awaits', offerId: live.id, commitmentId: thread.id };
  }
  const latest = latestThread(state, pair);
  if (!latest || (latest.status !== 'rejected' && latest.status !== 'withdrawn')) return null;
  const belief = believedThreadStatus(state, shi, latest.id);
  if (belief !== 'rejected' && belief !== 'withdrawn') return null;
  return { pair, reason: 'closure_learned', offerId: latest.liveOfferId, commitmentId: latest.id };
}

/** Deadlock pause options: at the global cap no new segment can open (only urge_accept if an offer awaits Shi, urge_stop, ask). */
export function deadlockOptions(state: WorldState, config: CoreConfig, pair: PairId): DecisionOption[] {
  if (state.negotiation[pair].offersTotal < config.params.pair_offer_cap) return [...FEASIBLE_OPTIONS.negotiation_deadlock];
  const shi = config.factions[BESIEGED_FACTION].principal;
  const thread = negotiatingThread(state, pair);
  const live = thread ? own(state.offers, thread.liveOfferId) : undefined;
  const awaitsShi = live !== undefined && live.status === 'delivered' && live.to === shi;
  return awaitsShi ? ['urge_accept', 'urge_stop', 'ask'] : ['urge_stop', 'ask'];
}

const DOCUMENT_ACTIONS = new Set(['revise_document', 'approve_document', 'set_dispatch_timing', 'dispatch_document']);
const OFFER_ACTIONS = new Set(['propose_terms', 'respond_to_offer', 'confirm_commitment', 'withdraw_offer']);

/** Whether the paused proposals involve a document (⇒ `amend`) or an offer (⇒ `counter_draft`). */
export function involvementOf(actions: readonly unknown[]): { document: boolean; offer: boolean } {
  let document = false;
  let offer = false;
  for (const action of actions) {
    if (typeof action !== 'object' || action === null) continue;
    const a = action as { type?: unknown; args?: { target?: { kind?: unknown } } };
    const type = typeof a.type === 'string' ? a.type : '';
    if (DOCUMENT_ACTIONS.has(type) || (type === 'suggest_revision' && a.args?.target?.kind === 'document')) document = true;
    if (OFFER_ACTIONS.has(type) || (type === 'suggest_revision' && a.args?.target?.kind === 'offer')) offer = true;
  }
  return { document, offer };
}

/**
 * The concrete options of a pause (§7): category table, `amend`/`counter_draft` by involvement for semantic and
 * prompt pauses, and the global-cap restriction for deadlock pauses.
 */
export function optionsForPause(
  state: WorldState,
  config: CoreConfig,
  category: PauseCategory,
  pair: PairId | null,
  actions: readonly unknown[],
): DecisionOption[] {
  if (category === 'negotiation_deadlock') return deadlockOptions(state, config, pair ?? ASSISTANCE_PAIR);
  if (isSemanticOrPrompt(category)) return feasibleOptions(category, involvementOf(actions));
  return [...FEASIBLE_OPTIONS[category]];
}

/** Deadlock decisions that qualify for a segment reset (§4.1). */
export const QUALIFYING_DEADLOCK_OPTIONS: readonly DecisionOption[] = ['adjust_goal', 'urge_accept', 'urge_stop'];
