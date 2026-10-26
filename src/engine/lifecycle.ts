/**
 * Round lifecycle steps (PLAN §10.1) over the harness API; the same code runs every mode (§10.2):
 *  1 PREPARE   system_prepare batch (the harness records round_starts first)
 *  2 PLAYER    the round's player turn (script or UI) is persisted first, then applied in ONE transaction with the
 *              queued instructions (delivered as player speech to everyone present), SELECT and the player-done
 *              marker — a crash either loses nothing or repeats nothing
 *  3 SELECT    the deterministic scene scheduler (§10.3) per interaction step `r<round>.s<step>`: the round's tiers
 *              in step 1, actionable interaction items (§10.4) in every step; activations logged with tier and reason
 *  4 GENERATE  character batch: authorized contexts (with each character's interaction view, from the ledger
 *              derived from everything committed before the step) → parallel character calls; the turns (recorded
 *              outputs) are stored atomically with the proposals (baseline: baseline prompt variant)
 *  5 CHECK     schema/cites (agents layer) — cite errors logged
 *  6 ASSESS    Harness dry run (mandatory, control and prompt pauses; baseline: prompt pauses only);
 *              full mode: Judge with the REVISE loop (one revision call per character, one re-assessment) BEFORE
 *              submission; REVISE originals and replacements are persisted as full envelopes (never executed);
 *              Judge transport failures open an error_recovery pause (retry / skip = defaulted misses / stop)
 *  7 DECIDE    policy or UI per open pause; answers superseded while awaited (interrupt, epoch change) are
 *              discarded; regenerating decisions (amend, deadlock options) obsolete the batch ⇒ back to GENERATE
 *  8 COMMIT    commitBatch (baseline: permissive executor)
 *  9 NARRATE   per scene via createNarrateFn; a failed scene is regenerated once from the committed events;
 *              otherwise it stays narration_pending; budget refusals reach the limit handling
 *              — each commit derives the follow-up items in the same transaction
 *  ·  STEP      after a committed step: another step (3–9) while an item is actionable and the round's step budget
 *              allows; else
 * 10 ADVANCE   system_advance (+ staged mutiny system_outcome, decided before the next round); unresolved items
 *              carry over
 * Every harness request id is deterministic (round, interaction step, epoch, batch generation), so a restarted
 * engine repeats a step idempotently (H06). The wall-clock deadline is checked after every awaited call and before commits; a watchdog
 * aborts outstanding calls when it expires.
 */
import { runAnswer, noAnswerLine } from '../agents/answer.js';
import { redactSecrets } from '../llm/redact.js';
import { runCharacterTurn, type CharacterTurnResult, type RevisionItem } from '../agents/character.js';
import { judgeWithRevision, runJudge, type JudgeProposalInput, type JudgeVerdict } from '../agents/judge.js';
import { renderFactHeader, fallbackProse } from '../agents/narration/index.js';
import { createNarrateFn } from '../agents/narrator.js';
import type { DialogueRow, ProposalDraft } from '../agents/types.js';
import type { BatchDecision, BatchProposal } from '../core/execute.js';
import { isPlayerSide, presentAt } from '../core/knowledge.js';
import { BESIEGED_FACTION, CHAR_IDS, type CharId, type LocId, type NarrationFact, type WorldState } from '../core/types.js';
import type { DecisionInput, NarrateOutput, NarrateRequest, PlayerInput, ProposalInput, SemanticPauseInput } from '../harness/index.js';
import type { BatchRecord, DecisionRecord, PauseRecord, ProposalRecord } from '../store/repo.js';
import { pausedWithinLimits } from './policy.js';
import type { InteractionContextView } from '../agents/interaction-view.js';
import { actionableItems, interactionViewFor, isCharId, itemTier, type Ledger } from './interaction.js';
import { ledgerHashOf, syncInteraction } from './interaction-store.js';
import type { ActivationRecord, RevisionRecord, TurnRecord } from './records.js';
import {
  callSignal,
  emit,
  expired,
  fireInterrupt,
  hook,
  identity,
  interactionEnv,
  log,
  pendingInterrupt,
  sessionOf,
  stateOf,
  takeFault,
  EngineError,
  type Runtime,
} from './runtime.js';
import { schedule, type LastActivation, type PendingCandidate, type SchedulerPersona } from './scheduler.js';
import type { ActivationView, DecisionChoice, DecisionContext, EngineEvent, PlayerTurn, StopReason } from './types.js';

export type StepSignal = 'continue' | 'stopped';

export interface LimitReached {
  outcome: 'budget_exhausted' | 'error';
  reason: string;
  /** Which limit (PLAN §8.4); a budget refusal is classified from the refusal itself when absent. */
  stopReason?: StopReason;
}

export const WALL_CLOCK: LimitReached = { outcome: 'error', reason: 'wall-clock limit of the run exceeded', stopReason: 'wall_clock' };
export const BUDGET: LimitReached = { outcome: 'budget_exhausted', reason: 'LLM budget exhausted' };

/** Stop reason of a limit: wall clock, or the call / cost budget named by the last refusal. */
export function stopReasonOf(rt: Runtime, limit: LimitReached): StopReason {
  if (limit.stopReason) return limit.stopReason;
  if (limit.outcome === 'error') return 'wall_clock';
  return /call budget/i.test(rt.client.lastBudgetRefusal ?? limit.reason) ? 'call_budget' : 'cost_budget';
}

function isChar(id: string): id is CharId {
  return (CHAR_IDS as readonly string[]).includes(id);
}

/** Control flow out of nested awaits inside GENERATE. */
class LimitSignal extends Error {
  constructor(readonly limit: LimitReached) {
    super(limit.reason);
  }
}
class StopSignal extends Error {}
class SupersededSignal extends Error {}

// ---------------------------------------------------------------------------------------------------------------
// Continuation (derived from committed facts, never from a recovered phase)
// ---------------------------------------------------------------------------------------------------------------

export function roundPrepared(rt: Runtime, round: number): boolean {
  return rt.harness.repo.committedBatches(rt.sessionId).some((b) => b.kind === 'system_prepare' && b.round === round);
}

export function characterCommitted(rt: Runtime, round: number): boolean {
  return committedSteps(rt, round) > 0;
}

/** Interaction steps of `round` completed (= committed character batches of the round; PLAN §10.1). */
export function committedSteps(rt: Runtime, round: number): number {
  return rt.harness.repo.committedBatches(rt.sessionId).filter((b) => b.kind === 'character' && b.round === round).length;
}

/** The interaction step the round is in (derived from committed facts, never from a recovered phase). */
export function currentStep(rt: Runtime, round: number): number {
  return committedSteps(rt, round) + 1;
}

export function stepId(round: number, step: number): string {
  return `r${round}.s${step}`;
}

/** Step of an activation's select id (`r<round>.s<step>.e<epoch>`; engine.v1 ids `r<round>.e<epoch>` are step 1). */
export function stepOfSelectId(selectId: string): number {
  const m = /^r\d+\.s(\d+)\./.exec(selectId);
  return m ? Number(m[1]) : 1;
}

/** Derives and materializes the interaction ledger (idempotent; joins the caller's transaction). */
export function syncLedger(rt: Runtime): Ledger {
  return syncInteraction(interactionEnv(rt));
}

/** Scheduling candidates from the ledger's actionable items at (round, step). */
function candidatesOf(ledger: Ledger, state: WorldState, round: number, step: number): PendingCandidate[] {
  return actionableItems(ledger, state, round, step)
    .filter((it) => isCharId(it.responsible))
    .map((it) => ({ charId: it.responsible, itemId: it.itemId, kind: it.kind, tier: itemTier(it.kind), seq: it.seq }));
}

export interface StepDecision {
  next: 'step' | 'advance';
  reason: 'actionable_items' | 'no_actionable_items' | 'step_budget_exhausted';
  actionable: string[];
}

/**
 * After step `done` of `round` committed: another step when an item is actionable and the round's step budget
 * allows it, else ADVANCE (unresolved items carry over). Derived from committed facts; logged once per step.
 */
export function stepDecision(rt: Runtime, round: number, done: number): StepDecision {
  const ledger = syncLedger(rt);
  const state = stateOf(rt);
  const actionable = candidatesOf(ledger, state, round, done + 1).map((c) => `${c.itemId}:${c.charId}:${c.kind}`);
  const decision: StepDecision =
    actionable.length === 0
      ? { next: 'advance', reason: 'no_actionable_items', actionable }
      : done >= rt.maxStepsPerRound
        ? { next: 'advance', reason: 'step_budget_exhausted', actionable }
        : { next: 'step', reason: 'actionable_items', actionable };
  if (log(rt, 'step_decision', { round, step: done, ...decision, maxStepsPerRound: rt.maxStepsPerRound }, `${stepId(round, done)}`)) {
    emit(rt, { type: 'step', round, step: done, next: decision.next, reason: decision.reason, actionable });
  }
  return decision;
}

/** The PLAYER step of `round` completed and no interrupt has restarted it since. */
export function playerDone(rt: Runtime, round: number): boolean {
  const done = rt.records.playerDoneEpochs(rt.sessionId, round);
  if (done.length === 0) return false;
  const latest = Math.max(...done);
  const current = sessionOf(rt).epoch;
  return !rt.harness.repo.listEpochs(rt.sessionId).some((e) => e.reason === 'interrupt' && e.epoch > latest && e.epoch <= current);
}

// ---------------------------------------------------------------------------------------------------------------
// Display helpers (deterministic fact headers for system batches; no LLM)
// ---------------------------------------------------------------------------------------------------------------

export function headerForVersions(rt: Runtime, fromVersion: number, toVersion: number): string | null {
  if (!rt.hooks.onEvent || toVersion <= fromVersion) return null;
  const events = rt.harness.repo.listEvents(rt.sessionId, { fromVersion: fromVersion + 1, toVersion });
  const byScene = new Map<string, { facts: NarrationFact[]; day: number }>();
  for (const e of events) {
    for (const f of e.facts) {
      const entry = byScene.get(f.scene) ?? { facts: [], day: e.day };
      entry.facts.push(f);
      byScene.set(f.scene, entry);
    }
  }
  const parts = [...byScene.entries()].map(([scene, v]) => renderFactHeader(v.facts, rt.names, rt.lang, { scene, day: v.day }));
  return parts.length > 0 ? parts.join('\n') : null;
}

// ---------------------------------------------------------------------------------------------------------------
// 1 PREPARE
// ---------------------------------------------------------------------------------------------------------------

export async function prepareStep(rt: Runtime): Promise<void> {
  const state = stateOf(rt);
  await hook(rt, 'prepare');
  // Deliveries and the items they create commit together (a crash loses or repeats neither).
  const result = rt.harness.store.transaction(() => {
    const r = rt.harness.runSystemPrepare(rt.sessionId, `r${state.round}.prepare`);
    syncLedger(rt);
    return r;
  });
  emit(rt, { type: 'round', round: state.round, day: state.day, epoch: sessionOf(rt).epoch });
  emit(rt, { type: 'system', kind: 'prepare', result, header: headerForVersions(rt, result.fromVersion, result.toVersion) });
}

/** Opens a user_requested pause at the start of a round (resolved by the decision source: `resume`). */
export function userPauseStep(rt: Runtime, round: number): boolean {
  if (!rt.userPauseRounds.includes(round)) return false;
  const key = `user_pause:${round}`;
  if (rt.records.hasLog(rt.sessionId, 'user_pause', key)) return false;
  const { pauseId } = rt.harness.openPause(rt.sessionId, { category: 'user_requested', proposalIds: [], batchId: null }, `r${round}.userpause`);
  log(rt, 'user_pause', { round, pauseId }, key);
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// 2 PLAYER (+ 3 SELECT, atomically)
// ---------------------------------------------------------------------------------------------------------------

function presentCharacters(state: WorldState): CharId[] {
  return presentAt(state, state.player.location as LocId).filter((a): a is CharId => isChar(a) && state.characters[a].status === 'alive');
}

interface StoredTurn {
  script: NonNullable<PlayerTurn['script']>;
  inputs: NonNullable<PlayerTurn['inputs']>;
}

/**
 * PLAYER: the round's turn is persisted before anything executes (a restart re-applies the same turn and never asks
 * the source twice); the script, direct inputs, queued instructions (marked applied together with their delivery),
 * SELECT and the player-done marker then commit in one transaction, with idempotent request ids.
 */
export async function playerStep(rt: Runtime): Promise<LimitReached | null> {
  const state = stateOf(rt);
  const round = state.round;
  await hook(rt, 'player');
  let turn = rt.records.findTurn(rt.sessionId, round) as StoredTurn | null;
  if (turn === null) {
    const fresh = await rt.players.turn({ sessionId: rt.sessionId, round, state, config: rt.config, lang: rt.lang });
    rt.records.saveTurn(rt.sessionId, round, { script: fresh.script ?? [], inputs: fresh.inputs ?? [] });
    turn = rt.records.findTurn(rt.sessionId, round) as StoredTurn;
    await hook(rt, 'player:turn');
  }
  // The turn may have been awaited past the deadline: suspend without applying it (it is kept for a resume).
  if (expired(rt)) return WALL_CLOCK;
  const stored = turn;
  const epoch = sessionOf(rt).epoch;
  const events: EngineEvent[] = [];
  rt.harness.store.transaction(() => {
    const script = rt.harness.applyScriptInputs(rt.sessionId, stored.script, `r${round}.script`, { lang: rt.lang });
    if (!script.replayed) {
      log(rt, 'player', {
        round,
        applied: script.applied,
        skipped: script.skipped,
        outcomes: script.outcomes.map((o) => ({ proposalId: o.proposalId, status: o.status, rule: o.rule })),
      });
      events.push({ type: 'player', round, applied: script.applied.length, skipped: script.skipped });
    }
    if (stored.inputs.length > 0 && !stateOf(rt).terminal) {
      const direct = rt.harness.applyPlayerAction(rt.sessionId, stored.inputs, `r${round}.input`);
      if (!direct.replayed) log(rt, 'player_input', { round, outcomes: direct.outcomes.map((o) => ({ proposalId: o.proposalId, status: o.status, rule: o.rule })) });
    }
    if (!stateOf(rt).terminal) {
      const taken = rt.harness.takeInstructions(rt.sessionId, `r${round}.e${epoch}.take`);
      if (taken.instructions.length > 0) {
        const listeners = presentCharacters(stateOf(rt));
        const inputs: PlayerInput[] = taken.instructions.map((i) => ({ kind: 'dialogue', to: listeners, text: i.text }));
        rt.harness.applyPlayerAction(rt.sessionId, inputs, `r${round}.e${epoch}.instr`);
        log(rt, 'instructions', { round, instructions: taken.instructions.map((i) => i.instructionId), listeners });
      }
      if (sessionOf(rt).phase === 'player') rt.harness.applyPlayerAction(rt.sessionId, [], `r${round}.e${epoch}.player`);
      const selected = selectStep(rt);
      if (selected.created) events.push(selected.event);
    }
    rt.records.markPlayerDone(rt.sessionId, round, epoch);
  });
  for (const e of events) emit(rt, e);
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// 3 SELECT
// ---------------------------------------------------------------------------------------------------------------

function schedulerPersonas(rt: Runtime): Record<CharId, SchedulerPersona> {
  const out = {} as Record<CharId, SchedulerPersona>;
  for (const id of CHAR_IDS) {
    const p = rt.personas[id];
    out[id] = { agendaTriggers: p.agendaTriggers, periodicActivation: p.periodicActivation };
  }
  return out;
}

function toView(a: ActivationRecord): ActivationView {
  return { charId: a.charId, tier: a.tier, reason: a.reason, agendaIds: a.agendaIds };
}

/** Characters the player addressed this round (speech and questions, any epoch of the round). */
export function addressedThisRound(rt: Runtime, round: number): CharId[] {
  const out = new Set<CharId>();
  for (const row of rt.harness.repo.listDialogue(rt.sessionId)) {
    if (row.speaker !== 'player' || row.round !== round || (row.kind !== 'speech' && row.kind !== 'question')) continue;
    for (const l of row.listeners) if (isChar(l)) out.add(l);
  }
  return CHAR_IDS.filter((c) => out.has(c));
}

/** Hash of a ledger as used for a selection and its contexts (replay compares it with a re-derivation). */
export function ledgerHash(ledger: Ledger): string {
  return ledgerHashOf(ledger);
}

/**
 * SELECT for the current round, step and epoch (idempotent: an existing selection is reused). Candidates come from
 * the interaction ledger's actionable items plus, in the round's first step, the round-level tiers (offers, agendas,
 * periodic activation). The ledger used is logged with its hash and the number of happenings it was derived from.
 */
export function selectStep(rt: Runtime): { rows: ActivationRecord[]; created: boolean; event: EngineEvent } {
  const state = stateOf(rt);
  const session = sessionOf(rt);
  const round = state.round;
  const step = currentStep(rt, round);
  const selectId = `${stepId(round, step)}.e${session.epoch}`;
  const existing = rt.records.activations(rt.sessionId, { selectId });
  const eventOf = (rows: ActivationRecord[]): EngineEvent => ({
    type: 'select',
    round,
    step,
    active: rows.filter((a) => !a.skipped).map(toView),
    skipped: rows.filter((a) => a.skipped).map(toView),
  });
  if (existing.length > 0) return { rows: existing, created: false, event: eventOf(existing) };
  // History of completed steps only: an interrupted or crashed selection of this step did not act.
  const lastActivation: Partial<Record<CharId, LastActivation>> = {};
  for (const a of rt.records.activations(rt.sessionId)) {
    if (a.skipped) continue;
    if (a.round > round || (a.round === round && stepOfSelectId(a.selectId) >= step)) continue;
    const prev = lastActivation[a.charId];
    if (!prev || a.round > prev.round || (a.round === prev.round && a.version > prev.version)) lastActivation[a.charId] = { round: a.round, version: a.version };
  }
  const ledger = syncLedger(rt);
  log(rt, 'ledger_used', { use: 'select', selectId, round, step, epoch: session.epoch, controlSeq: session.controlSeq, hash: ledgerHash(ledger), items: ledger.items.length }, selectId);
  const result = schedule({
    state,
    config: rt.config,
    personas: schedulerPersonas(rt),
    addressed: addressedThisRound(rt, round),
    lastActivation,
    events: rt.harness.repo.listEvents(rt.sessionId).map((e) => ({ version: e.version, kind: e.kind })),
    step,
    pending: candidatesOf(ledger, state, round, step),
  });
  const rows = [...result.active.map((c) => ({ c, skipped: false })), ...result.skipped.map((c) => ({ c, skipped: true }))].map(({ c, skipped }, ord) => ({
    sessionId: rt.sessionId,
    selectId,
    round,
    epoch: session.epoch,
    version: state.version,
    ord,
    charId: c.charId,
    tier: c.tier,
    reason: c.reason,
    agendaIds: c.agendaIds,
    skipped,
  }));
  rt.records.insertActivations(rows);
  const stored = rt.records.activations(rt.sessionId, { selectId });
  return { rows: stored, created: true, event: eventOf(stored) };
}

/**
 * The selection GENERATE uses: this step's selection of this epoch, else this step's latest (a regeneration after
 * an amendment or a deadlock decision keeps the step's activations), else a new SELECT. Never a selection of an
 * earlier step: a later step of the same round cannot reuse a stale selection.
 */
function currentSelection(rt: Runtime): ActivationRecord[] {
  const round = stateOf(rt).round;
  const epoch = sessionOf(rt).epoch;
  const step = currentStep(rt, round);
  const own = rt.records.activations(rt.sessionId, { selectId: `${stepId(round, step)}.e${epoch}` });
  if (own.length > 0) return own;
  const ofStep = rt.records.activations(rt.sessionId, { round }).filter((a) => stepOfSelectId(a.selectId) === step && a.selectId.startsWith(`${stepId(round, step)}.`));
  if (ofStep.length > 0) {
    const latestEpoch = Math.max(...ofStep.map((a) => a.epoch));
    return ofStep.filter((a) => a.epoch === latestEpoch);
  }
  const selected = selectStep(rt);
  if (selected.created) emit(rt, selected.event);
  return selected.rows;
}

// ---------------------------------------------------------------------------------------------------------------
// 4–6 GENERATE, CHECK, ASSESS
// ---------------------------------------------------------------------------------------------------------------

function dialogueRows(rt: Runtime): DialogueRow[] {
  return rt.harness.repo.listDialogue(rt.sessionId) as DialogueRow[];
}

interface CallOptions {
  state: WorldState;
  round: number;
  epoch: number;
  callTag: string;
  signal: AbortSignal;
  agendaIds: string[];
  /** The character's interaction view (from the step's ledger; feedback included). */
  interaction: InteractionContextView | null;
  revision?: RevisionItem[];
}

interface CallOutcome {
  actor: CharId;
  result: CharacterTurnResult | null;
  status: 'ok' | 'format_error' | 'error';
  errorKind: string | null;
  errorMessage: string | null;
  drafts: ProposalDraft[];
  callTag: string;
  /** Item ids the context supplied (recorded with the turn). */
  supplied: string[];
}

async function callCharacter(rt: Runtime, charId: CharId, opts: CallOptions, allowFault: boolean): Promise<CallOutcome> {
  if (allowFault && takeFault(rt, 'llm_timeout', opts.round, charId)) {
    return { actor: charId, result: null, status: 'error', errorKind: 'timeout', errorMessage: 'injected llm_timeout fault', drafts: [], callTag: opts.callTag, supplied: [] };
  }
  const result = await runCharacterTurn({
    client: rt.client,
    content: rt.content,
    config: rt.config,
    state: opts.state,
    charId,
    lang: rt.lang,
    variant: rt.mode === 'baseline' ? 'baseline' : 'harness',
    identity: identity(rt, opts.round, opts.epoch, opts.callTag),
    persona: rt.personas[charId],
    dialogue: dialogueRows(rt),
    interaction: opts.interaction,
    activeAgendaIds: opts.agendaIds,
    names: rt.names,
    signal: opts.signal,
    ...(opts.revision ? { revision: opts.revision } : {}),
  });
  if (result.citeErrors > 0 || result.invalidActions.length > 0) {
    log(rt, 'check', { actor: charId, callTag: opts.callTag, citeErrors: result.citeErrors, strippedCites: result.strippedCites, invalidActions: result.invalidActions });
  }
  return {
    actor: charId,
    result,
    status: result.status,
    errorKind: result.llm.errorKind,
    errorMessage: result.llm.errorMessage,
    drafts: result.drafts,
    callTag: opts.callTag,
    supplied: result.supplied,
  };
}

/**
 * The recorded turn of an actor in a step (PLAN §10.4): the final outcome (after retries / a REVISE call), the item
 * ids its context showed, the interaction metadata and speech as output, the raw text, and its proposal ids.
 */
function turnRecord(rt: Runtime, batchId: string, round: number, step: number, epoch: number, o: CallOutcome, skipped: boolean, proposalIds: string[]): TurnRecord {
  const r = o.result;
  const status: TurnRecord['status'] = skipped ? 'skipped' : o.status;
  return {
    sessionId: rt.sessionId,
    turnId: `${batchId}:${o.actor}`,
    batchId,
    round,
    step,
    epoch,
    actor: o.actor,
    status,
    callTag: o.callTag,
    supplied: o.supplied,
    interaction: status === 'ok' ? (r?.interaction ?? null) : null,
    speech: status === 'ok' ? (r?.speech ?? '') : '',
    raw: status === 'ok' ? (r?.llm.raw ?? null) : null,
    proposalIds,
  };
}

function batchLive(rt: Runtime, batchId: string, epoch: number): boolean {
  const batch = rt.harness.repo.findBatch(batchId);
  return batch !== null && batch.status === 'generating' && sessionOf(rt).epoch === epoch;
}

function toInput(d: ProposalDraft, formatError: boolean): ProposalInput {
  return { actor: d.actor, action: d.action, source: 'llm', rationale: d.rationale, cites: d.cites, askPlayer: d.askPlayer, formatError };
}

/** Player-side drafts the Judge assesses (speech and plain waiting are not proposals of consequence). */
function judgeable(rt: Runtime, state: WorldState, d: ProposalDraft): boolean {
  if (!isPlayerSide(state, rt.config, d.actor)) return false;
  if (d.action.type === 'speak') return false;
  return d.action.type !== 'wait' || d.askPlayer !== null;
}

/** Suspends the run (batch and pauses preserved); headless runs then stop with the execution outcome. */
export function limitStep(rt: Runtime, limit: LimitReached, stop: boolean): void {
  const session = sessionOf(rt);
  if (session.status !== 'suspended' && session.status !== 'stopped') {
    rt.harness.suspend(rt.sessionId, limit.reason, `suspend.${session.controlSeq}`);
  }
  const stopReason = stopReasonOf(rt, limit);
  log(rt, 'suspended', { ...limit, stopReason, position: executionPosition(rt) });
  emit(rt, { type: 'suspended', reason: limit.reason });
  if (stop && sessionOf(rt).status !== 'stopped') {
    rt.harness.stop(rt.sessionId, limit.outcome, `stop.${sessionOf(rt).controlSeq}`);
    recordRunStop(rt, limit.outcome, stopReason, limit.reason);
  }
}

/** Where the run is (recovery position): round, step, world version, epoch. */
export function executionPosition(rt: Runtime): { round: number; step: number; version: number; epoch: number } {
  const state = stateOf(rt);
  return { round: state.round, step: currentStep(rt, state.round), version: state.version, epoch: sessionOf(rt).epoch };
}

/**
 * An execution stop (never a world terminal, PLAN §8.4): the outcome, the limit that stopped the run, the position,
 * and the interaction items still unresolved. Logged once.
 */
export function recordRunStop(rt: Runtime, outcome: string, stopReason: StopReason, detail: string | null): void {
  const ledger = syncLedger(rt);
  const unresolved = ledger.items.filter((i) => i.status !== 'resolved' && i.status !== 'obsolete');
  log(
    rt,
    'run_stop',
    {
      outcome,
      stopReason,
      detail,
      position: executionPosition(rt),
      worldTerminal: stateOf(rt).terminal?.kind ?? null,
      unresolved: unresolved.map((i) => ({ id: i.itemId, kind: i.kind, responsible: i.responsible, status: i.status, since: `r${i.created.round}.s${i.created.step}` })),
    },
    'run_stop',
  );
}

/**
 * Opens an error_recovery pause for a failed call and awaits the decision. `superseded` when the pause was
 * obsoleted (interrupt) or the epoch changed while the decision was awaited — the answer is then discarded.
 */
async function recoverCall(
  rt: Runtime,
  spec: { batchId: string | null; liveBatchId: string; epoch: number; requestId: string; actor: string; reason: string },
  attempt: number,
): Promise<'retry' | 'skip_actor' | 'stop' | 'superseded'> {
  const { pauseId } = rt.harness.openPause(
    rt.sessionId,
    { batchId: spec.batchId, category: 'error_recovery', proposalIds: [], actor: spec.actor as CharId, reason: spec.reason },
    spec.requestId,
  );
  const pause = rt.harness.repo.findPause(pauseId) as PauseRecord;
  emit(rt, { type: 'pause', pause });
  const choice = await rt.decisions.decide(decisionContext(rt, pause));
  if (expired(rt)) throw new LimitSignal(WALL_CLOCK);
  const fresh = rt.harness.repo.findPause(pauseId);
  if (fresh?.status !== 'open' || sessionOf(rt).epoch !== spec.epoch || !batchLive(rt, spec.liveBatchId, spec.epoch)) {
    log(rt, 'decision_discarded', { pauseId, reason: 'superseded while the decision was awaited', option: choice.option });
    emit(rt, { type: 'discarded', pauseId, reason: 'superseded' });
    // A batch-less pause (Judge) is not obsoleted by the interrupt: close it without effect.
    if (fresh?.status === 'open') rt.harness.resolvePause(rt.sessionId, pauseId, { option: 'skip_actor', by: 'policy', advice: 'superseded by an interrupt' }, `d:${pauseId}:0`);
    return 'superseded';
  }
  let option = choice.option;
  let note = choice.note ?? null;
  if (option === 'retry' && attempt >= rt.maxRetries) {
    option = 'skip_actor';
    note = `retry limit (${rt.maxRetries}) reached: skip_actor`;
  }
  if (option !== 'retry' && option !== 'skip_actor' && option !== 'stop') option = 'retry';
  const res = rt.harness.resolvePause(rt.sessionId, pauseId, { option, by: choice.by ?? 'policy', advice: choice.advice ?? null }, `d:${pauseId}:0`);
  log(rt, 'decision', { pauseId, category: 'error_recovery', option, note, actor: spec.actor, status: res.status });
  emit(rt, { type: 'decision', pauseId, category: 'error_recovery', option, note, replayed: res.replayed });
  return option;
}

function defaultedVerdicts(proposals: readonly JudgeProposalInput[], reason: string): JudgeVerdict[] {
  return proposals.map((p) => ({ proposalId: p.proposalId, verdict: 'CONTINUE', category: null, reason, question: null, sanitized: false, defaulted: true }));
}

/**
 * GENERATE → CHECK → (Judge) → submit → ASSESS → (COMMIT when no pause). Returns a limit when the budget or the
 * wall clock ran out (the caller suspends), `stopped` when an error_recovery decision stopped the run.
 */
type JudgeRef = { judgeId: string; realProposalId: string | null; revisionId: string | null };

/**
 * Real ids of a Judge draft id (`judge:<actor>:<i>` = the actor's i-th draft of the batch; `judge:<actor>:rev<i>` =
 * its i-th REVISE replacement), derived ONLY from stored records: the harness proposals of the batch (each actor's
 * drafts are submitted in order, so draft i is the actor's proposal with seq i+1) and the REVISE envelopes
 * (`rev:<batch>:<actor>:o<i>` / `r<i>`). A revised original was never submitted (`realProposalId` null).
 */
function resolveJudgeRef(
  judgeId: string,
  batchId: string,
  proposals: readonly ProposalRecord[],
  revisions: readonly RevisionRecord[],
): JudgeRef {
  const m = /^judge:([a-z_]+):(rev)?(\d+)$/.exec(judgeId);
  if (!m || m[1] === undefined || m[3] === undefined) return { judgeId, realProposalId: null, revisionId: null };
  const actor = m[1];
  const i = Number(m[3]);
  const bySeq = (): string | null => proposals.find((p) => p.actor === actor && p.seq === i + 1 && p.source === 'llm')?.proposalId ?? null;
  if (m[2]) {
    const rev = revisions.find((r) => r.batchId === batchId && r.actor === actor && r.kind === 'replacement' && r.index === i);
    if (!rev) return { judgeId, realProposalId: null, revisionId: null };
    return { judgeId, realProposalId: rev.links.proposalId ?? (rev.status === 'final' ? bySeq() : null), revisionId: rev.revisionId };
  }
  const orig = revisions.find((r) => r.batchId === batchId && r.actor === actor && r.kind === 'original' && r.index === i);
  const submitted = !orig || orig.status === 'revision_failed';
  return { judgeId, realProposalId: submitted ? bySeq() : null, revisionId: orig?.revisionId ?? null };
}

/**
 * Completes Judge log records (`judge`, `judge_skipped`) with `realProposalId` / `revisionId` on every verdict and
 * `defaultedRefs` / `missRefs`, from the stored proposals and revisions. Idempotent; called in the same transaction
 * as the submission and every REVISE record write, and on recovery (backfill of records written before a crash).
 */
export function linkJudgeLogs(rt: Runtime, onlyBatchId: string | null = null): number {
  let updated = 0;
  const revisions = rt.records.revisions(rt.sessionId);
  const proposalsOf = new Map<string, ProposalRecord[]>();
  for (const entry of rt.records.logs(rt.sessionId)) {
    if (entry.kind !== 'judge' && entry.kind !== 'judge_skipped') continue;
    const data = entry.data as Record<string, unknown>;
    const batchId = typeof data.batchId === 'string' ? data.batchId : null;
    if (!batchId || (onlyBatchId !== null && batchId !== onlyBatchId)) continue;
    let proposals = proposalsOf.get(batchId);
    if (!proposals) {
      proposals = rt.harness.repo.listProposals(batchId);
      proposalsOf.set(batchId, proposals);
    }
    const ref = (j: string): JudgeRef => resolveJudgeRef(j, batchId, proposals as ProposalRecord[], revisions);
    const verdicts = Array.isArray(data.verdicts) ? (data.verdicts as Array<{ proposalId: string }>) : [];
    const next: Record<string, unknown> = {
      ...data,
      verdicts: verdicts.map((v) => {
        const r = ref(v.proposalId);
        return { ...v, realProposalId: r.realProposalId, revisionId: r.revisionId };
      }),
    };
    if (Array.isArray(data.defaulted)) next.defaultedRefs = (data.defaulted as string[]).map(ref);
    if (Array.isArray(data.misses)) next.missRefs = (data.misses as string[]).map(ref);
    if (JSON.stringify(next) !== JSON.stringify(data)) {
      rt.records.updateLogData(entry.id, next);
      updated += 1;
    }
  }
  return updated;
}

export async function generateStep(rt: Runtime): Promise<StepSignal | LimitReached> {
  const { signal, dispose } = callSignal(rt);
  try {
    return await generate(rt, signal);
  } catch (err) {
    if (err instanceof LimitSignal) return err.limit;
    if (err instanceof StopSignal) return 'stopped';
    if (err instanceof SupersededSignal) return 'continue';
    throw err;
  } finally {
    dispose();
  }
}

async function generate(rt: Runtime, signal: AbortSignal): Promise<StepSignal | LimitReached> {
  const selectionRows = currentSelection(rt);
  const selection = selectionRows.filter((a) => !a.skipped);
  const state = stateOf(rt);
  const round = state.round;
  const step = currentStep(rt, round);
  const generation = rt.harness.repo.listBatches(rt.sessionId).filter((b) => b.kind === 'character' && b.round === round).length;
  const epoch = sessionOf(rt).epoch;
  // Every request id carries the round, the interaction step, the epoch and the batch generation.
  const prefix = `${stepId(round, step)}.e${epoch}.b${generation}`;
  if (takeFault(rt, 'budget_exhausted', round, null)) return { outcome: 'budget_exhausted', reason: 'injected budget_exhausted fault', stopReason: 'call_budget' };
  const selectId = selectionRows[0]?.selectId ?? `${stepId(round, step)}.e${epoch}`;
  const opened = rt.harness.store.transaction(() => {
    const o = rt.harness.openCharacterBatch(rt.sessionId, `${prefix}.open`);
    rt.records.insertStep({ sessionId: rt.sessionId, batchId: o.batchId, stepId: stepId(round, step), round, step, epoch: o.epoch, selectId });
    return o;
  });
  const batchId = opened.batchId;
  await hook(rt, 'generate:opened');
  // Contexts of this step read the ledger derived from everything committed before it (never a parallel turn).
  const ledger = syncLedger(rt);
  const at = sessionOf(rt);
  log(rt, 'ledger_used', { use: 'context', selectId, batchId, round, step, epoch, controlSeq: at.controlSeq, hash: ledgerHash(ledger), items: ledger.items.length }, `ctx:${prefix}`);
  const views = new Map<CharId, InteractionContextView>();
  for (const a of selection) {
    views.set(a.charId, interactionViewFor(ledger, a.charId, { state, round, step, maxSteps: rt.maxStepsPerRound, activation: { tier: a.tier, reason: a.reason } }));
  }
  const refusalsBefore = rt.client.budgetRefusals;
  const checkLimits = (): void => {
    if (expired(rt)) throw new LimitSignal(WALL_CLOCK);
    if (rt.client.budgetRefusals > refusalsBefore) throw new LimitSignal(BUDGET);
  };

  // Parallel character calls (the scripted `generate` interrupt fires after N completed calls).
  const interrupt = pendingInterrupt(rt, round, 'generate', step);
  let completed = 0;
  const base: Omit<CallOptions, 'agendaIds' | 'interaction'> = { state, round, epoch, callTag: `char.s${step}.g${generation}`, signal };
  const viewOf = (c: CharId): InteractionContextView | null => views.get(c) ?? null;
  const outcomes = await Promise.all(
    selection.map(async (a) => {
      const out = await callCharacter(rt, a.charId, { ...base, agendaIds: a.agendaIds, interaction: viewOf(a.charId) }, true);
      completed += 1;
      if (interrupt && completed === (interrupt.spec.afterCalls ?? 1) && batchLive(rt, batchId, epoch)) fireInterrupt(rt, interrupt);
      return out;
    }),
  );
  await hook(rt, 'generate:called');

  const byActor = new Map<CharId, CallOutcome>(outcomes.map((o) => [o.actor, o]));
  if (!batchLive(rt, batchId, epoch)) {
    // Interrupted (or superseded): whatever arrived is recorded as stale_epoch for the audit trail; the turns are
    // kept too but, their batch never committing, have no effect on the interaction ledger.
    rt.harness.store.transaction(() => {
      const ordered = outcomes.flatMap((o) => o.drafts.map((d) => ({ actor: o.actor, input: toInput(d, o.status === 'format_error') })));
      const late = ordered.length > 0 ? rt.harness.submitProposals(rt.sessionId, batchId, ordered.map((x) => x.input), `${prefix}.submit`) : null;
      for (const o of outcomes) {
        const ids = ordered.flatMap((x, i) => (x.actor === o.actor && late?.proposalIds[i] ? [late.proposalIds[i] as string] : []));
        rt.records.insertTurn(turnRecord(rt, batchId, round, step, epoch, o, false, ids));
      }
    });
    return 'continue';
  }
  checkLimits();

  // Failed calls: error_recovery pause per actor (retry / skip_actor / stop).
  for (const charId of CHAR_IDS) {
    let current = byActor.get(charId);
    let attempt = 0;
    while (current && current.status === 'error' && current.errorKind !== 'aborted') {
      const option = await recoverCall(
        rt,
        { batchId, liveBatchId: batchId, epoch, requestId: `${prefix}.err.${charId}.${attempt}`, actor: charId, reason: `${current.errorKind ?? 'error'}: ${current.errorMessage ?? ''}` },
        attempt,
      );
      if (option === 'superseded') return 'continue';
      if (option === 'stop') return 'stopped';
      if (option === 'skip_actor') {
        byActor.set(charId, { ...current, drafts: [], status: 'error', errorKind: 'skipped' });
        break;
      }
      attempt += 1;
      const agendaIds = selection.find((a) => a.charId === charId)?.agendaIds ?? [];
      current = await callCharacter(rt, charId, { ...base, agendaIds, interaction: viewOf(charId), callTag: `char.s${step}.g${generation}.retry${attempt}` }, false);
      byActor.set(charId, current);
      if (!batchLive(rt, batchId, epoch)) return 'continue';
      checkLimits();
    }
  }

  const finalDrafts = new Map<CharId, ProposalDraft[]>();
  const formatErrors = new Set<CharId>();
  const finalOutcome = new Map<CharId, CallOutcome>();
  for (const a of selection) {
    const o = byActor.get(a.charId);
    if (o) finalOutcome.set(a.charId, o);
    if (!o || o.errorKind === 'skipped') continue;
    finalDrafts.set(a.charId, o.drafts);
    if (o.status === 'format_error') formatErrors.add(a.charId);
  }

  // Judge (full mode) with the REVISE loop, before submission.
  const tempIds = new Map<ProposalDraft, string>();
  const revisions: RevisionRecord[] = [];
  let verdicts: JudgeVerdict[] = [];
  if (rt.mode === 'full') {
    const judged: JudgeProposalInput[] = [];
    for (const [actor, drafts] of finalDrafts) {
      drafts.forEach((d, i) => {
        if (!judgeable(rt, state, d)) return;
        const id = `judge:${actor}:${i}`;
        tempIds.set(d, id);
        judged.push({ proposalId: id, actor, action: d.action, askPlayer: d.askPlayer });
      });
    }
    if (judged.length > 0) {
      const revised = new Map<CharId, { drafts: ProposalDraft[]; callTag: string; items: Array<{ proposalId: string; verdict: JudgeVerdict }> }>();
      const assess = async (proposals: readonly JudgeProposalInput[], reassessment: boolean): Promise<JudgeVerdict[]> => {
        const tag = `${reassessment ? 'rejudge' : 'judge'}.s${step}.g${generation}`;
        for (let attempt = 0; ; attempt++) {
          const injected = attempt === 0 && !reassessment && takeFault(rt, 'llm_timeout', round, 'judge');
          const r = injected
            ? null
            : await runJudge({
                client: rt.client,
                content: rt.content,
                config: rt.config,
                state,
                proposals,
                lang: rt.lang,
                identity: identity(rt, round, epoch, attempt === 0 ? tag : `${tag}.retry${attempt}`),
                dialogue: dialogueRows(rt),
                names: rt.names,
                reassessment,
                signal,
              });
          const errorKind = r ? r.llm.errorKind : 'timeout';
          const status = r ? r.status : 'error';
          const session = sessionOf(rt);
          // Appended and linked (real proposal / revision ids available now) in one transaction, before any
          // limit check or error recovery: no exit path depends on a later finalization.
          rt.harness.store.transaction(() => {
            rt.records.appendLog(rt.sessionId, session.round, session.epoch, 'judge', {
              batchId,
              reassessment,
              attempt,
              status,
              errorKind,
              injected: injected ? 'llm_timeout' : null,
              verdicts: r?.verdicts ?? [],
              defaulted: (r?.verdicts ?? []).filter((v) => v.defaulted).map((v) => v.proposalId),
              unknownIds: r?.unknownIds ?? [],
            });
            linkJudgeLogs(rt, batchId);
          });
          if (!batchLive(rt, batchId, epoch)) throw new SupersededSignal();
          checkLimits();
          if (r && status !== 'error') return r.verdicts; // ok, or format_error ⇒ defaulted CONTINUE (logged as misses)
          if (errorKind === 'aborted') throw new SupersededSignal();
          const option = await recoverCall(
            rt,
            {
              batchId: null,
              liveBatchId: batchId,
              epoch,
              requestId: `${prefix}.err.judge${reassessment ? '.re' : ''}.${attempt}`,
              actor: 'judge',
              reason: `judge ${errorKind ?? 'error'}: ${r?.llm.errorMessage ?? 'injected fault'}`,
            },
            attempt,
          );
          if (option === 'superseded') throw new SupersededSignal();
          if (option === 'stop') throw new StopSignal();
          if (option === 'skip_actor') {
            const skipped = defaultedVerdicts(proposals, 'judge skipped after an error (not assessed)');
            const session = sessionOf(rt);
            rt.harness.store.transaction(() => {
              rt.records.appendLog(rt.sessionId, session.round, session.epoch, 'judge_skipped', { batchId, reassessment, misses: skipped.map((v) => v.proposalId), verdicts: skipped });
              linkJudgeLogs(rt, batchId);
            });
            return skipped;
          }
        }
      };
      // REVISE envelopes are persisted as the loop progresses (they survive a stop, an error or a crash): originals
      // before the revision call (`revising`), then `replaced` / `revision_failed`; replacements before the
      // re-assessment (`pending_reassessment`), then `final`. Never executed.
      const envelope = (d: ProposalDraft, callTag: string): RevisionRecord['envelope'] => ({
        action: d.action,
        rationale: d.rationale,
        cites: d.cites,
        askPlayer: d.askPlayer,
        seq: d.seq,
        callTag,
      });
      const row = (actor: CharId, kind: RevisionRecord['kind'], index: number, rest: Pick<RevisionRecord, 'envelope' | 'verdict' | 'links' | 'status'>): RevisionRecord => ({
        revisionId: `rev:${batchId}:${actor}:${kind === 'original' ? 'o' : 'r'}${index}`,
        sessionId: rt.sessionId,
        batchId,
        round,
        epoch,
        actor,
        kind,
        index,
        ...rest,
      });
      const flow = await judgeWithRevision({
        proposals: judged,
        assess,
        revise: async (actor, items) => {
          if (!isChar(actor)) return null;
          const originals = finalDrafts.get(actor) ?? [];
          const originalTag = byActor.get(actor)?.callTag ?? `char.s${step}.g${generation}`;
          const origIds = originals.map((_d, i) => `rev:${batchId}:${actor}:o${i}`);
          const writeOriginals = (status: RevisionRecord['status'], replacedBy: string[]): void => {
            originals.forEach((d, i) => {
              const verdict = items.find((it) => it.proposal.proposalId === tempIds.get(d))?.verdict ?? null;
              rt.records.insertRevision(row(actor, 'original', i, { envelope: envelope(d, originalTag), verdict, links: { replacedBy }, status }));
            });
          };
          const atomically = (fn: () => void): void =>
            rt.harness.store.transaction(() => {
              fn();
              linkJudgeLogs(rt, batchId);
            });
          atomically(() => writeOriginals('revising', []));
          const agendaIds = selection.find((a) => a.charId === actor)?.agendaIds ?? [];
          const callTag = `rev.s${step}.g${generation}`;
          const out = await callCharacter(
            rt,
            actor,
            {
              ...base,
              agendaIds,
              interaction: viewOf(actor),
              callTag,
              revision: items.map((i) => ({ action: i.proposal.action, reason: i.verdict.reason, category: i.verdict.category })),
            },
            false,
          );
          if (!batchLive(rt, batchId, epoch)) throw new SupersededSignal();
          checkLimits();
          if (out.status !== 'ok') {
            atomically(() => writeOriginals('revision_failed', []));
            return null;
          }
          const replIds = out.drafts.map((_d, i) => `rev:${batchId}:${actor}:r${i}`);
          atomically(() => {
            out.drafts.forEach((d, i) => {
              rt.records.insertRevision(row(actor, 'replacement', i, { envelope: envelope(d, callTag), verdict: null, links: { replaces: origIds, proposalId: null }, status: 'pending_reassessment' }));
            });
            writeOriginals('replaced', replIds);
          });
          revised.set(actor, { drafts: out.drafts, callTag, items: items.map((i) => ({ proposalId: i.proposal.proposalId, verdict: i.verdict })) });
          // The revision's output (speech, metadata, raw text) is the turn's final recorded output.
          finalOutcome.set(actor, out);
          const replacements: JudgeProposalInput[] = [];
          out.drafts.forEach((d, i) => {
            if (!judgeable(rt, state, d)) return;
            const id = `judge:${actor}:rev${i}`;
            tempIds.set(d, id);
            replacements.push({ proposalId: id, actor, action: d.action, askPlayer: d.askPlayer });
          });
          return replacements;
        },
      });
      rt.harness.store.transaction(() => {
        for (const [actor, rev] of revised) {
          const origIds = (finalDrafts.get(actor) ?? []).map((_d, i) => `rev:${batchId}:${actor}:o${i}`);
          rev.drafts.forEach((d, i) => {
            const verdict = flow.verdicts.find((v) => v.proposalId === tempIds.get(d)) ?? null;
            const final = row(actor, 'replacement', i, { envelope: envelope(d, rev.callTag), verdict, links: { replaces: origIds, proposalId: null }, status: 'final' });
            rt.records.insertRevision(final);
            revisions.push(final);
          });
        }
        linkJudgeLogs(rt, batchId);
      });
      for (const [actor, rev] of revised) finalDrafts.set(actor, rev.drafts);
      verdicts = flow.verdicts;
      emit(rt, { type: 'judge', batchId, verdicts: verdicts.map((v) => ({ proposalId: v.proposalId, verdict: v.verdict, category: v.category })) });
    }
    if (!batchLive(rt, batchId, epoch)) return 'continue';
    checkLimits();
  }

  // Submit (proposal ids are assigned in submission order).
  const ordered: Array<{ draft: ProposalDraft; formatError: boolean }> = [];
  for (const a of selection) {
    for (const d of finalDrafts.get(a.charId) ?? []) ordered.push({ draft: d, formatError: formatErrors.has(a.charId) });
  }
  const submit = rt.harness.store.transaction(() => {
    const result = rt.harness.submitProposals(rt.sessionId, batchId, ordered.map((o) => toInput(o.draft, o.formatError)), `${prefix}.submit`);
    // Link each REVISE replacement to the proposal it became, and every Judge verdict to its real ids.
    for (const r of revisions) {
      if (r.kind !== 'replacement') continue;
      const index = ordered.findIndex((o) => o.draft.actor === r.actor && o.draft === (finalDrafts.get(r.actor as CharId) ?? [])[r.index]);
      rt.records.insertRevision({ ...r, links: { ...r.links, proposalId: result.proposalIds[index] ?? null } });
    }
    linkJudgeLogs(rt, batchId);
    // The step's turns (recorded outputs), atomically with their proposals.
    for (const a of selection) {
      const o = finalOutcome.get(a.charId);
      if (!o) continue;
      const ids = ordered.flatMap((x, i) => (x.draft.actor === a.charId && result.proposalIds[i] ? [result.proposalIds[i] as string] : []));
      rt.records.insertTurn(turnRecord(rt, batchId, round, step, epoch, o, o.errorKind === 'skipped', ids));
    }
    return result;
  });
  emit(rt, {
    type: 'proposals',
    batchId,
    accepted: submit.accepted,
    proposals: ordered.map((o, i) => ({ proposalId: submit.proposalIds[i] ?? '?', actor: o.draft.actor, type: o.draft.action.type })),
  });
  await hook(rt, 'generate:submitted');
  if (!submit.accepted) return 'continue';

  const semantic: SemanticPauseInput[] = [];
  const realId = new Map<string, string>();
  ordered.forEach((o, i) => {
    const temp = tempIds.get(o.draft);
    const id = submit.proposalIds[i];
    if (temp && id) realId.set(temp, id);
  });
  for (const v of verdicts) {
    if (v.verdict !== 'PAUSE' || v.category === null) continue;
    const id = realId.get(v.proposalId);
    if (!id) continue;
    const q = v.question ?? v.reason;
    semantic.push({ category: v.category, proposalIds: [id], question: { zh: q, en: q } });
  }

  const assessInterrupt = pendingInterrupt(rt, round, 'assess', step);
  if (assessInterrupt) {
    fireInterrupt(rt, assessInterrupt);
    return 'continue';
  }
  await hook(rt, 'assess');
  if (!batchLive(rt, batchId, epoch)) return 'continue';
  checkLimits();
  const assessed = rt.harness.assess(rt.sessionId, batchId, `${prefix}.assess`, semantic);
  log(rt, 'assess', { batchId, status: assessed.status, pauseIds: assessed.pauseIds, semantic: semantic.length });
  for (const id of assessed.pauseIds) {
    const pause = rt.harness.repo.findPause(id);
    if (pause) emit(rt, { type: 'pause', pause });
  }
  if (assessed.status === 'assessed') {
    checkLimits();
    await commitStep(rt, rt.harness.repo.getBatch(batchId));
  }
  return 'continue';
}

// ---------------------------------------------------------------------------------------------------------------
// 7 DECIDE
// ---------------------------------------------------------------------------------------------------------------

function executable(proposals: readonly ProposalRecord[]): BatchProposal[] {
  return proposals
    .filter((p) => ['pending', 'committed', 'rejected', 'withheld', 'unapplied'].includes(p.status))
    .map((p) => ({ proposalId: p.proposalId, actor: p.actor, seq: p.seq, action: p.action, askPlayer: p.askPlayer, source: p.source }));
}

function batchDecisions(decisions: readonly DecisionRecord[]): BatchDecision[] {
  return decisions
    .filter((d) => d.option !== 'ask')
    .map((d) => ({
      decisionId: d.decisionId,
      category: d.category,
      option: d.option,
      proposalIds: d.proposalIds,
      pair: d.pair,
      authorization: d.payload.authorization,
      goalLimits: d.payload.goalLimits,
    }));
}

export function decisionContext(rt: Runtime, pause: PauseRecord): DecisionContext {
  const state = stateOf(rt);
  const batch = pause.batchId ? rt.harness.repo.findBatch(pause.batchId) : null;
  const all = batch ? rt.harness.repo.listProposals(batch.batchId) : [];
  const proposals = all.filter((p) => pause.proposalIds.includes(p.proposalId));
  const decisions = batch ? rt.harness.repo.listDecisions(batch.batchId) : rt.harness.repo.listSessionDecisions(rt.sessionId);
  const within =
    batch && batch.kind === 'character'
      ? pausedWithinLimits(state, rt.config, rt.mode, executable(all), batchDecisions(decisions), pause.proposalIds)
      : { within: undefined, unknown: [] };
  return {
    sessionId: rt.sessionId,
    mode: rt.mode,
    lang: rt.lang,
    round: state.round,
    pause,
    proposals,
    state,
    config: rt.config,
    withinLimits: within.within,
    termsUnknown: within.unknown,
    asked: decisions.filter((d) => d.pauseId === pause.id && d.option === 'ask').length,
    askable: askableCharacters(rt, state, proposals.map((p) => p.actor)),
  };
}

/**
 * Who may be asked during a pause: living characters present at the player's scene, the paused proposals' actors
 * first. An offstage paused actor (e.g. a remote court's `ask_player`) cannot be asked: the clerk can only speak to
 * those in the room (PLAN §7).
 */
export function askableCharacters(rt: Runtime, state: WorldState, pausedActors: readonly string[]): CharId[] {
  const present = presentCharacters(state);
  const out: CharId[] = [];
  for (const a of pausedActors) if (isChar(a) && present.includes(a) && !out.includes(a)) out.push(a);
  for (const c of present) if (!out.includes(c)) out.push(c);
  return out;
}

/** The answerer of an `ask`: the named character if askable, else the paused actor, else the player's principal. */
function answererOf(rt: Runtime, state: WorldState, askable: readonly CharId[], to: CharId | null | undefined): { charId: CharId; rejected: string | null } {
  if (to && askable.includes(to)) return { charId: to, rejected: null };
  const principal = rt.config.factions[BESIEGED_FACTION].principal;
  const fallback = askable[0] ?? principal;
  return { charId: fallback, rejected: to ? `${to} cannot be asked now (not present or not alive)` : null };
}

/** The harness payload of a choice (provenance fields stay in the engine log). */
function decisionInput(choice: DecisionChoice): DecisionInput {
  const input: DecisionInput = { option: choice.option, by: choice.by ?? 'user' };
  if (choice.advice !== undefined) input.advice = choice.advice;
  if (choice.authorization !== undefined) input.authorization = choice.authorization;
  if (choice.goalLimits !== undefined) input.goalLimits = choice.goalLimits;
  if (choice.amend !== undefined) input.amend = choice.amend;
  if (choice.counterTerms !== undefined) input.counterTerms = choice.counterTerms;
  return input;
}

/**
 * Resolves the oldest open pause (policy or UI). The answer is discarded if, while it was awaited, the pause was
 * obsoleted or the epoch changed (interrupt); the new continuation is then followed.
 */
export async function decideStep(rt: Runtime): Promise<StepSignal | LimitReached> {
  const pause = rt.harness.openPauses(rt.sessionId)[0];
  if (!pause) return 'continue';
  const round = stateOf(rt).round;
  const epoch = sessionOf(rt).epoch;
  const batch = pause.batchId ? rt.harness.repo.findBatch(pause.batchId) : null;
  if (batch?.kind === 'character') {
    const pending = pendingInterrupt(rt, round, 'decide', currentStep(rt, round));
    if (pending) {
      fireInterrupt(rt, pending);
      return 'continue';
    }
  }
  // An `ask` recorded before a crash or suspension gets its answer first (never a second call for one decision).
  const pendingAsk = pendingAnswer(rt, pause.id);
  if (pendingAsk) return answerStep(rt, pause, pendingAsk, epoch);
  await hook(rt, 'decide');
  const ctx = decisionContext(rt, pause);
  const choice = await rt.decisions.decide(ctx);
  if (expired(rt)) return WALL_CLOCK;
  const fresh = rt.harness.repo.findPause(pause.id);
  if (fresh?.status !== 'open' || sessionOf(rt).epoch !== epoch) {
    log(rt, 'decision_discarded', { pauseId: pause.id, category: pause.category, option: choice.option, status: fresh?.status ?? null, epochBefore: epoch, epochNow: sessionOf(rt).epoch });
    emit(rt, { type: 'discarded', pauseId: pause.id, reason: `pause ${fresh?.status ?? 'missing'} / epoch ${sessionOf(rt).epoch}` });
    return 'continue';
  }
  if (choice.option === 'ask') return askStep(rt, pause, ctx, choice, epoch);
  const input = decisionInput(choice);
  const requestId = `d:${pause.id}:${ctx.asked}`;
  // A decision may commit the batch: its follow-up items are derived in the same transaction.
  const res = rt.harness.store.transaction(() => {
    const r = rt.harness.resolvePause(rt.sessionId, pause.id, input, requestId);
    syncLedger(rt);
    return r;
  });
  const skippedRules = (choice as { skippedRules?: string[] }).skippedRules ?? [];
  log(rt, 'decision', {
    pauseId: pause.id,
    category: pause.category,
    option: input.option,
    by: input.by ?? 'user',
    note: choice.note ?? null,
    skippedRules,
    withinLimits: ctx.withinLimits ?? null,
    termsUnknown: ctx.termsUnknown,
    status: res.status,
    decisionId: res.decisionId,
  });
  emit(rt, { type: 'decision', pauseId: pause.id, category: pause.category, option: input.option, note: choice.note ?? null, replayed: res.replayed });
  // D3 fault: the same decision request is sent twice; H06 returns the stored result and commits nothing twice.
  if (batch?.kind === 'character' && res.status !== 'regenerated' && res.status !== 'open' && takeFault(rt, 'duplicate_request', round, 'decision')) {
    const versionBefore = stateOf(rt).version;
    const again = rt.harness.resolvePause(rt.sessionId, pause.id, input, requestId);
    const ok = again.replayed && again.decisionId === res.decisionId && stateOf(rt).version === versionBefore;
    log(rt, 'duplicate_request', { requestId, replayed: again.replayed, sameDecision: again.decisionId === res.decisionId, versionUnchanged: stateOf(rt).version === versionBefore, ok });
    if (!ok) throw new EngineError(`duplicate request ${requestId} was executed twice`);
    emit(rt, { type: 'decision', pauseId: pause.id, category: pause.category, option: input.option, note: 'duplicate request (H06 replay)', replayed: again.replayed });
  }
  for (const id of res.newPauseIds) {
    const p = rt.harness.repo.findPause(id);
    if (p) emit(rt, { type: 'pause', pause: p });
  }
  if (res.commit) emit(rt, { type: 'commit', result: res.commit });
  return res.status === 'stopped' ? 'stopped' : 'continue';
}

// ---------------------------------------------------------------------------------------------------------------
// 7b ASK: in-character answers while a decision is paused (PLAN §7)
// ---------------------------------------------------------------------------------------------------------------

interface PendingAsk {
  requestId: string;
  decisionId: string;
  question: string;
  charId: CharId;
}

/** An `ask` of this pause whose decision was recorded but whose answer was not (crash, suspension). */
function pendingAnswer(rt: Runtime, pauseId: string): PendingAsk | null {
  for (const entry of rt.records.logs(rt.sessionId, 'ask')) {
    const a = entry.data as { pauseId: string; requestId: string; question: string; to: CharId };
    if (a.pauseId !== pauseId || rt.records.hasLog(rt.sessionId, 'answer', a.requestId)) continue;
    const request = rt.harness.repo.findRequest(rt.sessionId, a.requestId);
    const decisionId = (request?.result as { decisionId?: string } | undefined)?.decisionId;
    if (decisionId) return { requestId: a.requestId, decisionId, question: a.question, charId: a.to };
  }
  return null;
}

/**
 * ASK: records the decision (the harness keeps the pause open and records the question as dialogue), addresses
 * the question to the answerer if the harness did not, then asks the character (one `answer` call). No world
 * change; scripted policies never get here.
 */
async function askStep(rt: Runtime, pause: PauseRecord, ctx: DecisionContext, choice: DecisionChoice, epoch: number): Promise<StepSignal | LimitReached> {
  // Redacted ONCE at ingestion; the sanitized question is used everywhere (log, decision, dialogue, prompt, events).
  const question = redactSecrets((choice.question ?? choice.advice ?? '').trim()) || (rt.lang === 'zh' ? '此事何如？' : 'What do you make of this?');
  const { charId, rejected } = answererOf(rt, ctx.state, ctx.askable, choice.to);
  const requestId = `d:${pause.id}:${ctx.asked}`;
  rt.records.log(rt.sessionId, ctx.round, epoch, 'ask', { pauseId: pause.id, requestId, question, to: charId, requestedTo: choice.to ?? null, rejected, by: choice.by ?? 'user' }, `ask:${requestId}`);
  const res = rt.harness.resolvePause(rt.sessionId, pause.id, { option: 'ask', advice: question, by: choice.by ?? 'user' }, requestId);
  const asked = rt.harness.repo.listDialogue(rt.sessionId).find((d) => d.decisionId === res.decisionId && d.kind === 'question');
  if (!asked?.listeners.includes(charId)) {
    rt.harness.recordDialogue(
      rt.sessionId,
      { speaker: 'player', listeners: [charId], text: question, kind: 'question', payload: { decisionId: res.decisionId, requestId, to: charId } },
      `${requestId}.q`,
    );
  }
  emit(rt, { type: 'decision', pauseId: pause.id, category: pause.category, option: 'ask', note: choice.note ?? null, replayed: res.replayed });
  return answerStep(rt, pause, { requestId, decisionId: res.decisionId, question, charId }, epoch);
}

/**
 * The answer call. Idempotent per decision: an answer already recorded is never redone, and a call that was
 * started before a crash is never repeated (a templated "no answer" line is recorded instead). A failed or
 * over-budget call records the "no answer" line (no error_recovery pause); a leaking answer is blocked.
 */
async function answerStep(rt: Runtime, pause: PauseRecord, rawAsk: PendingAsk, epoch: number): Promise<StepSignal | LimitReached> {
  const ask: PendingAsk = { ...rawAsk, question: redactSecrets(rawAsk.question) };
  if (rt.records.hasLog(rt.sessionId, 'answer', ask.requestId)) return 'continue';
  const state = stateOf(rt);
  // Read back an answer already persisted (e.g. by an engine version that wrote dialogue and marker separately).
  const persisted = rt.harness.repo
    .listDialogue(rt.sessionId)
    .find((d) => d.kind === 'answer' && (d.payload as { requestId?: string } | null)?.requestId === ask.requestId);
  if (persisted) {
    const outcome = ((persisted.payload as { outcome?: string }).outcome ?? 'answered') as 'answered' | 'blocked' | 'no_answer';
    rt.records.log(rt.sessionId, state.round, epoch, 'answer', { pauseId: pause.id, requestId: ask.requestId, decisionId: ask.decisionId, charId: ask.charId, outcome, dialogueSeq: persisted.seq, recovered: true }, ask.requestId);
    emit(rt, { type: 'answer', pauseId: pause.id, charId: ask.charId, question: ask.question, text: persisted.text, outcome, dialogueSeq: persisted.seq });
    return 'continue';
  }
  let text: string;
  let outcome: 'answered' | 'blocked' | 'no_answer';
  let detail: Record<string, unknown> = {};
  if (rt.records.hasLog(rt.sessionId, 'answer_call', ask.requestId)) {
    text = noAnswerLine(rt.names, ask.charId, rt.lang);
    outcome = 'no_answer';
    detail = { reason: 'the call was interrupted by a restart; not repeated' };
  } else {
    if (expired(rt)) return WALL_CLOCK;
    rt.records.log(rt.sessionId, state.round, epoch, 'answer_call', { pauseId: pause.id, requestId: ask.requestId, charId: ask.charId }, ask.requestId);
    const { signal, dispose } = callSignal(rt);
    let r: Awaited<ReturnType<typeof runAnswer>>;
    try {
      r = await runAnswer({
        client: rt.client,
        content: rt.content,
        config: rt.config,
        state,
        charId: ask.charId,
        lang: rt.lang,
        identity: identity(rt, state.round, epoch, `answer.${pause.id}.${ask.requestId.split(':').at(-1) ?? '0'}`),
        question: ask.question,
        facts: [...pause.visibleFacts, pause.question],
        persona: rt.personas[ask.charId],
        dialogue: dialogueRows(rt),
        names: rt.names,
        signal,
      });
    } finally {
      dispose();
    }
    const fresh = rt.harness.repo.findPause(pause.id);
    if (fresh?.status !== 'open' || sessionOf(rt).epoch !== epoch) {
      rt.records.log(rt.sessionId, state.round, epoch, 'answer', { pauseId: pause.id, requestId: ask.requestId, decisionId: ask.decisionId, charId: ask.charId, discarded: 'superseded while the answer was awaited' }, ask.requestId);
      emit(rt, { type: 'discarded', pauseId: pause.id, reason: 'answer superseded' });
      return 'continue';
    }
    text = r.text;
    outcome = r.outcome;
    detail = { status: r.status, errorKind: r.llm.errorKind, leakHits: r.leakHits };
  }
  const listeners = [...presentCharacters(stateOf(rt)).filter((c) => c !== ask.charId), 'player' as const];
  // Dialogue and completion marker in ONE transaction: a crash leaves either both or neither.
  const seq = rt.harness.store.transaction(() => {
    const recorded = rt.harness.recordDialogue(
      rt.sessionId,
      { speaker: ask.charId, listeners, text, kind: 'answer', payload: { decisionId: ask.decisionId, requestId: ask.requestId, outcome } },
      `${ask.requestId}.a`,
    );
    rt.records.log(rt.sessionId, state.round, epoch, 'answer', { pauseId: pause.id, requestId: ask.requestId, decisionId: ask.decisionId, charId: ask.charId, outcome, dialogueSeq: recorded.seq, ...detail }, ask.requestId);
    return recorded.seq;
  });
  emit(rt, { type: 'answer', pauseId: pause.id, charId: ask.charId, question: ask.question, text, outcome, dialogueSeq: seq });
  return expired(rt) ? WALL_CLOCK : 'continue';
}

// ---------------------------------------------------------------------------------------------------------------
// 8 COMMIT
// ---------------------------------------------------------------------------------------------------------------

export async function commitStep(rt: Runtime, batch: BatchRecord): Promise<void> {
  await hook(rt, 'commit');
  // The commit, the follow-up items it creates and the processing progress of its turns: one transaction.
  const result = rt.harness.store.transaction(() => {
    const r = rt.harness.commitBatch({ sessionId: rt.sessionId, batchId: batch.batchId, requestId: `commit:${batch.batchId}` });
    syncLedger(rt);
    return r;
  });
  log(rt, 'commit', { batchId: batch.batchId, ok: result.ok, rule: result.rule, reason: result.reason, events: result.events.length });
  emit(rt, { type: 'commit', result });
}

// ---------------------------------------------------------------------------------------------------------------
// 9 NARRATE
// ---------------------------------------------------------------------------------------------------------------

function narrateFnFor(rt: Runtime, batch: BatchRecord, injectFailureFor: string | null, signal: AbortSignal): (req: NarrateRequest) => Promise<NarrateOutput> {
  const snapshot = (batch.committedVersion !== null ? rt.harness.repo.getSnapshot(rt.sessionId, batch.committedVersion)?.state : null) ?? stateOf(rt);
  const session = sessionOf(rt);
  const narrate = createNarrateFn({
    client: rt.client,
    content: rt.content,
    config: rt.config,
    lang: rt.lang,
    names: rt.names,
    day: snapshot.day,
    signal,
    getState: () => snapshot,
    identity: () => ({ sessionId: rt.sessionId, caseId: rt.run.caseId, rep: rt.run.rep, round: batch.round, epoch: session.epoch }),
  });
  return async (req) => {
    if (injectFailureFor !== null && req.scene === injectFailureFor) {
      const header = renderFactHeader(req.facts, rt.names, rt.lang, { scene: req.scene, day: snapshot.day });
      const prose = fallbackProse(req.facts, rt.names, rt.lang);
      return {
        status: 'failed',
        raw: null,
        header,
        displayed: `${header}\n\n${prose}`,
        check: { checker: null, fallbackReason: 'error', injected: 'narration_failure', mentionedFacts: [] },
      };
    }
    return narrate(req);
  };
}

function covers(row: { eventVersions: number[] }, versions: readonly number[]): boolean {
  return versions.every((v) => row.eventVersions.includes(v));
}

/**
 * Narrates the scenes of a committed character batch that lack a good narration; retries failed scenes once
 * (unless the budget refused or the deadline passed: the scene then stays pending for an explicit retry).
 */
export async function narrateBatch(rt: Runtime, batch: BatchRecord): Promise<void> {
  const scenes = rt.harness.narrationScenes(rt.sessionId, batch.batchId);
  if (scenes.length === 0) return;
  await hook(rt, 'narrate');
  let injectFor: string | null = null;
  for (const scene of scenes) {
    if (takeFault(rt, 'narration_failure', batch.round, scene.scene, false)) injectFor = scene.scene;
  }
  if (injectFor !== null) takeFault(rt, 'narration_failure', batch.round, injectFor);
  const { signal, dispose } = callSignal(rt);
  try {
    const narrate = narrateFnFor(rt, batch, injectFor, signal);
    const refusalsBefore = rt.client.budgetRefusals;
    const rowsOf = (scene: string) => rt.harness.repo.listNarrations(rt.sessionId).filter((n) => n.batchId === batch.batchId && n.scene === scene);
    for (const scene of scenes) {
      const rows = rowsOf(scene.scene);
      const latest = rows.at(-1);
      if (latest && latest.status !== 'failed' && covers(latest, scene.eventVersions)) continue;
      if (expired(rt) || rt.client.budgetRefusals > refusalsBefore) return;
      const out = await narrate(scene);
      rt.harness.recordNarration(
        rt.sessionId,
        { batchId: batch.batchId, scene: scene.scene, eventVersions: scene.eventVersions, status: out.status, raw: out.raw, header: out.header, displayed: out.displayed, check: out.check },
        `n:${batch.batchId}:${scene.scene}:${rows.length + 1}`,
      );
      emit(rt, { type: 'narration', batchId: batch.batchId, scene: scene.scene, status: out.status, displayed: out.displayed });
    }
    // narration_pending: regenerate failed scenes once from the committed events (never re-executes actions).
    const failed = scenes.filter((s) => rowsOf(s.scene).at(-1)?.status === 'failed');
    if (failed.length === 0 || rt.client.budgetRefusals > refusalsBefore || expired(rt)) return;
    const regenerate = narrateFnFor(rt, batch, null, signal);
    for (const scene of failed) {
      if (rt.client.budgetRefusals > refusalsBefore || expired(rt)) return;
      const versionBefore = stateOf(rt).version;
      const ids = await rt.harness.regenerateNarration(rt.sessionId, scene.eventVersions, regenerate);
      const latest = rowsOf(scene.scene).at(-1);
      log(rt, 'narration_regenerated', { batchId: batch.batchId, scene: scene.scene, narrationIds: ids, status: latest?.status ?? null, versionUnchanged: stateOf(rt).version === versionBefore });
      if (latest) emit(rt, { type: 'narration', batchId: batch.batchId, scene: scene.scene, status: latest.status, displayed: latest.displayed });
    }
  } finally {
    dispose();
  }
}

/** NARRATE every committed character batch still pending (oldest first); reports a limit reached meanwhile. */
export async function narratePending(rt: Runtime): Promise<LimitReached | null> {
  const refusalsBefore = rt.client.budgetRefusals;
  for (const batch of rt.harness.repo.committedBatches(rt.sessionId)) {
    if (batch.kind !== 'character') continue;
    if (batch.narrationStatus !== 'pending' && batch.narrationStatus !== 'failed') continue;
    await narrateBatch(rt, batch);
    if (rt.client.budgetRefusals > refusalsBefore) return { outcome: 'budget_exhausted', reason: 'LLM budget exhausted during NARRATE (narration kept pending)' };
    if (expired(rt)) return WALL_CLOCK;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// 10 ADVANCE
// ---------------------------------------------------------------------------------------------------------------

export async function advanceStep(rt: Runtime): Promise<void> {
  const state = stateOf(rt);
  if (state.terminal) return;
  await hook(rt, 'advance');
  if (!characterCommitted(rt, state.round)) throw new EngineError(`round ${state.round} has no committed character batch; ADVANCE refused`);
  const result = rt.harness.store.transaction(() => {
    const r = rt.harness.runSystemAdvance(rt.sessionId, `r${state.round}.advance`);
    syncLedger(rt);
    return r;
  });
  if (!result.ok) throw new EngineError(`ADVANCE refused (${result.rule ?? '?'}): ${result.reason ?? ''}`);
  log(rt, 'advance', { round: state.round, toVersion: result.toVersion, staged: result.staged, terminal: result.terminal?.kind ?? null });
  emit(rt, { type: 'system', kind: 'advance', result, header: headerForVersions(rt, result.fromVersion, result.toVersion) });
  if (result.staged?.pauseId) {
    const pause = rt.harness.repo.findPause(result.staged.pauseId);
    if (pause) emit(rt, { type: 'pause', pause });
  }
}
