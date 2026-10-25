/**
 * Engine sessions (PLAN §10, §8.4, §8.5): create a run from a case/dev/pilot config, drive the round lifecycle to a
 * run outcome, and recover, resume, interrupt, save (named checkpoints), load and branch.
 *
 * - Metadata: the harness session records the mode, seed and content/rule/prompt hashes; `engine_runs` adds case,
 *   rep, language, model slugs, engine version and lineage.
 * - Seeds are deterministic per (case, rep); mock personas derive theirs from (case, rep, actor, round, epoch,
 *   callTag), so the same (case, rep, mode) replays to identical world hashes.
 * - Limits: per-run budget (100 calls / US$0.50 by default) through a `BudgetedClient` keyed by the session and
 *   configured with the effective model slugs, output caps and prices (worst-case reservations; live runs require a
 *   price bound). Every call is written to a persistent ledger (`engine_charges`) before it starts, so a restarted
 *   run restores calls and USD exactly as charged — unknown-cost and interrupted calls at their worst case. A
 *   wall-clock limit (20 min, injectable clock) is checked after every awaited step, before commits and before
 *   completion; a watchdog aborts outstanding calls when it expires. Hitting a limit suspends the run (batch,
 *   pauses and pending narration preserved); headless runs then stop with `budget_exhausted` or `error`.
 * - Continuation is derived from committed facts (round prepared? PLAYER done since the last interrupt? character
 *   batch committed?), never from the phase a recovery reports, so a narration backlog can never skip a round.
 * - Recovery: opening an existing session runs `harness.recover` (a crashed generating batch becomes stale and the
 *   epoch is bumped, so the round regenerates; paused batches keep their pauses; unnarrated batches are narrated).
 * - Baseline isolation: a database holds either baseline runs or Harness-mode runs, never both.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildNames } from '../agents/names.js';
import { promptSetHash } from '../agents/prompts/index.js';
import { caseCoreConfig, caseInitialState, effectiveCharacter, findCase, type ContentBundle } from '../content/loader.js';
import type { CharacterConfig } from '../content/schema.js';
import { hashState, hashValue } from '../core/hash.js';
import { seedFrom } from '../core/rng.js';
import { CHAR_IDS, type CharId, type TerminalState } from '../core/types.js';
import type { Harness, InterruptResult } from '../harness/index.js';
import { BudgetedClient } from '../llm/budget.js';
import { MockLlmClient, MOCK_MODEL } from '../llm/mock/index.js';
import { DEFAULT_PRICES } from '../llm/prices.js';
import type { LlmClient, LlmRequest } from '../llm/types.js';
import {
  WALL_CLOCK,
  advanceStep,
  characterCommitted,
  commitStep,
  decideStep,
  generateStep,
  limitStep,
  linkJudgeLogs,
  narratePending,
  playerDone,
  playerStep,
  prepareStep,
  roundPrepared,
  userPauseStep,
  type LimitReached,
  type StepSignal,
} from './lifecycle.js';
import { PolicyDecisionSource } from './policy.js';
import { EngineRecords, type CheckpointRecord, type RunRecord } from './records.js';
import { EngineError, RefusingClient, TrackingClient, emit, expired, log, sessionOf, stateOf, type Runtime } from './runtime.js';
import {
  DEFAULT_MAX_CALLS,
  DEFAULT_MAX_USD,
  DEFAULT_WALL_CLOCK_MS,
  ENGINE_VERSION,
  type CaseLikeConfig,
  type CreateRunInput,
  type EngineOptions,
  type PlayerSource,
  type PricingOptions,
  type RunOutcome,
  type RunSummary,
} from './types.js';

const contentHashes = new WeakMap<ContentBundle, string>();

/** Hash of the whole content bundle (scenario, characters, cases, dev, pilot, traces, sources). */
export function contentHash(content: ContentBundle): string {
  let h = contentHashes.get(content);
  if (!h) {
    const { root: _root, ...rest } = content;
    h = hashValue(JSON.parse(JSON.stringify(rest)) as unknown);
    contentHashes.set(content, h);
  }
  return h;
}

/** Deterministic seed of a run: (case, rep). */
export function runSeed(caseId: string, rep: number): number {
  return seedFrom('jinyang-run', caseId, rep);
}

/** The case's scripted player inputs (one entry per round). */
export function scriptPlayerSource(caseConfig: CaseLikeConfig): PlayerSource {
  return { turn: (ctx) => ({ script: caseConfig.script.find((s) => s.round === ctx.round)?.inputs ?? [] }) };
}

function isMock(llm: LlmClient): boolean {
  let current: unknown = llm;
  for (let i = 0; i < 5 && current; i++) {
    if (current instanceof MockLlmClient) return true;
    current = (current as { inner?: unknown }).inner;
  }
  return false;
}

/** Effective pricing of a run: the mock LLM is unpriced (cost 0); any other client needs price bounds. */
export function effectivePricing(llm: LlmClient, opts: Pick<EngineOptions, 'pricing' | 'models'>): Required<Omit<PricingOptions, 'maxTokens'>> & Pick<PricingOptions, 'maxTokens'> {
  const mock = isMock(llm);
  const models = { ...(mock ? { character: MOCK_MODEL, judge: MOCK_MODEL, narrator: MOCK_MODEL, mapper: MOCK_MODEL } : {}), ...(opts.models ?? {}), ...(opts.pricing?.models ?? {}) };
  return {
    models,
    ...(opts.pricing?.maxTokens ? { maxTokens: opts.pricing.maxTokens } : {}),
    prices: opts.pricing?.prices ?? DEFAULT_PRICES,
    httpRetries: opts.pricing?.httpRetries ?? 2,
    requirePrice: opts.pricing?.requirePrice ?? !mock,
  };
}

/**
 * The run's budget guard, restored from the persistent ledger: remaining calls/USD after everything already
 * charged (unknown-cost and unfinished calls at their worst case), with worst-case reservations computed from the
 * effective model slugs, output caps and prices.
 */
export function restoreBudgetClient(harness: Harness, records: EngineRecords, sessionId: string, llm: LlmClient, opts: EngineOptions): TrackingClient {
  const maxCalls = opts.budget?.maxCalls ?? DEFAULT_MAX_CALLS;
  const maxUsd = opts.budget?.maxUsd ?? DEFAULT_MAX_USD;
  const used = records.usedBudget(sessionId);
  const remainingCalls = maxCalls - used.calls;
  const remainingUsd = maxUsd - used.usd;
  const pricing = effectivePricing(llm, opts);
  const resolveModel = (req: LlmRequest<unknown>): string | undefined => req.model ?? (pricing.models as Record<string, string | undefined>)[req.role];
  const resolveMaxTokens = (req: LlmRequest<unknown>): number | undefined => req.maxTokens ?? pricing.maxTokens?.[req.role];
  const ledger = {
    begin: (role: string, reservedUsd: number) => records.chargeBegin(sessionId, role, reservedUsd),
    end: (id: number, c: { status: 'done' | 'refused'; chargedUsd: number; attempts: number; unknownCost: boolean }) => records.chargeEnd(id, c),
  };
  if (remainingCalls <= 0 || !(remainingUsd > 0)) {
    return new TrackingClient(new RefusingClient(`run budget already spent: ${used.calls} calls, $${used.usd.toFixed(6)}`), { ...ledger, reservation: () => 0 });
  }
  const budgeted = new BudgetedClient(
    llm,
    { maxCallsPerSession: remainingCalls, maxUsdPerSession: remainingUsd },
    {
      sink: harness.usageSink(sessionId),
      resolveModel,
      resolveMaxTokens,
      fallbackMaxTokens: 4096,
      httpRetries: pricing.httpRetries,
      prices: pricing.prices,
      requirePrice: pricing.requirePrice,
    },
  );
  return new TrackingClient(budgeted, { ...ledger, reservation: (req) => budgeted.reservationUsd(req) ?? 0 });
}

function personasOf(content: ContentBundle, caseConfig: CaseLikeConfig): Record<CharId, CharacterConfig> {
  const out = {} as Record<CharId, CharacterConfig>;
  for (const id of CHAR_IDS) out[id] = effectiveCharacter(content, caseConfig, id);
  return out;
}

function stopOutcome(runOutcome: string | null): RunOutcome {
  return runOutcome === 'max_rounds' || runOutcome === 'budget_exhausted' ? runOutcome : 'error';
}

export class EngineSession {
  readonly rt: Runtime;
  private readonly options: EngineOptions;

  private constructor(rt: Runtime, options: EngineOptions) {
    this.rt = rt;
    this.options = options;
  }

  get sessionId(): string {
    return this.rt.sessionId;
  }

  get harness(): Harness {
    return this.rt.harness;
  }

  get records(): EngineRecords {
    return this.rt.records;
  }

  // ------------------------------------------------------------------------------------------------------------
  // Construction
  // ------------------------------------------------------------------------------------------------------------

  /** Creates a new run (session) for a case/dev/pilot config. */
  static create(harness: Harness, opts: EngineOptions, input: CreateRunInput): EngineSession {
    const records = new EngineRecords(harness.store);
    const clock = opts.clock ?? Date.now;
    const modes = records.modes();
    if (input.mode === 'baseline' ? modes.some((m) => m !== 'baseline') : modes.includes('baseline')) {
      throw new EngineError(`baseline runs use an isolated database (this one holds ${modes.join(', ')} runs)`);
    }
    const caseConfig = findCase(opts.content, input.caseId);
    const config = caseCoreConfig(opts.content, input.caseId);
    const initialState = caseInitialState(opts.content, input.caseId);
    const seed = runSeed(input.caseId, input.rep);
    const hashes = { content: contentHash(opts.content), rules: hashValue(config), prompts: promptSetHash() };
    harness.createSession(
      { sessionId: input.sessionId, mode: input.mode, caseId: input.caseId, config, initialState, rngSeed: seed, hashes },
      `create:${input.sessionId}`,
    );
    const now = clock();
    records.insertRun({
      sessionId: input.sessionId,
      caseId: caseConfig.id,
      rep: input.rep,
      mode: input.mode,
      lang: opts.lang ?? 'zh',
      seed,
      contentHash: hashes.content,
      rulesHash: hashes.rules,
      promptHash: hashes.prompts,
      models: effectivePricing(opts.llm, opts).models as Record<string, string>,
      engineVersion: ENGINE_VERSION,
      parentSessionId: null,
      startedAtMs: now,
      outcome: null,
      outcomeDetail: null,
      updatedAtMs: now,
    });
    return EngineSession.open(harness, opts, input.sessionId);
  }

  /** Opens an existing run; unfinished sessions are recovered first (restart after a crash). */
  static open(harness: Harness, opts: EngineOptions, sessionId: string): EngineSession {
    const records = new EngineRecords(harness.store);
    const run = records.findRun(sessionId);
    if (!run) throw new EngineError(`no engine run ${sessionId} in this database`);
    const caseConfig = findCase(opts.content, run.caseId);
    const session = harness.getSession(sessionId);
    const personas = personasOf(opts.content, caseConfig);
    const rt: Runtime = {
      harness,
      records,
      sessionId,
      run,
      content: opts.content,
      caseConfig,
      config: session.config,
      mode: session.mode,
      lang: run.lang,
      personas,
      names: buildNames(opts.content, personas),
      client: restoreBudgetClient(harness, records, sessionId, opts.llm, opts),
      decisions: opts.decisions ?? new PolicyDecisionSource(caseConfig.decision_policy),
      players: opts.players ?? scriptPlayerSource(caseConfig),
      interrupts: opts.interrupts ?? ('interrupts' in caseConfig ? caseConfig.interrupts : []),
      faults: opts.faults ?? ('faults' in caseConfig ? caseConfig.faults : []),
      userPauseRounds: opts.userPauseRounds ?? [],
      maxRounds: caseConfig.max_rounds,
      maxRetries: opts.maxRetries ?? 2,
      hooks: opts.hooks ?? {},
      clock: opts.clock ?? Date.now,
      deadlineAt: run.startedAtMs + (opts.wallClockLimitMs ?? DEFAULT_WALL_CLOCK_MS),
      deadlinePollMs: opts.deadlinePollMs ?? 500,
    };
    const engine = new EngineSession(rt, opts);
    // Backfill Judge links of records written before a crash (idempotent; derived from stored proposals/revisions).
    const linked = linkJudgeLogs(rt);
    if (linked > 0) log(rt, 'judge_links_backfilled', { records: linked });
    if (session.status !== 'finished' && session.status !== 'stopped') {
      const report = harness.recover(sessionId, `recover.${session.controlSeq}`);
      if (report.staleBatches.length > 0 || report.restoredPauses.length > 0 || report.narrationPending.length > 0) {
        log(rt, 'recovered', report);
      }
    }
    return engine;
  }

  /** Branches a run at a round start (PLAN §8.5); the child resumes at PREPARE of that round. */
  static branch(harness: Harness, opts: EngineOptions, parentSessionId: string, round: number, newSessionId: string): EngineSession {
    const records = new EngineRecords(harness.store);
    const parent = records.findRun(parentSessionId);
    if (!parent) throw new EngineError(`no engine run ${parentSessionId}`);
    const result = harness.branch(parentSessionId, round, newSessionId, `branch:${newSessionId}`);
    const now = (opts.clock ?? Date.now)();
    records.insertRun({ ...parent, sessionId: newSessionId, parentSessionId, startedAtMs: now, outcome: null, outcomeDetail: null, updatedAtMs: now });
    // The scheduler's history before the branch round is part of the child's past (carry-forward, agendas).
    const inherited = records
      .activations(parentSessionId, { beforeRound: round })
      .map(({ inherited: _i, ...a }) => ({ ...a, sessionId: newSessionId }));
    records.insertActivations(inherited, true);
    records.log(newSessionId, round, 0, 'branched', { parentSessionId, round, version: result.version });
    return EngineSession.open(harness, opts, newSessionId);
  }

  /** Loads a named checkpoint as a new session (a branch at the checkpoint's round start). */
  static load(harness: Harness, opts: EngineOptions, name: string, newSessionId: string, fromSessionId?: string): EngineSession {
    const records = new EngineRecords(harness.store);
    const cp = records.findCheckpoint(name, fromSessionId);
    if (!cp) throw new EngineError(`no checkpoint named ${name}`);
    return EngineSession.branch(harness, opts, cp.sessionId, cp.round, newSessionId);
  }

  // ------------------------------------------------------------------------------------------------------------
  // Driving the lifecycle
  // ------------------------------------------------------------------------------------------------------------

  /** Runs until a run outcome (or a suspension that the options leave in place). */
  async run(maxSteps = 10_000): Promise<RunSummary> {
    for (let i = 0; i < maxSteps; i++) {
      const more = await this.harness.mutex.run(this.sessionId, () => this.step());
      if (!more) return this.summary();
    }
    throw new EngineError(`run did not finish within ${maxSteps} steps`);
  }

  /** One lifecycle step; false when the run has an outcome (or is left suspended). */
  async step(): Promise<boolean> {
    const rt = this.rt;
    // A finalized run keeps its outcome: reopening it never re-applies deadlines, budgets or completion (idempotent).
    if (this.records.findRun(this.sessionId)?.outcome) return false;
    const session = sessionOf(rt);
    const state = stateOf(rt);
    if (session.status === 'stopped') {
      this.finish(stopOutcome(session.runOutcome), this.lastSuspendReason());
      return false;
    }
    if (session.status === 'suspended') {
      if (this.stopOnLimit()) {
        const limit = this.lastLimit() ?? { outcome: 'error' as const, reason: 'suspended' };
        this.harness.stop(this.sessionId, limit.outcome, `stop.${session.controlSeq}`);
        return true;
      }
      return false;
    }
    // The deadline is checked before anything else, including completion.
    if (expired(rt)) return this.handle(WALL_CLOCK);
    if (state.terminal) {
      const limit = await narratePending(rt);
      if (limit) return this.handle(limit);
      if (expired(rt)) return this.handle(WALL_CLOCK);
      this.finishTerminal(state.terminal);
      return false;
    }
    if (this.harness.openPauses(this.sessionId).length > 0) return this.handle(await decideStep(rt));
    const open = this.harness.repo.openBatches(this.sessionId);
    const first = open[0];
    if (first) {
      if (first.status === 'assessed') {
        await commitStep(rt, first);
        return true;
      }
      // A generating batch whose GENERATE is not running (crash, suspension): recovery regenerates the round.
      const report = this.harness.recover(this.sessionId, `recover.${session.controlSeq}`);
      log(rt, 'recovered', report);
      return true;
    }
    // Continuation from committed facts (never from a recovered phase: a narration backlog cannot skip a round).
    const round = state.round;
    if (!roundPrepared(rt, round)) {
      if (round > rt.maxRounds) {
        const limit = await narratePending(rt);
        if (limit) return this.handle(limit);
        this.harness.stop(this.sessionId, 'max_rounds', `stop.${session.controlSeq}`);
        return true;
      }
      if (userPauseStep(rt, round)) return true;
      await prepareStep(rt);
      return true;
    }
    if (characterCommitted(rt, round)) {
      const limit = await narratePending(rt);
      if (limit) return this.handle(limit);
      if (expired(rt)) return this.handle(WALL_CLOCK);
      await advanceStep(rt);
      return true;
    }
    if (!playerDone(rt, round)) {
      const limit = await playerStep(rt);
      return limit ? this.handle(limit) : true;
    }
    return this.handle(await generateStep(rt));
  }

  private stopOnLimit(): boolean {
    return (this.options.onLimit ?? 'stop') === 'stop';
  }

  private handle(signal: StepSignal | LimitReached): boolean {
    if (typeof signal === 'object') limitStep(this.rt, signal, this.stopOnLimit());
    return true;
  }

  private lastLimit(): LimitReached | null {
    const entry = this.records.logs(this.sessionId, 'suspended').at(-1);
    return entry ? (entry.data as LimitReached) : null;
  }

  private lastSuspendReason(): string | null {
    return this.lastLimit()?.reason ?? null;
  }

  private finishTerminal(terminal: TerminalState): void {
    const valid = this.rt.caseConfig.valid_terminals.includes(terminal.kind);
    emit(this.rt, { type: 'terminal', terminal });
    this.finish(valid ? `valid_terminal:${terminal.kind}` : `invalid_terminal:${terminal.kind}`, null);
  }

  private finish(outcome: RunOutcome, detail: string | null): void {
    const run = this.records.findRun(this.sessionId);
    if (run?.outcome === outcome && run.outcomeDetail === detail) return;
    this.records.setOutcome(this.sessionId, outcome, detail, this.rt.clock());
    emit(this.rt, { type: 'outcome', outcome, detail });
  }

  // ------------------------------------------------------------------------------------------------------------
  // Control API (UI / server)
  // ------------------------------------------------------------------------------------------------------------

  /** Player instruction (PLAN §8.3): interrupts an open character batch, else queued for the next PLAYER step. */
  interrupt(text: string): InterruptResult {
    const seq = sessionOf(this.rt).controlSeq;
    const result = this.harness.interrupt(this.sessionId, { text }, `int.user.${seq}`);
    log(this.rt, 'interrupt', { text, result }, null);
    emit(this.rt, { type: 'interrupt', round: stateOf(this.rt).round, phase: sessionOf(this.rt).phase, accepted: result.accepted, instruction: text });
    return result;
  }

  /** Resumes a suspended run (retry); the next step recovers any batch left generating. */
  resume(): void {
    const session = sessionOf(this.rt);
    this.harness.resume(this.sessionId, `resume.${session.controlSeq}`);
    this.rt.client = restoreBudgetClient(this.harness, this.records, this.sessionId, this.options.llm, this.options);
    // A resumed run gets a fresh wall-clock window (in memory; a reopened run measures from its start).
    this.rt.deadlineAt = this.rt.clock() + (this.options.wallClockLimitMs ?? DEFAULT_WALL_CLOCK_MS);
    this.records.setOutcome(this.sessionId, null, null, this.rt.clock());
  }

  /** Named checkpoint at the latest round start (a quiescent version). */
  save(name: string): CheckpointRecord {
    const start = this.harness.repo.listRoundStarts(this.sessionId).at(-1);
    if (!start) throw new EngineError('no round has started yet; nothing to save');
    const cp: CheckpointRecord = { sessionId: this.sessionId, name, round: start.round, version: start.version, createdAtMs: this.rt.clock() };
    this.records.saveCheckpoint(cp);
    return cp;
  }

  /** Consistent copy of the whole run database (`VACUUM INTO`). */
  saveDatabase(destPath: string): string {
    return this.harness.exportDatabase(destPath);
  }

  branch(round: number, newSessionId: string): EngineSession {
    return EngineSession.branch(this.harness, this.options, this.sessionId, round, newSessionId);
  }

  // ------------------------------------------------------------------------------------------------------------
  // Reporting
  // ------------------------------------------------------------------------------------------------------------

  summary(): RunSummary {
    const rt = this.rt;
    const session = sessionOf(rt);
    const state = stateOf(rt);
    const run = this.records.findRun(this.sessionId) as RunRecord;
    const repo = this.harness.repo;
    const count = <T>(items: readonly T[], key: (t: T) => string): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
      return out;
    };
    const calls = this.harness.store.db
      .prepare('SELECT role, attempts, cost_usd FROM llm_calls WHERE session_id = ?')
      .all(this.sessionId) as Array<{ role: string; attempts: number; cost_usd: number | null }>;
    const made = calls.filter((c) => Number(c.attempts) > 0);
    const charged = this.records.usedBudget(this.sessionId);
    return {
      sessionId: this.sessionId,
      caseId: run.caseId,
      mode: session.mode,
      rep: run.rep,
      lang: run.lang,
      seed: run.seed,
      outcome: run.outcome as RunOutcome | null,
      outcomeDetail: run.outcomeDetail,
      status: session.status,
      terminal: state.terminal,
      rounds: repo.listRoundStarts(this.sessionId).length,
      finalRound: state.terminal?.round ?? repo.listRoundStarts(this.sessionId).at(-1)?.round ?? state.round,
      version: state.version,
      finalHash: hashState(state),
      epochs: session.epoch,
      calls: made.length,
      refusedCalls: calls.length - made.length,
      callsByRole: count(made, (c) => c.role),
      costUsd: made.reduce((s, c) => s + (c.cost_usd === null ? 0 : Number(c.cost_usd)), 0),
      budgetChargedUsd: charged.usd,
      proposals: count(repo.listSessionProposals(this.sessionId), (p) => p.status),
      pauses: count(repo.listPauses(this.sessionId), (p) => p.category),
      decisions: repo.listSessionDecisions(this.sessionId).length,
      narrations: count(repo.listNarrations(this.sessionId), (n) => n.status),
      hashes: { content: run.contentHash, rules: run.rulesHash, prompts: run.promptHash },
    };
  }

  /** Harness audit bundle plus the engine records (`engine.json`) and the run summary (`summary.json`). */
  exportAudit(dir: string): string[] {
    const files = this.harness.exportAudit(this.sessionId, dir);
    const engineFile = path.join(dir, 'engine.json');
    const exported = this.records.exportSession(this.sessionId);
    writeFileSync(engineFile, `${JSON.stringify(exported, null, 2)}\n`, 'utf8');
    // Judge-REVISE originals and replacements (never executed), one envelope per line, for evaluation inputs.
    const revisionsFile = path.join(dir, 'revisions.jsonl');
    writeFileSync(revisionsFile, exported.revisions.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf8');
    const summaryFile = path.join(dir, 'summary.json');
    writeFileSync(summaryFile, `${JSON.stringify(this.summary(), null, 2)}\n`, 'utf8');
    return [...files, engineFile, revisionsFile, summaryFile];
  }
}
