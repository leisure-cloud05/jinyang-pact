/**
 * Branching (PLAN §8.5): only at round-start versions (quiescent: no open batch or pause), recorded in
 * `round_starts`. The child session gets immutable lineage `{parentSessionId, parentRound, parentVersion}`, a copy
 * of the snapshot, the events ≤ version and the dialogue rows with `seq ≤ dialogueSeqCutoff` (marked inherited);
 * control records stay in the parent; the epoch restarts at 0 and the child resumes at PREPARE of that round.
 */
import type { SessionRecord } from '../store/repo.js';
import { HarnessError, type HarnessContext, type Replayable } from './context.js';

export interface BranchResult extends Replayable {
  newSessionId: string;
  parentSessionId: string;
  round: number;
  version: number;
}

export function branchTx(ctx: HarnessContext, sessionId: string, round: number, newSessionId: string): BranchResult {
  const parent = ctx.repo.getSession(sessionId);
  if (ctx.repo.findSession(newSessionId)) throw new HarnessError('invalid_state', `session ${newSessionId} already exists`);
  const start = ctx.repo.findRoundStart(sessionId, round);
  if (!start) throw new HarnessError('invalid_state', `round ${round} of ${sessionId} has no recorded round start`);
  const snapshot = ctx.repo.getSnapshot(sessionId, start.version);
  if (!snapshot) throw new HarnessError('invalid_state', `no snapshot at round-start version ${start.version}`);

  const child: SessionRecord = {
    ...parent,
    sessionId: newSessionId,
    status: 'ready',
    suspendedFrom: null,
    phase: 'prepare',
    round,
    epoch: 0,
    baseVersion: start.version,
    parentSessionId: sessionId,
    parentRound: round,
    parentVersion: start.version,
    runOutcome: null,
    controlSeq: 0,
    dialogueSeq: start.dialogueSeqCutoff,
    createdAt: ctx.clock(),
  };
  ctx.repo.insertSession(child);
  ctx.repo.putSnapshot(newSessionId, snapshot.state);
  for (const event of ctx.repo.listEvents(sessionId, { toVersion: start.version })) {
    ctx.repo.insertEvent(newSessionId, event.batchId, event, event.stateHash, true);
  }
  for (const row of ctx.repo.listDialogue(sessionId, start.dialogueSeqCutoff)) {
    ctx.repo.insertDialogue({ ...row, sessionId: newSessionId, inherited: true });
  }
  ctx.repo.insertEpoch({
    sessionId: newSessionId,
    epoch: 0,
    reason: `branch of ${sessionId} at round ${round}`,
    instructionId: null,
    startedAt: ctx.clock(),
    controlSeq: ctx.repo.nextControlSeq(newSessionId),
  });
  return { replayed: false, newSessionId, parentSessionId: sessionId, round, version: start.version };
}
