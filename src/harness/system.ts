/**
 * System batches (PLAN §6, §8.3, §10.1):
 * - PREPARE records `round_starts(round, version, dialogueSeqCutoff, controlSeqCutoff)` before its batch (quiescent
 *   point for branching), then commits deliveries and the terminal check as a `system_prepare` batch;
 * - ADVANCE enforces H14, commits the `system_advance` batch, then evaluates G06: a staged `system_outcome` batch
 *   holding `mutiny_outbreak`, with a mandatory `mutiny` pause in Harness modes or committed at once in baseline.
 */
import { checkAdvance } from '../core/rules.js';
import { MUTINY_OUTBREAK, mutinyDue, runAdvance, runPrepare } from '../core/system.js';
import { commitProposalBatch, commitSystemStep, currentState, insertSystemProposal, newBatch, type CommitResult } from './commit.js';
import { HarnessError, type HarnessContext } from './context.js';
import { openPauseTx } from './decisions.js';

function ensureRunnable(ctx: HarnessContext, sessionId: string): void {
  const session = ctx.repo.getSession(sessionId);
  if (session.status === 'suspended' || session.status === 'stopped') {
    throw new HarnessError('invalid_state', `session ${sessionId} is ${session.status}`);
  }
}

export function runSystemPrepareTx(ctx: HarnessContext, sessionId: string): CommitResult {
  ensureRunnable(ctx, sessionId);
  const session = ctx.repo.getSession(sessionId);
  const state = currentState(ctx, sessionId);
  if (state.terminal) throw new HarnessError('terminal', `the world is terminal (${state.terminal.kind})`);
  const open = ctx.repo.openBatches(sessionId);
  if (open.length > 0) throw new HarnessError('invalid_state', `open batch ${open[0]?.batchId} before PREPARE`);
  if (ctx.repo.listPauses(sessionId, { status: 'open' }).length > 0) throw new HarnessError('invalid_state', 'open pause before PREPARE');
  if (!ctx.repo.findRoundStart(sessionId, state.round)) {
    ctx.repo.insertRoundStart({
      sessionId,
      round: state.round,
      version: state.version,
      dialogueSeqCutoff: session.dialogueSeq,
      controlSeqCutoff: session.controlSeq,
    });
  }
  const batch = newBatch(ctx, session, 'system_prepare', state, { status: 'assessed' });
  return commitSystemStep(ctx, session, batch, state, runPrepare(state, session.config));
}

export function runSystemAdvanceTx(ctx: HarnessContext, sessionId: string): CommitResult {
  ensureRunnable(ctx, sessionId);
  const session = ctx.repo.getSession(sessionId);
  const state = currentState(ctx, sessionId);
  if (state.terminal) throw new HarnessError('terminal', `the world is terminal (${state.terminal.kind})`);
  const gate = checkAdvance(state, {
    openPauses: ctx.repo.listPauses(sessionId, { status: 'open' }).length,
    uncommittedBatches: ctx.repo.openBatches(sessionId).length,
  });
  if (gate) {
    return {
      ok: false,
      replayed: false,
      batchId: null,
      kind: 'system_advance',
      fromVersion: state.version,
      toVersion: state.version,
      events: [],
      outcomes: [],
      terminal: null,
      rule: gate.rule,
      reason: gate.reason,
      staged: null,
      continuation: session.phase,
    };
  }
  const batch = newBatch(ctx, session, 'system_advance', state, { status: 'assessed' });
  const result = commitSystemStep(ctx, session, batch, state, runAdvance(state, session.config));
  const after = currentState(ctx, sessionId);
  const outcomeOpen = ctx.repo.openBatches(sessionId).some((b) => b.kind === 'system_outcome');
  if (after.terminal || outcomeOpen || !mutinyDue(after, session.config)) return result;

  // G06: stage the consequential outcome as its own batch (baseVersion = current).
  const fresh = ctx.repo.getSession(sessionId);
  const outcome = newBatch(ctx, fresh, 'system_outcome', after, { status: 'assessed' });
  const proposal = insertSystemProposal(ctx, fresh, outcome, MUTINY_OUTBREAK);
  if (fresh.mode === 'baseline') {
    const committed = commitProposalBatch(ctx, sessionId, outcome.batchId);
    return {
      ...result,
      toVersion: committed.toVersion,
      events: [...result.events, ...committed.events],
      terminal: committed.terminal,
      staged: { batchId: outcome.batchId, pauseId: null },
      continuation: committed.continuation,
    };
  }
  const pause = openPauseTx(ctx, sessionId, { batchId: outcome.batchId, category: 'mutiny', proposalIds: [proposal.proposalId] });
  ctx.repo.updateSession(sessionId, { status: 'awaiting_decision', phase: 'outcome' });
  return { ...result, staged: { batchId: outcome.batchId, pauseId: pause.id }, continuation: 'outcome' };
}
