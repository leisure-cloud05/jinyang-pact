/**
 * Deterministic patch application (RFC-6902 subset: add / replace / remove, `-` for array append) and the
 * `Draft` effect builder used by resolvers.
 *
 * Resolvers never mutate state directly: every change goes through a `Draft`, which applies the operation to its
 * private working copy with the same `applyOp` used by replay and records it. Committing an effect re-applies the
 * recorded operations to a fresh clone of the base state and appends the version bump, so an event's `changes`
 * reproduce the post-state exactly (patch replay, §8.5).
 */
import type { EffectDraft, EventKind, IdPrefix, NarrationFact, PatchOp, WorldEvent, WorldState, ActorId } from './types.js';

export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchError';
  }
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function encodePointer(path: ReadonlyArray<string | number>): string {
  return path.map((segment) => '/' + String(segment).replace(/~/g, '~0').replace(/\//g, '~1')).join('');
}

/** Path segments that could reach an object's prototype; patches never traverse or create them. */
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

export function decodePointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new PatchError(`invalid JSON pointer "${pointer}"`);
  const tokens = pointer
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  for (const token of tokens) {
    if (FORBIDDEN_SEGMENTS.has(token)) throw new PatchError(`forbidden path segment "${token}" in ${pointer}`);
  }
  return tokens;
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null;
}

function arrayIndex(arr: unknown[], token: string, allowEnd: boolean, pointer: string): number {
  if (token === '-' && allowEnd) return arr.length;
  if (!/^(0|[1-9]\d*)$/.test(token)) throw new PatchError(`invalid array index "${token}" in ${pointer}`);
  const index = Number(token);
  const limit = allowEnd ? arr.length : arr.length - 1;
  if (index > limit) throw new PatchError(`array index ${index} out of range in ${pointer}`);
  return index;
}

/** Applies one operation to `target` in place. Inserted values are cloned (ops stay immutable). */
export function applyOp(target: unknown, op: PatchOp): void {
  const tokens = decodePointer(op.path);
  if (tokens.length === 0) throw new PatchError('operations on the document root are not supported');
  let parent: unknown = target;
  for (const token of tokens.slice(0, -1)) {
    if (!isContainer(parent)) throw new PatchError(`path ${op.path} traverses a non-container`);
    const next: unknown = Array.isArray(parent)
      ? parent[arrayIndex(parent, token, false, op.path)]
      : Object.hasOwn(parent, token)
        ? (parent as Record<string, unknown>)[token]
        : undefined;
    if (next === undefined) throw new PatchError(`path ${op.path} does not exist`);
    parent = next;
  }
  if (!isContainer(parent)) throw new PatchError(`parent of ${op.path} is not a container`);
  const last = tokens[tokens.length - 1] as string;

  if (Array.isArray(parent)) {
    switch (op.op) {
      case 'add':
        parent.splice(arrayIndex(parent, last, true, op.path), 0, clone(op.value));
        return;
      case 'replace':
        parent[arrayIndex(parent, last, false, op.path)] = clone(op.value);
        return;
      case 'remove':
        parent.splice(arrayIndex(parent, last, false, op.path), 1);
        return;
    }
  }
  const record = parent as Record<string, unknown>;
  switch (op.op) {
    case 'add':
      record[last] = clone(op.value);
      return;
    case 'replace':
      if (!Object.prototype.hasOwnProperty.call(record, last)) throw new PatchError(`replace target ${op.path} missing`);
      record[last] = clone(op.value);
      return;
    case 'remove':
      if (!Object.prototype.hasOwnProperty.call(record, last)) throw new PatchError(`remove target ${op.path} missing`);
      delete record[last];
      return;
  }
}

/** Pure: returns a new value with all operations applied in order. */
export function applyPatch<T>(value: T, ops: readonly PatchOp[]): T {
  const copy = clone(value);
  for (const op of ops) applyOp(copy, op);
  return copy;
}

function hasPath(root: unknown, path: ReadonlyArray<string | number>): boolean {
  let node: unknown = root;
  for (const segment of path) {
    if (!isContainer(node)) return false;
    if (Array.isArray(node)) {
      const i = Number(segment);
      if (!Number.isInteger(i) || i < 0 || i >= node.length) return false;
      node = node[i];
    } else {
      if (!Object.prototype.hasOwnProperty.call(node, String(segment))) return false;
      node = (node as Record<string, unknown>)[String(segment)];
    }
  }
  return true;
}

export type Path = ReadonlyArray<string | number>;

/** Effect builder: a working copy of the state plus the list of operations that produced it. */
export class Draft {
  readonly base: WorldState;
  private readonly work: WorldState;
  private readonly ops: PatchOp[] = [];
  private readonly factList: NarrationFact[] = [];
  private readonly rules = new Set<string>();

  constructor(base: WorldState) {
    this.base = base;
    this.work = clone(base);
  }

  /** The evolving state (read only; mutate through `set`/`push`/`remove`). */
  get s(): Readonly<WorldState> {
    return this.work;
  }

  /** Event id / version this effect will produce when committed. */
  get eventId(): number {
    return this.base.version + 1;
  }

  set(path: Path, value: unknown): void {
    if (value === undefined) throw new PatchError(`undefined value for ${encodePointer(path)}`);
    const op: PatchOp = hasPath(this.work, path)
      ? { op: 'replace', path: encodePointer(path), value: clone(value) }
      : { op: 'add', path: encodePointer(path), value: clone(value) };
    applyOp(this.work, op);
    this.ops.push(op);
  }

  push(path: Path, value: unknown): void {
    if (value === undefined) throw new PatchError(`undefined value for ${encodePointer(path)}`);
    const op: PatchOp = { op: 'add', path: encodePointer([...path, '-']), value: clone(value) };
    applyOp(this.work, op);
    this.ops.push(op);
  }

  remove(path: Path): void {
    const op: PatchOp = { op: 'remove', path: encodePointer(path) };
    applyOp(this.work, op);
    this.ops.push(op);
  }

  nextId(prefix: IdPrefix): string {
    const n = (this.work.counters[prefix] ?? 0) + 1;
    this.set(['counters', prefix], n);
    return `${prefix}:${n}`;
  }

  nextSendSeq(): number {
    const n = (this.work.counters.sendSeq ?? 0) + 1;
    this.set(['counters', 'sendSeq'], n);
    return n;
  }

  fact(fact: NarrationFact): void {
    this.factList.push(clone(fact));
  }

  rule(...ids: string[]): void {
    for (const id of ids) this.rules.add(id);
  }

  changes(): PatchOp[] {
    return this.ops.slice();
  }

  build(kind: EventKind, actor: ActorId): EffectDraft {
    return {
      kind,
      actor,
      changes: this.ops.slice(),
      facts: this.factList.slice(),
      rulesApplied: [...this.rules].sort(),
    };
  }
}

export interface CommitMeta {
  proposalId?: string | null;
  decisionId?: string | null;
}

/**
 * Commits one effect: applies its changes plus the version bump to a clone of `state`.
 * Every committed world change is one event and increases the version by exactly one (§8.2).
 */
export function commitEffect(
  state: WorldState,
  effect: EffectDraft,
  meta: CommitMeta = {},
): { state: WorldState; event: WorldEvent } {
  const version = state.version + 1;
  const changes: PatchOp[] = [...effect.changes, { op: 'replace', path: '/version', value: version }];
  const next = applyPatch(state, changes);
  const event: WorldEvent = {
    version,
    round: state.round,
    day: state.day,
    kind: effect.kind,
    actor: effect.actor,
    proposalId: meta.proposalId ?? null,
    decisionId: meta.decisionId ?? null,
    changes,
    facts: effect.facts,
    rulesApplied: effect.rulesApplied,
  };
  return { state: next, event };
}

/** Patch replay (§8.5): re-applies stored changes from a snapshot; returns every intermediate state. */
export function replayEvents(initial: WorldState, events: readonly WorldEvent[]): WorldState[] {
  const states: WorldState[] = [];
  let current = initial;
  for (const event of events) {
    if (event.version !== current.version + 1) {
      throw new PatchError(`event version ${event.version} does not follow state version ${current.version}`);
    }
    current = applyPatch(current, event.changes);
    states.push(current);
  }
  return states;
}
