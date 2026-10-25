/**
 * Retrospective review (PLAN §8.5, §11): rounds with their pauses and decisions, lineage (branches), checkpoints,
 * and the comparison of two sessions with the first divergence.
 *
 * Comparison: player view compares what the clerk witnessed (the rendered fact lines of visible events, in order);
 * director view compares world events by their post-event state hash, so the first divergence is a world version.
 */
import { renderFactLine } from '../../agents/narration/index.js';
import type { Lang } from '../../agents/types.js';
import { compareIds } from '../../core/ids.js';
import { playerView } from '../../core/knowledge.js';
import type { Document, WorldState } from '../../core/types.js';
import type { CompareItem, CompareRound, CompareView, TimelineRound, TimelineView, ViewMode } from '../api-types.js';
import type { SessionCtx } from '../context.js';
import { Aliases } from '../aliases.js';
import { stateAt } from '../history.js';
import { playerSeesFact } from './common.js';

export function timelineView(ctx: SessionCtx, viewer: ViewMode, related: { children: TimelineView['lineage']['children']; related: string[] }, ended: boolean): TimelineView {
  const { harness, sessionId } = ctx;
  const events = harness.repo.listEvents(sessionId);
  const starts = harness.repo.listRoundStarts(sessionId);
  const pauses = harness.repo.listPauses(sessionId);
  const decisions = harness.repo.listSessionDecisions(sessionId);
  const narrations = harness.repo.listNarrations(sessionId);
  const instructions = harness.repo.listInstructions(sessionId);
  const activations = viewer === 'director' ? ctx.records.activations(sessionId) : [];
  const rounds = new Set<number>([...events.map((e) => e.round), ...starts.map((s) => s.round)]);
  if (!ctx.state.terminal) rounds.add(ctx.state.round);
  const out: TimelineRound[] = [];
  for (const r of [...rounds].sort((a, b) => a - b)) {
    const start = starts.find((s) => s.round === r) ?? null;
    const evs = events.filter((e) => e.round === r);
    const visible = viewer === 'director' ? evs : evs.filter((e) => e.actor === 'player' || e.facts.some((f) => playerSeesFact(f, ctx.playerLoc)));
    const day = evs[0]?.day ?? (start ? (harness.repo.getSnapshot(sessionId, start.version)?.state.day ?? ctx.state.day) : ctx.state.day);
    const batchIds = new Set(harness.repo.listBatches(sessionId).filter((b) => b.round === r).map((b) => b.batchId));
    const ns = narrations.filter((n) => n.batchId !== null && batchIds.has(n.batchId) && (viewer === 'director' || n.scene === ctx.playerLoc));
    const terminal = evs.find((e) => e.kind === 'terminal');
    const round: TimelineRound = {
      round: r,
      version: viewer === 'director' ? (start?.version ?? null) : null,
      day,
      inherited: evs.length > 0 && evs.every((e) => e.inherited),
      events: visible.length,
      pauses: pauses
        .filter((p) => p.round === r)
        .map((p) => {
          const d = p.decisionId ? decisions.find((x) => x.decisionId === p.decisionId) : undefined;
          return { id: p.id, category: p.category, status: p.status, option: d?.option ?? null, advice: d?.advice ?? null, by: d?.by ?? null };
        }),
      interrupts: instructions.filter((i) => i.interrupted && (i.appliedRound === r || (i.appliedRound === null && r === ctx.state.round))).length,
      narrations: {
        ok: ns.filter((n) => n.status === 'ok').length,
        fallback: ns.filter((n) => n.status === 'fallback').length,
        failed: ns.filter((n) => n.status === 'failed').length,
      },
      terminal: terminal ? String((terminal.facts[0]?.data as { terminal?: unknown } | undefined)?.terminal ?? 'terminal') : null,
      canBranch: start !== null,
    };
    if (viewer === 'director') {
      round.activations = activations.filter((a) => a.round === r && !a.inherited).map((a) => ({ charId: a.charId, tier: a.tier, reason: a.reason, skipped: a.skipped }));
    }
    out.push(round);
  }
  const run = ctx.records.findRun(sessionId);
  return {
    view: viewer,
    rounds: out,
    lineage: {
      parent: ctx.session.parentSessionId ? { sessionId: ctx.session.parentSessionId, round: ctx.session.parentRound } : null,
      children: related.children,
      related: related.related,
    },
    checkpoints: ctx.records.checkpoints(sessionId).map((c) => ({ name: c.name, round: c.round, version: viewer === 'director' ? c.version : null })),
    outcome: run?.outcome ?? null,
    ended,
  };
}

function doc1(state: WorldState): Document | null {
  const id = Object.keys(state.documents).sort(compareIds)[0];
  return id ? (state.documents[id] ?? null) : null;
}

function compareRounds(ctx: SessionCtx): CompareRound[] {
  const starts = ctx.harness.repo.listRoundStarts(ctx.sessionId);
  // Rounds inherited from ancestors come from their round starts (up to the branch round).
  const own = new Set(starts.map((s) => s.round));
  let ancestor = ctx.session.parentSessionId;
  let limit = ctx.session.parentRound ?? Number.MAX_SAFE_INTEGER;
  const all = [...starts];
  for (let i = 0; ancestor && i < 50; i++) {
    for (const s of ctx.harness.repo.listRoundStarts(ancestor)) if (s.round < limit && !own.has(s.round)) all.push(s);
    const parent = ctx.harness.repo.findSession(ancestor);
    limit = Math.min(limit, parent?.parentRound ?? Number.MAX_SAFE_INTEGER);
    ancestor = parent?.parentSessionId ?? null;
  }
  const rows = all
    .sort((a, b) => a.round - b.round)
    .map((s) => {
      const st = stateAt(ctx.harness, ctx.sessionId, s.version);
      const pv = playerView(st, ctx.config);
      const d = doc1(st);
      return {
        round: s.round,
        day: st.day,
        grain: pv.resources.resources.grain,
        pressure: st.siege.pressure,
        morale: st.siege.morale,
        docVersion: d?.version ?? null,
        docStatus: d?.status ?? null,
        timing: d ? d.timing.mode : null,
        terminal: st.terminal?.kind ?? null,
      };
    });
  if (ctx.state.terminal) {
    const pv = playerView(ctx.state, ctx.config);
    const d = doc1(ctx.state);
    rows.push({
      round: ctx.state.terminal.round,
      day: ctx.state.day,
      grain: pv.resources.resources.grain,
      pressure: ctx.state.siege.pressure,
      morale: ctx.state.siege.morale,
      docVersion: d?.version ?? null,
      docStatus: d?.status ?? null,
      timing: d ? d.timing.mode : null,
      terminal: ctx.state.terminal.kind,
    });
  }
  return rows;
}

/**
 * Items compared. Player view: the facts the clerk witnessed, with every id already replaced by the session's
 * player-scoped alias — equality and the shared prefix are computed on exactly the texts the player reads, so a
 * difference in hidden objects (an extra offer elsewhere shifts `offer:N`) is never reported as a divergence.
 */
function compareItems(ctx: SessionCtx, viewer: ViewMode, lang: Lang): Array<CompareItem & { hash: string }> {
  const out: Array<CompareItem & { hash: string }> = [];
  const aliases = viewer === 'player' ? new Aliases(ctx) : null;
  for (const e of ctx.harness.repo.listEvents(ctx.sessionId)) {
    if (viewer === 'director') {
      const text = e.facts.length > 0 ? e.facts.map((f) => renderFactLine(f, ctx.names, lang)).join(' ') : `${e.kind} (${e.actor})`;
      out.push({ index: out.length, version: e.version, round: e.round, text, hash: e.stateHash });
      continue;
    }
    for (const f of e.facts) {
      if (!playerSeesFact(f, ctx.playerLoc)) continue;
      const text = (aliases as Aliases).apply(renderFactLine(f, ctx.names, lang));
      out.push({ index: out.length, version: null, round: e.round, text, hash: text });
    }
  }
  return out;
}

export function compareView(a: SessionCtx, b: SessionCtx, viewer: ViewMode, lang: Lang): CompareView {
  const ia = compareItems(a, viewer, lang);
  const ib = compareItems(b, viewer, lang);
  let index = -1;
  const n = Math.max(ia.length, ib.length);
  for (let i = 0; i < n; i++) {
    const x = ia[i];
    const y = ib[i];
    const same = x !== undefined && y !== undefined && x.hash === y.hash && (viewer === 'player' || x.version === y.version);
    if (!same) {
      index = i;
      break;
    }
  }
  const strip = (items: Array<CompareItem & { hash: string }>): CompareItem[] => items.map(({ hash: _h, ...rest }) => rest);
  const pick = (items: Array<CompareItem & { hash: string }>, i: number): CompareItem | null => {
    const it = items[i];
    if (!it) return null;
    const { hash: _h, ...rest } = it;
    return rest;
  };
  const ra = a.records.findRun(a.sessionId);
  const rb = b.records.findRun(b.sessionId);
  const da = index >= 0 ? pick(ia, index) : null;
  const db = index >= 0 ? pick(ib, index) : null;
  return {
    view: viewer,
    a: { sessionId: a.sessionId, outcome: ra?.outcome ?? null, rounds: compareRounds(a), items: strip(ia) },
    b: { sessionId: b.sessionId, outcome: rb?.outcome ?? null, rounds: compareRounds(b), items: strip(ib) },
    divergence:
      index >= 0
        ? {
            index,
            round: da?.round ?? db?.round ?? null,
            version: viewer === 'director' ? (da?.version ?? db?.version ?? null) : null,
            a: da,
            b: db,
          }
        : null,
    sharedPrefix: index >= 0 ? index : n,
  };
}
