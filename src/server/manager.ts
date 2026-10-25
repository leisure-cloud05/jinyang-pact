/**
 * Session manager: owns the play databases (one writer process: the harness lock enforces it), the content, the
 * LLM factory and one `PlayController` per open session.
 *
 * - Harness-mode sessions (`full`, `no_judge`) live in the play DB (`data/play.sqlite` by default); `baseline`
 *   sessions live in a sibling DB (`<name>.baseline.sqlite`) because a database holds either baseline or Harness-mode
 *   runs, never both (engine rule).
 * - LLM: the offline mock personas by default; live OpenRouter calls only when the server was started with `--live`
 *   AND `LLM_PROVIDER=openrouter` (checked once at start-up by the entry point; `live` is then a loaded config).
 * - Sessions are opened lazily on first access (engine recovery runs then) and their controller starts driving the
 *   engine until it waits for the player or a decision.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { registerMockPersonas } from '../agents/mock-personas/index.js';
import type { Lang } from '../agents/types.js';
import type { AppConfig } from '../config/env.js';
import { findCase, type ContentBundle } from '../content/loader.js';
import type { Mode } from '../core/types.js';
import {
  CallbackDecisionSource,
  EngineRecords,
  EngineSession,
  defaultContent,
  type EngineOptions,
  type RunRecord,
} from '../engine/index.js';
import { Harness } from '../harness/index.js';
import { createLlmClient } from '../llm/client.js';
import { MockLlmClient, MOCK_MODEL, type MockLlmClientOptions } from '../llm/mock/index.js';
import type { LlmClient } from '../llm/types.js';
import type { SessionInfo, SessionListItem, ViewMode } from './api-types.js';
import { configKind, withFreePlay } from './content.js';
import { buildCtx, type SessionCtx } from './context.js';
import { PlayController } from './controller.js';
import { ApiError } from './errors.js';
import { SseHub } from './sse.js';
import { ServerStore, type DbName, type SessionMeta } from './store.js';

export const DEFAULT_PLAY_DB = path.join('data', 'play.sqlite');
/** Interactive play: a human's thinking time counts toward the engine's wall-clock limit, so it is generous. */
export const PLAY_WALL_CLOCK_MS = 12 * 60 * 60 * 1000;

export interface ManagerOptions {
  dbPath: string;
  baselineDbPath?: string;
  content?: ContentBundle;
  /** Loaded live configuration (only when `--live` and LLM_PROVIDER=openrouter); null: mock only. */
  live?: AppConfig | null;
  liveProblem?: string | null;
  /** `--director`: director views are never locked (development). */
  directorOpen?: boolean;
  defaultLang?: Lang;
  clock?: () => number;
  harnessClock?: () => string;
  mockOptions?: Omit<MockLlmClientOptions, 'sink'>;
  /** Mock LLM only: extra handlers registered after the personas (tests).*/
  mockSetup?: (mock: MockLlmClient) => void;
  wallClockLimitMs?: number;
  budget?: { maxCalls?: number; maxUsd?: number };
}

export function baselineDbFor(dbPath: string): string {
  const ext = path.extname(dbPath);
  return `${dbPath.slice(0, dbPath.length - ext.length)}.baseline${ext || '.sqlite'}`;
}

/** Deterministic id of the session a create request makes (known before it exists: write-ahead intent). */
export function createdSessionId(caseId: string, mode: string, requestId: string): string {
  return `${caseId}-${mode}-${shortHash(`create:${requestId}`)}`;
}

/** Deterministic id of the session a branch/load request makes. */
export function branchedSessionId(caseId: string, mode: string, parentId: string, round: number, requestId: string): string {
  return `${caseId}-${mode}-r${round}b-${shortHash(`branch:${parentId}:${requestId}`)}`;
}

function shortHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);
}

export interface CreateInput {
  caseId: string;
  mode: Mode;
  lang: Lang;
  llm: 'mock' | 'live';
  script: boolean;
  director: boolean;
}

export class SessionManager {
  readonly content: ContentBundle;
  readonly hub = new SseHub();
  readonly main: Harness;
  readonly store: ServerStore;
  readonly live: AppConfig | null;
  readonly liveProblem: string | null;
  readonly directorOpen: boolean;
  readonly defaultLang: Lang;
  private readonly opts: ManagerOptions;
  private readonly baselinePath: string;
  private baseline: Harness | null = null;
  private readonly recordsByHarness = new Map<Harness, EngineRecords>();
  private readonly controllers = new Map<string, PlayController>();
  private closed = false;

  constructor(opts: ManagerOptions) {
    this.opts = opts;
    this.content = withFreePlay(opts.content ?? defaultContent());
    this.live = opts.live ?? null;
    this.liveProblem = this.live ? null : (opts.liveProblem ?? 'the server was started without --live (mock LLM only)');
    this.directorOpen = opts.directorOpen ?? false;
    this.defaultLang = opts.defaultLang ?? 'zh';
    this.main = Harness.open(opts.dbPath, opts.harnessClock ? { clock: opts.harnessClock } : {});
    this.store = new ServerStore(this.main.store);
    this.baselinePath = opts.baselineDbPath ?? baselineDbFor(opts.dbPath);
    if (existsSync(this.baselinePath)) this.harnessOf('baseline');
  }

  // ------------------------------------------------------------------------------------------------------------
  // Databases and lookups
  // ------------------------------------------------------------------------------------------------------------

  harnessOf(db: DbName): Harness {
    if (db === 'main') return this.main;
    this.baseline ??= Harness.open(this.baselinePath, this.opts.harnessClock ? { clock: this.opts.harnessClock } : {});
    return this.baseline;
  }

  recordsOf(harness: Harness): EngineRecords {
    let r = this.recordsByHarness.get(harness);
    if (!r) {
      r = new EngineRecords(harness.store);
      this.recordsByHarness.set(harness, r);
    }
    return r;
  }

  private now(): number {
    return (this.opts.clock ?? Date.now)();
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }

  /** The session's metadata, database and run record (sessions found in a play DB without metadata are adopted). */
  locate(sessionId: string): { harness: Harness; meta: SessionMeta; run: RunRecord } {
    if (this.closed) throw new ApiError(503, 'closing', 'the server is shutting down');
    const meta = this.store.findSession(sessionId);
    if (meta) {
      const harness = this.harnessOf(meta.db);
      const run = this.recordsOf(harness).findRun(sessionId);
      if (!run) throw new ApiError(404, 'unknown_session', `session ${sessionId} has no engine run`);
      return { harness, meta, run };
    }
    for (const db of ['main', 'baseline'] as const) {
      if (db === 'baseline' && !this.baseline) continue;
      const harness = this.harnessOf(db);
      const run = this.recordsOf(harness).findRun(sessionId);
      if (!run) continue;
      const adopted: SessionMeta = {
        sessionId,
        db,
        llm: run.models.character === undefined || run.models.character === MOCK_MODEL ? 'mock' : 'live',
        script: false,
        directorUnlockedRound: null,
        createdAt: new Date(run.startedAtMs).toISOString(),
        origin: 'external',
      };
      this.store.insertSession(adopted);
      return { harness, meta: adopted, run };
    }
    throw new ApiError(404, 'unknown_session', `no session ${sessionId}`);
  }

  ctx(sessionId: string): SessionCtx {
    const { harness, meta, run } = this.locate(sessionId);
    return buildCtx(harness, this.recordsOf(harness), this.content, meta, run);
  }

  ended(ctx: SessionCtx): boolean {
    const run = this.recordsOf(ctx.harness).findRun(ctx.sessionId);
    return (run?.outcome ?? null) !== null || ctx.state.terminal !== null || ctx.session.status === 'finished' || ctx.session.status === 'stopped';
  }

  directorAllowed(ctx: SessionCtx): boolean {
    return this.directorOpen || ctx.meta.directorUnlockedRound !== null || this.ended(ctx);
  }

  unlockDirector(sessionId: string): SessionCtx {
    const ctx = this.ctx(sessionId);
    this.store.unlockDirector(sessionId, ctx.state.round);
    return this.ctx(sessionId);
  }

  // ------------------------------------------------------------------------------------------------------------
  // Controllers
  // ------------------------------------------------------------------------------------------------------------

  private newController(meta: SessionMeta, harness: Harness, caseId: string): PlayController {
    const caseConfig = findCase(this.content, caseId);
    const records = this.recordsOf(harness);
    const unavailable =
      meta.llm === 'live' && !this.live
        ? 'This session uses live model calls: restart the server with --live (and LLM_PROVIDER=openrouter) to continue it. It can still be reviewed.'
        : null;
    return new PlayController({
      sessionId: meta.sessionId,
      harness,
      meta,
      hub: this.hub,
      scriptFor: (round) => [...(caseConfig.script.find((s) => s.round === round)?.inputs ?? [])],
      policy: caseConfig.decision_policy,
      unavailable,
      suspendedReason: () => {
        const entry = records.logs(meta.sessionId, 'suspended').at(-1);
        const reason = (entry?.data as { reason?: unknown } | undefined)?.reason;
        return typeof reason === 'string' ? reason : null;
      },
      outcome: () => {
        const run = records.findRun(meta.sessionId);
        return { outcome: run?.outcome ?? null, detail: run?.outcomeDetail ?? null };
      },
    });
  }

  private llmFor(meta: SessionMeta, harness: Harness): LlmClient {
    const sink = harness.usageSink(meta.sessionId);
    if (meta.llm === 'live') {
      if (!this.live) throw new ApiError(409, 'live_unavailable', this.liveProblem ?? 'live calls are not available');
      return createLlmClient(this.live, sink);
    }
    const mock = new MockLlmClient({ ...(this.opts.mockOptions ?? {}), sink });
    registerMockPersonas(mock);
    this.opts.mockSetup?.(mock);
    return mock;
  }

  private engineOptions(ctl: PlayController, meta: SessionMeta, harness: Harness, lang: Lang): EngineOptions {
    const budget = this.opts.budget ?? (this.live && meta.llm === 'live' ? { maxCalls: this.live.budget.maxCallsPerSession, maxUsd: this.live.budget.maxUsdPerSession } : undefined);
    return {
      content: this.content,
      llm: this.llmFor(meta, harness),
      lang,
      decisions: new CallbackDecisionSource((ctx) => ctl.awaitDecision(ctx)),
      players: { turn: (ctx) => ctl.awaitTurn(ctx) },
      onLimit: 'suspend',
      wallClockLimitMs: this.opts.wallClockLimitMs ?? PLAY_WALL_CLOCK_MS,
      ...(this.opts.clock ? { clock: this.opts.clock } : {}),
      ...(budget ? { budget } : {}),
      ...(meta.llm === 'live' && this.live
        ? {
            models: { ...this.live.models },
            pricing: { models: this.live.models, maxTokens: this.live.maxTokens, prices: this.live.prices, httpRetries: this.live.httpRetries, requirePrice: true },
          }
        : {}),
      hooks: {
        onEvent: (e) => ctl.onEvent(e),
        onStep: (step, info) => ctl.onStep(step, info),
      },
    };
  }

  /** The session's controller (opened and started on first access). */
  controller(sessionId: string): PlayController {
    const existing = this.controllers.get(sessionId);
    if (existing) return existing;
    const { harness, meta, run } = this.locate(sessionId);
    const ctl = this.newController(meta, harness, run.caseId);
    if (ctl.unavailableReason === null) {
      const engine = EngineSession.open(harness, this.engineOptions(ctl, meta, harness, run.lang), sessionId);
      ctl.attach(engine);
    }
    this.controllers.set(sessionId, ctl);
    ctl.start();
    return ctl;
  }

  create(input: CreateInput, requestId: string): string {
    const caseConfig = (() => {
      try {
        return findCase(this.content, input.caseId);
      } catch {
        throw new ApiError(400, 'unknown_case', `no case, dev or pilot config ${input.caseId}`);
      }
    })();
    if (input.llm === 'live' && !this.live) throw new ApiError(400, 'live_unavailable', this.liveProblem ?? 'live calls are not available');
    const db: DbName = input.mode === 'baseline' ? 'baseline' : 'main';
    const harness = this.harnessOf(db);
    const sessionId = createdSessionId(caseConfig.id, input.mode, requestId);
    if (this.store.findSession(sessionId) || harness.repo.findSession(sessionId)) {
      throw new ApiError(409, 'session_exists', `session ${sessionId} exists (reuse of a request id?)`);
    }
    const meta: SessionMeta = {
      sessionId,
      db,
      llm: input.llm,
      script: input.script,
      directorUnlockedRound: input.director ? 1 : null,
      createdAt: this.isoNow(),
      origin: 'create',
    };
    const ctl = this.newController(meta, harness, caseConfig.id);
    const engine = EngineSession.create(harness, this.engineOptions(ctl, meta, harness, input.lang), {
      sessionId,
      caseId: caseConfig.id,
      mode: input.mode,
      rep: 1,
    });
    this.store.insertSession(meta);
    ctl.attach(engine);
    this.controllers.set(sessionId, ctl);
    ctl.start();
    return sessionId;
  }

  /** Branch at a round start, or load a named checkpoint (a branch at its round), as a new session. */
  branch(parentId: string, spec: { round: number } | { checkpoint: string }, requestId: string): string {
    const { harness, meta, run } = this.locate(parentId);
    const records = this.recordsOf(harness);
    let round: number;
    let origin: string;
    if ('checkpoint' in spec) {
      const cp = records.findCheckpoint(spec.checkpoint, parentId);
      if (!cp) throw new ApiError(404, 'unknown_checkpoint', `no checkpoint ${spec.checkpoint} in ${parentId}`);
      round = cp.round;
      origin = `load:${parentId}#${spec.checkpoint}`;
    } else {
      round = spec.round;
      origin = `branch:${parentId}@r${round}`;
    }
    if (!harness.repo.findRoundStart(parentId, round)) {
      throw new ApiError(409, 'no_round_start', `round ${round} of ${parentId} has no recorded round start (branch from the session that played it)`);
    }
    const sessionId = branchedSessionId(run.caseId, run.mode, parentId, round, requestId);
    if (this.store.findSession(sessionId) || harness.repo.findSession(sessionId)) {
      throw new ApiError(409, 'session_exists', `session ${sessionId} exists`);
    }
    const childMeta: SessionMeta = {
      sessionId,
      db: meta.db,
      llm: meta.llm,
      script: meta.script,
      directorUnlockedRound: meta.directorUnlockedRound,
      createdAt: this.isoNow(),
      origin,
    };
    const ctl = this.newController(childMeta, harness, run.caseId);
    if (ctl.unavailableReason !== null) throw new ApiError(409, 'live_unavailable', 'branching a live session needs a live server');
    const engine = EngineSession.branch(harness, this.engineOptions(ctl, childMeta, harness, run.lang), parentId, round, sessionId);
    this.store.insertSession(childMeta);
    ctl.attach(engine);
    this.controllers.set(sessionId, ctl);
    ctl.start();
    return sessionId;
  }

  list(): SessionListItem[] {
    const out: SessionListItem[] = [];
    for (const meta of this.store.listSessions()) {
      try {
        const ctx = this.ctx(meta.sessionId);
        out.push({ ...this.sessionInfo(ctx), status: ctx.session.status, phase: ctx.session.phase, round: ctx.state.round, terminal: ctx.state.terminal?.kind ?? null });
      } catch {
        /* a session whose database is missing is skipped */
      }
    }
    return out.reverse();
  }

  /** Session metadata; the evaluation `purpose` only in an allowed director view. */
  sessionInfo(ctx: SessionCtx, viewer: ViewMode = 'player'): SessionInfo {
    const run = this.recordsOf(ctx.harness).findRun(ctx.sessionId);
    const director = viewer === 'director' && this.directorAllowed(ctx);
    return {
      purpose: director ? { ...ctx.caseConfig.purpose } : null,
      sessionId: ctx.sessionId,
      caseId: ctx.run.caseId,
      caseTitle: { ...ctx.caseConfig.title },
      kind: configKind(this.content, ctx.run.caseId),
      mode: ctx.session.mode,
      lang: ctx.run.lang,
      llm: ctx.meta.llm,
      script: ctx.meta.script,
      createdAt: ctx.meta.createdAt,
      parentSessionId: ctx.session.parentSessionId,
      parentRound: ctx.session.parentRound,
      directorUnlockedRound: ctx.meta.directorUnlockedRound,
      directorAllowed: this.directorAllowed(ctx),
      ended: this.ended(ctx),
      outcome: run?.outcome ?? null,
    };
  }

  /** Sessions sharing a lineage tree with `sessionId` (for branch comparison). */
  related(sessionId: string): string[] {
    const { harness } = this.locate(sessionId);
    const parentOf = new Map<string, string | null>();
    for (const id of harness.repo.listSessions()) parentOf.set(id, harness.repo.findSession(id)?.parentSessionId ?? null);
    const rootOf = (id: string): string => {
      let cur = id;
      for (let i = 0; i < 100; i++) {
        const p = parentOf.get(cur);
        if (!p) return cur;
        cur = p;
      }
      return cur;
    };
    const root = rootOf(sessionId);
    return [...parentOf.keys()].filter((id) => id !== sessionId && rootOf(id) === root && this.recordsOf(harness).findRun(id) !== null);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const c of this.controllers.values()) c.close();
    this.controllers.clear();
    this.baseline?.close();
    this.main.close();
  }
}
