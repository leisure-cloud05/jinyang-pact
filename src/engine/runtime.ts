/**
 * Runtime shared by the lifecycle steps: the harness, engine records, the run's content/config, the budgeted LLM
 * client (with a persistent budget ledger and refusal tracking), the wall-clock deadline (with a watchdog that aborts
 * outstanding calls on expiry), decision and player sources, hooks, and small helpers (deterministic request ids,
 * call identities, logging, fired-once markers).
 */
import type { AgentNames } from '../agents/names.js';
import type { CallIdentity, Lang } from '../agents/types.js';
import type { ContentBundle } from '../content/loader.js';
import type { CharacterConfig } from '../content/schema.js';
import type { CharId, CoreConfig, Mode, WorldState } from '../core/types.js';
import type { Harness } from '../harness/index.js';
import type { LlmClient, LlmRequest, LlmResult } from '../llm/types.js';
import type { SessionRecord } from '../store/repo.js';
import type { InteractionEnv } from './interaction-store.js';
import type { EngineRecords, RunRecord } from './records.js';
import type {
  CaseLikeConfig,
  DecisionSource,
  EngineEvent,
  EngineHooks,
  FaultKind,
  FaultSpec,
  InterruptSpec,
  PlayerSource,
  StepName,
} from './types.js';

export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineError';
  }
}

export interface ChargeLedger {
  /** Worst-case USD of one logical call (0 when the model is unpriced, e.g. the mock). */
  reservation(req: LlmRequest<unknown>): number;
  begin(role: string, reservedUsd: number): number;
  end(id: number, c: { status: 'done' | 'refused'; chargedUsd: number; attempts: number; unknownCost: boolean }): void;
}

/**
 * Wraps the budgeted client: every call is written to the persistent budget ledger before it starts (at its
 * worst-case reservation) and settled afterwards (reported/estimated cost, or the worst case when the cost is
 * unknown), so a restarted run restores exactly what the budget guard charged. Counts budget refusals.
 */
export class TrackingClient implements LlmClient {
  readonly inner: LlmClient;
  private readonly ledger: ChargeLedger | null;
  budgetRefusals = 0;
  errors = 0;
  /** Message of the last budget refusal (call budget vs cost budget). */
  lastBudgetRefusal: string | null = null;

  constructor(inner: LlmClient, ledger: ChargeLedger | null = null) {
    this.inner = inner;
    this.ledger = ledger;
  }

  async complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    const reserved = this.ledger?.reservation(req as LlmRequest<unknown>) ?? 0;
    const id = this.ledger?.begin(req.role, reserved) ?? null;
    let result: LlmResult<T>;
    try {
      result = await this.inner.complete(req);
    } catch (err) {
      if (id !== null) this.ledger?.end(id, { status: 'done', chargedUsd: reserved, attempts: 1, unknownCost: true });
      throw err;
    }
    const refused = !result.ok && result.error.kind === 'budget' && result.attempts === 0;
    if (id !== null) {
      const unknownCost = result.attempts > 0 && result.usage.costUsd === null;
      this.ledger?.end(id, {
        status: refused ? 'refused' : 'done',
        chargedUsd: result.attempts === 0 ? 0 : (result.usage.costUsd ?? reserved),
        attempts: result.attempts,
        unknownCost,
      });
    }
    if (!result.ok) {
      this.errors += 1;
      if (result.error.kind === 'budget') {
        this.budgetRefusals += 1;
        this.lastBudgetRefusal = result.error.message;
      }
    }
    return result;
  }
}

/** Refuses every call as over budget (a resumed run whose budget is already spent). */
export class RefusingClient implements LlmClient {
  private readonly message: string;
  constructor(message: string) {
    this.message = message;
  }
  complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    return Promise.resolve({
      ok: false,
      error: { kind: 'budget', message: this.message },
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, costSource: 'estimated' },
      attempts: 0,
      latencyMs: 0,
      model: req.model ?? 'unknown',
    });
  }
}

export interface Runtime {
  harness: Harness;
  records: EngineRecords;
  sessionId: string;
  run: RunRecord;
  content: ContentBundle;
  caseConfig: CaseLikeConfig;
  config: CoreConfig;
  mode: Mode;
  lang: Lang;
  personas: Record<CharId, CharacterConfig>;
  names: AgentNames;
  client: TrackingClient;
  decisions: DecisionSource;
  players: PlayerSource;
  interrupts: InterruptSpec[];
  faults: FaultSpec[];
  userPauseRounds: number[];
  maxRounds: number;
  /** Interaction steps per round (PLAN §10.1): the round advances when none is actionable or this many committed. */
  maxStepsPerRound: number;
  /** Immutable committed snapshots, shared by the interaction ledger's derivations. */
  snapshotCache: Map<number, WorldState>;
  maxRetries: number;
  hooks: EngineHooks;
  clock: () => number;
  /** Wall-clock deadline of the run (ms, on `clock`). */
  deadlineAt: number;
  deadlinePollMs: number;
}

export function sessionOf(rt: Runtime): SessionRecord {
  return rt.harness.getSession(rt.sessionId);
}

export function stateOf(rt: Runtime): WorldState {
  return rt.harness.getState(rt.sessionId);
}

export function emit(rt: Runtime, event: EngineEvent): void {
  rt.hooks.onEvent?.(event);
}

export async function hook(rt: Runtime, step: StepName): Promise<void> {
  if (!rt.hooks.onStep) return;
  const s = sessionOf(rt);
  const round = s.round;
  // Interaction step of the round (committed character batches + 1).
  const interactionStep = rt.harness.repo.committedBatches(rt.sessionId).filter((b) => b.kind === 'character' && b.round === round).length + 1;
  await rt.hooks.onStep(step, { sessionId: rt.sessionId, round, epoch: s.epoch, step: interactionStep });
}

export function log(rt: Runtime, kind: string, data: unknown, key: string | null = null): boolean {
  const s = sessionOf(rt);
  return rt.records.log(rt.sessionId, s.round, s.epoch, kind, data, key);
}

/** The interaction ledger's environment for this run. */
export function interactionEnv(rt: Runtime): InteractionEnv {
  return { harness: rt.harness, records: rt.records, sessionId: rt.sessionId, config: rt.config, maxRounds: rt.maxRounds, lang: rt.lang, snapshots: rt.snapshotCache };
}

export function identity(rt: Runtime, round: number, epoch: number, callTag: string): CallIdentity {
  return { sessionId: rt.sessionId, caseId: rt.run.caseId, rep: rt.run.rep, round, epoch, callTag };
}

export function expired(rt: Runtime): boolean {
  return rt.clock() >= rt.deadlineAt;
}

/**
 * An abort signal for outstanding calls: aborted by the harness (epoch change) or by the wall-clock watchdog, which
 * polls the (injectable) clock. `dispose` stops the watchdog.
 */
export function callSignal(rt: Runtime): { signal: AbortSignal; dispose: () => void } {
  const deadline = new AbortController();
  const timer = setInterval(() => {
    if (expired(rt)) deadline.abort(new Error('wall-clock limit of the run reached'));
  }, rt.deadlinePollMs);
  timer.unref?.();
  if (expired(rt)) deadline.abort(new Error('wall-clock limit of the run reached'));
  return {
    signal: AbortSignal.any([rt.harness.signal(rt.sessionId), deadline.signal]),
    dispose: () => clearInterval(timer),
  };
}

/** A fault of `kind` for this round (and target), not yet injected; marks it injected when `consume`. */
export function takeFault(rt: Runtime, kind: FaultKind, round: number, target: string | null, consume = true): FaultSpec | null {
  const spec = rt.faults.find((f) => f.kind === kind && f.round === round && (f.target === null || target === null || f.target === target));
  if (!spec) return null;
  const key = `${kind}:${round}:${spec.target ?? '*'}`;
  if (rt.records.hasLog(rt.sessionId, 'fault', key)) return null;
  if (consume) log(rt, 'fault', { ...spec, injectedFor: target }, key);
  return spec;
}

/** The scripted interrupt for this round and phase that has not fired yet. */
export function pendingInterrupt(rt: Runtime, round: number, phase: InterruptSpec['phase'], step: number | null = null): { spec: InterruptSpec; key: string } | null {
  for (const [i, spec] of rt.interrupts.entries()) {
    if (spec.round !== round || spec.phase !== phase) continue;
    if (spec.step !== undefined && step !== null && spec.step !== step) continue;
    const key = `${round}:${phase}:${i}`;
    if (!rt.records.hasLog(rt.sessionId, 'interrupt', key)) return { spec, key };
  }
  return null;
}

/** Fires a scripted interrupt (harness: accepted while a character batch is open, else queued). */
export function fireInterrupt(rt: Runtime, pending: { spec: InterruptSpec; key: string }): boolean {
  const result = rt.harness.interrupt(rt.sessionId, { text: pending.spec.instruction }, `int.${pending.key}`);
  rt.records.log(rt.sessionId, pending.spec.round, result.epoch, 'interrupt', { ...pending.spec, result }, pending.key);
  emit(rt, { type: 'interrupt', round: pending.spec.round, phase: pending.spec.phase, accepted: result.accepted, instruction: pending.spec.instruction });
  return result.accepted;
}
