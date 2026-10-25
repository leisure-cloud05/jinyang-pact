/**
 * Recovery on start (PLAN §8.4): a `generating` character batch is marked stale and the epoch is bumped (reason
 * `recovery`, as for an interrupt; the engine regenerates the batch);
 * `assessed`/`paused` batches keep their pauses; committed character batches without narration are reported as
 * `narration_pending`; the session status is recomputed from what is actually open. A suspended session stays
 * suspended (resume = retry). Transactions guarantee that no half-written commit exists after a crash.
 */
import type { PauseRecord } from '../store/repo.js';
import { markStale } from './commit.js';
import type { HarnessContext, Replayable } from './context.js';
import { bumpEpoch } from './decisions.js';

export interface RecoveryReport extends Replayable {
  sessionId: string;
  staleBatches: string[];
  /** Epoch after recovery (bumped with reason `recovery` when a crashed batch was marked stale). */
  epoch: number;
  openBatches: string[];
  restoredPauses: string[];
  narrationPending: string[];
  status: string;
  phase: string;
}

export function recoverTx(ctx: HarnessContext, sessionId: string): RecoveryReport {
  const session = ctx.repo.getSession(sessionId);
  const staleBatches: string[] = [];
  for (const batch of ctx.repo.openBatches(sessionId)) {
    if (batch.status === 'generating') {
      markStale(ctx, batch, 'stale', 'stale_epoch');
      staleBatches.push(batch.batchId);
    }
  }
  // Uniform audit/H05 semantics: a batch lost to a crash is superseded exactly like an interrupted one.
  const epoch = staleBatches.length > 0 ? bumpEpoch(ctx, session, 'recovery', null) : session.epoch;
  const open = ctx.repo.openBatches(sessionId);
  const pauses: PauseRecord[] = ctx.repo.listPauses(sessionId, { status: 'open' });
  const narrationPending = ctx.repo
    .listBatches(sessionId)
    .filter((b) => b.status === 'committed' && (b.narrationStatus === 'pending' || b.narrationStatus === 'failed'))
    .map((b) => b.batchId);

  let status = session.status;
  let phase = session.phase;
  if (status !== 'suspended' && status !== 'stopped' && status !== 'finished') {
    if (pauses.length > 0) {
      status = 'awaiting_decision';
      phase = open.some((b) => b.kind === 'system_outcome') ? 'outcome' : 'decide';
    } else if (open.length > 0) {
      status = 'committing';
      phase = 'commit';
    } else if (staleBatches.length > 0) {
      status = 'ready';
      phase = 'generate';
    } else if (narrationPending.length > 0) {
      status = 'narrating';
      phase = 'narrate';
    } else if (status !== 'ready') {
      status = 'ready';
    }
    ctx.repo.updateSession(sessionId, { status, phase });
  }
  return {
    replayed: false,
    sessionId,
    staleBatches,
    epoch,
    openBatches: open.map((b) => b.batchId),
    restoredPauses: pauses.map((p) => p.id),
    narrationPending,
    status,
    phase,
  };
}
