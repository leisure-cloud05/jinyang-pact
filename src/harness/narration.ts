/**
 * Narration storage (PLAN §9.4, §8.4): raw prose, deterministic header, displayed text and checker result are all
 * stored, one row per scene and attempt. `regenerateNarration` re-narrates committed events from their stored facts
 * and never re-executes actions: events and snapshots are untouched.
 */
import type { NarrationFact } from '../core/types.js';
import type { NarrationRecord } from '../store/repo.js';
import { HarnessError, controlId, type HarnessContext } from './context.js';

export interface NarrationInput {
  batchId: string | null;
  scene: string;
  eventVersions: number[];
  status: 'ok' | 'fallback' | 'failed';
  raw: string | null;
  header: string;
  displayed: string;
  check: unknown;
}

export interface NarrateRequest {
  scene: string;
  eventVersions: number[];
  facts: NarrationFact[];
}

export interface NarrateOutput {
  status: 'ok' | 'fallback' | 'failed';
  raw: string | null;
  header: string;
  displayed: string;
  check: unknown;
}

export type NarrateFn = (request: NarrateRequest) => NarrateOutput | Promise<NarrateOutput>;

/** Scenes a committed batch must narrate, with the event versions each scene's facts come from. */
export function requiredScenes(ctx: HarnessContext, sessionId: string, batchId: string): Map<string, Set<number>> {
  const scenes = new Map<string, Set<number>>();
  for (const event of ctx.repo.listBatchEvents(sessionId, batchId)) {
    for (const fact of event.facts) {
      const versions = scenes.get(fact.scene) ?? new Set<number>();
      versions.add(event.version);
      scenes.set(fact.scene, versions);
    }
  }
  return scenes;
}

/**
 * Narration completeness: a batch is `done` only when every scene of its committed facts has, as its latest
 * narration row, an `ok`/`fallback` narration covering all of that scene's events; `failed` if some scene's latest
 * attempt failed; otherwise `pending`. Only the session's latest committed character batch can move the session
 * from NARRATE to ADVANCE (re-narrating an older batch never changes the phase).
 */
function refreshNarrationStatus(ctx: HarnessContext, sessionId: string, batchId: string | null): void {
  if (!batchId) return;
  const batch = ctx.repo.findBatch(batchId);
  if (!batch || batch.status !== 'committed' || batch.sessionId !== sessionId) return;
  const required = requiredScenes(ctx, sessionId, batchId);
  const rows = ctx.repo.listNarrations(sessionId).filter((n) => n.batchId === batchId);
  const latestPerScene = new Map<string, NarrationRecord>();
  for (const row of rows) latestPerScene.set(row.scene, row);
  let failed = false;
  let complete = true;
  for (const [scene, versions] of required) {
    const latest = latestPerScene.get(scene);
    if (!latest) {
      complete = false;
      continue;
    }
    if (latest.status === 'failed') failed = true;
    if (latest.status === 'failed' || [...versions].some((v) => !latest.eventVersions.includes(v))) complete = false;
  }
  const status = complete ? 'done' : failed ? 'failed' : 'pending';
  ctx.repo.updateBatch(batchId, { narrationStatus: status });
  if (status !== 'done') return;
  const session = ctx.repo.getSession(sessionId);
  const latestCharacter = ctx.repo
    .committedBatches(sessionId)
    .filter((b) => b.kind === 'character')
    .at(-1);
  if (session.phase !== 'narrate' || latestCharacter?.batchId !== batchId) return;
  // Late narration never revives a run: a stopped run is left alone; a suspended one only records where an
  // explicit resume will continue.
  if (session.status === 'stopped') return;
  if (session.status === 'suspended') {
    ctx.repo.updateSession(sessionId, { phase: 'advance', suspendedFrom: 'ready' });
    return;
  }
  ctx.repo.updateSession(sessionId, { phase: 'advance', status: 'ready' });
}

export function recordNarrationTx(ctx: HarnessContext, sessionId: string, input: NarrationInput): number {
  const previous = ctx.repo
    .listNarrations(sessionId)
    .filter((n) => n.scene === input.scene && n.batchId === input.batchId && sameVersions(n.eventVersions, input.eventVersions));
  const { seq } = controlId(ctx, sessionId, 'n');
  const id = ctx.repo.insertNarration({
    sessionId,
    batchId: input.batchId,
    scene: input.scene,
    eventVersions: [...input.eventVersions],
    attempt: previous.length + 1,
    status: input.status,
    raw: input.raw,
    header: input.header,
    displayed: input.displayed,
    check: input.check,
    controlSeq: seq,
  });
  refreshNarrationStatus(ctx, sessionId, input.batchId);
  return id;
}

function sameVersions(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Facts of committed events grouped by scene (read-only). */
export function scenesOf(ctx: HarnessContext, sessionId: string, eventVersions: readonly number[]): NarrateRequest[] {
  const wanted = new Set(eventVersions);
  const events = ctx.repo.listEvents(sessionId).filter((e) => wanted.has(e.version));
  if (events.length !== wanted.size) throw new HarnessError('not_found', 'some events do not exist in this session');
  const byScene = new Map<string, NarrateRequest>();
  for (const event of events) {
    for (const fact of event.facts) {
      const scene = byScene.get(fact.scene) ?? { scene: fact.scene, eventVersions: [], facts: [] };
      if (!scene.eventVersions.includes(event.version)) scene.eventVersions.push(event.version);
      scene.facts.push(fact);
      byScene.set(fact.scene, scene);
    }
  }
  return [...byScene.values()].sort((a, b) => (a.scene < b.scene ? -1 : a.scene > b.scene ? 1 : 0));
}

/** Batch of each event version (for attributing regenerated narration). */
export function batchOfEvents(ctx: HarnessContext, sessionId: string, eventVersions: readonly number[]): string | null {
  const batches = new Set(
    ctx.repo
      .listEvents(sessionId)
      .filter((e) => eventVersions.includes(e.version))
      .map((e) => e.batchId),
  );
  return batches.size === 1 ? ([...batches][0] ?? null) : null;
}
