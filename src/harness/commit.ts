/**
 * Commit protocol (PLAN §8.2) inside an already-open transaction: H05 entry check, decision world-effects and
 * sequential validation/resolution (the pure `executeBatch`), then events (with the post-event state hash),
 * the snapshot, proposal outcomes, implicit `player_initiated` decisions, speech dialogue, the batch status and
 * the session continuation. Callers wrap this in `withRequest` (BEGIN IMMEDIATE … COMMIT / ROLLBACK).
 */
import { executeBatch, type BatchDecision, type BatchProposal, type ExecuteResult, type ProposalOutcome } from '../core/execute.js';
import { hashState } from '../core/hash.js';
import { applyPatch } from '../core/reducer.js';
import { checkBatchEntry } from '../core/rules.js';
import type { StepResult } from '../core/system.js';
import type { BatchKind, RuleId, TerminalState, WorldEvent, WorldState } from '../core/types.js';
import type { BatchRecord, DecisionRecord, ProposalRecord, SessionPhase, SessionRecord, SessionStatus } from '../store/repo.js';
import { HarnessError, controlId, stage, type HarnessContext } from './context.js';

export interface OutcomeSummary {
  proposalId: string;
  actor: string;
  status: ProposalOutcome['status'];
  rule: RuleId | null;
  reason: string | null;
  feedback: string | null;
  gate: ProposalOutcome['gate'];
  eventVersions: number[];
}

export interface CommitResult {
  ok: boolean;
  replayed: boolean;
  batchId: string | null;
  kind: BatchKind | null;
  fromVersion: number;
  toVersion: number;
  events: Array<{ version: number; kind: string }>;
  outcomes: OutcomeSummary[];
  terminal: TerminalState | null;
  rule: RuleId | null;
  reason: string | null;
  /** A staged system outcome (G06) created by ADVANCE. */
  staged: { batchId: string; pauseId: string | null } | null;
  continuation: SessionPhase;
}

export function currentState(ctx: HarnessContext, sessionId: string): WorldState {
  return ctx.repo.latestSnapshot(sessionId).state;
}

export function newBatch(
  ctx: HarnessContext,
  session: SessionRecord,
  kind: BatchKind,
  state: WorldState,
  opts: { status?: BatchRecord['status']; generation?: number; note?: string | null } = {},
): BatchRecord {
  const { id, seq } = controlId(ctx, session.sessionId, `b`);
  const batch: BatchRecord = {
    batchId: id,
    sessionId: session.sessionId,
    kind,
    round: state.round,
    epoch: session.epoch,
    baseVersion: state.version,
    status: opts.status ?? 'generating',
    generation: opts.generation ?? 0,
    controlSeq: seq,
    commitSeq: null,
    committedVersion: null,
    narrationStatus: 'none',
    note: opts.note ?? null,
  };
  ctx.repo.insertBatch(batch);
  return batch;
}

export function insertSystemProposal(ctx: HarnessContext, session: SessionRecord, batch: BatchRecord, action: unknown): ProposalRecord {
  const { seq } = controlId(ctx, session.sessionId, 'p');
  const proposal: ProposalRecord = {
    proposalId: `${batch.batchId}/p1`,
    sessionId: session.sessionId,
    batchId: batch.batchId,
    round: batch.round,
    epoch: batch.epoch,
    baseVersion: batch.baseVersion,
    actor: 'system',
    source: 'system',
    seq: 1,
    action,
    rationale: '',
    cites: [],
    askPlayer: null,
    status: 'pending',
    rule: null,
    reason: null,
    feedback: null,
    code: null,
    category: null,
    gate: null,
    authorizationId: null,
    decisionId: null,
    eventVersions: [],
    controlSeq: seq,
  };
  ctx.repo.insertProposal(proposal);
  return proposal;
}

/** Persists committed events with the hash of the state after each one; returns the final state. */
function writeEvents(ctx: HarnessContext, sessionId: string, batchId: string, from: WorldState, events: readonly WorldEvent[]): WorldState {
  let state = from;
  for (const event of events) {
    state = applyPatch(state, event.changes);
    ctx.repo.insertEvent(sessionId, batchId, event, hashState(state));
  }
  return state;
}

function continuationOf(kind: BatchKind, state: WorldState): SessionPhase {
  if (state.terminal) return 'finished';
  switch (kind) {
    case 'system_prepare':
      return 'player';
    case 'player':
      return 'select';
    case 'character':
      return 'narrate';
    case 'system_advance':
    case 'system_outcome':
      return 'prepare';
  }
}

function statusOf(phase: SessionPhase): SessionStatus {
  if (phase === 'finished') return 'finished';
  if (phase === 'narrate') return 'narrating';
  return 'ready';
}

/** Finalises a committed batch: snapshot, batch status, session continuation. */
function finishBatch(
  ctx: HarnessContext,
  session: SessionRecord,
  batch: BatchRecord,
  finalState: WorldState,
  hadEvents: boolean,
): SessionPhase {
  ctx.repo.putSnapshot(session.sessionId, finalState);
  const commitSeq = ctx.repo.nextControlSeq(session.sessionId);
  ctx.repo.updateBatch(batch.batchId, {
    status: 'committed',
    commitSeq,
    committedVersion: finalState.version,
    narrationStatus: batch.kind === 'character' && hadEvents ? 'pending' : batch.kind === 'character' ? 'done' : 'none',
  });
  const phase = continuationOf(batch.kind, finalState);
  ctx.repo.updateSession(session.sessionId, { round: finalState.round, phase, status: statusOf(phase) });
  return phase;
}

function summarize(outcomes: readonly ProposalOutcome[]): OutcomeSummary[] {
  return outcomes.map((o) => ({
    proposalId: o.proposalId,
    actor: o.actor,
    status: o.status,
    rule: o.rule,
    reason: o.reason,
    feedback: o.feedback,
    gate: o.gate,
    eventVersions: o.eventVersions,
  }));
}

export function toBatchDecision(d: DecisionRecord): BatchDecision {
  return {
    decisionId: d.decisionId,
    category: d.category,
    option: d.option,
    proposalIds: d.proposalIds,
    pair: d.pair,
    authorization: d.payload.authorization,
    goalLimits: d.payload.goalLimits,
  };
}

/** Proposals that take part in execution (format errors and stale/obsolete proposals do not). */
export function executableProposals(proposals: readonly ProposalRecord[]): BatchProposal[] {
  return proposals
    .filter((p) => p.status === 'pending' || p.status === 'committed' || p.status === 'rejected' || p.status === 'withheld' || p.status === 'unapplied')
    .map((p) => ({ proposalId: p.proposalId, actor: p.actor, seq: p.seq, action: p.action, askPlayer: p.askPlayer, source: p.source }));
}

export function stalenessCheck(session: SessionRecord, batch: BatchRecord, state: WorldState) {
  return checkBatchEntry(batch, session.epoch, state.version);
}

/** Marks a batch stale and its pending proposals `stale_epoch`, its open pauses obsolete. */
export function markStale(ctx: HarnessContext, batch: BatchRecord, status: 'stale' | 'obsolete', proposalStatus: 'stale_epoch' | 'obsolete'): void {
  ctx.repo.updateBatch(batch.batchId, { status });
  for (const p of ctx.repo.listProposals(batch.batchId)) {
    if (p.status === 'pending') ctx.repo.updateProposal(p.proposalId, { status: proposalStatus });
  }
  for (const pause of ctx.repo.listPauses(batch.sessionId, { batchId: batch.batchId, status: 'open' })) {
    ctx.repo.updatePause(pause.id, { status: 'obsolete' });
  }
}

/**
 * Commits a proposal batch (player / character / system_outcome) inside the caller's transaction:
 * H05 entry check → executeBatch (decision effects, validation, resolution, terminal checks) → persistence.
 */
export function commitProposalBatch(ctx: HarnessContext, sessionId: string, batchId: string): CommitResult {
  const session = ctx.repo.getSession(sessionId);
  const batch = ctx.repo.getBatch(batchId);
  const state = currentState(ctx, sessionId);
  const base: Omit<CommitResult, 'ok' | 'rule' | 'reason'> = {
    replayed: false,
    batchId,
    kind: batch.kind,
    fromVersion: state.version,
    toVersion: state.version,
    events: [],
    outcomes: [],
    terminal: state.terminal,
    staged: null,
    continuation: session.phase,
  };
  if (batch.sessionId !== sessionId) throw new HarnessError('not_found', `${batchId} is not a batch of ${sessionId}`);
  if (batch.status === 'committed') throw new HarnessError('invalid_state', `${batchId} is already committed`);
  if (batch.status === 'stale' || batch.status === 'obsolete') {
    return { ...base, ok: false, rule: 'H05', reason: `${batchId} is ${batch.status} and can never commit` };
  }
  if (batch.kind === 'character' && batch.status === 'generating') {
    throw new HarnessError('invalid_state', `${batchId} has not been assessed`);
  }
  const open = ctx.repo.listPauses(sessionId, { batchId, status: 'open' });
  if (open.length > 0) throw new HarnessError('invalid_state', `${batchId} has ${open.length} open pause(s)`);

  const entry = stalenessCheck(session, batch, state);
  if (entry) {
    markStale(ctx, batch, 'stale', 'stale_epoch');
    return { ...base, ok: false, rule: 'H05', reason: entry.reason };
  }

  const decisions = ctx.repo.listDecisions(batchId).filter((d) => d.option !== 'ask').map(toBatchDecision);
  const proposals = ctx.repo.listProposals(batchId);
  const result: ExecuteResult = executeBatch(
    state,
    { kind: batch.kind, proposals: executableProposals(proposals), decisions },
    { config: session.config, mode: session.mode },
  );
  stage(ctx, 'executed', sessionId, batchId);

  const finalState = writeEvents(ctx, sessionId, batchId, state, result.events);
  stage(ctx, 'events_written', sessionId, batchId);

  let version = state.version;
  const effectVersions = result.decisionEffects.flatMap((d) => d.eventVersions);
  if (effectVersions.length > 0) version = Math.max(...effectVersions);
  for (const o of result.outcomes) {
    const decisionId =
      o.decisionId ??
      (o.gate === 'player_initiated'
        ? insertImplicitDecision(ctx, session, batch, o)
        : null);
    ctx.repo.updateProposal(o.proposalId, {
      status: o.status,
      rule: o.rule,
      reason: o.reason,
      feedback: o.feedback,
      code: o.code,
      category: o.category,
      gate: o.gate,
      authorizationId: o.authorizationId,
      decisionId,
      eventVersions: o.eventVersions,
    });
    if (o.eventVersions.length > 0) version = Math.max(version, ...o.eventVersions);
    if (o.dialogue && o.status === 'committed') {
      ctx.repo.insertDialogue({
        sessionId,
        seq: ctx.repo.nextDialogueSeq(sessionId),
        round: batch.round,
        epoch: batch.epoch,
        worldVersion: version,
        speaker: o.dialogue.speaker,
        listeners: o.dialogue.listeners,
        text: o.dialogue.text,
        kind: o.dialogue.kind,
        proposalId: o.proposalId,
        decisionId: null,
      });
    }
  }
  stage(ctx, 'proposals_written', sessionId, batchId);

  const continuation = finishBatch(ctx, session, batch, finalState, result.events.length > 0);
  return {
    ...base,
    ok: true,
    rule: null,
    reason: null,
    toVersion: finalState.version,
    events: result.events.map((e) => ({ version: e.version, kind: e.kind })),
    outcomes: summarize(result.outcomes),
    terminal: finalState.terminal,
    continuation,
  };
}

function insertImplicitDecision(ctx: HarnessContext, session: SessionRecord, batch: BatchRecord, o: ProposalOutcome): string {
  const { id, seq } = controlId(ctx, session.sessionId, 'd');
  ctx.repo.insertDecision({
    decisionId: id,
    sessionId: session.sessionId,
    pauseId: null,
    batchId: batch.batchId,
    category: o.category ?? 'dispatch_request',
    proposalIds: [o.proposalId],
    pair: null,
    option: 'player_initiated',
    advice: null,
    payload: { authorization: null, goalLimits: null, amend: null, counterTerms: null },
    by: 'implicit',
    requestId: null,
    round: batch.round,
    epoch: batch.epoch,
    controlSeq: seq,
  });
  return id;
}

/** Persists a system step (PREPARE / ADVANCE) as a committed batch. */
export function commitSystemStep(
  ctx: HarnessContext,
  session: SessionRecord,
  batch: BatchRecord,
  from: WorldState,
  step: StepResult,
): CommitResult {
  const finalState = writeEvents(ctx, session.sessionId, batch.batchId, from, step.events);
  stage(ctx, 'events_written', session.sessionId, batch.batchId);
  if (hashState(finalState) !== hashState(step.state)) {
    throw new HarnessError('invalid_state', 'system step events do not reproduce the step state');
  }
  const continuation = finishBatch(ctx, session, batch, finalState, step.events.length > 0);
  return {
    ok: true,
    replayed: false,
    batchId: batch.batchId,
    kind: batch.kind,
    fromVersion: from.version,
    toVersion: finalState.version,
    events: step.events.map((e) => ({ version: e.version, kind: e.kind })),
    outcomes: [],
    terminal: finalState.terminal,
    rule: null,
    reason: null,
    staged: null,
    continuation,
  };
}
