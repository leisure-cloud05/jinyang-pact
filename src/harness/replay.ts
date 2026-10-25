/**
 * Replay (PLAN §8.5), read-only. Nothing stored is trusted without re-derivation:
 * - every stored snapshot's `state_json` is re-hashed and compared with its hash column, and with the state
 *   reconstructed at that version (the base snapshot included);
 * - `patch`: re-apply the stored RFC-6902 `changes` from the base snapshot, checking every event's post-state hash;
 * - `rederive` (mode-aware): re-run the committed batches in commit order from control history — execution
 *   membership from each proposal's immutable intake evidence (cross-checked with the submit request records and
 *   the action hash), the H05 entry condition from the epoch history and the evolving world version — requiring
 *   identical events (including round/day), identical outcomes for every proposal, and the same final state.
 * Computed for every session, complete or not.
 */
import { executeBatch, type BatchProposal } from '../core/execute.js';
import { hashState, hashValue } from '../core/hash.js';
import { applyPatch } from '../core/reducer.js';
import { runAdvance, runPrepare } from '../core/system.js';
import type { WorldEvent, WorldState } from '../core/types.js';
import type { BatchRecord, ProposalRecord, Repo } from '../store/repo.js';
import { toBatchDecision } from './commit.js';

export interface ReplayReport {
  sessionId: string;
  mode: 'patch' | 'rederive';
  ok: boolean;
  checkedEvents: number;
  checkedBatches: number;
  mismatches: string[];
  finalHash: string;
  expectedHash: string;
}

/** Snapshots whose stored contents do not match their own hash column. */
function snapshotIntegrity(repo: Repo, sessionId: string): { states: Map<number, string>; mismatches: string[] } {
  const states = new Map<number, string>();
  const mismatches: string[] = [];
  for (const version of repo.listSnapshotVersions(sessionId)) {
    const snap = repo.getSnapshot(sessionId, version);
    if (!snap) continue;
    const actual = hashState(snap.state);
    if (actual !== snap.hash) mismatches.push(`snapshot ${version}: contents do not match the stored hash`);
    if (snap.state.version !== version) mismatches.push(`snapshot ${version}: contents are version ${snap.state.version}`);
    states.set(version, actual);
  }
  return { states, mismatches };
}

function baseState(repo: Repo, sessionId: string): WorldState {
  const session = repo.getSession(sessionId);
  const snap = repo.getSnapshot(sessionId, session.baseVersion);
  if (!snap) throw new Error(`session ${sessionId} has no base snapshot at version ${session.baseVersion}`);
  return snap.state;
}

function latestContentHash(repo: Repo, sessionId: string): string {
  return hashState(repo.latestSnapshot(sessionId).state);
}

export function replayPatch(repo: Repo, sessionId: string): ReplayReport {
  const session = repo.getSession(sessionId);
  const integrity = snapshotIntegrity(repo, sessionId);
  const mismatches = [...integrity.mismatches];
  let state = baseState(repo, sessionId);
  const events = repo.listEvents(sessionId, { fromVersion: session.baseVersion + 1, includeInherited: false });
  for (const event of events) {
    if (event.version !== state.version + 1) {
      mismatches.push(`event ${event.version} does not follow version ${state.version}`);
      break;
    }
    try {
      state = applyPatch(state, event.changes);
    } catch (err) {
      mismatches.push(`event ${event.version}: patch failed (${(err as Error).message})`);
      break;
    }
    const hash = hashState(state);
    if (hash !== event.stateHash) mismatches.push(`event ${event.version}: state hash differs`);
    const stored = integrity.states.get(event.version);
    if (stored !== undefined && stored !== hash) mismatches.push(`snapshot ${event.version}: contents differ from the replayed state`);
  }
  const expectedHash = latestContentHash(repo, sessionId);
  const finalHash = hashState(state);
  if (finalHash !== expectedHash) mismatches.push('final state differs from the latest snapshot contents');
  return { sessionId, mode: 'patch', ok: mismatches.length === 0, checkedEvents: events.length, checkedBatches: 0, mismatches, finalHash, expectedHash };
}

function eventKey(e: WorldEvent): string {
  return hashValue({
    version: e.version,
    round: e.round,
    day: e.day,
    kind: e.kind,
    actor: e.actor,
    changes: e.changes,
    facts: e.facts,
    rules: e.rulesApplied,
    proposalId: e.proposalId,
    decisionId: e.decisionId,
  });
}

/** Epoch in force when a batch committed, reconstructed from the epoch history (control order). */
function epochAtCommit(repo: Repo, sessionId: string, batch: BatchRecord): number {
  let epoch = 0;
  for (const e of repo.listEpochs(sessionId)) if (batch.commitSeq !== null && e.controlSeq < batch.commitSeq) epoch = Math.max(epoch, e.epoch);
  return epoch;
}

/** Intake evidence recorded by submit requests (independent of the proposals table). */
function submittedIntake(repo: Repo, sessionId: string): Map<string, { intake: string; intakeHash: string }> {
  const out = new Map<string, { intake: string; intakeHash: string }>();
  for (const r of repo.listRequests(sessionId)) {
    if (r.op !== 'submit') continue;
    const intake = (r.result as { intake?: Array<{ proposalId: string; intake: string; intakeHash: string }> }).intake ?? [];
    for (const i of intake) out.set(i.proposalId, { intake: i.intake, intakeHash: i.intakeHash });
  }
  return out;
}

/**
 * A skipped turn (`skip_actor`) must be backed by its control record: an error_recovery `skip_actor` decision for
 * that very actor, recorded before the placeholder proposal.
 */
function checkSkipProvenance(repo: Repo, p: ProposalRecord, mismatches: string[]): void {
  const decision = p.decisionId ? repo.listSessionDecisions(p.sessionId).find((d) => d.decisionId === p.decisionId) : undefined;
  const pause = decision?.pauseId ? repo.findPause(decision.pauseId) : null;
  const ok =
    decision !== undefined &&
    decision.category === 'error_recovery' &&
    decision.option === 'skip_actor' &&
    decision.controlSeq < p.controlSeq &&
    pause?.meta?.actor === p.actor;
  if (!ok) mismatches.push(`${p.proposalId}: skipped turn without a matching skip_actor decision`);
}

function checkIntake(p: ProposalRecord, submitted: Map<string, { intake: string; intakeHash: string }>, mismatches: string[]): void {
  if (hashValue(p.action) !== p.intakeHash) mismatches.push(`${p.proposalId}: stored action differs from its intake`);
  const record = submitted.get(p.proposalId);
  if (p.source === 'llm' || p.source === 'policy') {
    if (!record) mismatches.push(`${p.proposalId}: no submit record`);
    else if (record.intake !== p.intake || record.intakeHash !== p.intakeHash) {
      mismatches.push(`${p.proposalId}: intake differs from its submit record`);
    }
  }
}

export function replayRederive(repo: Repo, sessionId: string): ReplayReport {
  const session = repo.getSession(sessionId);
  const integrity = snapshotIntegrity(repo, sessionId);
  const mismatches = [...integrity.mismatches];
  const submitted = submittedIntake(repo, sessionId);
  let state = baseState(repo, sessionId);
  let checkedEvents = 0;
  const batches = repo.committedBatches(sessionId);
  for (const batch of batches) {
    // H05 from control history: the batch must have been generated at the version and epoch in force.
    if (batch.baseVersion !== state.version) {
      mismatches.push(`${batch.batchId}: base version ${batch.baseVersion} but the world was at ${state.version}`);
    }
    const epoch = epochAtCommit(repo, sessionId, batch);
    if (batch.epoch !== epoch) mismatches.push(`${batch.batchId}: epoch ${batch.epoch} but epoch ${epoch} was in force at commit`);

    const stored = repo.listBatchEvents(sessionId, batch.batchId);
    let produced: WorldEvent[];
    let next: WorldState;
    if (batch.kind === 'system_prepare') {
      const step = runPrepare(state, session.config);
      produced = step.events;
      next = step.state;
    } else if (batch.kind === 'system_advance') {
      const step = runAdvance(state, session.config);
      produced = step.events;
      next = step.state;
    } else {
      const proposals = repo.listProposals(batch.batchId);
      const members: BatchProposal[] = [];
      for (const p of proposals) {
        checkIntake(p, submitted, mismatches);
        if (p.code === 'skipped' || (p.source === 'system' && p.intake === 'format_error')) checkSkipProvenance(repo, p, mismatches);
        if (p.intake === 'pending') {
          members.push({ proposalId: p.proposalId, actor: p.actor, seq: p.seq, action: p.action, askPlayer: p.askPlayer, source: p.source });
        } else if (p.status !== p.intake) {
          mismatches.push(`${batch.batchId} ${p.proposalId}: intake ${p.intake} but stored ${p.status}`);
        }
      }
      const decisions = repo.listDecisions(batch.batchId).filter((d) => d.option !== 'ask').map(toBatchDecision);
      const result = executeBatch(state, { kind: batch.kind, proposals: members, decisions }, { config: session.config, mode: session.mode });
      produced = result.events;
      next = result.state;
      for (const p of proposals.filter((x) => x.intake === 'pending')) {
        const o = result.outcomes.find((x) => x.proposalId === p.proposalId);
        if (!o) {
          mismatches.push(`${batch.batchId} ${p.proposalId}: no re-derived outcome`);
          continue;
        }
        if (p.status !== o.status || p.rule !== o.rule || p.gate !== o.gate) {
          mismatches.push(`${batch.batchId} ${p.proposalId}: stored ${p.status}/${p.rule ?? '-'}/${p.gate ?? '-'}, re-derived ${o.status}/${o.rule ?? '-'}/${o.gate ?? '-'}`);
        }
      }
    }
    if (produced.length !== stored.length) {
      mismatches.push(`${batch.batchId} (${batch.kind}): ${stored.length} stored events, ${produced.length} re-derived`);
    } else {
      produced.forEach((e, i) => {
        const s = stored[i];
        if (s && eventKey(e) !== eventKey(s)) mismatches.push(`${batch.batchId}: event ${s.version} differs`);
      });
    }
    checkedEvents += produced.length;
    state = next;
    if (batch.committedVersion !== null && batch.committedVersion !== state.version) {
      mismatches.push(`${batch.batchId}: committed version ${batch.committedVersion}, re-derived ${state.version}`);
    }
    const snapHash = batch.committedVersion !== null ? integrity.states.get(batch.committedVersion) : undefined;
    if (snapHash !== undefined && snapHash !== hashState(state)) {
      mismatches.push(`${batch.batchId}: state after the batch differs from its snapshot contents`);
    }
  }
  const expectedHash = latestContentHash(repo, sessionId);
  const finalHash = hashState(state);
  if (finalHash !== expectedHash) mismatches.push('final state differs from the latest snapshot contents');
  return { sessionId, mode: 'rederive', ok: mismatches.length === 0, checkedEvents, checkedBatches: batches.length, mismatches, finalHash, expectedHash };
}
