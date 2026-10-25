/**
 * Usage (PLAN §9 cost record contract, §13.2 efficiency): logical calls, attempts, tokens, cost split by source
 * (`reported` / `estimated`; `none` counted as unknown, never as zero), latency median/p95 — totals and per role.
 * Player view: offstage actors and call tags (which name remote scenes) are hidden.
 * Audit: player view is a summary; director view is the full record set of the session.
 */
import { DEFAULT_MAX_CALLS, DEFAULT_MAX_USD } from '../../engine/index.js';
import type { UsageBucket, UsageView, ViewMode } from '../api-types.js';
import type { SessionCtx } from '../context.js';

interface CallRow {
  call_id: string;
  ts: string;
  role: string;
  actor: string | null;
  round: number | null;
  call_tag: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  cost_source: string;
  latency_ms: number;
  attempts: number;
  status: string;
}

interface AttemptRow {
  call_id: string;
  cost_usd: number | null;
  cost_source: string;
}

function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx] ?? null;
}

function bucket(calls: readonly CallRow[], attempts: readonly AttemptRow[]): UsageBucket {
  const made = calls.filter((c) => Number(c.attempts) > 0);
  const ids = new Set(made.map((c) => c.call_id));
  const att = attempts.filter((a) => ids.has(a.call_id));
  const latencies = made.map((c) => Number(c.latency_ms)).sort((a, b) => a - b);
  const unknownCalls = new Set(att.filter((a) => a.cost_source === 'none' || a.cost_usd === null).map((a) => a.call_id));
  return {
    calls: made.length,
    attempts: made.reduce((s, c) => s + Number(c.attempts), 0),
    refused: calls.length - made.length,
    inputTokens: made.reduce((s, c) => s + Number(c.input_tokens), 0),
    outputTokens: made.reduce((s, c) => s + Number(c.output_tokens), 0),
    costReportedUsd: att.filter((a) => a.cost_source === 'reported').reduce((s, a) => s + Number(a.cost_usd ?? 0), 0),
    costEstimatedUsd: att.filter((a) => a.cost_source === 'estimated').reduce((s, a) => s + Number(a.cost_usd ?? 0), 0),
    unknownCostCalls: unknownCalls.size,
    medianLatencyMs: quantile(latencies, 0.5),
    p95LatencyMs: quantile(latencies, 0.95),
  };
}

/**
 * Usage. `detailed` (director view, or a session whose director view is allowed): per-call and per-role telemetry.
 * Otherwise only player-scoped counters: the player's own actions and mapper calls, round/day and a coarse budget
 * share — never the roles, timing or tokens of offstage calls, which would reveal offstage activity.
 */
export function usageView(ctx: SessionCtx, viewer: ViewMode, budget: { maxCalls?: number; maxUsd?: number } | undefined, detailed: boolean): UsageView {
  const db = ctx.harness.store.db;
  const calls = db.prepare('SELECT * FROM llm_calls WHERE session_id = ? ORDER BY rowid').all(ctx.sessionId) as unknown as CallRow[];
  const maxCalls = budget?.maxCalls ?? DEFAULT_MAX_CALLS;
  const own = ctx.harness.repo.listSessionProposals(ctx.sessionId).filter((p) => p.actor === 'player');
  const made = calls.filter((c) => Number(c.attempts) > 0).length;
  const player = {
    round: ctx.state.round,
    day: ctx.state.day,
    actions: { total: own.length, committed: own.filter((p) => p.status === 'committed').length, rejected: own.filter((p) => p.status === 'rejected').length },
    mapperCalls: calls.filter((c) => c.role === 'mapper').length,
    budgetUsed: Math.min(1, Math.floor((made / Math.max(1, maxCalls)) * 4) / 4),
  };
  const base = { view: viewer, player, budget: { maxCalls, maxUsd: budget?.maxUsd ?? DEFAULT_MAX_USD } };
  if (!detailed) return { ...base, detailed: false, totals: null, byRole: null, calls: null };
  const attempts = db
    .prepare('SELECT a.call_id, a.cost_usd, a.cost_source FROM llm_attempts a JOIN llm_calls c ON a.call_id = c.call_id WHERE c.session_id = ?')
    .all(ctx.sessionId) as unknown as AttemptRow[];
  const roles = [...new Set(calls.map((c) => c.role))].sort();
  return {
    ...base,
    detailed: true,
    totals: bucket(calls, attempts),
    byRole: roles.map((role) => ({ role, ...bucket(calls.filter((c) => c.role === role), attempts) })),
    // Call ids and tags carry global counters (database-wide call numbers, event versions): director view only.
    calls: calls.map((c, i) => ({
      callId: viewer === 'director' ? c.call_id : `call ${i + 1}`,
      ts: c.ts,
      role: c.role,
      actor: c.actor,
      round: c.round === null ? null : Number(c.round),
      tag: viewer === 'director' ? c.call_tag : null,
      model: c.model,
      inputTokens: Number(c.input_tokens),
      outputTokens: Number(c.output_tokens),
      costUsd: c.cost_usd === null ? null : Number(c.cost_usd),
      costSource: c.cost_source,
      latencyMs: Number(c.latency_ms),
      attempts: Number(c.attempts),
      status: c.status,
    })),
  };
}
/** Audit: summary (player) or the session's full record set (director). */
export function auditView(ctx: SessionCtx, viewer: ViewMode): Record<string, unknown> {
  const repo = ctx.harness.repo;
  const run = ctx.records.findRun(ctx.sessionId);
  const count = <T>(items: readonly T[], key: (t: T) => string): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const i of items) out[key(i)] = (out[key(i)] ?? 0) + 1;
    return out;
  };
  const summary = {
    view: viewer,
    sessionId: ctx.sessionId,
    caseId: ctx.run.caseId,
    mode: ctx.session.mode,
    lang: ctx.run.lang,
    seed: ctx.run.seed,
    engineVersion: ctx.run.engineVersion,
    hashes: { content: ctx.run.contentHash, rules: ctx.run.rulesHash, prompts: ctx.run.promptHash },
    // The parent's world version is a global counter: director view only.
    lineage: { parentSessionId: ctx.session.parentSessionId, parentRound: ctx.session.parentRound, parentVersion: viewer === 'director' ? ctx.session.parentVersion : null },
    outcome: run?.outcome ?? null,
    outcomeDetail: run?.outcomeDetail ?? null,
    version: viewer === 'director' ? ctx.state.version : null,
    epoch: ctx.session.epoch,
    counts: {
      pauses: count(repo.listPauses(ctx.sessionId), (p) => `${p.category}:${p.status}`),
      decisions: repo.listSessionDecisions(ctx.sessionId).length,
      // Narrations of other scenes are offstage activity: the player counts only its own scene's.
      narrations: count(
        repo.listNarrations(ctx.sessionId).filter((n) => viewer === 'director' || n.scene === ctx.playerLoc),
        (n) => n.status,
      ),
    },
  };
  if (viewer === 'player') return summary;
  return {
    ...summary,
    session: ctx.session,
    run,
    events: repo.listEvents(ctx.sessionId),
    batches: repo.listBatches(ctx.sessionId),
    proposals: repo.listSessionProposals(ctx.sessionId),
    pauses: repo.listPauses(ctx.sessionId),
    decisions: repo.listSessionDecisions(ctx.sessionId),
    dialogue: repo.listDialogue(ctx.sessionId),
    narrations: repo.listNarrations(ctx.sessionId),
    epochs: repo.listEpochs(ctx.sessionId),
    roundStarts: repo.listRoundStarts(ctx.sessionId),
    instructions: repo.listInstructions(ctx.sessionId),
    engine: ctx.records.exportSession(ctx.sessionId),
  };
}
