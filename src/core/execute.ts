/**
 * Pure batch execution (the body of `commitBatch`, PLAN §8.2, after the H05 entry check which the harness does):
 * 1. decision world-effects (delegate ⇒ Authorization; deadlock options ⇒ goal change and/or new segment),
 * 2. proposals in commit order (commitPriority of the actor, then seq): withheld per decisions; otherwise
 *    validated against the evolving state (Harness modes) or applied permissively (baseline), resolved and
 *    committed as one event each, with the G12 terminal check after every committed event.
 * The same function run with `dryRun: true` ignores H10 and reports which proposals would need a decision.
 */
import { isCharId } from './knowledge.js';
import { applyPermissive } from './permissive.js';
import { PROCEED_OPTIONS, QUALIFYING_DEADLOCK_OPTIONS, WITHHOLD_OPTIONS, mandatoryCategory } from './pauses.js';
import { authorizationEffect, goalEffect, openNewSegmentEffect, resolveAction, type DialogueDraft } from './resolve.js';
import { validate } from './rules.js';
import { commitWithTerminal, mutinyAvertedEffect } from './system.js';
import type {
  ActorId,
  AuthorizationGrant,
  BatchKind,
  CoreConfig,
  DecisionOption,
  GateKind,
  Mode,
  PairId,
  PauseCategory,
  ProposalSource,
  RuleId,
  TermLimits,
  WorldEvent,
  WorldState,
} from './types.js';

export interface BatchProposal {
  proposalId: string;
  actor: ActorId;
  seq: number;
  action: unknown;
  askPlayer: { question: string } | null;
  source?: ProposalSource;
}

export interface BatchDecision {
  decisionId: string;
  category: PauseCategory;
  option: DecisionOption;
  proposalIds: string[];
  /** Pair of a negotiation_deadlock decision. */
  pair?: PairId | null;
  authorization?: AuthorizationGrant | null;
  goalLimits?: TermLimits | null;
}

export interface ExecuteInput {
  kind: BatchKind;
  proposals: BatchProposal[];
  decisions: BatchDecision[];
}

export interface ExecuteOptions {
  config: CoreConfig;
  mode: Mode;
  /** Simulation for the pause plan: H10 is not enforced; `requiresDecision` is reported instead. */
  dryRun?: boolean;
}

export type OutcomeStatus = 'committed' | 'rejected' | 'withheld' | 'unapplied';

export interface ProposalOutcome {
  proposalId: string;
  actor: ActorId;
  status: OutcomeStatus;
  rule: RuleId | null;
  reason: string | null;
  feedback: string | null;
  code: string | null;
  category: PauseCategory | null;
  gate: GateKind | null;
  authorizationId: string | null;
  requiresDecision: PauseCategory | null;
  /** Decision that gated or withheld the proposal. */
  decisionId: string | null;
  /** World versions of the events this proposal produced (action event, then terminal if any). */
  eventVersions: number[];
  dialogue: DialogueDraft | null;
}

export interface DecisionEffectRecord {
  decisionId: string;
  eventVersions: number[];
  authorizationId: string | null;
}

export interface ExecuteResult {
  state: WorldState;
  events: WorldEvent[];
  outcomes: ProposalOutcome[];
  decisionEffects: DecisionEffectRecord[];
}

export class ExecutionInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionInvariantError';
  }
}

function priority(config: CoreConfig, actor: ActorId): number {
  if (actor === 'system') return -2;
  if (actor === 'player') return -1;
  return config.characters[actor].commitPriority;
}

/** Commit order: commitPriority of the actor (principals first), then actor id, then seq, then proposal id. */
export function orderProposals<T extends { actor: ActorId; seq: number; proposalId: string }>(
  proposals: readonly T[],
  config: CoreConfig,
): T[] {
  return [...proposals].sort(
    (a, b) =>
      priority(config, a.actor) - priority(config, b.actor) ||
      (a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0) ||
      a.seq - b.seq ||
      (a.proposalId < b.proposalId ? -1 : a.proposalId > b.proposalId ? 1 : 0),
  );
}

function decisionsFor(decisions: readonly BatchDecision[], proposalId: string): BatchDecision[] {
  return decisions.filter((d) => d.proposalIds.includes(proposalId) && d.option !== 'ask');
}

function baseOutcome(p: BatchProposal): ProposalOutcome {
  return {
    proposalId: p.proposalId,
    actor: p.actor,
    status: 'committed',
    rule: null,
    reason: null,
    feedback: null,
    code: null,
    category: null,
    gate: null,
    authorizationId: null,
    requiresDecision: null,
    decisionId: null,
    eventVersions: [],
    dialogue: null,
  };
}

export function executeBatch(state0: WorldState, input: ExecuteInput, opts: ExecuteOptions): ExecuteResult {
  const { config, mode } = opts;
  let state = state0;
  const events: WorldEvent[] = [];
  const outcomes: ProposalOutcome[] = [];
  const decisionEffects: DecisionEffectRecord[] = [];

  const phase = input.kind === 'system_outcome' ? 'outcome' : 'action';
  const commit = (effect: Parameters<typeof commitWithTerminal>[2], meta: { proposalId?: string; decisionId?: string }): number[] => {
    const step = commitWithTerminal(state, config, effect, phase, meta);
    state = step.state;
    events.push(...step.events);
    return step.events.map((e) => e.version);
  };

  // 1. Decision world-effects.
  for (const decision of input.decisions) {
    const record: DecisionEffectRecord = { decisionId: decision.decisionId, eventVersions: [], authorizationId: null };
    if (decision.option === 'delegate') {
      const first = input.proposals.find((p) => decision.proposalIds.includes(p.proposalId));
      const grant: AuthorizationGrant | null =
        decision.authorization ??
        (first && isCharId(first.actor)
          ? { grantee: first.actor, categories: [decision.category], limits: state.player.goal.limits, expiresRound: null }
          : null);
      if (grant) {
        const { effect, authId } = authorizationEffect(state, config, grant);
        record.authorizationId = authId;
        record.eventVersions.push(...commit(effect, { decisionId: decision.decisionId }));
      }
    }
    if (decision.category === 'negotiation_deadlock' && QUALIFYING_DEADLOCK_OPTIONS.includes(decision.option)) {
      if (decision.option === 'adjust_goal' && decision.goalLimits) {
        record.eventVersions.push(...commit(goalEffect(state, config, decision.goalLimits), { decisionId: decision.decisionId }));
      }
      const pair = decision.pair ?? 'hedong-khitan';
      record.eventVersions.push(
        ...commit(openNewSegmentEffect(state, config, pair, decision.decisionId), { decisionId: decision.decisionId }),
      );
    }
    if (record.eventVersions.length > 0) decisionEffects.push(record);
  }

  // 2. Proposals in commit order.
  for (const p of orderProposals(input.proposals, config)) {
    const out = baseOutcome(p);
    outcomes.push(out);
    const decisions = decisionsFor(input.decisions, p.proposalId);
    const withholding = decisions.find((d) => WITHHOLD_OPTIONS.includes(d.option));
    if (withholding) {
      out.status = 'withheld';
      out.decisionId = withholding.decisionId;
      if (withholding.option === 'urge_payment' && !opts.dryRun) {
        out.eventVersions = commit(mutinyAvertedEffect(state, config), { proposalId: p.proposalId, decisionId: withholding.decisionId });
      }
      continue;
    }
    const proceeding = decisions.find((d) => PROCEED_OPTIONS.includes(d.option));

    if (mode === 'baseline') {
      const applied = applyPermissive(state, config, p.actor, p.action);
      if (applied.status === 'unapplied') {
        out.status = 'unapplied';
        out.reason = applied.reason;
        continue;
      }
      const category = mandatoryCategory(state, config, p.actor, applied.action);
      out.category = category;
      out.gate = category === null ? 'not_required' : p.actor === 'player' ? 'player_initiated' : proceeding ? 'decision' : 'ungated';
      out.decisionId = proceeding?.decisionId ?? null;
      out.dialogue = applied.dialogue;
      if (applied.effect) out.eventVersions = commit(applied.effect, { proposalId: p.proposalId });
      continue;
    }

    const v = validate(state, p, { config, mode, decided: proceeding !== undefined, checkGate: !opts.dryRun });
    if (!v.ok) {
      out.status = 'rejected';
      out.rule = v.rule;
      out.reason = v.reason;
      out.feedback = v.feedback;
      out.code = v.code;
      continue;
    }
    out.category = v.category;
    out.gate = v.gate;
    out.authorizationId = v.authorizationId;
    out.requiresDecision = v.requiresDecision;
    out.decisionId = v.gate === 'decision' ? (proceeding?.decisionId ?? null) : null;
    const resolved = resolveAction(state, p.actor, v.action, { config });
    if (!resolved.ok) {
      // A validated action must be applicable; anything else is an engine bug: the harness rolls back.
      throw new ExecutionInvariantError(`validated proposal ${p.proposalId} was inapplicable: ${resolved.reason}`);
    }
    out.dialogue = resolved.dialogue;
    if (resolved.effect) out.eventVersions = commit(resolved.effect, { proposalId: p.proposalId });
  }

  return { state, events, outcomes, decisionEffects };
}
