/**
 * Story view (PLAN §9.4, §11): the chapter as the player lived it, round by round — deterministic fact lines for
 * system and player steps, and per-scene narration (fact header + prose) for committed character batches. The fact
 * lines are re-rendered from the stored facts in the requested language; model prose stays in the session language
 * (template/fallback prose is re-rendered). Player view: only facts the clerk witnesses at headquarters and the
 * narration of that scene; director view: every scene.
 */
import { fallbackProse, renderFactLine } from '../../agents/narration/index.js';
import type { Lang } from '../../agents/types.js';
import type { NarrationFact } from '../../core/types.js';
import type { EventRecord, NarrationRecord } from '../../store/repo.js';
import type { StoryItem, StoryView, ViewMode } from '../api-types.js';
import type { SessionCtx } from '../context.js';
import { placeOf, playerSeesFact } from './common.js';

export function lineageIds(ctx: SessionCtx): string[] {
  const ids: string[] = [];
  let cur: string | null = ctx.sessionId;
  for (let i = 0; cur && i < 50; i++) {
    ids.push(cur);
    cur = ctx.harness.repo.findSession(cur)?.parentSessionId ?? null;
  }
  return ids;
}

/** Latest narration row per (batch, scene), across the session and its ancestors (inherited batches). */
function latestNarrations(ctx: SessionCtx): Map<string, NarrationRecord> {
  const out = new Map<string, NarrationRecord>();
  for (const id of lineageIds(ctx).reverse()) {
    for (const n of ctx.harness.repo.listNarrations(id)) {
      if (!n.batchId) continue;
      const key = `${n.batchId}\u0000${n.scene}`;
      const prev = out.get(key);
      if (!prev || prev.sessionId !== n.sessionId || n.narrationId > prev.narrationId) out.set(key, n);
    }
  }
  return out;
}

function splitProse(n: NarrationRecord): string {
  const prefix = `${n.header}\n\n`;
  return n.displayed.startsWith(prefix) ? n.displayed.slice(prefix.length) : n.displayed;
}

function fallbackReason(n: NarrationRecord): string | null {
  const c = n.check as { fallbackReason?: unknown } | null;
  return c && typeof c.fallbackReason === 'string' ? c.fallbackReason : null;
}

interface Group {
  batchId: string | null;
  events: EventRecord[];
}

function groups(events: readonly EventRecord[]): Group[] {
  const out: Group[] = [];
  for (const e of events) {
    const last = out.at(-1);
    if (last && last.batchId === e.batchId && last.events[0]?.round === e.round) last.events.push(e);
    else out.push({ batchId: e.batchId, events: [e] });
  }
  return out;
}

export function storyView(ctx: SessionCtx, viewer: ViewMode, lang: Lang): StoryView {
  const { harness, names } = ctx;
  const events = harness.repo.listEvents(ctx.sessionId);
  const narrations = latestNarrations(ctx);
  const sees = (f: NarrationFact): boolean => viewer === 'director' || playerSeesFact(f, ctx.playerLoc);
  const items: StoryItem[] = [];
  let round = -1;
  for (const g of groups(events)) {
    const first = g.events[0] as EventRecord;
    if (first.round !== round) {
      round = first.round;
      items.push({ kind: 'round', round, day: first.day });
    }
    const batch = g.batchId ? harness.repo.findBatch(g.batchId) : null;
    const batchKind = batch?.kind ?? 'unknown';
    const inherited = first.inherited;
    const byScene = new Map<string, NarrationFact[]>();
    for (const e of g.events) {
      for (const f of e.facts) {
        if (!sees(f)) continue;
        const list = byScene.get(f.scene) ?? [];
        list.push(f);
        byScene.set(f.scene, list);
      }
    }
    for (const [scene, facts] of byScene) {
      const n = g.batchId ? narrations.get(`${g.batchId}\u0000${scene}`) : undefined;
      const headerLines = facts.map((f) => renderFactLine(f, names, lang));
      if (n && (viewer === 'director' || scene === ctx.playerLoc)) {
        const templated = n.status !== 'ok';
        items.push({
          kind: 'narration',
          round: first.round,
          day: first.day,
          scene,
          sceneName: placeOf(names, scene),
          batchId: n.batchId as string,
          // The stored id is a global counter (other scenes and sessions included): players get an ordinal.
          narrationId: viewer === 'director' ? n.narrationId : items.filter((x) => x.kind === 'narration').length + 1,
          attempt: n.attempt,
          headerLines,
          prose: templated ? fallbackProse(facts, names, lang, scene) : splitProse(n),
          proseLang: templated ? lang : ctx.lang,
          status: n.status,
          fallbackReason: fallbackReason(n),
          inherited,
        });
      } else {
        items.push({ kind: 'facts', round: first.round, day: first.day, batchKind, scene, sceneName: placeOf(names, scene), lines: headerLines, inherited });
      }
    }
  }
  if (!items.some((i) => i.kind === 'round' && i.round === ctx.state.round) && !ctx.state.terminal) {
    items.push({ kind: 'round', round: ctx.state.round, day: ctx.state.day });
  }
  return { view: viewer, lang, items };
}
