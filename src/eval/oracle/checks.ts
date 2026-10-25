/**
 * Action validity for the oracle (PLAN §4 table, §5 H01–H04, H07–H09, H11–H13), evaluated on the state just
 * before the action. Unlike the harness validator it reports EVERY violated rule, not the first. H05/H06/H10/H14
 * depend on control history and are checked in oracle.ts; the detectors use exactly this function as the §13.1
 * eligibility test (which excludes H05, H06, H10 and H14 by construction).
 */
import type { ActorId, CharId, CoreConfig, Document, Offer, PairId, PauseCategory, TermSet, WorldState } from '../../core/types.js';
import { parseOracleAction, type OAction, type OSystemAction } from './actions.js';
import {
  aliveIn,
  available,
  believedStatus,
  canAccess,
  consentNeeds,
  docPair,
  expandTerms,
  factionOf,
  hasReceipt,
  isChar,
  knowsAbout,
  knowsClause,
  limitViolations,
  openThread,
  pairOf,
  playerSide,
  poolClaimThreads,
  principalOf,
  senderOf,
  shiOf,
  termProblems,
  threadsOf,
  together,
  HEDONG_KHITAN,
} from './world.js';

export type OracleRule = `H${string}` | `G${string}`;

export interface Violation {
  rule: OracleRule;
  detail: string;
  code?: string;
}

/** Independent negotiation-segment bookkeeping of one pair (PLAN §4.1, H13). */
export interface SegmentState {
  segment: number;
  roundsInSegment: number;
  offersTotal: number;
  /** The next offer is the opening offer of a segment (the pair's first, or the first after a qualifying reset). */
  openingNext: boolean;
}

export const EMPTY_SEGMENT: SegmentState = { segment: 0, roundsInSegment: 0, offersTotal: 0, openingNext: true };

export interface CheckContext {
  config: CoreConfig;
  /** Segment bookkeeping at this state (from the oracle ledger); defaults to empty. */
  segments?: (pair: PairId) => SegmentState;
}

export const PLAYER_NEVER: ReadonlySet<string> = new Set([
  'approve_document',
  'propose_terms',
  'respond_to_offer',
  'confirm_commitment',
  'withdraw_offer',
  'allocate_resources',
  'abandon_request',
]);

export const SEGMENT_EXHAUSTED = 'segment_exhausted';

function v(rule: OracleRule, detail: string, code?: string): Violation {
  return code ? { rule, detail, code } : { rule, detail };
}

function segmentCheck(ctx: CheckContext, pair: PairId): Violation | null {
  const s = ctx.segments?.(pair) ?? EMPTY_SEGMENT;
  const p = ctx.config.params;
  if (s.offersTotal >= p.pair_offer_cap) return v('H13', `${pair} has ${s.offersTotal} offers (cap ${p.pair_offer_cap})`, 'global_cap');
  if (!s.openingNext && s.roundsInSegment >= p.segment_round_cap) {
    return v('H13', `segment ${s.segment} of ${pair} used its ${p.segment_round_cap} rounds`, SEGMENT_EXHAUSTED);
  }
  return null;
}

function consentFeasible(s: WorldState, terms: TermSet, pair: PairId, faction: ReturnType<typeof factionOf>, exclude: string | null): Violation[] {
  if (!faction) return [];
  const out: Violation[] = [];
  const needs = consentNeeds(terms, pair, faction);
  for (const [r, amount] of needs.resources) {
    const have = available(s, faction, r);
    if (have < amount) out.push(v('H07', `${faction} needs ${amount} ${r}, has ${have} available`));
  }
  for (const pool of needs.pools) {
    const others = poolClaimThreads(s, pool, exclude);
    if (others.length > 0) out.push(v('H07', `pool ${pool} already claimed by ${others.join(', ')}`));
  }
  return out;
}

function clauseKnowledge(s: WorldState, c: CoreConfig, actor: ActorId, ids: readonly string[]): Violation[] {
  return ids.filter((id) => !knowsClause(s, c, actor, id)).map((id) => v('H08', `${actor} references unknown secret clause ${id}`));
}

function documentAccess(s: WorldState, actor: ActorId, docId: string): Document | Violation {
  const doc = s.documents[docId];
  if (!doc) return v('H04', `no document ${docId}`);
  if (!canAccess(s, actor, doc)) return v('H08', `${actor} cannot access ${docId}`);
  return doc;
}

function isViolation(x: unknown): x is Violation {
  return typeof x === 'object' && x !== null && 'rule' in x && 'detail' in x;
}

/** Answer preconditions shared by respond/confirm (receipt, liveness, delivery). */
function answerable(s: WorldState, actor: ActorId, offer: Offer): Violation[] {
  const out: Violation[] = [];
  if (!knowsAbout(s, actor, offer.id)) out.push(v('H08', `${actor} has not received ${offer.id}`));
  else if (!hasReceipt(s, actor, offer.id, offer.termsVersion)) out.push(v('H08', `${actor} holds no receipt of ${offer.id} v${offer.termsVersion}`));
  if (offer.status === 'accepted' || offer.status === 'countered' || offer.status === 'rejected') out.push(v('H12', `${offer.id} already answered (${offer.status})`));
  else if (offer.status === 'withdrawn') out.push(v('H04', `${offer.id} was withdrawn`));
  else {
    const t = s.commitments[offer.commitmentId];
    if (!t || t.status !== 'negotiating' || t.liveOfferId !== offer.id) out.push(v('H04', `${offer.id} is not the live offer of an open thread`));
    if (offer.status !== 'delivered') out.push(v('H08', `${offer.id} not delivered`));
  }
  return out;
}

function checkSystem(s: WorldState, actor: ActorId, a: OSystemAction): Violation[] {
  const out: Violation[] = [];
  if (actor !== 'system') out.push(v('H02', `${a.type} is a system outcome`));
  if (s.terminal) out.push(v('H03', `world terminal (${s.terminal.kind})`));
  if (a.type === 'mutiny_outbreak' && s.flags.mutinyOccurred) out.push(v('H04', 'a mutiny already occurred'));
  return out;
}

function checkWorldAction(s: WorldState, ctx: CheckContext, actor: ActorId, a: OAction): Violation[] {
  const c = ctx.config;
  const out: Violation[] = [];
  const push = (x: Violation | null | undefined) => {
    if (x) out.push(x);
  };
  if (actor === 'system') return [v('H02', 'the system performs no character action')];
  if (s.terminal) out.push(v('H03', `world terminal (${s.terminal.kind})`));
  if (!aliveIn(s, actor)) out.push(v('H03', `${actor} is ${isChar(actor) ? s.characters[actor].status : 'absent'}`));
  if (actor === 'player') {
    if (PLAYER_NEVER.has(a.type)) out.push(v('H02', `the player never performs ${a.type}`));
    else if (!c.player.permissions.includes(a.type)) out.push(v('H02', `the player may not ${a.type}`));
  } else if (!c.characters[actor]?.permissions.includes(a.type)) {
    out.push(v('H02', `${actor} lacks permission ${a.type}`));
  }
  const faction = factionOf(s, c, actor);
  switch (a.type) {
    case 'wait':
      break;
    case 'speak':
      for (const l of a.args.to) {
        if (l !== actor && (!aliveIn(s, l) || !together(s, actor, l))) out.push(v('H08', `${l} is not present to hear ${actor}`));
      }
      break;
    case 'send_letter':
      if (a.args.to === actor) out.push(v('H01', 'letter to self'));
      else if (together(s, actor, a.args.to)) out.push(v('H08', `${a.args.to} is present (speak instead)`));
      break;
    case 'revise_document': {
      const doc = documentAccess(s, actor, a.args.docId);
      if (isViolation(doc)) {
        out.push(doc);
        break;
      }
      if (doc.status === 'sent' || doc.status === 'withdrawn') out.push(v('H11', `${doc.id} is ${doc.status} and immutable`));
      if (a.args.baseDocVersion !== doc.version) out.push(v('H04', `stale document version v${a.args.baseDocVersion} (current v${doc.version})`));
      out.push(...clauseKnowledge(s, c, actor, a.args.terms.secret_clauses));
      const pair = docPair(s, c, doc);
      if (!pair) out.push(v('H01', `${doc.id} has no principal pair`));
      else {
        const hidden = doc.terms.secret_clauses.filter((cl) => !knowsClause(s, c, actor, cl.id));
        out.push(...termProblems(expandTerms(a.args.terms, c, hidden), pair, c).map((p) => v('H01', p)));
      }
      break;
    }
    case 'suggest_revision': {
      const t = a.args.target;
      if (!t.id.startsWith(t.kind === 'document' ? 'doc:' : 'offer:')) out.push(v('H01', `target ${t.id} is not a ${t.kind}`));
      else if (t.kind === 'document') {
        const d = documentAccess(s, actor, t.id);
        if (isViolation(d)) out.push(d);
      } else if (!s.offers[t.id]) out.push(v('H04', `no offer ${t.id}`));
      else if (!knowsAbout(s, actor, t.id)) out.push(v('H08', `${actor} does not know ${t.id}`));
      for (const key of ['annual_silk', 'immediate_silk', 'aid_cavalry', 'aid_arrival_days'] as const) {
        const n = a.args.terms[key];
        const e = c.catalog.terms[key];
        if (n === null || !e) continue;
        if ((e.min !== null && n < e.min) || (e.max !== null && n > e.max)) out.push(v('H01', `suggested ${key} out of range`));
      }
      out.push(...clauseKnowledge(s, c, actor, a.args.terms.secret_clauses ?? []));
      break;
    }
    case 'approve_document': {
      const doc = documentAccess(s, actor, a.args.docId);
      if (isViolation(doc)) {
        out.push(doc);
        break;
      }
      if (actor !== senderOf(s, c, doc)) out.push(v('H02', `only ${senderOf(s, c, doc)} may approve ${doc.id}`));
      if (doc.status === 'sent' || doc.status === 'withdrawn') out.push(v('H11', `${doc.id} is ${doc.status}`));
      else {
        if (a.args.docVersion !== doc.version) out.push(v('H04', `approving v${a.args.docVersion}, current v${doc.version}`));
        if (doc.status !== 'draft') out.push(v('H04', `${doc.id} already ${doc.status}`));
      }
      break;
    }
    case 'set_dispatch_timing': {
      const doc = documentAccess(s, actor, a.args.docId);
      if (isViolation(doc)) {
        out.push(doc);
        break;
      }
      if (doc.status === 'sent' || doc.status === 'withdrawn') out.push(v('H11', `${doc.id} is ${doc.status}`));
      if (a.args.mode === 'delay') {
        const r = a.args.rounds;
        if (r === null || r < c.params.delay_rounds_min || r > c.params.delay_rounds_max) out.push(v('H01', 'delay rounds out of range'));
      }
      break;
    }
    case 'dispatch_document': {
      const doc = documentAccess(s, actor, a.args.docId);
      if (isViolation(doc)) {
        out.push(doc);
        break;
      }
      const sender = senderOf(s, c, doc);
      if (doc.status === 'sent') out.push(v('H12', `${doc.id} already dispatched`));
      else if (doc.status === 'withdrawn') out.push(v('H11', `${doc.id} withdrawn`));
      else {
        if (a.args.docVersion !== doc.version) out.push(v('H04', `dispatching v${a.args.docVersion}, current v${doc.version}`));
        if (doc.status !== 'approved' || !doc.approval || doc.approval.version !== doc.version) out.push(v('H11', `${doc.id} v${doc.version} not approved`));
        else if (doc.approval.by !== sender) out.push(v('H09', `approval (consent) by ${doc.approval.by}, not by the sender ${sender}`));
        if (doc.timing.mode === 'hold') out.push(v('H11', `${doc.id} on hold`));
        if (doc.timing.mode === 'delay' && doc.timing.notBeforeRound !== null && s.round < doc.timing.notBeforeRound) {
          out.push(v('H11', `${doc.id} delayed until round ${doc.timing.notBeforeRound}`));
        }
      }
      const pair = docPair(s, c, doc);
      if (!pair) {
        out.push(v('H01', `${doc.id} has no pair`));
        break;
      }
      if (doc.status !== 'sent') {
        if (openThread(s, pair)) out.push(v('H04', `${pair} already has a negotiating thread`));
        push(segmentCheck(ctx, pair));
      }
      out.push(...termProblems(doc.terms, pair, c).map((p) => v('H01', p)));
      out.push(...consentFeasible(s, doc.terms, pair, s.characters[sender].faction, null));
      break;
    }
    case 'propose_terms': {
      if (!isChar(actor) || principalOf(c, s.characters[actor].faction) !== actor) {
        out.push(v('H02', `${actor} is not a principal`));
        break;
      }
      const to = s.characters[a.args.to];
      if (!to || principalOf(c, to.faction) !== a.args.to) out.push(v('H01', `${a.args.to} is not a principal`));
      const pair = to ? pairOf(s.characters[actor].faction, to.faction) : null;
      if (!pair) {
        out.push(v('H01', 'not a principal pair'));
        break;
      }
      if (openThread(s, pair)) out.push(v('H04', `${pair} already has a negotiating thread`));
      push(segmentCheck(ctx, pair));
      out.push(...clauseKnowledge(s, c, actor, a.args.terms.secret_clauses));
      const terms = expandTerms(a.args.terms, c);
      out.push(...termProblems(terms, pair, c).map((p) => v('H01', p)));
      out.push(...consentFeasible(s, terms, pair, faction, null));
      break;
    }
    case 'respond_to_offer': {
      const offer = s.offers[a.args.offerId];
      if (!offer) {
        out.push(v('H04', `no offer ${a.args.offerId}`));
        break;
      }
      if (actor !== offer.to) out.push(v('H02', `only ${offer.to} may answer ${offer.id}`));
      out.push(...answerable(s, actor, offer));
      if (a.args.response === 'counter') {
        const thread = s.commitments[offer.commitmentId];
        if (a.args.counterTerms === null) out.push(v('H01', 'counter without counterTerms'));
        else if (thread) {
          out.push(...clauseKnowledge(s, c, actor, a.args.counterTerms.secret_clauses));
          const terms = expandTerms(a.args.counterTerms, c);
          out.push(...termProblems(terms, thread.pair, c).map((p) => v('H01', p)));
          push(segmentCheck(ctx, thread.pair));
          out.push(...consentFeasible(s, terms, thread.pair, s.characters[offer.to].faction, thread.id));
        }
      }
      break;
    }
    case 'withdraw_offer': {
      const offer = s.offers[a.args.offerId];
      if (!offer) {
        out.push(v('H04', `no offer ${a.args.offerId}`));
        break;
      }
      if (actor !== offer.from) {
        out.push(knowsAbout(s, actor, offer.id) ? v('H02', `only ${offer.from} may withdraw ${offer.id}`) : v('H08', `${actor} does not know ${offer.id}`));
        break;
      }
      if (offer.withdrawal !== null || believedStatus(s, actor, `${offer.id}/withdrawal`) !== null) out.push(v('H12', `withdrawal of ${offer.id} already sent`));
      const belief = believedStatus(s, actor, offer.id);
      if (belief !== 'sent' && belief !== 'delivered') out.push(v('H04', `per ${actor} ${offer.id} is not open (${belief ?? 'unknown'})`));
      break;
    }
    case 'confirm_commitment': {
      const thread = s.commitments[a.args.commitmentId];
      const offer = s.offers[a.args.offerId];
      if (!thread) out.push(v('H04', `no commitment ${a.args.commitmentId}`));
      if (!offer) out.push(v('H04', `no offer ${a.args.offerId}`));
      if (!thread || !offer) break;
      if (!knowsAbout(s, actor, thread.id)) out.push(v('H08', `${actor} has no evidence of ${thread.id}`));
      if (offer.commitmentId !== thread.id) out.push(v('H04', `${offer.id} is not in ${thread.id}`));
      if (!isChar(actor) || !thread.parties.includes(actor)) out.push(v('H09', `${actor} is not a party of ${thread.id}`));
      else if (actor === offer.from) out.push(v('H09', `${actor} sent ${offer.id}; only its recipient can confirm`));
      else if (actor !== offer.to) out.push(v('H09', `${actor} is not the recipient of ${offer.id}`));
      out.push(...answerable(s, actor, offer));
      if (a.args.termsVersion !== offer.termsVersion) out.push(v('H04', `termsVersion ${a.args.termsVersion} ≠ live v${offer.termsVersion}`));
      const senderConsent = thread.consents[offer.from];
      if (!senderConsent || senderConsent.termsVersion !== offer.termsVersion) out.push(v('H09', `${offer.from} has not consented to v${offer.termsVersion}`));
      out.push(...consentFeasible(s, offer.terms, thread.pair, s.characters[offer.to]?.faction ?? null, thread.id));
      break;
    }
    case 'allocate_resources': {
      const { faction: f, resource, amount, purpose } = a.args;
      if (amount <= 0) out.push(v('H01', 'amount must be positive'));
      const target = purpose === 'intensify_siege' ? { f: 'tang', r: 'reserve_troops' } : { f: 'hedong', r: 'silk' };
      if (target.f !== f || target.r !== resource) out.push(v('H01', `${purpose} allocates ${target.f} ${target.r}`));
      if (!isChar(actor) || s.characters[actor].faction !== f || principalOf(c, f) !== actor) out.push(v('H02', `only the principal of ${f} allocates its resources`));
      if (available(s, f, resource) < amount) out.push(v('H07', `${f} has ${available(s, f, resource)} ${resource} available, ${amount} requested`));
      break;
    }
    case 'abandon_request': {
      if (actor !== shiOf(c)) out.push(v('H02', `only ${shiOf(c)} may abandon the request`));
      if (s.flags.assistanceAbandoned) out.push(v('H04', 'already abandoned'));
      if (threadsOf(s, HEDONG_KHITAN).some((t) => t.status === 'confirmed')) out.push(v('H04', 'the pact is already confirmed'));
      break;
    }
    case 'revoke_authorization': {
      const auth = s.player.authorizations[a.args.authId];
      if (!auth) out.push(v('H04', `no authorization ${a.args.authId}`));
      else if (auth.revoked) out.push(v('H04', `${a.args.authId} already revoked`));
      break;
    }
  }
  return out;
}

export interface ValidityResult {
  parsed: { system: boolean; action: OAction | OSystemAction } | null;
  violations: Violation[];
}

/** All H01–H04, H07–H09, H11–H13 violations of `raw` by `actor` on state `s` (empty = valid). */
export function checkValidity(s: WorldState, ctx: CheckContext, actor: ActorId, raw: unknown): ValidityResult {
  const parsed = parseOracleAction(actor, raw);
  if (!parsed.ok) return { parsed: null, violations: [v('H01', `not a closed-set action: ${parsed.error}`)] };
  const violations = parsed.system ? checkSystem(s, actor, parsed.action) : checkWorldAction(s, ctx, actor, parsed.action);
  // Deduplicate identical findings.
  const seen = new Set<string>();
  const unique = violations.filter((x) => {
    const k = `${x.rule}|${x.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { parsed: { system: parsed.system, action: parsed.action }, violations: unique };
}

// ---------------------------------------------------------------------------------------------------------------
// Criticality (§4 P column) and authorizations (H10)
// ---------------------------------------------------------------------------------------------------------------

/** Mandatory pause category of an action (critical only when the actor is player-side; system outcomes always). */
export function criticalCategory(s: WorldState, c: CoreConfig, actor: ActorId, action: OAction | OSystemAction): PauseCategory | null {
  switch (action.type) {
    case 'mutiny_outbreak':
      return 'mutiny';
    case 'character_death':
      return 'death';
    case 'allegiance_change':
      return 'allegiance';
    default:
      break;
  }
  if (!playerSide(s, c, actor)) return null;
  switch (action.type) {
    case 'dispatch_document':
      return 'dispatch_request';
    case 'propose_terms':
    case 'confirm_commitment':
      return 'major_commitment';
    case 'respond_to_offer':
      return action.args.response === 'counter' ? 'major_commitment' : 'strategic_turn';
    case 'abandon_request':
      return 'strategic_turn';
    default:
      return null;
  }
}

/** Terms a critical action would commit to, and their pair. */
export function committedTerms(s: WorldState, c: CoreConfig, actor: ActorId, action: OAction | OSystemAction): { pair: PairId; terms: TermSet } | null {
  switch (action.type) {
    case 'dispatch_document': {
      const doc = s.documents[action.args.docId];
      const pair = doc ? docPair(s, c, doc) : null;
      return doc && pair ? { pair, terms: doc.terms } : null;
    }
    case 'propose_terms': {
      if (!isChar(actor) || !s.characters[action.args.to]) return null;
      const pair = pairOf(s.characters[actor].faction, s.characters[action.args.to].faction);
      return pair ? { pair, terms: expandTerms(action.args.terms, c) } : null;
    }
    case 'respond_to_offer':
    case 'confirm_commitment': {
      const offer = s.offers[action.args.offerId];
      const thread = offer ? s.commitments[offer.commitmentId] : undefined;
      if (!offer || !thread) return null;
      if (action.type === 'respond_to_offer' && action.args.response === 'counter' && action.args.counterTerms) {
        return { pair: thread.pair, terms: expandTerms(action.args.counterTerms, c) };
      }
      return { pair: thread.pair, terms: offer.terms };
    }
    default:
      return null;
  }
}

/** Active authorization covering the action (grantee, category, round, terms within limits), if any. */
export function coveringAuthorization(s: WorldState, c: CoreConfig, actor: ActorId, category: PauseCategory, action: OAction | OSystemAction): string | null {
  if (!isChar(actor)) return null;
  const terms = committedTerms(s, c, actor, action);
  const ids = Object.keys(s.player.authorizations).sort();
  for (const id of ids) {
    const auth = s.player.authorizations[id];
    if (!auth || auth.revoked || auth.grantee !== (actor as CharId) || !auth.categories.includes(category)) continue;
    if (auth.grantedRound > s.round || (auth.expiresRound !== null && s.round > auth.expiresRound)) continue;
    if (terms && limitViolations(terms.terms, auth.limits, c, terms.pair).length > 0) continue;
    return id;
  }
  return null;
}
