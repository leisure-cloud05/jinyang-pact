/**
 * World history reads for the inspector, timeline and branch comparison: the state at any version (nearest stored
 * snapshot + event patches, following a branch's lineage below its base version), a walk over events with the
 * value each operation replaced, and a readable JSON diff. Read-only.
 */
import { applyPatch } from '../core/reducer.js';
import type { PatchOp, WorldState } from '../core/types.js';
import type { Harness } from '../harness/index.js';
import type { EventRecord } from '../store/repo.js';
import type { ChangeView } from './api-types.js';

export function stateAt(harness: Harness, sessionId: string, version: number): WorldState {
  const session = harness.repo.getSession(sessionId);
  const base = harness.repo
    .listSnapshotVersions(sessionId)
    .filter((v) => v <= version)
    .at(-1);
  if (base === undefined) {
    if (session.parentSessionId) return stateAt(harness, session.parentSessionId, version);
    throw new Error(`no snapshot at or below version ${version} of ${sessionId}`);
  }
  let state = (harness.repo.getSnapshot(sessionId, base) as { state: WorldState }).state;
  if (base === version) return state;
  for (const e of harness.repo.listEvents(sessionId, { fromVersion: base + 1, toVersion: version })) state = applyPatch(state, e.changes);
  return state;
}

export function unescapePointer(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function pointerSegments(path: string): string[] {
  return path === '' ? [] : path.split('/').slice(1).map(unescapePointer);
}

export function getAt(root: unknown, segments: readonly string[]): unknown {
  let node: unknown = root;
  for (const s of segments) {
    if (node === null || typeof node !== 'object') return undefined;
    if (Array.isArray(node)) {
      if (s === '-') return undefined;
      node = node[Number(s)];
    } else {
      node = Object.hasOwn(node, s) ? (node as Record<string, unknown>)[s] : undefined;
    }
  }
  return node;
}

export interface WalkedEvent {
  event: EventRecord;
  before: WorldState;
  after: WorldState;
  changes: Array<ChangeView & { segments: string[] }>;
}

/** Events of a session (inherited included) in version order, with the states around each. */
export function walkEvents(harness: Harness, sessionId: string): WalkedEvent[] {
  const events = harness.repo.listEvents(sessionId);
  if (events.length === 0) return [];
  const first = events[0] as EventRecord;
  let state = stateAt(harness, sessionId, first.version - 1);
  const out: WalkedEvent[] = [];
  for (const event of events) {
    const before = state;
    const changes = event.changes.map((op: PatchOp) => {
      const segments = pointerSegments(op.path);
      return {
        op: op.op,
        path: op.path,
        segments,
        before: getAt(before, segments) ?? null,
        after: op.op === 'remove' ? null : (op as { value: unknown }).value,
      };
    });
    state = applyPatch(state, event.changes);
    out.push({ event, before, after: state, changes });
  }
  return out;
}

function escapeSegment(s: string): string {
  return s.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Readable structural diff (`added` / `removed` / `changed` leaves). */
export function jsonDiff(a: unknown, b: unknown, path = '', out: ChangeView[] = [], limit = 2000): ChangeView[] {
  if (out.length >= limit) return out;
  if (a === b) return out;
  const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (i >= a.length) out.push({ op: 'added', path: `${path}/${i}`, before: null, after: b[i] });
      else if (i >= b.length) out.push({ op: 'removed', path: `${path}/${i}`, before: a[i], after: null });
      else jsonDiff(a[i], b[i], `${path}/${i}`, out, limit);
    }
    return out;
  }
  if (isObj(a) && isObj(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) {
      const p = `${path}/${escapeSegment(k)}`;
      if (!Object.hasOwn(a, k)) out.push({ op: 'added', path: p, before: null, after: b[k] });
      else if (!Object.hasOwn(b, k)) out.push({ op: 'removed', path: p, before: a[k], after: null });
      else jsonDiff(a[k], b[k], p, out, limit);
    }
    return out;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ op: 'changed', path: path || '/', before: a ?? null, after: b ?? null });
  return out;
}
