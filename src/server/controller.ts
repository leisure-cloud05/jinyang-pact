/**
 * Play controller: drives one interactive session's engine in the background (PLAN §10.1 lifecycle, §11 UI).
 *
 * - The engine runs step by step under the harness's per-session mutex. It pauses itself where it needs the user:
 *   the PLAYER step awaits the player's turn (`players.turn`), DECIDE awaits a decision (`decisions.decide`). Both are
 *   promises resolved by POST requests (`advance`, `decision`), so no step ever runs twice and nothing is polled.
 * - During the player's turn each UI input is committed at once as its own `player` batch through the harness
 *   (PLAN §8.3 "per player input (UI)"), so the draft, the version and any rejection are visible immediately; ending
 *   the turn hands the engine the case's scripted lines (opt-in) and lets it continue with SELECT.
 * - An accepted interrupt while a decision is awaited releases that wait: the harness has already made the batch
 *   stale and its pauses obsolete and bumped the epoch, so the engine discards the released answer (its
 *   `decision_discarded` path) and continues at PLAYER with the instruction (§8.3). The player's turn inputs are
 *   committed as they are made (not through the engine's persisted turn record): after a restart in mid-turn the
 *   engine simply asks for the turn again.
 * - A decision the harness refuses (e.g. an amend that fails validation) is reported to its request; the pause stays
 *   open and the engine waits again.
 * Engine events are republished on the session's SSE channel as player-safe messages (no remote-scene content).
 */
import { runMapper, type MapperResult } from '../agents/mapper.js';
import { choosePolicy, type DecisionChoice, type DecisionContext, type EngineEvent, type EngineSession, type PlayerContext, type PlayerTurn, type StepName } from '../engine/index.js';
import type { ScriptInputLike } from '../core/script.js';
import type { LocId } from '../core/types.js';
import { HarnessError, type Harness, type InterruptResult, type PlayerInput, type PlayerResult } from '../harness/index.js';
import { redactSecrets } from '../llm/redact.js';
import type { ControlState, ControlView, PolicySuggestion } from './api-types.js';
import { ApiError, errorMessage } from './errors.js';
import type { SseHub } from './sse.js';
import type { SessionMeta } from './store.js';

export class DecisionCancelled extends Error {
  constructor(reason: string) {
    super(`decision wait cancelled: ${reason}`);
    this.name = 'DecisionCancelled';
  }
}

interface TurnWaiter {
  round: number;
  epoch: number;
  /** Opaque per-turn token (round and epoch): inputs and the turn-ending advance must present it. */
  token: string;
  resolve: (turn: PlayerTurn) => void;
}

interface DecisionWaiter {
  pauseId: string;
  ctx: DecisionContext;
  resolve: (choice: DecisionChoice) => void;
  reject: (err: Error) => void;
}

interface Attempt {
  pauseId: string;
  error: string | null;
}

export interface ControllerDeps {
  sessionId: string;
  harness: Harness;
  meta: SessionMeta;
  hub: SseHub;
  /** The case's scripted inputs of a round (used when the session opted in). */
  scriptFor: (round: number) => ScriptInputLike[];
  /** Case decision policy (hint for the decision modal); empty for free play. */
  policy: Parameters<typeof choosePolicy>[0];
  /** Why the engine cannot run in this server (live session on a mock-only server), or null. */
  unavailable: string | null;
  suspendedReason: () => string | null;
  outcome: () => { outcome: string | null; detail: string | null };
}

const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * Lifecycle steps that happen in every round whatever happens offstage (NARRATE and COMMIT steps, for instance,
 * depend on whether a remote scene had events, so streaming them would reveal offstage activity).
 */
const EVERY_ROUND_STEPS = new Set<string>(['prepare', 'player', 'generate:opened', 'generate:called', 'generate:submitted', 'assess', 'decide', 'advance']);

export function turnToken(round: number, epoch: number): string {
  return `turn-r${round}-e${epoch}`;
}

export class PlayController {
  readonly sessionId: string;
  readonly harness: Harness;
  readonly meta: SessionMeta;
  private readonly deps: ControllerDeps;
  private engineRef: EngineSession | null = null;
  private running = false;
  private closed = false;
  private turn: TurnWaiter | null = null;
  private decision: DecisionWaiter | null = null;
  private attempt: Attempt | null = null;
  private error: string | null = null;
  private lastStep: string | null = null;
  private idleWaiters: Array<() => void> = [];

  constructor(deps: ControllerDeps) {
    this.deps = deps;
    this.sessionId = deps.sessionId;
    this.harness = deps.harness;
    this.meta = deps.meta;
  }

  // ------------------------------------------------------------------------------------------------------------
  // Engine wiring (sources and hooks passed to EngineSession)
  // ------------------------------------------------------------------------------------------------------------

  attach(engine: EngineSession): void {
    this.engineRef = engine;
  }

  get engine(): EngineSession {
    if (!this.engineRef) throw new ApiError(409, 'engine_unavailable', this.deps.unavailable ?? 'the engine is not attached');
    return this.engineRef;
  }

  get unavailableReason(): string | null {
    return this.deps.unavailable;
  }

  get available(): boolean {
    return this.engineRef !== null && this.deps.unavailable === null;
  }

  /** PlayerSource.turn: waits for the player to end the turn. */
  awaitTurn(ctx: PlayerContext): Promise<PlayerTurn> {
    return new Promise((resolve) => {
      const epoch = this.harness.getSession(this.sessionId).epoch;
      this.turn = { round: ctx.round, epoch, token: turnToken(ctx.round, epoch), resolve };
      this.publishControl();
      this.flushIdle();
    });
  }

  /** DecisionSource.decide: waits for the user's decision on the oldest open pause. */
  awaitDecision(ctx: DecisionContext): Promise<DecisionChoice> {
    return new Promise((resolve, reject) => {
      this.decision = { pauseId: ctx.pause.id, ctx, resolve, reject };
      this.publishControl();
      this.flushIdle();
    });
  }

  onEvent(e: EngineEvent): void {
    const pub = (type: string, data: unknown): void => {
      this.deps.hub.publish(this.sessionId, type, data);
    };
    switch (e.type) {
      case 'round':
        pub('round', { round: e.round, day: e.day });
        break;
      case 'pause':
        pub('pause', { pauseId: e.pause.id, category: e.pause.category, kind: e.pause.kind });
        break;
      case 'decision':
        pub('decision', { pauseId: e.pauseId, category: e.category, option: e.option, replayed: e.replayed });
        break;
      case 'narration':
        // Only the player's own scene is narrated to the player; other scenes leave no trace on the stream.
        if (e.scene === this.playerLocation()) pub('narration', { scene: e.scene, status: e.status, batchId: e.batchId, text: e.displayed });
        break;
      case 'interrupt':
        pub('interrupt', { accepted: e.accepted, instruction: e.instruction, round: e.round });
        break;
      case 'suspended':
        pub('suspended', { reason: e.reason });
        break;
      case 'terminal':
        pub('terminal', { kind: e.terminal.kind, round: e.terminal.round, day: e.terminal.day });
        break;
      case 'outcome':
        pub('outcome', { outcome: e.outcome, detail: e.detail });
        break;
      default:
        // Selections, proposals, Judge verdicts, commits, system steps and discarded answers vary with offstage
        // activity: they are not streamed to the player (the steps that occur every round are, via onStep).
        break;
    }
  }

  onStep(step: StepName, info: { round: number; epoch: number }): void {
    if (!EVERY_ROUND_STEPS.has(step)) return;
    this.lastStep = step;
    this.deps.hub.publish(this.sessionId, 'phase', { step, round: info.round, epoch: info.epoch });
  }

  private playerLocation(): LocId | null {
    try {
      return this.harness.getState(this.sessionId).player.location;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------------------------------------------------
  // Background loop
  // ------------------------------------------------------------------------------------------------------------

  start(): void {
    if (this.running || this.closed || !this.available) return;
    this.running = true;
    this.error = null;
    this.publishControl();
    void this.loop();
  }

  private async loop(): Promise<void> {
    let failures = 0;
    try {
      for (;;) {
        if (this.closed) return;
        let more: boolean;
        try {
          more = await this.harness.mutex.run(this.sessionId, () => this.engine.step());
          this.attempt = null;
          failures = 0;
        } catch (err) {
          if (this.closed) return;
          if (err instanceof DecisionCancelled) continue;
          const attempt = this.attempt;
          if (attempt) {
            // The user's decision was refused (nothing was written): report it, the pause stays open.
            attempt.error = redactSecrets(errorMessage(err));
            this.attempt = null;
            failures += 1;
            if (failures <= MAX_CONSECUTIVE_FAILURES && err instanceof HarnessError) continue;
          }
          throw err;
        }
        if (!more) break;
      }
    } catch (err) {
      this.error = redactSecrets(errorMessage(err));
      this.deps.hub.publish(this.sessionId, 'error', { message: this.error });
    } finally {
      this.running = false;
      this.turn = null;
      this.decision = null;
      if (!this.closed) this.publishControl();
      this.flushIdle();
    }
  }

  close(): void {
    this.closed = true;
    this.flushIdle();
  }

  // ------------------------------------------------------------------------------------------------------------
  // Idle tracking (POST handlers wait until the engine blocks again)
  // ------------------------------------------------------------------------------------------------------------

  isIdle(): boolean {
    return !this.running || this.turn !== null || this.decision !== null || this.closed;
  }

  whenIdle(timeoutMs: number): Promise<boolean> {
    if (this.isIdle()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: boolean): void => {
        if (done) return;
        done = true;
        resolve(v);
      };
      const timer = setTimeout(() => {
        this.idleWaiters = this.idleWaiters.filter((w) => w !== onIdle);
        finish(false);
      }, Math.max(0, timeoutMs));
      const onIdle = (): void => {
        clearTimeout(timer);
        finish(true);
      };
      this.idleWaiters.push(onIdle);
    });
  }

  private flushIdle(): void {
    if (!this.isIdle()) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  // ------------------------------------------------------------------------------------------------------------
  // User actions
  // ------------------------------------------------------------------------------------------------------------

  get awaitingPlayer(): boolean {
    return this.turn !== null;
  }

  get pendingDecision(): { pauseId: string; ctx: DecisionContext } | null {
    return this.decision ? { pauseId: this.decision.pauseId, ctx: this.decision.ctx } : null;
  }

  /** Policy hint for the awaited pause (cases with a scripted-user policy). */
  suggestion(): PolicySuggestion | null {
    const d = this.decision;
    if (!d || this.deps.policy.length === 0) return null;
    const c = choosePolicy(this.deps.policy, d.ctx);
    return {
      option: c.option,
      advice: c.advice ?? null,
      authorization: c.authorization ?? null,
      goalLimits: c.goalLimits ?? null,
      counterTerms: c.counterTerms ?? null,
      amend: c.amend ?? null,
      note: c.note ?? null,
    };
  }

  /** The token of the awaited player turn (null: not the player's turn). */
  get turnToken(): string | null {
    return this.turn?.token ?? null;
  }

  /** The awaited turn, or a 409 when it is not the player's turn or `token` names an older/other turn. */
  private requireTurn(token: string | null | undefined): TurnWaiter {
    const t = this.turn;
    if (!t) throw new ApiError(409, 'not_player_turn', 'It is not your turn: decide the open pause, or send an interrupt while the council deliberates.');
    if (token !== t.token) {
      throw new ApiError(409, 'stale_turn', `This input belongs to ${token ? `turn ${token}` : 'no turn'}, but the current turn is ${t.token}; reload and try again.`, { turn: t.token });
    }
    return t;
  }

  /**
   * Commits player inputs now: only within the turn named by `token`, and — for inputs prepared asynchronously
   * (mapper) — only if the epoch and the world version are still those the input was prepared against. The check
   * and the commit run in one synchronous step.
   */
  applyInputs(inputs: PlayerInput[], requestId: string, token: string | null | undefined, expect?: { epoch: number; version: number }): PlayerResult {
    this.requireTurn(token);
    if (expect) {
      const epoch = this.harness.getSession(this.sessionId).epoch;
      const version = this.harness.getState(this.sessionId).version;
      if (epoch !== expect.epoch || version !== expect.version) {
        throw new ApiError(409, 'stale_mapping', 'The situation changed while your command was being interpreted; nothing was applied. Please send it again.');
      }
    }
    const result = this.harness.applyPlayerAction(this.sessionId, inputs, `ui:${requestId}`);
    this.deps.hub.publish(this.sessionId, 'progress', { kind: 'player_input' });
    return result;
  }

  /**
   * Free text → mapper (the session's budgeted client; usage recorded with the session). Returns the binding the
   * interpretation was made against; `applyInputs` refuses it if the turn, epoch or world changed meanwhile.
   */
  async mapText(text: string, requestId: string, token: string | null | undefined): Promise<{ mapped: MapperResult; expect: { epoch: number; version: number } }> {
    this.requireTurn(token);
    const engine = this.engine;
    const state = this.harness.getState(this.sessionId);
    const session = this.harness.getSession(this.sessionId);
    const expect = { epoch: session.epoch, version: state.version };
    const mapped = await runMapper({
      client: engine.rt.client,
      content: engine.rt.content,
      config: session.config,
      state,
      text,
      lang: engine.rt.lang,
      identity: { sessionId: this.sessionId, round: state.round, epoch: session.epoch, callTag: `mapper:${requestId}` },
      names: engine.rt.names,
    });
    if (this.turn?.token !== token) {
      throw new ApiError(409, 'stale_mapping', 'Your turn ended while your command was being interpreted; nothing was applied.', { turn: this.turn?.token ?? null });
    }
    return { mapped, expect };
  }

  /** Ends the turn named by `token` (or resumes a suspended run). */
  advance(token: string | null | undefined): 'end_turn' | 'resumed' | 'restarted' {
    if (this.turn) {
      const t = this.requireTurn(token);
      this.turn = null;
      t.resolve({ script: this.meta.script ? this.deps.scriptFor(t.round) : [] });
      return 'end_turn';
    }
    if (token) throw new ApiError(409, 'stale_turn', `Turn ${token} is no longer awaited.`, { turn: null });
    if (this.decision) throw new ApiError(409, 'awaiting_decision', `Decide the open pause ${this.decision.pauseId} first.`);
    if (this.running) throw new ApiError(409, 'busy', 'The council is still deliberating.');
    const session = this.harness.getSession(this.sessionId);
    if (session.status === 'suspended') {
      this.engine.resume();
      this.start();
      return 'resumed';
    }
    const state = this.harness.getState(this.sessionId);
    if (state.terminal || session.status === 'finished' || session.status === 'stopped') {
      throw new ApiError(409, 'ended', 'The chapter has ended.');
    }
    this.start();
    return 'restarted';
  }
  /** Resolves the awaited pause; resolves after the engine blocked again (or the wait timed out). */
  async decide(pauseId: string, choice: DecisionChoice, waitMs: number, beforeEffect?: () => void): Promise<{ settled: boolean; error: string | null }> {
    const d = this.decision;
    if (!d) throw new ApiError(409, 'no_pending_decision', 'No decision is awaited right now.');
    if (d.pauseId !== pauseId) throw new ApiError(409, 'pause_mismatch', `The awaited pause is ${d.pauseId}.`);
    if (!d.ctx.pause.options.includes(choice.option)) {
      throw new ApiError(400, 'invalid_option', `${choice.option} is not an option of this pause (${d.ctx.pause.options.join(', ')}).`);
    }
    beforeEffect?.();
    const attempt: Attempt = { pauseId, error: null };
    this.attempt = attempt;
    this.decision = null;
    d.resolve(choice);
    const settled = await this.whenIdle(waitMs);
    return { settled, error: attempt.error };
  }

  /** Player instruction (PLAN §8.3); an accepted interrupt cancels an awaited decision of the stale batch. */
  interrupt(text: string): InterruptResult {
    const epochBefore = this.harness.getSession(this.sessionId).epoch;
    const result = this.engine.interrupt(text);
    const d = this.decision;
    if (result.accepted && d) {
      const pause = this.harness.repo.findPause(d.pauseId);
      const superseded = !pause || pause.status !== 'open' || this.harness.getSession(this.sessionId).epoch !== epochBefore;
      if (superseded) {
        // The engine discards any answer to a superseded pause; release its wait with a neutral answer.
        this.decision = null;
        d.resolve({ option: d.ctx.pause.options[0] ?? 'endorse', by: 'user', note: 'superseded by an interrupt (discarded)' });
      }
    }
    return result;
  }

  // ------------------------------------------------------------------------------------------------------------
  // Control view
  // ------------------------------------------------------------------------------------------------------------

  control(): ControlView {
    const session = this.harness.getSession(this.sessionId);
    const state = this.harness.getState(this.sessionId);
    const { outcome, detail } = this.deps.outcome();
    let st: ControlState;
    if (this.deps.unavailable !== null) st = 'unavailable';
    else if (this.error !== null) st = 'error';
    else if (this.decision) st = 'awaiting_decision';
    else if (this.turn) st = 'awaiting_player';
    else if (this.running) st = 'running';
    else if (session.status === 'suspended') st = 'suspended';
    else if (session.status === 'stopped') st = 'stopped';
    else if (state.terminal || session.status === 'finished' || outcome !== null) st = 'finished';
    else st = 'starting';
    return {
      state: st,
      round: state.round,
      day: state.day,
      phase: session.phase,
      epoch: session.epoch,
      sessionStatus: session.status,
      pauseId: this.decision?.pauseId ?? null,
      outcome,
      outcomeDetail: detail,
      terminal: state.terminal ? { kind: state.terminal.kind, round: state.terminal.round, day: state.terminal.day } : null,
      error: this.error ?? this.deps.unavailable,
      lastStep: this.lastStep,
      suspendedReason: session.status === 'suspended' ? this.deps.suspendedReason() : null,
      turn: this.turn?.token ?? null,
    };
  }

  publishControl(): void {
    if (this.closed) return;
    try {
      this.deps.hub.publish(this.sessionId, 'control', this.control());
    } catch {
      /* the database may be closing */
    }
  }
}
