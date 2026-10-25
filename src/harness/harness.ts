/**
 * Harness facade (PLAN §8.1): the only component that writes world state. Every mutating operation takes a
 * `requestId` and runs as one idempotent `BEGIN IMMEDIATE` transaction (H06); world writes go through batches
 * with the H05 entry check (§8.3). Operations are synchronous; callers that interleave async work (LLM calls)
 * serialise per session with `harness.mutex` and pass `harness.signal(sessionId)` to in-flight calls, which is
 * aborted when the epoch changes.
 */
import { hashState, hashValue } from '../core/hash.js';
import { mandatoryCategory } from '../core/pauses.js';
import type { PausePlan } from '../core/plan.js';
import { parseProposalAction, validate, type ValidationContext, type ValidationResult } from '../core/rules.js';
import type { ActorId, AnyAction, CoreConfig, Mode, PauseCategory, WorldState } from '../core/types.js';
import { Store } from '../store/db.js';
import { exportAudit, vacuumInto } from '../store/export.js';
import { Repo, type DialogueKind, type InstructionRecord, type PauseRecord, type SessionRecord } from '../store/repo.js';
import { SqliteUsageSink } from '../store/usage.js';
import { branchTx, type BranchResult } from './branch.js';
import { commitProposalBatch, currentState, newBatch, type CommitResult } from './commit.js';
import { HarnessError, controlId, redactDeep, withRequest, type HarnessContext, type HarnessHooks, type Replayable } from './context.js';
import {
  addDialogue,
  assertRunning,
  assessBatch,
  bumpEpoch,
  openPauseTx,
  planForBatch,
  resolvePauseTx,
  type AssessResult,
  type DecisionInput,
  type PauseSpec,
  type ResolveResult,
  type SemanticPauseInput,
} from './decisions.js';
import { SessionMutex } from './mutex.js';
import { prepareScriptInputs, type ScriptInputLike } from '../core/script.js';
import { batchOfEvents, recordNarrationTx, scenesOf, type NarrateFn, type NarrateOutput, type NarrateRequest, type NarrationInput } from './narration.js';
import { recoverTx, type RecoveryReport } from './recovery.js';
import { replayPatch, replayRederive, type ReplayReport } from './replay.js';
import { runSystemAdvanceTx, runSystemPrepareTx } from './system.js';

export interface HarnessOptions {
  clock?: () => string;
  hooks?: HarnessHooks;
}

export interface CreateSessionInput {
  sessionId: string;
  mode: Mode;
  caseId?: string | null;
  config: CoreConfig;
  initialState: WorldState;
  rngSeed: number;
  hashes?: { content?: string; rules?: string; prompts?: string };
}

export type PlayerInput =
  | { kind: 'action'; action: unknown; probe?: boolean }
  | { kind: 'dialogue'; to: ActorId[]; text: string };

export interface PlayerResult extends CommitResult {
  dialogueSeqs: number[];
}

export interface ScriptResult extends PlayerResult {
  /** Inputs applied, in script order (action proposals carry their probe flag). */
  applied: Array<{ index: number; kind: 'action' | 'dialogue'; probe: boolean }>;
  /** Inputs skipped with the reason (condition false, placeholder unresolvable) — logged in the request record. */
  skipped: Array<{ index: number; reason: string }>;
}

export interface ProposalInput {
  actor: ActorId;
  action: unknown;
  source?: 'llm' | 'policy';
  rationale?: string;
  cites?: string[];
  askPlayer?: { question: string } | null;
  /** The model output could not be parsed: stored as `format_error` and treated as `wait`. */
  formatError?: boolean;
}

export interface OpenBatchResult extends Replayable {
  batchId: string;
  epoch: number;
  baseVersion: number;
  generation: number;
}

export interface SubmitResult extends Replayable {
  accepted: boolean;
  proposalIds: string[];
  reason: string | null;
  /** Immutable intake evidence (class and action hash per proposal), cross-checked by rederive. */
  intake: Array<{ proposalId: string; intake: 'pending' | 'format_error' | 'stale_epoch'; intakeHash: string }>;
}

export interface InterruptResult extends Replayable {
  accepted: boolean;
  queued: boolean;
  epoch: number;
  instructionId: string;
  staleBatchId: string | null;
}

interface Simple extends Replayable {
  ok: true;
}

export class Harness {
  readonly store: Store;
  readonly repo: Repo;
  readonly mutex = new SessionMutex();
  private readonly ctx: HarnessContext;

  constructor(store: Store, opts: HarnessOptions = {}) {
    this.store = store;
    this.repo = new Repo(store);
    this.ctx = {
      store,
      repo: this.repo,
      clock: opts.clock ?? (() => new Date().toISOString()),
      hooks: opts.hooks ?? {},
      aborts: new Map(),
      afterCommit: null,
    };
  }

  static open(dbPath: string, opts: HarnessOptions = {}): Harness {
    return new Harness(Store.open(dbPath), opts);
  }

  close(): void {
    for (const c of this.ctx.aborts.values()) c.abort(new Error('harness closed'));
    this.store.close();
  }

  /** Test hook access (fault injection). */
  get hooks(): HarnessHooks {
    return this.ctx.hooks;
  }

  // ------------------------------------------------------------------------------------------------------------
  // Pure helpers and reads
  // ------------------------------------------------------------------------------------------------------------

  validate(state: WorldState, proposal: { actor: ActorId; action: unknown }, ctx: ValidationContext): ValidationResult {
    return validate(state, proposal, ctx);
  }

  /** Mandatory pause category of a proposal on the session's current state. */
  classify(sessionId: string, proposal: { actor: ActorId; action: unknown }): PauseCategory | null {
    const parsed = parseProposalAction(proposal.actor, proposal.action);
    if (!parsed.ok) return null;
    return mandatoryCategory(this.getState(sessionId), this.getSession(sessionId).config, proposal.actor, parsed.action as AnyAction);
  }

  /** Pause plan of an open batch on the current state (read-only). */
  dryRun(sessionId: string, batchId: string): PausePlan {
    const session = this.getSession(sessionId);
    return planForBatch(this.ctx, session, this.repo.getBatch(batchId));
  }

  getSession(sessionId: string): SessionRecord {
    return this.repo.getSession(sessionId);
  }

  getState(sessionId: string): WorldState {
    return currentState(this.ctx, sessionId);
  }

  openPauses(sessionId: string): PauseRecord[] {
    return this.repo.listPauses(sessionId, { status: 'open' });
  }

  /** Abort signal for the current epoch's in-flight calls of a session. */
  signal(sessionId: string): AbortSignal {
    let controller = this.ctx.aborts.get(sessionId);
    if (!controller) {
      controller = new AbortController();
      this.ctx.aborts.set(sessionId, controller);
    }
    return controller.signal;
  }

  usageSink(sessionId: string | null = null): SqliteUsageSink {
    return new SqliteUsageSink(this.store, sessionId);
  }

  // ------------------------------------------------------------------------------------------------------------
  // Session lifecycle
  // ------------------------------------------------------------------------------------------------------------

  createSession(input: CreateSessionInput, requestId = 'create-session'): SessionRecord {
    const payload = {
      mode: input.mode,
      caseId: input.caseId ?? null,
      state: hashState(input.initialState),
      config: hashValue(input.config),
      seed: input.rngSeed,
      hashes: input.hashes ?? null,
    };
    withRequest(this.ctx, input.sessionId, requestId, 'create_session', payload, () => {
      if (this.repo.findSession(input.sessionId)) throw new HarnessError('invalid_state', `session ${input.sessionId} exists`);
      const state = input.initialState;
      this.repo.insertSession({
        sessionId: input.sessionId,
        mode: input.mode,
        caseId: input.caseId ?? null,
        status: 'ready',
        suspendedFrom: null,
        phase: state.terminal ? 'finished' : 'prepare',
        round: state.round,
        epoch: 0,
        rngSeed: input.rngSeed,
        contentHash: input.hashes?.content ?? '',
        rulesHash: input.hashes?.rules ?? hashValue(input.config),
        promptHash: input.hashes?.prompts ?? '',
        config: input.config,
        baseVersion: state.version,
        parentSessionId: null,
        parentRound: null,
        parentVersion: null,
        runOutcome: null,
        controlSeq: 0,
        dialogueSeq: 0,
        createdAt: this.ctx.clock(),
      });
      this.repo.putSnapshot(input.sessionId, state);
      this.repo.insertEpoch({
        sessionId: input.sessionId,
        epoch: 0,
        reason: 'start',
        instructionId: null,
        startedAt: this.ctx.clock(),
        controlSeq: this.repo.nextControlSeq(input.sessionId),
      });
      return { replayed: false, ok: true } satisfies Simple;
    });
    return this.getSession(input.sessionId);
  }

  suspend(sessionId: string, reason: string, requestId: string): Simple {
    return withRequest(this.ctx, sessionId, requestId, 'suspend', { reason }, () => {
      const s = this.getSession(sessionId);
      if (s.status === 'suspended') throw new HarnessError('invalid_state', 'already suspended');
      this.repo.updateSession(sessionId, { status: 'suspended', suspendedFrom: s.status });
      return { replayed: false, ok: true };
    });
  }

  resume(sessionId: string, requestId: string): Simple {
    return withRequest(this.ctx, sessionId, requestId, 'resume', null, () => {
      const s = this.getSession(sessionId);
      if (s.status !== 'suspended') throw new HarnessError('invalid_state', 'not suspended');
      this.repo.updateSession(sessionId, { status: s.suspendedFrom ?? 'ready', suspendedFrom: null });
      return { replayed: false, ok: true };
    });
  }

  /** Stops a run with an execution outcome (`max_rounds`, `budget_exhausted`, `error`, …) — not a world terminal. */
  stop(sessionId: string, outcome: string, requestId: string): Simple {
    return withRequest(this.ctx, sessionId, requestId, 'stop', { outcome }, () => {
      this.repo.updateSession(sessionId, { status: 'stopped', runOutcome: outcome });
      return { replayed: false, ok: true };
    });
  }

  recover(sessionId: string, requestId: string): RecoveryReport {
    return withRequest(this.ctx, sessionId, requestId, 'recover', null, () => recoverTx(this.ctx, sessionId));
  }

  // ------------------------------------------------------------------------------------------------------------
  // Round lifecycle
  // ------------------------------------------------------------------------------------------------------------

  runSystemPrepare(sessionId: string, requestId: string): CommitResult {
    return withRequest(this.ctx, sessionId, requestId, 'prepare', null, () => runSystemPrepareTx(this.ctx, sessionId));
  }

  /** PLAYER step: player speech (dialogue) and player actions (one `player` batch, never paused). */
  applyPlayerAction(sessionId: string, inputs: PlayerInput | PlayerInput[], requestId: string): PlayerResult {
    const list = redactDeep(Array.isArray(inputs) ? inputs : [inputs]);
    return withRequest(this.ctx, sessionId, requestId, 'player', list, () => this.playerTx(sessionId, list));
  }

  /**
   * Scripted PLAYER step (§12.4): each input's `when` condition is evaluated and `"$current"` resolved against the
   * player's knowledge only; inputs that do not apply are skipped and logged; the rest run as `applyPlayerAction`.
   */
  applyScriptInputs(sessionId: string, rawInputs: ScriptInputLike[], requestId: string, opts: { lang?: 'zh' | 'en' } = {}): ScriptResult {
    const inputs = redactDeep(rawInputs);
    return withRequest(this.ctx, sessionId, requestId, 'script', { inputs, lang: opts.lang ?? 'zh' }, () => {
      const session = this.getSession(sessionId);
      const plan = prepareScriptInputs(currentState(this.ctx, sessionId), session.config, inputs, opts.lang ?? 'zh', session.mode);
      const list: PlayerInput[] = plan.apply.map((p) =>
        p.kind === 'dialogue' && p.dialogue
          ? { kind: 'dialogue' as const, to: p.dialogue.to as ActorId[], text: p.dialogue.text }
          : { kind: 'action' as const, action: p.action, probe: p.probe },
      );
      const result = this.playerTx(sessionId, list);
      return { ...result, applied: plan.apply.map((p) => ({ index: p.index, kind: p.kind, probe: p.probe })), skipped: plan.skipped };
    });
  }

  private playerTx(sessionId: string, list: PlayerInput[]): PlayerResult {
      const session = this.getSession(sessionId);
      if (session.status === 'suspended' || session.status === 'stopped') throw new HarnessError('invalid_state', `session is ${session.status}`);
      const state = currentState(this.ctx, sessionId);
      if (state.terminal) throw new HarnessError('terminal', `the world is terminal (${state.terminal.kind})`);
      const open = this.repo.openBatches(sessionId);
      if (open.length > 0) {
        throw new HarnessError('invalid_state', `batch ${open[0]?.batchId} is open; interrupt or resolve it first`);
      }
      const dialogueSeqs: number[] = [];
      for (const input of list) {
        if (input.kind === 'dialogue') {
          dialogueSeqs.push(addDialogue(this.ctx, sessionId, { speaker: 'player', listeners: input.to, text: input.text, kind: 'speech' }));
        }
      }
      const actions = list.filter((i): i is Extract<PlayerInput, { kind: 'action' }> => i.kind === 'action');
      if (actions.length === 0) {
        this.repo.updateSession(sessionId, { phase: 'select' });
        return {
          ok: true,
          replayed: false,
          batchId: null,
          kind: null,
          fromVersion: state.version,
          toVersion: state.version,
          events: [],
          outcomes: [],
          terminal: null,
          rule: null,
          reason: null,
          staged: null,
          continuation: 'select' as const,
          dialogueSeqs,
        };
      }
      const batch = newBatch(this.ctx, session, 'player', state, { status: 'assessed' });
      actions.forEach((input, i) => {
        const { seq } = controlId(this.ctx, sessionId, 'p');
        this.repo.insertProposal({
          proposalId: `${batch.batchId}/p${i + 1}`,
          sessionId,
          batchId: batch.batchId,
          round: batch.round,
          epoch: batch.epoch,
          baseVersion: batch.baseVersion,
          actor: 'player',
          source: 'player',
          seq: i + 1,
          action: input.action,
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
          probe: input.probe ?? false,
        });
      });
      return { ...commitProposalBatch(this.ctx, sessionId, batch.batchId), dialogueSeqs };
  }

  /** Records dialogue that is not the effect of an action (e.g. Judge questions, answers while paused). */
  recordDialogue(
    sessionId: string,
    rawRow: { speaker: ActorId; listeners: ActorId[]; text: string; kind: DialogueKind; payload?: unknown },
    requestId: string,
  ): { seq: number } & Replayable {
    const row = redactDeep(rawRow);
    return withRequest(this.ctx, sessionId, requestId, 'dialogue', row, () => ({
      replayed: false,
      seq: addDialogue(this.ctx, sessionId, row),
    }));
  }

  /** Queued instructions to apply at this PLAYER step (marked applied). */
  takeInstructions(sessionId: string, requestId: string): { instructions: InstructionRecord[] } & Replayable {
    return withRequest(this.ctx, sessionId, requestId, 'take_instructions', null, () => {
      const round = currentState(this.ctx, sessionId).round;
      const queued = this.repo.listInstructions(sessionId, 'queued');
      for (const i of queued) this.repo.markInstructionApplied(sessionId, i.instructionId, round);
      return { replayed: false, instructions: queued.map((i) => ({ ...i, status: 'applied' as const, appliedRound: round })) };
    });
  }

  openCharacterBatch(sessionId: string, requestId: string): OpenBatchResult {
    return withRequest(this.ctx, sessionId, requestId, 'open_character_batch', null, () => {
      const session = this.getSession(sessionId);
      if (session.status === 'suspended' || session.status === 'stopped') throw new HarnessError('invalid_state', `session is ${session.status}`);
      const state = currentState(this.ctx, sessionId);
      if (state.terminal) throw new HarnessError('terminal', `the world is terminal (${state.terminal.kind})`);
      const open = this.repo.openBatches(sessionId);
      if (open.length > 0) throw new HarnessError('invalid_state', `batch ${open[0]?.batchId} is still open`);
      const generation = this.repo.listBatches(sessionId).filter((b) => b.kind === 'character' && b.round === state.round).length;
      const batch = newBatch(this.ctx, session, 'character', state, { generation });
      this.repo.updateSession(sessionId, { status: 'generating', phase: 'generate' });
      return { replayed: false, batchId: batch.batchId, epoch: batch.epoch, baseVersion: batch.baseVersion, generation };
    });
  }

  /** Stores generated proposals (pending). Proposals arriving for a stale batch are kept as `stale_epoch`. */
  submitProposals(sessionId: string, batchId: string, rawProposals: ProposalInput[], requestId: string): SubmitResult {
    const proposals = redactDeep(rawProposals);
    return withRequest(this.ctx, sessionId, requestId, 'submit', { batchId, proposals }, () => {
      assertRunning(this.ctx, sessionId);
      const session = this.getSession(sessionId);
      const batch = this.repo.getBatch(batchId);
      if (batch.sessionId !== sessionId || batch.kind !== 'character') throw new HarnessError('not_found', `${batchId} is not a character batch of ${sessionId}`);
      const live = batch.status === 'generating' && batch.epoch === session.epoch;
      const existing = this.repo.listProposals(batchId);
      const ids: string[] = [];
      for (const [i, p] of proposals.entries()) {
        const { seq: controlSeq } = controlId(this.ctx, sessionId, 'p');
        const perActor = existing.filter((e) => e.actor === p.actor).length + proposals.slice(0, i).filter((q) => q.actor === p.actor).length + 1;
        const proposalId = `${batchId}/p${existing.length + i + 1}`;
        ids.push(proposalId);
        this.repo.insertProposal({
          proposalId,
          sessionId,
          batchId,
          round: batch.round,
          epoch: batch.epoch,
          baseVersion: batch.baseVersion,
          actor: p.actor,
          source: p.source ?? 'llm',
          seq: perActor,
          action: p.action ?? null,
          rationale: p.rationale ?? '',
          cites: p.cites ?? [],
          askPlayer: p.askPlayer ?? null,
          status: !live ? 'stale_epoch' : p.formatError ? 'format_error' : 'pending',
          rule: live ? null : 'H05',
          reason: live ? null : `batch ${batchId} is ${batch.status} (epoch ${batch.epoch}, session epoch ${session.epoch})`,
          feedback: null,
          code: null,
          category: null,
          gate: null,
          authorizationId: null,
          decisionId: null,
          eventVersions: [],
          controlSeq,
        });
      }
      const intake = this.repo
        .listProposals(batchId)
        .filter((p) => ids.includes(p.proposalId))
        .map((p) => ({ proposalId: p.proposalId, intake: p.intake ?? 'pending', intakeHash: p.intakeHash ?? '' }));
      return { replayed: false, accepted: live, proposalIds: ids, reason: live ? null : 'stale batch (H05)', intake };
    });
  }

  /** ASSESS: opens the pause plan's pauses plus the Judge's semantic pauses. */
  assess(sessionId: string, batchId: string, requestId: string, rawSemantic: SemanticPauseInput[] = []): AssessResult {
    const semantic = redactDeep(rawSemantic);
    return withRequest(this.ctx, sessionId, requestId, 'assess', { batchId, semantic }, () => {
      assertRunning(this.ctx, sessionId);
      return assessBatch(this.ctx, sessionId, batchId, semantic);
    });
  }

  commitBatch(req: { sessionId: string; batchId: string; requestId: string }): CommitResult {
    return withRequest(this.ctx, req.sessionId, req.requestId, 'commit', { batchId: req.batchId }, () => {
      assertRunning(this.ctx, req.sessionId);
      return commitProposalBatch(this.ctx, req.sessionId, req.batchId);
    });
  }

  openPause(sessionId: string, rawSpec: PauseSpec & { batchId?: string | null }, requestId: string): { pauseId: string } & Replayable {
    const spec = redactDeep(rawSpec);
    return withRequest(this.ctx, sessionId, requestId, 'open_pause', spec, () => ({
      replayed: false,
      pauseId: openPauseTx(this.ctx, sessionId, spec).id,
    }));
  }

  resolvePause(sessionId: string, pauseId: string, rawDecision: DecisionInput, requestId: string, opts: { autoCommit?: boolean } = {}): ResolveResult {
    const decision = redactDeep(rawDecision);
    return withRequest(this.ctx, sessionId, requestId, 'resolve', { pauseId, decision, autoCommit: opts.autoCommit ?? true }, () =>
      resolvePauseTx(this.ctx, sessionId, pauseId, decision, requestId, opts),
    );
  }

  runSystemAdvance(sessionId: string, requestId: string): CommitResult {
    return withRequest(this.ctx, sessionId, requestId, 'advance', null, () => runSystemAdvanceTx(this.ctx, sessionId));
  }

  /**
   * Interrupt (§8.3): accepted only while a character batch is open (generating/assessed/paused) ⇒ epoch+1, the
   * batch stale, its pauses obsolete, in-flight calls aborted, restart at PLAYER. Otherwise the instruction is
   * queued in `pending_instructions` (applied at the next PLAYER step) and the epoch is unchanged.
   */
  interrupt(sessionId: string, rawInstruction: { instructionId?: string; text: string }, requestId: string): InterruptResult {
    const instruction = redactDeep(rawInstruction);
    return withRequest(this.ctx, sessionId, requestId, 'interrupt', instruction, () => {
      assertRunning(this.ctx, sessionId); // a stopped or suspended run is only resumed explicitly
      const session = this.getSession(sessionId);
      const instructionId = instruction.instructionId ?? controlId(this.ctx, sessionId, 'ins').id;
      const open = this.repo.openBatches(sessionId).find((b) => b.kind === 'character');
      let epoch = session.epoch;
      if (open) {
        this.repo.updateBatch(open.batchId, { status: 'stale' });
        for (const p of this.repo.listProposals(open.batchId)) {
          if (p.status === 'pending') this.repo.updateProposal(p.proposalId, { status: 'stale_epoch' });
        }
        for (const pause of this.repo.listPauses(sessionId, { batchId: open.batchId, status: 'open' })) {
          this.repo.updatePause(pause.id, { status: 'obsolete' });
        }
        epoch = bumpEpoch(this.ctx, session, 'interrupt', instructionId);
        this.repo.updateSession(sessionId, { status: 'ready', phase: 'player' });
      }
      this.repo.insertInstruction({
        sessionId,
        instructionId,
        text: instruction.text,
        status: 'queued',
        interrupted: open !== undefined,
        epoch,
        controlSeq: this.repo.nextControlSeq(sessionId),
        appliedRound: null,
      });
      return { replayed: false, accepted: open !== undefined, queued: open === undefined, epoch, instructionId, staleBatchId: open?.batchId ?? null };
    });
  }

  // ------------------------------------------------------------------------------------------------------------
  // Narration, replay, branch, export
  // ------------------------------------------------------------------------------------------------------------

  recordNarration(sessionId: string, rawInput: NarrationInput, requestId: string): { narrationId: number } & Replayable {
    const input = redactDeep(rawInput);
    return withRequest(this.ctx, sessionId, requestId, 'narration', input, () => ({
      replayed: false,
      narrationId: recordNarrationTx(this.ctx, sessionId, input),
    }));
  }

  /** Scenes (with their facts) a committed batch must narrate for NARRATE to be complete. */
  narrationScenes(sessionId: string, batchId: string): NarrateRequest[] {
    const versions = this.repo.listBatchEvents(sessionId, batchId).map((e) => e.version);
    return versions.length === 0 ? [] : scenesOf(this.ctx, sessionId, versions);
  }

  /** Re-narrates committed events from their stored facts; never re-executes actions or touches world state. */
  async regenerateNarration(sessionId: string, eventVersions: number[], narrate: NarrateFn): Promise<number[]> {
    const scenes = scenesOf(this.ctx, sessionId, eventVersions);
    const batchId = batchOfEvents(this.ctx, sessionId, eventVersions);
    const outputs: Array<{ scene: NarrateRequest; output: NarrateOutput }> = [];
    for (const scene of scenes) outputs.push({ scene, output: redactDeep(await narrate(scene)) });
    return this.store.transaction(() =>
      outputs.map(({ scene, output }) =>
        recordNarrationTx(this.ctx, sessionId, {
          batchId,
          scene: scene.scene,
          eventVersions: scene.eventVersions,
          status: output.status,
          raw: output.raw,
          header: output.header,
          displayed: output.displayed,
          check: output.check,
        }),
      ),
    );
  }

  replay(sessionId: string, mode: 'patch' | 'rederive'): ReplayReport {
    return mode === 'patch' ? replayPatch(this.repo, sessionId) : replayRederive(this.repo, sessionId);
  }

  branch(sessionId: string, round: number, newSessionId: string, requestId: string): BranchResult {
    return withRequest(this.ctx, sessionId, requestId, 'branch', { round, newSessionId }, () =>
      branchTx(this.ctx, sessionId, round, newSessionId),
    );
  }

  exportAudit(sessionId: string, dir: string): string[] {
    return exportAudit(this.repo, sessionId, dir);
  }

  exportDatabase(destPath: string): string {
    return vacuumInto(this.store, destPath);
  }
}
