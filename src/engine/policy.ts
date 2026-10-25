/**
 * Scripted-user decision policy (PLAN §12.4; content/README.md §6) and the decision-source interface.
 * - First match wins: the first rule whose `match` keys all hold (omitted = any) decides.
 * - `within_limits` compares the paused proposal's terms AS THE PLAYER CAN KNOW THEM (`playerVisibleTerms`: an
 *   accessible or last-observed document version, terms written in the proposal restricted to known clauses, or
 *   an offer as the player's own assertions describe it — never live hidden world objects), on the state just
 *   before it would commit in its batch, with the player's CURRENT goal limits. Terms the player cannot see are
 *   unknown, which counts as NOT within (conservative; logged). A rule with `within_limits` never matches a pause
 *   whose proposals carry no terms.
 * - Only options feasible for the concrete pause (`pause.options`, computed by core `optionsForPause`) are chosen;
 *   a matching rule whose option is infeasible, or whose payload is unusable, is skipped (logged) and the next
 *   matching rule is tried. `amend` payloads may use `"$current"`, resolved (core `resolvePlaceholders`) to the
 *   document version the player sees at decision time.
 * - Scripted policies never choose `ask` (PLAN §7: it exists for interactive play); such a rule is skipped.
 * - No usable rule ⇒ a conservative, logged fallback (endorse / let_it_happen / urge_stop / resume / retry).
 */
import type { PolicyRuleSchema } from '../content/schema.js';
import type { z } from 'zod';
import { asTermSet } from '../agents/util.js';
import { isSystemActionType, type Action, type TermSetArgs } from '../core/actions.js';
import { executeBatch, orderProposals, type BatchDecision, type BatchProposal } from '../core/execute.js';
import { own } from '../core/ids.js';
import { canAccessDocument, clauseLookupFor, filterTermsFor, isCharId, knowsClause, latestBelief } from '../core/knowledge.js';
import { documentPair } from '../core/negotiation.js';
import { parseProposalAction } from '../core/rules.js';
import { resolvePlaceholders } from '../core/script.js';
import { expandTermArgs, pairOf, withinLimits } from '../core/terms.js';
import type { ActorId, CoreConfig, DecisionOption, Mode, PairId, PauseCategory, TermSet, WorldState } from '../core/types.js';
import type { DecisionChoice, DecisionContext, DecisionSource } from './types.js';

export type PolicyRule = z.output<typeof PolicyRuleSchema>;

export interface PolicyFacts {
  category: PauseCategory;
  actor?: ActorId | undefined;
  actionType?: string | undefined;
  within?: boolean | undefined;
}

export function ruleMatches(rule: PolicyRule, facts: PolicyFacts): boolean {
  const m = rule.match;
  return (
    m.category === facts.category &&
    (m.actor === undefined || m.actor === facts.actor) &&
    (m.action_type === undefined || m.action_type === facts.actionType) &&
    (m.within_limits === undefined || (facts.within !== undefined && m.within_limits === facts.within))
  );
}

function actionType(action: unknown): string | undefined {
  if (typeof action !== 'object' || action === null) return undefined;
  const t = (action as { type?: unknown }).type;
  return typeof t === 'string' ? t : undefined;
}

export type VisibleTerms =
  | { kind: 'none' }
  | { kind: 'unknown'; reason: string }
  | { kind: 'known'; pair: PairId; terms: TermSet };

function record(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Proposed term args as the player can read them: clause ids the player does not know are not visible. */
function visibleArgs(state: WorldState, config: CoreConfig, args: TermSetArgs, pair: PairId | null): VisibleTerms {
  if (!pair) return { kind: 'unknown', reason: 'the pair of the proposed terms is not known' };
  const known = args.secret_clauses.filter((id) => knowsClause(state, config, 'player', id));
  const expanded = expandTermArgs({ ...args, secret_clauses: known }, clauseLookupFor(state, config, 'player'));
  return expanded.ok ? { kind: 'known', pair, terms: expanded.terms } : { kind: 'unknown', reason: 'unreadable proposed terms' };
}

/** An offer's terms as the player's own assertions describe them (optionally a specific terms version). */
function believedOffer(state: WorldState, offerId: string, termsVersion: number | null): VisibleTerms {
  const belief = latestBelief(state, 'player', offerId, 'terms');
  const value = record(belief?.value);
  const terms = value ? asTermSet(value.terms) : null;
  if (!value || !terms) return { kind: 'unknown', reason: `the player holds no terms of ${offerId}` };
  if (termsVersion !== null && value.termsVersion !== termsVersion) {
    return { kind: 'unknown', reason: `the player knows ${offerId} v${String(value.termsVersion)}, not v${termsVersion}` };
  }
  const pair = typeof value.commitmentId === 'string' ? (own(state.commitments, value.commitmentId)?.pair ?? null) : null;
  return pair ? { kind: 'known', pair, terms } : { kind: 'unknown', reason: `the thread of ${offerId} is not known` };
}

/**
 * Terms of a critical proposal as the PLAYER can know them (never the live world object): a dispatched document
 * the player can access now (or its last observed version), terms written in the proposal itself (restricted to
 * clauses the player knows), or an offer as the player's own assertions describe it. `none` = the proposal carries
 * no terms; `unknown` = it does, but the player cannot see them.
 */
export function playerVisibleTerms(state: WorldState, config: CoreConfig, actor: ActorId, action: unknown): VisibleTerms {
  const parsed = parseProposalAction(actor, action);
  if (!parsed.ok || isSystemActionType(parsed.action.type)) return { kind: 'none' };
  const a = parsed.action as Action;
  switch (a.type) {
    case 'dispatch_document': {
      const doc = own(state.documents, a.args.docId);
      const pair = doc ? documentPair(state, config, doc) : null;
      if (!doc || !pair) return { kind: 'unknown', reason: `${a.args.docId} is not known to the player` };
      if (canAccessDocument(state, 'player', doc)) {
        if (doc.version !== a.args.docVersion) return { kind: 'unknown', reason: `the player sees v${doc.version}, not v${a.args.docVersion}` };
        return { kind: 'known', pair, terms: filterTermsFor(state, config, 'player', doc.terms) };
      }
      const value = record(latestBelief(state, 'player', doc.id, 'content')?.value);
      const terms = value ? asTermSet(value.terms) : null;
      if (!value || !terms || value.version !== a.args.docVersion) return { kind: 'unknown', reason: `the player has not seen ${doc.id} v${a.args.docVersion}` };
      return { kind: 'known', pair, terms };
    }
    case 'propose_terms': {
      if (!isCharId(actor)) return { kind: 'none' };
      return visibleArgs(state, config, a.args.terms, pairOf(state.characters[actor].faction, state.characters[a.args.to].faction));
    }
    case 'respond_to_offer': {
      if (a.args.response === 'counter' && a.args.counterTerms) {
        const offer = own(state.offers, a.args.offerId);
        return visibleArgs(state, config, a.args.counterTerms, offer ? (own(state.commitments, offer.commitmentId)?.pair ?? null) : null);
      }
      return believedOffer(state, a.args.offerId, null);
    }
    case 'confirm_commitment':
      return believedOffer(state, a.args.offerId, a.args.termsVersion);
    default:
      return { kind: 'none' };
  }
}

export interface WithinLimitsResult {
  /** undefined: no paused proposal carries terms; unknown terms count as NOT within (conservative). */
  within: boolean | undefined;
  /** Why terms were unavailable to the player (logged with the decision). */
  unknown: string[];
}

/**
 * Whether the paused proposals' player-visible terms are within the player's CURRENT goal limits, each evaluated
 * on the state just before it in commit order (dry run of the batch's earlier proposals). Terms the player cannot
 * see are unknown and map conservatively to `false`.
 */
export function pausedWithinLimits(
  state: WorldState,
  config: CoreConfig,
  mode: Mode,
  batchProposals: readonly BatchProposal[],
  decisions: readonly BatchDecision[],
  targetIds: readonly string[],
): WithinLimitsResult {
  const ordered = orderProposals(batchProposals, config);
  const results: boolean[] = [];
  const unknown: string[] = [];
  for (const id of targetIds) {
    const index = ordered.findIndex((p) => p.proposalId === id);
    const target = ordered[index];
    if (!target) continue;
    const before =
      index <= 0
        ? state
        : executeBatch(state, { kind: 'character', proposals: ordered.slice(0, index), decisions: [...decisions] }, { config, mode, dryRun: true }).state;
    const terms = playerVisibleTerms(before, config, target.actor, target.action);
    if (terms.kind === 'none') continue;
    if (terms.kind === 'unknown') {
      unknown.push(`${id}: ${terms.reason}`);
      results.push(false);
      continue;
    }
    results.push(withinLimits(terms.terms, before.player.goal.limits, config.catalog, terms.pair).ok);
  }
  return { within: results.length === 0 ? undefined : results.every(Boolean), unknown };
}

const FALLBACK: Partial<Record<PauseCategory, DecisionOption>> = {
  mutiny: 'let_it_happen',
  negotiation_deadlock: 'urge_stop',
  user_requested: 'resume',
  error_recovery: 'retry',
};

export function fallbackOption(category: PauseCategory, options: readonly DecisionOption[]): DecisionOption {
  const preferred = FALLBACK[category] ?? 'endorse';
  if (options.includes(preferred)) return preferred;
  const usable = options.filter((o) => o !== 'ask' && o !== 'amend' && o !== 'adjust_goal');
  return usable[0] ?? options[0] ?? 'endorse';
}

export interface PolicyChoice extends DecisionChoice {
  ruleIndex: number | null;
  skippedRules: string[];
}

/** First-match policy decision for a concrete pause (pure). */
export function choosePolicy(rules: readonly PolicyRule[], ctx: DecisionContext): PolicyChoice {
  const first = ctx.proposals[0];
  const facts: PolicyFacts = {
    category: ctx.pause.category,
    actor: first?.actor,
    actionType: first ? actionType(first.action) : undefined,
    within: ctx.withinLimits,
  };
  const pausedActors = new Set(ctx.proposals.map((p) => p.actor));
  const skipped: string[] = [];
  for (const [index, rule] of rules.entries()) {
    if (!ruleMatches(rule, facts)) continue;
    const option = rule.choose;
    const tag = `rule #${index} (${option})`;
    if (!ctx.pause.options.includes(option)) {
      skipped.push(`${tag}: not an option of this pause (${ctx.pause.options.join(', ')})`);
      continue;
    }
    const base = { by: 'policy' as const, advice: rule.advice ?? null, ruleIndex: index, skippedRules: skipped, note: `policy ${tag}` };
    switch (option) {
      case 'ask':
        // Scripted decision policies never ask (PLAN §7): `ask` is for interactive play only.
        skipped.push(`${tag}: scripted policies never choose ask`);
        continue;
      case 'amend': {
        if (!rule.amend) {
          skipped.push(`${tag}: no amend payload`);
          continue;
        }
        const resolved = resolvePlaceholders(ctx.state, { type: 'revise_document', args: rule.amend });
        if (!resolved.ok) {
          skipped.push(`${tag}: ${resolved.reason}`);
          continue;
        }
        const args = (resolved.action as { args: { docId: string; baseDocVersion: number; terms: unknown; note: string } }).args;
        return { ...base, option, amend: { docId: args.docId, baseDocVersion: args.baseDocVersion, terms: args.terms, note: args.note } };
      }
      case 'adjust_goal':
        if (!rule.goal_limits) {
          skipped.push(`${tag}: no goal_limits`);
          continue;
        }
        return { ...base, option, goalLimits: rule.goal_limits };
      case 'delegate':
        if (rule.authorization && !pausedActors.has(rule.authorization.grantee)) {
          skipped.push(`${tag}: grantee ${rule.authorization.grantee} is not the paused actor`);
          continue;
        }
        return { ...base, option, authorization: rule.authorization ?? null };
      case 'counter_draft':
        return { ...base, option, counterTerms: rule.counter_terms ?? null };
      default:
        return { ...base, option };
    }
  }
  const option = fallbackOption(ctx.pause.category, ctx.pause.options);
  return { option, by: 'policy', advice: null, ruleIndex: null, skippedRules: skipped, note: `policy fallback (${option}): no usable rule` };
}

/** The case's scripted user (formal runs). */
export class PolicyDecisionSource implements DecisionSource {
  readonly rules: readonly PolicyRule[];

  constructor(rules: readonly PolicyRule[]) {
    this.rules = rules;
  }

  decide(ctx: DecisionContext): PolicyChoice {
    return choosePolicy(this.rules, ctx);
  }
}

/** A decision source backed by a callback (UI adapters: CLI prompt, server request queue). */
export class CallbackDecisionSource implements DecisionSource {
  private readonly fn: (ctx: DecisionContext) => Promise<DecisionChoice> | DecisionChoice;

  constructor(fn: (ctx: DecisionContext) => Promise<DecisionChoice> | DecisionChoice) {
    this.fn = fn;
  }

  decide(ctx: DecisionContext): Promise<DecisionChoice> | DecisionChoice {
    return this.fn(ctx);
  }
}
