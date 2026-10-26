/**
 * Engine types (WP-D, PLAN §10): run options, decision and player-input sources, hooks and the run summary.
 * The engine drives the round lifecycle through the harness (the only writer of world state) and the agents
 * (which only propose); it owns no world state of its own.
 */
import type { Lang } from '../agents/types.js';
import type { ContentBundle } from '../content/loader.js';
import type { CaseConfig, DevConfig } from '../content/schema.js';
import type { ScriptInputLike } from '../core/script.js';
import type { CharId, CoreConfig, DecisionOption, Mode, TerminalKind, TerminalState, WorldState } from '../core/types.js';
import type { CommitResult, DecisionInput, PlayerInput } from '../harness/index.js';
import type { PauseRecord, ProposalRecord } from '../store/repo.js';
import type { PriceTable } from '../llm/prices.js';
import type { LlmClient, LlmRole, UsageSink } from '../llm/types.js';

/**
 * engine.v1: one character step per round (main-live-01, runs/freeze.json). engine.v2: interaction steps within a
 * round driven by the persistent interaction ledger (PLAN §10.1, §10.4).
 */
export const ENGINE_VERSION = 'engine.v2';

/**
 * PLAN §8.4 / §10.1: per-run limits, separate from each other and from the world-round limit (`max_rounds` of the
 * case). Initial engine.v2 values for development and pilot validation: up to 4 interaction steps per round (a
 * question, its answer and the decision that follows fit with one step to spare); 160 calls (main-live-01 used
 * 14–30 calls per run with one step per round; a round with four steps can need 2–3× that); US$0.50 (main-live-01
 * runs cost under US$0.01 each, so the call cap binds first); 30 minutes of wall clock (more sequential steps).
 */
export const DEFAULT_MAX_CALLS = 160;
export const DEFAULT_MAX_USD = 0.5;
export const DEFAULT_WALL_CLOCK_MS = 30 * 60 * 1000;
export const DEFAULT_MAX_STEPS_PER_ROUND = 4;
/** PLAN §10.3 scheduler cap. */
export const MAX_ACTIVE = 4;

/** Execution status of a run (PLAN §8.4): a world terminal, or an execution outcome. */
export type RunOutcome =
  | `valid_terminal:${TerminalKind}`
  | `invalid_terminal:${TerminalKind}`
  | 'max_rounds'
  | 'budget_exhausted'
  | 'error';

/**
 * Why a run stopped without a world terminal (PLAN §8.4): never a world outcome. `max_rounds` = world-round limit;
 * `call_budget` / `cost_budget` = LLM budget (`budget_exhausted`); `wall_clock` = time limit; `error_recovery_stop` =
 * a stop decision after a failed call; `stopped` = any other explicit stop.
 */
export type StopReason = 'max_rounds' | 'call_budget' | 'cost_budget' | 'wall_clock' | 'error_recovery_stop' | 'stopped';

export type CaseLikeConfig = CaseConfig | DevConfig;

export type InterruptPhase = 'generate' | 'assess' | 'decide';

/** Scripted interrupt (dev configs' `interrupts`; tests may add `afterCalls`). */
export interface InterruptSpec {
  round: number;
  phase: InterruptPhase;
  instruction: string;
  /** phase `generate`: fire after this many character calls of the batch have completed (default 1). */
  afterCalls?: number;
  /** Fire only in this interaction step of the round (default: the first step that reaches the phase). */
  step?: number;
}

export type FaultKind = 'duplicate_request' | 'narration_failure' | 'llm_timeout' | 'budget_exhausted';

/** Engine-injected fault (dev configs' `faults`). */
export interface FaultSpec {
  round: number;
  kind: FaultKind;
  /** duplicate_request: `decision`; narration_failure: a scene id; llm_timeout: a character id. */
  target: string | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Decisions (policy or UI)
// ---------------------------------------------------------------------------------------------------------------

export interface DecisionContext {
  sessionId: string;
  mode: Mode;
  lang: Lang;
  round: number;
  pause: PauseRecord;
  /** The paused proposals (for a deadlock pause: the related player-side negotiation proposals). */
  proposals: ProposalRecord[];
  /** Current world state (the paused batch has not committed). */
  state: WorldState;
  config: CoreConfig;
  /**
   * Whether the paused proposals' PLAYER-VISIBLE terms are within the player's current goal limits (undefined: the
   * proposals carry no terms; terms the player cannot see count as not within — see `termsUnknown`).
   */
  withinLimits: boolean | undefined;
  /** Paused proposals whose terms the player cannot see (why), mapped conservatively to `withinLimits: false`. */
  termsUnknown: string[];
  /** `ask` decisions already recorded on this pause. */
  asked: number;
  /** Characters the player may ask while this pause is open (paused actors first, then those present). */
  askable: CharId[];
}

export interface DecisionChoice extends DecisionInput {
  /** Provenance for the engine log (policy rule index, fallback, UI). */
  note?: string;
  /**
   * `ask` only (PLAN §7): the player's question (falls back to `advice`) and, optionally, whom to ask — a living
   * character present at the player's scene or the actor of a paused proposal (default: the paused actor, else the
   * player's principal). The character answers in character (one speech-only `answer` call); the pause stays open.
   */
  question?: string;
  to?: CharId | null;
}

/** Where decisions come from: the case's scripted policy (formal runs) or a user interface. */
export interface DecisionSource {
  decide(ctx: DecisionContext): Promise<DecisionChoice> | DecisionChoice;
}

// ---------------------------------------------------------------------------------------------------------------
// Player inputs (script or UI)
// ---------------------------------------------------------------------------------------------------------------

export interface PlayerContext {
  sessionId: string;
  round: number;
  state: WorldState;
  config: CoreConfig;
  lang: Lang;
}

export interface PlayerTurn {
  /** Scripted inputs (`when` conditions and `"$current"` are evaluated by the harness on the player's knowledge). */
  script?: ScriptInputLike[];
  /** Direct inputs (UI): dialogue and player actions. */
  inputs?: PlayerInput[];
}

/** Supplies the PLAYER step's inputs once per round (the first epoch of the round). */
export interface PlayerSource {
  turn(ctx: PlayerContext): Promise<PlayerTurn> | PlayerTurn;
}

// ---------------------------------------------------------------------------------------------------------------
// Hooks and events
// ---------------------------------------------------------------------------------------------------------------

export type StepName =
  | 'prepare'
  | 'player'
  | 'select'
  | 'generate:opened'
  | 'generate:called'
  | 'generate:submitted'
  | 'assess'
  | 'decide'
  | 'commit'
  | 'narrate'
  | 'advance'
  | 'player:turn';

export interface ActivationView {
  charId: CharId;
  tier: string;
  reason: string;
  agendaIds: string[];
}

export type EngineEvent =
  | { type: 'round'; round: number; day: number; epoch: number }
  | { type: 'system'; kind: 'prepare' | 'advance' | 'outcome'; result: CommitResult; header: string | null }
  | { type: 'player'; round: number; applied: number; skipped: Array<{ index: number; reason: string }> }
  | { type: 'select'; round: number; step: number; active: ActivationView[]; skipped: ActivationView[] }
  | { type: 'step'; round: number; step: number; next: 'step' | 'advance'; reason: string; actionable: string[] }
  | { type: 'proposals'; batchId: string; accepted: boolean; proposals: Array<{ proposalId: string; actor: string; type: string }> }
  | { type: 'judge'; batchId: string; verdicts: Array<{ proposalId: string; verdict: string; category: string | null }> }
  | { type: 'pause'; pause: PauseRecord }
  | { type: 'decision'; pauseId: string; category: string; option: DecisionOption; note: string | null; replayed: boolean }
  | { type: 'commit'; result: CommitResult }
  | { type: 'narration'; batchId: string | null; scene: string; status: string; displayed: string }
  | { type: 'interrupt'; round: number; phase: string; accepted: boolean; instruction: string }
  | { type: 'suspended'; reason: string }
  | { type: 'discarded'; pauseId: string; reason: string }
  | { type: 'answer'; pauseId: string; charId: CharId; question: string; text: string; outcome: 'answered' | 'blocked' | 'no_answer'; dialogueSeq: number }
  | { type: 'terminal'; terminal: TerminalState }
  | { type: 'outcome'; outcome: RunOutcome; detail: string | null }
  | { type: 'log'; message: string };

export interface EngineHooks {
  /**
   * Called at step boundaries (outside any transaction); throwing simulates a crash of the process. `step` is the
   * interaction step of the round (PLAN §10.1).
   */
  onStep?(step: StepName, info: { sessionId: string; round: number; epoch: number; step: number }): void | Promise<void>;
  /** Progress events (CLI display, tests). */
  onEvent?(event: EngineEvent): void;
}

// ---------------------------------------------------------------------------------------------------------------
// Options and summary
// ---------------------------------------------------------------------------------------------------------------

export interface EngineOptions {
  content: ContentBundle;
  /** The LLM client (the engine wraps it in a per-run BudgetedClient). */
  llm: LlmClient;
  lang?: Lang;
  /** Decision source; default: the case's `decision_policy`. */
  decisions?: DecisionSource;
  /** Player-input source; default: the case's `script`. */
  players?: PlayerSource;
  /** Milliseconds clock (injectable; wall-clock limit and timestamps). */
  clock?: () => number;
  wallClockLimitMs?: number;
  budget?: { maxCalls?: number; maxUsd?: number };
  /** Interaction steps per round (default DEFAULT_MAX_STEPS_PER_ROUND). */
  interaction?: { maxStepsPerRound?: number };
  /** Model slugs per role, recorded in the run metadata (default: `pricing.models`, or `mock` for the mock LLM). */
  models?: Partial<Record<LlmRole, string>>;
  /**
   * Effective model slugs, output caps, prices and HTTP retries used for the run budget's worst-case reservations
   * (live runs: from the AppConfig, `requirePrice: true`). Default: the mock LLM is unpriced (cost 0); any other
   * client requires a price bound for the resolved model or its calls are refused.
   */
  pricing?: PricingOptions;
  /** Poll interval of the wall-clock watchdog that aborts outstanding calls on expiry (default 500 ms). */
  deadlinePollMs?: number;
  /** error_recovery retries per actor and batch before `skip_actor` is forced. */
  maxRetries?: number;
  /** Interrupts / faults; default: the dev config's `interrupts` / `faults` (none for cases). */
  interrupts?: InterruptSpec[];
  faults?: FaultSpec[];
  /** Rounds at whose start a user_requested pause is opened (resolved by the decision source). */
  userPauseRounds?: number[];
  /** Budget exhaustion or wall-clock limit: stop the run (headless, default) or leave it suspended (interactive). */
  onLimit?: 'stop' | 'suspend';
  hooks?: EngineHooks;
}

export interface PricingOptions {
  models?: Partial<Record<LlmRole, string>>;
  maxTokens?: Partial<Record<LlmRole, number>>;
  prices?: PriceTable;
  httpRetries?: number;
  requirePrice?: boolean;
}

export interface CreateRunInput {
  sessionId: string;
  caseId: string;
  mode: Mode;
  rep: number;
}

export interface RunSummary {
  sessionId: string;
  caseId: string;
  mode: Mode;
  rep: number;
  lang: Lang;
  seed: number;
  outcome: RunOutcome | null;
  outcomeDetail: string | null;
  status: string;
  terminal: TerminalState | null;
  /** Rounds started (PREPARE recorded). */
  rounds: number;
  finalRound: number;
  version: number;
  finalHash: string;
  epochs: number;
  calls: number;
  refusedCalls: number;
  callsByRole: Record<string, number>;
  costUsd: number;
  /** USD charged by the run's budget ledger (unknown-cost and unfinished calls at their worst case). */
  budgetChargedUsd: number;
  proposals: Record<string, number>;
  pauses: Record<string, number>;
  decisions: number;
  narrations: Record<string, number>;
  hashes: { content: string; rules: string; prompts: string };
  engineVersion: string;
  /** Committed interaction steps (all rounds) and per round. */
  steps: number;
  stepsByRound: Record<string, number>;
  /** Execution stop without a world terminal (null for a terminal or an unfinished run). */
  stopReason: StopReason | null;
  /** Interaction items (PLAN §10.4): created, unresolved at the end, by kind. */
  items: { created: number; unresolved: number; unresolvedByKind: Record<string, number> };
  /** Effective limits of the run (including recorded budget extensions). */
  limits: { maxRounds: number; maxStepsPerRound: number; maxCalls: number; maxUsd: number; wallClockMs: number };
}

/** `llm` may be given as a factory receiving the run database's usage sink (so llm_calls land in the run DB). */
export type LlmFactory = LlmClient | ((sink: UsageSink) => LlmClient);
