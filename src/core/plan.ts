/**
 * Pause plan (PLAN §7): a dry run of the batch computes which proposals would commit and which of those still
 * need a decision (mandatory categories in Harness modes; `askPlayer` prompt pauses in all modes), plus the
 * negotiation exhaustion control pause (Harness modes, character batches), which is exempt from the
 * "would commit" filter. The harness recomputes the plan after every resolved decision until it is stable.
 * Semantic pauses come from the Judge and are not computed here.
 */
import { executeBatch, type ExecuteInput, type ExecuteOptions, type ProposalOutcome } from './execute.js';
import { isPlayerSide } from './knowledge.js';
import { exhaustionCheckpoint, pauseKindOf, type ExhaustionCheckpoint } from './pauses.js';
import { H13_SEGMENT_EXHAUSTED } from './rules.js';
import type { PairId, PauseCategory, PauseKind, RuleId, WorldState } from './types.js';

export interface PauseRequest {
  kind: PauseKind;
  category: PauseCategory;
  proposalIds: string[];
  pair: PairId | null;
  checkpoint: ExhaustionCheckpoint | null;
}

export interface PausePlan {
  outcomes: ProposalOutcome[];
  wouldCommit: string[];
  rejected: { proposalId: string; rule: RuleId }[];
  required: PauseRequest[];
}

const NEGOTIATION_TYPES = new Set([
  'dispatch_document',
  'propose_terms',
  'respond_to_offer',
  'confirm_commitment',
  'withdraw_offer',
  'abandon_request',
]);

function actionType(action: unknown): string | null {
  if (typeof action !== 'object' || action === null) return null;
  const type = (action as { type?: unknown }).type;
  return typeof type === 'string' ? type : null;
}

export function planPauses(state: WorldState, input: ExecuteInput, opts: ExecuteOptions): PausePlan {
  const sim = executeBatch(state, input, { ...opts, dryRun: true });
  const byId = new Map(input.proposals.map((p) => [p.proposalId, p]));
  const decided = (proposalId: string): boolean =>
    input.decisions.some((d) => d.proposalIds.includes(proposalId) && d.option !== 'ask');
  const required: PauseRequest[] = [];

  for (const o of sim.outcomes) {
    if (o.status !== 'committed' || decided(o.proposalId)) continue;
    if (o.requiresDecision) {
      required.push({
        kind: pauseKindOf(o.requiresDecision),
        category: o.requiresDecision,
        proposalIds: [o.proposalId],
        pair: null,
        checkpoint: null,
      });
    } else if (byId.get(o.proposalId)?.askPlayer) {
      required.push({ kind: 'prompt', category: 'prompt_request', proposalIds: [o.proposalId], pair: null, checkpoint: null });
    }
  }

  if (opts.mode !== 'baseline' && input.kind === 'character') {
    const overSegment = sim.outcomes.filter(
      (o) => o.status === 'rejected' && o.rule === 'H13' && o.code === H13_SEGMENT_EXHAUSTED && isPlayerSide(state, opts.config, o.actor),
    );
    const wouldCommit = new Set(sim.outcomes.filter((o) => o.status === 'committed').map((o) => o.proposalId));
    const eligible = input.proposals.filter((p) => wouldCommit.has(p.proposalId));
    const checkpoint = exhaustionCheckpoint(state, opts.config, eligible, overSegment.length > 0);
    const deadlockDecided = input.decisions.some((d) => d.category === 'negotiation_deadlock' && d.option !== 'ask');
    if (checkpoint && !deadlockDecided) {
      const related = input.proposals
        .filter((p) => isPlayerSide(state, opts.config, p.actor) && NEGOTIATION_TYPES.has(actionType(p.action) ?? ''))
        .map((p) => p.proposalId);
      required.push({
        kind: 'control',
        category: 'negotiation_deadlock',
        proposalIds: [...new Set([...overSegment.map((o) => o.proposalId), ...related])],
        pair: checkpoint.pair,
        checkpoint,
      });
    }
  }

  return {
    outcomes: sim.outcomes,
    wouldCommit: sim.outcomes.filter((o) => o.status === 'committed').map((o) => o.proposalId),
    rejected: sim.outcomes
      .filter((o): o is ProposalOutcome & { rule: RuleId } => o.status === 'rejected' && o.rule !== null)
      .map((o) => ({ proposalId: o.proposalId, rule: o.rule })),
    required,
  };
}
