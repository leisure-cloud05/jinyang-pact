/**
 * Fastify application of the play server (WP-E, PLAN §11): REST + SSE over the engine and harness, and the built
 * web app. `buildApp` is used by the entry point, the dev runner and the API tests (Fastify `inject`).
 *
 * Every POST carries a `requestId` (idempotent, see `idempotency.ts`). Session reads answer from the player's
 * vantage; `?view=director` is refused (403 `director_locked`) until the chapter ended, the director view was
 * explicitly unlocked for the session (`POST …/director`, recorded), or the server runs with `--director`.
 * Player-view bodies pass the leak guard; its hit count is returned in `x-jinyang-leak-guard`.
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { createNarrateFn } from '../agents/narrator.js';
import type { Lang } from '../agents/types.js';
import { parseAction } from '../core/actions.js';
import { presentAt } from '../core/knowledge.js';
import { CHAR_IDS, MODES, type ActorId, type CharId } from '../core/types.js';
import { EngineError, type DecisionChoice } from '../engine/index.js';
import { HarnessError, type PlayerInput, type PlayerResult } from '../harness/index.js';
import { redactSecrets } from '../llm/redact.js';
import type {
  CompareView,
  ControlView,
  InputOutcome,
  InputResult,
  MappedView,
  ReplayView,
  ServerConfigView,
  SessionInfo,
  ViewMode,
} from './api-types.js';
import { configSummaries } from './content.js';
import type { SessionCtx } from './context.js';
import { ApiError, errorMessage } from './errors.js';
import { LeakGuard, playerNeedles } from './guard.js';
import { Aliases, type AliasKind } from './aliases.js';
import { Idempotency, type ApiResponse, type IdempotencyFaults, type IdempotentHandler } from './idempotency.js';
import { SessionManager, branchedSessionId, createdSessionId, type ManagerOptions } from './manager.js';
import type { PlayController } from './controller.js';
import {
  AdvanceSchema,
  BranchSchema,
  CreateSessionSchema,
  DecisionSchema,
  DirectorSchema,
  InputSchema,
  InterruptSchema,
  RegenerateSchema,
  ReplaySchema,
  SaveSchema,
} from './schemas.js';
import { diffView, dialogueView, eventsView, proposalsView } from './views/inspector.js';
import { pauseView, stateView } from './views/state.js';
import { storyView } from './views/story.js';
import { compareView, timelineView } from './views/timeline.js';
import { auditView, usageView } from './views/usage.js';

export const SERVER_VERSION = 'play-server.v1';
const DEFAULT_WAIT_MS = 3_000;

export interface AppOptions extends ManagerOptions {
  /** Built web app directory (index.html + assets); null/missing: a placeholder page is served at `/`. */
  staticDir?: string | null;
  logger?: boolean;
  /** Where `save` with `exportAudit` writes audit bundles (default: `<db dir>/audit`). */
  auditDir?: string;
  /** Test fault injection (e.g. a crash between an effect and its idempotency receipt). */
  faults?: IdempotencyFaults;
}

export interface PlayApp {
  app: FastifyInstance;
  manager: SessionManager;
}

type Params = { id: string };
type Query = Record<string, string | undefined>;

function viewOf(req: FastifyRequest): ViewMode {
  return (req.query as Query).view === 'director' ? 'director' : 'player';
}

function langOf(req: FastifyRequest, fallback: Lang): Lang {
  const l = (req.query as Query).lang;
  return l === 'en' || l === 'zh' ? l : fallback;
}

function intQuery(req: FastifyRequest, key: string): number | null {
  const v = (req.query as Query)[key];
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

export async function buildApp(opts: AppOptions): Promise<PlayApp> {
  const manager = new SessionManager(opts);
  const app = Fastify({ logger: opts.logger ?? false, forceCloseConnections: true, bodyLimit: 1_000_000 });
  const idem = new Idempotency(manager.store, () => new Date().toISOString(), opts.faults ?? {});
  const streams = new Set<ServerResponse>();

  app.addHook('onClose', async () => {
    for (const s of streams) {
      try {
        s.end();
      } catch {
        /* already closed */
      }
    }
    streams.clear();
    manager.close();
  });

  // ------------------------------------------------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------------------------------------------------

  const guardFor = (ctx: SessionCtx): LeakGuard => new LeakGuard(playerNeedles(ctx.state, ctx.config));

  /**
   * Player-view body: through the leak guard, then with every global-counter id replaced by its player-scoped alias
   * (director bodies are returned as they are, real ids included).
   */
  const safe = (ctx: SessionCtx, view: ViewMode, body: unknown): { body: unknown; hits: number } => {
    if (view === 'director') return { body, hits: 0 };
    const guard = guardFor(ctx);
    const out = new Aliases(ctx).apply(guard.apply(body));
    if (guard.hits > 0) app.log.warn({ sessionId: ctx.sessionId, hits: guard.hits }, 'leak guard sealed text in a player view');
    return { body: out, hits: guard.hits };
  };

  const send = (reply: FastifyReply, ctx: SessionCtx, view: ViewMode, body: unknown, status = 200): FastifyReply => {
    const out = safe(ctx, view, body);
    reply.header('x-jinyang-view', view);
    reply.header('x-jinyang-leak-guard', String(out.hits));
    return reply.code(status).send(out.body);
  };

  const requireView = (ctx: SessionCtx, view: ViewMode): void => {
    if (view === 'director' && !manager.directorAllowed(ctx)) {
      throw new ApiError(403, 'director_locked', 'The director view is locked until the chapter ends (or unlock it explicitly for this session).');
    }
  };

  const sessionInfo = (ctx: SessionCtx, view: ViewMode = 'player'): SessionInfo => manager.sessionInfo(ctx, view);

  const respondIdem = async (
    reply: FastifyReply,
    scope: string,
    route: string,
    body: Record<string, unknown> & { requestId: string },
    handler: IdempotentHandler,
  ): Promise<FastifyReply> => {
    const res = await idem.run(scope, route, body, handler);
    reply.header('x-idempotent-replay', res.replayed ? 'true' : 'false');
    return reply.code(res.status).send(res.body);
  };

  /** A POST response body in the player's vantage (stored as such for idempotent replays). */
  const playerBody = (sessionId: string, body: unknown): ApiResponse => {
    const ctx = manager.ctx(sessionId);
    return { status: 200, body: safe(ctx, 'player', body).body };
  };

  const waitOf = (body: { wait?: number | undefined }): number => body.wait ?? DEFAULT_WAIT_MS;

  // ------------------------------------------------------------------------------------------------------------
  // Errors
  // ------------------------------------------------------------------------------------------------------------

  app.setErrorHandler((err: unknown, req, reply) => {
    let status = 500;
    let code = 'internal';
    let message = errorMessage(err);
    let detail: unknown;
    if (err instanceof ApiError) {
      status = err.status;
      code = err.code;
      detail = err.detail;
    } else if (err instanceof ZodError) {
      status = 400;
      code = 'invalid_request';
      message = err.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`)
        .join('; ');
    } else if (err instanceof HarnessError) {
      status = err.code === 'not_found' ? 404 : err.code === 'invalid_decision' ? 422 : 409;
      code = `harness_${err.code}`;
    } else if (err instanceof EngineError) {
      status = 409;
      code = 'engine';
    } else if (typeof err === 'object' && err !== null && typeof (err as { statusCode?: unknown }).statusCode === 'number') {
      const sc = (err as { statusCode: number }).statusCode;
      if (sc >= 400 && sc < 500) {
        status = sc;
        code = String((err as { code?: unknown }).code ?? 'bad_request');
      }
    }
    if (status >= 500) app.log.error({ err: redactSecrets(errorMessage(err)) }, 'request failed');
    let body: unknown = { error: code, message: redactSecrets(message), ...(detail !== undefined ? { detail } : {}) };
    const id = (req.params as Partial<Params> | undefined)?.id;
    if (id) {
      try {
        body = safe(manager.ctx(id), 'player', body).body;
      } catch {
        /* unknown session: nothing session-specific to guard */
      }
    }
    void reply.code(status).send(body);
  });

  // ------------------------------------------------------------------------------------------------------------
  // Server and session collection
  // ------------------------------------------------------------------------------------------------------------

  app.get('/api/health', async () => ({ ok: true, version: SERVER_VERSION }));

  app.get('/api/config', async (): Promise<ServerConfigView> => ({
    version: SERVER_VERSION,
    liveAvailable: manager.live !== null,
    liveProblem: manager.liveProblem,
    defaultLang: manager.defaultLang,
    modes: [...MODES],
    configs: configSummaries(manager.content),
    directorOpen: manager.directorOpen,
    scenario: { title: { ...manager.content.scenario.title }, startNote: { ...manager.content.scenario.start_note } },
  }));

  app.get('/api/sessions', async () => ({ sessions: manager.list() }));

  app.post('/api/sessions', async (req, reply) => {
    const body = CreateSessionSchema.parse(req.body);
    const answer = async (sessionId: string, extra: Record<string, unknown> = {}): Promise<ApiResponse> => {
      const ctl = manager.controller(sessionId);
      await ctl.whenIdle(waitOf(body));
      const ctx = manager.ctx(sessionId);
      return playerBody(sessionId, { sessionId, session: sessionInfo(ctx), control: ctl.control(), ...extra });
    };
    return respondIdem(reply, '*', 'create', body, {
      recover: async (target) => {
        const t = target as { sessionId: string } | null;
        return t && manager.store.findSession(t.sessionId) ? answer(t.sessionId, { recovered: true }) : null;
      },
      exec: async (intend) => {
        intend({ sessionId: createdSessionId(body.caseId, body.mode, body.requestId) });
        const sessionId = manager.create(
          {
            caseId: body.caseId,
            mode: body.mode as (typeof MODES)[number],
            lang: body.lang ?? manager.defaultLang,
            llm: body.llm ?? (manager.live ? 'live' : 'mock'),
            script: body.script,
            director: body.director,
          },
          body.requestId,
        );
        return answer(sessionId);
      },
    });
  });

  app.get<{ Params: Params }>('/api/sessions/:id', async (req, reply) => {
    const ctl = manager.controller(req.params.id);
    const ctx = manager.ctx(req.params.id);
    return send(reply, ctx, 'player', { session: sessionInfo(ctx), control: ctl.control() });
  });

  // ------------------------------------------------------------------------------------------------------------
  // Session reads
  // ------------------------------------------------------------------------------------------------------------

  app.get<{ Params: Params }>('/api/sessions/:id/state', async (req, reply) => {
    const view = viewOf(req);
    const ctl = manager.controller(req.params.id);
    const wait = intQuery(req, 'wait');
    if (wait !== null && wait > 0) await ctl.whenIdle(Math.min(wait, 120_000));
    const ctx = manager.ctx(req.params.id);
    requireView(ctx, view);
    const pending = ctl.pendingDecision;
    const body = stateView(ctx, view, { session: sessionInfo(ctx, view), control: ctl.control() }, pending, pending ? ctl.suggestion() : null);
    return send(reply, ctx, view, body);
  });

  app.get<{ Params: Params }>('/api/sessions/:id/pauses', async (req, reply) => {
    const view = viewOf(req);
    const ctl = manager.controller(req.params.id);
    const ctx = manager.ctx(req.params.id);
    requireView(ctx, view);
    const pending = ctl.pendingDecision;
    const suggestion = pending ? ctl.suggestion() : null;
    const all = ctx.harness.repo.listPauses(ctx.sessionId).map((p) => pauseView(ctx, p, view, pending, suggestion));
    return send(reply, ctx, view, { view, open: all.filter((p) => p.status === 'open'), history: all.filter((p) => p.status !== 'open') });
  });

  app.get<{ Params: Params }>('/api/sessions/:id/events', async (req, reply) => {
    const view = viewOf(req);
    const ctx = manager.ctx(req.params.id);
    requireView(ctx, view);
    return send(reply, ctx, view, eventsView(ctx, view, langOf(req, ctx.lang)));
  });

  app.get<{ Params: Params }>('/api/sessions/:id/proposals', async (req, reply) => {
    const view = viewOf(req);
    const ctx = manager.ctx(req.params.id);
    requireView(ctx, view);
    return send(reply, ctx, view, proposalsView(ctx, view));
  });

  app.get<{ Params: Params }>('/api/sessions/:id/dialogue', async (req, reply) => {
    const view = viewOf(req);
    const ctx = manager.ctx(req.params.id);
    requireView(ctx, view);
    return send(reply, ctx, view, dialogueView(ctx, view));
  });

  app.get<{ Params: Params }>('/api/sessions/:id/narration', async (req, reply) => {
    const view = viewOf(req);
    const ctx = manager.ctx(req.params.id);
    requireView(ctx, view);
    return send(reply, ctx, view, storyView(ctx, view, langOf(req, ctx.lang)));
  });

  app.get<{ Params: Params }>('/api/sessions/:id/usage', async (req, reply) => {
    const view = viewOf(req);
    const ctx = manager.ctx(req.params.id);
    requireView(ctx, view);
    return send(reply, ctx, view, usageView(ctx, view, opts.budget, view === 'director' || manager.directorAllowed(ctx)));
  });

  app.get<{ Params: Params }>('/api/sessions/:id/audit', async (req, reply) => {
    const view = viewOf(req);
    const ctx = manager.ctx(req.params.id);
    requireView(ctx, view);
    return send(reply, ctx, view, auditView(ctx, view));
  });

  app.get<{ Params: Params }>('/api/sessions/:id/timeline', async (req, reply) => {
    const view = viewOf(req);
    const ctx = manager.ctx(req.params.id);
    requireView(ctx, view);
    const related = manager.related(ctx.sessionId);
    const children = related
      .map((id) => ({ id, s: ctx.harness.repo.findSession(id) }))
      .filter((c) => c.s?.parentSessionId === ctx.sessionId)
      .map((c) => ({ sessionId: c.id, round: c.s?.parentRound ?? null, outcome: ctx.records.findRun(c.id)?.outcome ?? null }));
    return send(reply, ctx, view, timelineView(ctx, view, { children, related }, manager.ended(ctx)));
  });

  app.get<{ Params: Params }>('/api/sessions/:id/diff', async (req, reply) => {
    const view = viewOf(req);
    const ctx = manager.ctx(req.params.id);
    requireView(ctx, view);
    if (view === 'player') {
      // The player compares round starts (world versions are not exposed): ?fromRound=&toRound= (default: this round → now).
      const fromRound = intQuery(req, 'fromRound') ?? ctx.state.round;
      const toRound = intQuery(req, 'toRound');
      return send(reply, ctx, view, diffView(ctx, view, fromRound, toRound));
    }
    const current = ctx.state.version;
    const starts = ctx.harness.repo.listRoundStarts(ctx.sessionId);
    const defaultFrom = starts.at(-1)?.version ?? ctx.session.baseVersion;
    const to = Math.min(intQuery(req, 'to') ?? current, current);
    const from = Math.max(0, Math.min(intQuery(req, 'from') ?? (defaultFrom < to ? defaultFrom : Math.max(0, to - 1)), to));
    return send(reply, ctx, view, diffView(ctx, view, from, to));
  });

  app.get('/api/compare', async (req, reply) => {
    const q = req.query as Query;
    if (!q.a || !q.b) throw new ApiError(400, 'invalid_request', 'compare needs ?a=<sessionId>&b=<sessionId>');
    const view = viewOf(req);
    const a = manager.ctx(q.a);
    const b = manager.ctx(q.b);
    requireView(a, view);
    requireView(b, view);
    const body = compareView(a, b, view, langOf(req, a.lang));
    if (view === 'director') return reply.send(body);
    const ga = guardFor(a);
    const gb = new LeakGuard(playerNeedles(b.state, b.config));
    // Each side in its own session's aliases (a branch shares its parent's aliases for the shared past).
    const aa = new Aliases(a);
    const ab = new Aliases(b);
    const side = (x: CompareView['a'], g: LeakGuard, al: Aliases): CompareView['a'] => al.apply(gb.apply(g.apply(x)));
    const out: CompareView = {
      ...body,
      a: side(body.a, ga, aa),
      b: side(body.b, ga, ab),
      divergence: body.divergence
        ? { ...body.divergence, a: body.divergence.a ? aa.apply(gb.apply(ga.apply(body.divergence.a))) : null, b: body.divergence.b ? ab.apply(gb.apply(ga.apply(body.divergence.b))) : null }
        : null,
    };
    reply.header('x-jinyang-view', 'player');
    reply.header('x-jinyang-leak-guard', String(ga.hits + gb.hits));
    return reply.send(out);
  });

  // SSE: engine progress (player-safe messages), resumable with Last-Event-ID or ?since=.
  app.get<{ Params: Params }>('/api/sessions/:id/stream', async (req, reply) => {
    const ctl = manager.controller(req.params.id);
    const sessionId = req.params.id;
    const header = req.headers['last-event-id'];
    const sinceRaw = typeof header === 'string' && header !== '' ? Number(header) : intQuery(req, 'since');
    const since = sinceRaw !== null && Number.isFinite(sinceRaw) ? sinceRaw : null;
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    streams.add(raw);
    let guard: { version: number; guard: LeakGuard } | null = null;
    const write = (id: number | null, type: string, data: unknown): void => {
      try {
        const ctx = manager.ctx(sessionId);
        if (!guard || guard.version !== ctx.state.version) guard = { version: ctx.state.version, guard: guardFor(ctx) };
        const payload = JSON.stringify(new Aliases(ctx).apply(guard.guard.apply(data)));
        raw.write(`${id !== null ? `id: ${id}\n` : ''}event: ${type}\ndata: ${payload}\n\n`);
      } catch {
        /* closing */
      }
    };
    raw.write(`retry: 2000\n\n`);
    write(null, 'control', ctl.control());
    const unsubscribe = manager.hub.subscribe(sessionId, (m) => write(m.id, m.type, m.data), since);
    const keepAlive = setInterval(() => {
      try {
        raw.write(': keep-alive\n\n');
      } catch {
        /* closed */
      }
    }, 15_000);
    const done = (): void => {
      clearInterval(keepAlive);
      unsubscribe();
      streams.delete(raw);
    };
    req.raw.on('close', done);
    raw.on('close', done);
  });

  // ------------------------------------------------------------------------------------------------------------
  // Session actions (idempotent POSTs with a write-ahead intent; see idempotency.ts)
  // ------------------------------------------------------------------------------------------------------------

  const presentCharacters = (sessionId: string): CharId[] => {
    const state = manager.ctx(sessionId).state;
    return presentAt(state, state.player.location).filter((a): a is CharId => (CHAR_IDS as readonly string[]).includes(a));
  };

  /**
   * Player actions name offers and threads by the aliases the player was shown ("offer A"). They are resolved here;
   * a raw world id (`offer:N`) or an unknown alias is refused, so the player can never probe hidden objects.
   */
  const resolveActionIds = (action: { type: string; args: Record<string, unknown> }, aliases: Aliases): unknown => {
    const args: Record<string, unknown> = { ...action.args };
    const fix = (value: unknown, kind: AliasKind): string => {
      const real = typeof value === 'string' ? aliases.resolve(kind, value) : null;
      if (!real) throw new ApiError(400, 'unknown_reference', `${String(value)} is not a ${kind} you know; use the names shown to you (e.g. "${kind} ${kind === 'offer' || kind === 'thread' || kind === 'document' ? 'A' : '1'}")`);
      return real;
    };
    const fields: Array<[string, AliasKind]> = [
      ['docId', 'document'],
      ['offerId', 'offer'],
      ['commitmentId', 'thread'],
      ['authId', 'authorization'],
    ];
    for (const [field, kind] of fields) if (args[field] !== undefined) args[field] = fix(args[field], kind);
    const target = args.target as { kind?: unknown; id?: unknown } | undefined;
    if (target && typeof target === 'object') {
      if (target.kind === 'offer') args.target = { ...target, id: fix(target.id, 'offer') };
      else if (target.kind === 'document') args.target = { ...target, id: fix(target.id, 'document') };
    }
    return { ...action, args };
  };
  const inputResult = (ctl: PlayController, kind: InputResult['kind'], inputs: PlayerInput[], result: PlayerResult | null, mapped: MappedView | null): InputResult => {
    const actions = inputs.filter((i): i is Extract<PlayerInput, { kind: 'action' }> => i.kind === 'action');
    const outcomes: InputOutcome[] = (result?.outcomes ?? []).map((o, i) => ({
      proposalId: o.proposalId,
      type: String((actions[i]?.action as { type?: unknown } | undefined)?.type ?? '?'),
      status: o.status,
      rule: o.rule,
      feedback: o.feedback ?? (o.status === 'committed' ? null : o.reason),
    }));
    return { kind, applied: inputs.length > 0, outcomes, spoken: result?.dialogueSeqs.length ?? 0, mapped, control: ctl.control() };
  };

  app.post<{ Params: Params }>('/api/sessions/:id/input', async (req, reply) => {
    const body = InputSchema.parse(req.body);
    const sessionId = req.params.id;
    const harnessRequestId = `ui:${body.requestId}`;
    return respondIdem(reply, sessionId, 'input', body, {
      // The harness keeps the player batch under `ui:<requestId>`: if it exists, the input was applied.
      recover: (target) => {
        const t = target as { kind?: InputResult['kind'] } | null;
        const stored = manager.locate(sessionId).harness.repo.findRequest(sessionId, harnessRequestId);
        if (!stored) return null;
        const ctl = manager.controller(sessionId);
        const r = stored.result as PlayerResult;
        return playerBody(sessionId, { ...inputResult(ctl, t?.kind ?? body.kind, [], r, null), applied: true, recovered: true });
      },
      exec: async (intend) => {
        const ctl = manager.controller(sessionId);
        const present = presentCharacters(sessionId);
        const checkListeners = (to: readonly string[]): ActorId[] => {
          const absent = to.filter((t) => !present.includes(t as CharId));
          if (absent.length > 0) {
            throw new ApiError(400, 'not_present', `You can only speak to characters present with you (${absent.join(', ')} ${absent.length > 1 ? 'are' : 'is'} elsewhere); letters travel through the harness.`);
          }
          return [...new Set(to)] as ActorId[];
        };
        let inputs: PlayerInput[] = [];
        let mapped: MappedView | null = null;
        let expect: { epoch: number; version: number } | undefined;
        if (body.kind === 'dialogue') {
          inputs = [{ kind: 'dialogue', to: checkListeners(body.to), text: body.text }];
        } else if (body.kind === 'action') {
          const parsed = parseAction(resolveActionIds(body.action, new Aliases(manager.ctx(sessionId))));
          if (!parsed.ok) throw new ApiError(400, 'invalid_action', `H01: ${parsed.error}`);
          inputs =
            parsed.value.type === 'speak'
              ? [{ kind: 'dialogue', to: checkListeners(parsed.value.args.to.filter((t) => t !== 'player')), text: parsed.value.args.text }]
              : [{ kind: 'action', action: parsed.value }];
        } else {
          // The interpretation is bound to this turn, epoch and world version: a completion that arrives after any
          // of them changed is refused (409 stale_mapping) and nothing is applied.
          const r = await ctl.mapText(body.text, body.requestId, body.turn);
          expect = r.expect;
          const m = r.mapped;
          const confirm = m.kind === 'action' && m.action?.type === 'dispatch_document';
          mapped = {
            kind: m.kind,
            status: m.status,
            action: m.action ? (m.action as unknown as { type: string; args: Record<string, unknown> }) : null,
            dialogue: m.dialogue ? { to: [...m.dialogue.to], text: m.dialogue.text } : null,
            question: m.question,
            reason: m.reason,
            downgraded: m.downgraded,
            confirmRequired: confirm,
          };
          if (m.kind === 'action' && m.action && !confirm) inputs = [{ kind: 'action', action: m.action }];
          if (m.kind === 'dialogue' && m.dialogue) {
            const to = m.dialogue.to.filter((t) => present.includes(t));
            if (to.length > 0) inputs = [{ kind: 'dialogue', to, text: m.dialogue.text }];
            else mapped = { ...mapped, kind: 'clarify', question: 'Whom are you addressing? Only characters present with you can hear you.' };
          }
        }
        let result: PlayerResult | null = null;
        if (inputs.length > 0) {
          intend({ kind: body.kind, turn: body.turn });
          result = ctl.applyInputs(inputs, body.requestId, body.turn, expect);
        } else if (body.kind !== 'text') {
          throw new ApiError(400, 'empty_input', 'nothing to apply');
        }
        return playerBody(sessionId, inputResult(ctl, body.kind, inputs, result, mapped));
      },
    });
  });

  app.post<{ Params: Params }>('/api/sessions/:id/advance', async (req, reply) => {
    const body = AdvanceSchema.parse(req.body);
    const sessionId = req.params.id;
    return respondIdem(reply, sessionId, 'advance', body, {
      // A turn is ended at most once: the engine persists the turn it was handed (findTurn). If that turn record
      // exists, the earlier attempt took effect — answer as it would have, and end nothing else.
      recover: async (target) => {
        const t = target as { kind: 'turn'; round: number; epoch: number } | { kind: 'resume' } | null;
        const { harness } = manager.locate(sessionId);
        const records = manager.recordsOf(harness);
        const ctl = manager.controller(sessionId);
        if (t?.kind === 'turn') {
          if (records.findTurn(sessionId, t.round) === null) return null;
        } else if (t?.kind === 'resume') {
          if (harness.getSession(sessionId).status === 'suspended') return null;
        } else {
          return null;
        }
        const settled = await ctl.whenIdle(waitOf(body));
        return playerBody(sessionId, { action: t.kind === 'turn' ? 'end_turn' : 'resumed', settled, recovered: true, control: ctl.control() });
      },
      exec: async (intend) => {
        const ctl = manager.controller(sessionId);
        const control = ctl.control();
        if (ctl.turnToken !== null) {
          if (body.turn !== ctl.turnToken) ctl.advance(body.turn); // throws the precise 409
          intend({ kind: 'turn', round: control.round, epoch: control.epoch });
        } else if (control.sessionStatus === 'suspended') {
          intend({ kind: 'resume' });
        }
        const action = ctl.advance(body.turn);
        const settled = await ctl.whenIdle(waitOf(body));
        return playerBody(sessionId, { action, settled, control: ctl.control() });
      },
    });
  });

  app.post<{ Params: Params }>('/api/sessions/:id/decision', async (req, reply) => {
    const body = DecisionSchema.parse(req.body);
    const sessionId = req.params.id;
    const askedOn = (pauseId: string): number =>
      manager
        .locate(sessionId)
        .harness.repo.listSessionDecisions(sessionId)
        .filter((d) => d.pauseId === pauseId && d.option === 'ask').length;
    return respondIdem(reply, sessionId, 'decision', body, {
      recover: async (target) => {
        const t = target as { pauseId: string; asked: number } | null;
        if (!t) return null;
        const { harness } = manager.locate(sessionId);
        const pause = harness.repo.findPause(t.pauseId);
        const decided = !pause || pause.status !== 'open' || askedOn(t.pauseId) > t.asked;
        if (!decided) return null;
        const ctl = manager.controller(sessionId);
        const settled = await ctl.whenIdle(waitOf(body));
        return playerBody(sessionId, { accepted: true, pauseId: t.pauseId, option: body.option, settled, recovered: true, control: ctl.control() });
      },
      exec: async (intend) => {
        const ctl = manager.controller(sessionId);
        const choice: DecisionChoice = { option: body.option, by: 'user', note: 'ui' };
        if (body.advice !== undefined) choice.advice = body.advice;
        if (body.option === 'ask' && body.to) choice.to = body.to;
        if (body.authorization !== undefined) choice.authorization = body.authorization;
        if (body.goalLimits !== undefined) choice.goalLimits = body.goalLimits;
        if (body.amend !== undefined) {
          // The amended document is named by its alias ("document A").
          const docId = body.amend ? new Aliases(manager.ctx(sessionId)).resolve('document', body.amend.docId) : null;
          if (body.amend && !docId) throw new ApiError(400, 'unknown_reference', `${body.amend.docId} is not a document you know`);
          choice.amend = body.amend && docId ? { ...body.amend, docId } : null;
        }
        if (body.counterTerms !== undefined) choice.counterTerms = body.counterTerms;
        // The player names pauses by their alias ("pause 3"); the real id is accepted too (it is the session's own).
        const pauseId = new Aliases(manager.ctx(sessionId)).resolve('pause', body.pauseId) ?? body.pauseId;
        if (body.option === 'ask' && body.to) {
          // An explicit addressee must be one the engine lists for this pause (living and present with the clerk);
          // refused before anything is recorded, never silently replaced by another speaker.
          const pending = ctl.pendingDecision;
          if (!pending || pending.pauseId !== pauseId || !pending.ctx.askable.includes(body.to)) {
            throw new ApiError(422, 'not_askable', `${body.to} cannot be asked now: you can only ask characters present with you.`);
          }
        }
        const res = await ctl.decide(pauseId, choice, waitOf(body), () => intend({ pauseId, asked: askedOn(pauseId) }));
        if (res.error !== null) throw new ApiError(422, 'decision_refused', res.error);
        return playerBody(sessionId, { accepted: true, pauseId: body.pauseId, option: body.option, settled: res.settled, control: ctl.control() });
      },
    });
  });

  app.post<{ Params: Params }>('/api/sessions/:id/interrupt', async (req, reply) => {
    const body = InterruptSchema.parse(req.body);
    const sessionId = req.params.id;
    const instructions = (): number => manager.locate(sessionId).harness.repo.listInstructions(sessionId).length;
    return respondIdem(reply, sessionId, 'interrupt', body, {
      recover: async (target) => {
        const t = target as { before: number } | null;
        if (!t || instructions() <= t.before) return null;
        const ctl = manager.controller(sessionId);
        const settled = await ctl.whenIdle(waitOf(body));
        return playerBody(sessionId, { recovered: true, settled, control: ctl.control() });
      },
      exec: async (intend) => {
        const ctl = manager.controller(sessionId);
        intend({ before: instructions() });
        const r = ctl.interrupt(body.text);
        const settled = await ctl.whenIdle(waitOf(body));
        return playerBody(sessionId, { accepted: r.accepted, queued: r.queued, epoch: r.epoch, instructionId: r.instructionId, settled, control: ctl.control() });
      },
    });
  });

  app.post<{ Params: Params }>('/api/sessions/:id/save', async (req, reply) => {
    const body = SaveSchema.parse(req.body);
    const sessionId = req.params.id;
    type SaveTarget = { name: string; round: number; version: number };
    const checkpoints = () => manager.recordsOf(manager.locate(sessionId).harness);
    return respondIdem(reply, sessionId, 'save', body, {
      // The intent records WHICH round start is saved. A retry never re-saves the current state: it completes the
      // recorded checkpoint if it is missing and otherwise leaves the stored one untouched.
      recover: (target) => {
        const t = target as SaveTarget | null;
        if (!t) return null;
        if (!checkpoints().findCheckpoint(t.name, sessionId)) {
          checkpoints().saveCheckpoint({ sessionId, name: t.name, round: t.round, version: t.version, createdAtMs: Date.now() });
        }
        return playerBody(sessionId, { checkpoint: { name: t.name, round: t.round }, exported: null, recovered: true });
      },
      exec: async (intend) => {
        const ctl = manager.controller(sessionId);
        if (body.exportAudit && !manager.directorAllowed(manager.ctx(sessionId))) {
          throw new ApiError(403, 'director_locked', 'Exporting the audit bundle reveals hidden information: finish the chapter or unlock the director view first.');
        }
        const start = manager.locate(sessionId).harness.repo.listRoundStarts(sessionId).at(-1);
        if (!start) throw new ApiError(409, 'nothing_to_save', 'No round has started yet.');
        const target: SaveTarget = { name: body.name, round: start.round, version: start.version };
        intend(target);
        checkpoints().saveCheckpoint({ sessionId, name: target.name, round: target.round, version: target.version, createdAtMs: Date.now() });
        let exported: { dir: string; files: string[] } | null = null;
        if (body.exportAudit) {
          const base = opts.auditDir ?? path.join(path.dirname(path.resolve(opts.dbPath)), 'audit');
          const dir = path.join(base, sessionId, body.name.replace(/[^A-Za-z0-9._-]+/g, '_'));
          mkdirSync(dir, { recursive: true });
          exported = { dir, files: ctl.engine.exportAudit(dir).map((f) => path.relative(dir, f)) };
        }
        return playerBody(sessionId, { checkpoint: { name: target.name, round: target.round }, exported });
      },
    });
  });
  app.post<{ Params: Params }>('/api/sessions/:id/branch', async (req, reply) => {
    const body = BranchSchema.parse(req.body);
    const parentId = req.params.id;
    const childOf = (): string => {
      const { harness, run } = manager.locate(parentId);
      const round = body.checkpoint !== undefined ? (manager.recordsOf(harness).findCheckpoint(body.checkpoint, parentId)?.round ?? 0) : (body.round as number);
      return branchedSessionId(run.caseId, run.mode, parentId, round, body.requestId);
    };
    const answer = async (sessionId: string, extra: Record<string, unknown> = {}): Promise<ApiResponse> => {
      const ctl = manager.controller(sessionId);
      await ctl.whenIdle(waitOf(body));
      const ctx = manager.ctx(sessionId);
      return playerBody(sessionId, { sessionId, parentSessionId: parentId, session: sessionInfo(ctx), control: ctl.control(), ...extra });
    };
    return respondIdem(reply, parentId, 'branch', body, {
      recover: async (target) => {
        const t = target as { sessionId: string } | null;
        return t && manager.store.findSession(t.sessionId) ? answer(t.sessionId, { recovered: true }) : null;
      },
      exec: async (intend) => {
        const spec = body.checkpoint !== undefined ? { checkpoint: body.checkpoint } : { round: body.round as number };
        intend({ sessionId: childOf() });
        const sessionId = manager.branch(parentId, spec, body.requestId);
        return answer(sessionId);
      },
    });
  });

  app.post<{ Params: Params }>('/api/sessions/:id/replay', async (req, reply) => {
    const body = ReplaySchema.parse(req.body);
    const sessionId = req.params.id;
    return respondIdem(reply, sessionId, 'replay', body, {
      // Read-only: no intent, a retry simply replays again.
      exec: async () => {
        const ctx = manager.ctx(sessionId);
        const r = ctx.harness.replay(sessionId, body.mode);
        // Counts and hashes reveal how much happened offstage: only with director access.
        const detailed = manager.directorAllowed(ctx);
        const view: ReplayView = {
          mode: r.mode,
          ok: r.ok,
          checkedEvents: detailed ? r.checkedEvents : null,
          checkedBatches: detailed ? r.checkedBatches : null,
          mismatches: detailed ? r.mismatches.slice(0, 50) : r.mismatches.length > 0 ? [`${r.mismatches.length} mismatch(es); details in the director view`] : [],
          finalHash: detailed ? r.finalHash : null,
          expectedHash: detailed ? r.expectedHash : null,
        };
        return playerBody(sessionId, view);
      },
    });
  });

  app.post<{ Params: Params }>('/api/sessions/:id/regenerate-narration', async (req, reply) => {
    const body = RegenerateSchema.parse(req.body);
    const sessionId = req.params.id;
    const rows = (batchId: string): number => manager.locate(sessionId).harness.repo.listNarrations(sessionId).filter((n) => n.batchId === batchId).length;
    return respondIdem(reply, sessionId, 'regenerate-narration', body, {
      recover: (target) => {
        const t = target as { batchId: string; before: number } | null;
        return t && rows(t.batchId) > t.before ? playerBody(sessionId, { batchId: t.batchId, recovered: true }) : null;
      },
      exec: async (intend) => {
        const ctl = manager.controller(sessionId);
        if (!ctl.isIdle()) throw new ApiError(409, 'busy', 'The council is deliberating; regenerate when it waits for you.');
        const ctx = manager.ctx(sessionId);
        const batch = ctx.harness.repo.findBatch(new Aliases(ctx).resolve('batch', body.batchId) ?? body.batchId);
        if (!batch || batch.sessionId !== sessionId || batch.kind !== 'character' || batch.status !== 'committed') {
          throw new ApiError(404, 'unknown_batch', `${body.batchId} is not a committed character batch of this session`);
        }
        const director = manager.directorAllowed(ctx);
        const scenes = ctx.harness
          .narrationScenes(sessionId, batch.batchId)
          .filter((s) => (body.scene === undefined || s.scene === body.scene) && (director || s.scene === ctx.playerLoc));
        if (scenes.length === 0) throw new ApiError(404, 'no_scene', 'no narratable scene of this batch is visible to you');
        const engine = ctl.engine;
        const snapshot = (batch.committedVersion !== null ? ctx.harness.repo.getSnapshot(sessionId, batch.committedVersion)?.state : null) ?? ctx.state;
        const narrate = createNarrateFn({
          client: engine.rt.client,
          content: engine.rt.content,
          config: ctx.config,
          lang: ctx.lang,
          names: engine.rt.names,
          day: snapshot.day,
          getState: () => snapshot,
          identity: () => ({ sessionId, caseId: ctx.run.caseId, rep: ctx.run.rep, round: batch.round, epoch: ctx.session.epoch }),
        });
        intend({ batchId: batch.batchId, before: rows(batch.batchId) });
        const results: Array<{ scene: string; status: string | null }> = [];
        for (const scene of scenes) {
          await ctx.harness.regenerateNarration(sessionId, scene.eventVersions, narrate);
          const latest = ctx.harness.repo.listNarrations(sessionId).filter((n) => n.batchId === batch.batchId && n.scene === scene.scene).at(-1);
          results.push({ scene: scene.scene, status: latest?.status ?? null });
        }
        manager.hub.publish(sessionId, 'progress', { kind: 'narration_regenerated' });
        return playerBody(sessionId, { batchId: batch.batchId, results, worldUnchanged: manager.ctx(sessionId).state.version === ctx.state.version });
      },
    });
  });

  app.post<{ Params: Params }>('/api/sessions/:id/director', async (req, reply) => {
    const body = DirectorSchema.parse(req.body);
    const sessionId = req.params.id;
    return respondIdem(reply, sessionId, 'director', body, {
      // Unlocking is idempotent (the first unlock round is kept).
      exec: async (intend) => {
        intend({});
        const ctx = manager.unlockDirector(sessionId);
        return playerBody(sessionId, { session: sessionInfo(ctx) });
      },
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  // Web app
  // ------------------------------------------------------------------------------------------------------------

  const staticDir = opts.staticDir ? path.resolve(opts.staticDir) : null;
  const hasStatic = staticDir !== null && existsSync(path.join(staticDir, 'index.html'));
  if (hasStatic) {
    await app.register(fastifyStatic, { root: staticDir, prefix: '/', index: ['index.html'] });
  } else {
    app.get('/', async (_req, reply) =>
      reply
        .type('text/html; charset=utf-8')
        .send(
          '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>The Jinyang Pact</title></head><body>' +
            '<h1>The Jinyang Pact — play server</h1><p>The web app is not built. Run <code>npm run play:web:build</code> ' +
            'and restart, or use <code>npm run play:web</code> for development.</p><p>API: <a href="/api/config">/api/config</a></p></body></html>',
        ),
    );
  }
  app.setNotFoundHandler(async (req, reply) => {
    if (!req.url.startsWith('/api/') && req.method === 'GET' && hasStatic) return reply.type('text/html; charset=utf-8').sendFile('index.html');
    return reply.code(404).send({ error: 'not_found', message: `no route ${req.method} ${req.url.split('?')[0] ?? ''}` });
  });

  return { app, manager };
}

export type { ControlView };
