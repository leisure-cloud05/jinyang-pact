/**
 * Player-scoped aliases for ids that carry global counters. World ids (`offer:N`, `cmt:N`, `msg:N`, `k:N`,
 * `event:N`) and control ids (`<session>/pauseN`, `/bN`, `/bN/pM`, `/dN`, `/insN`) are numbered across everything
 * that happened, offstage included: `offer:2` tells the player that an `offer:1` exists somewhere. In player views
 * every such id is replaced by an alias numbered in order of first player visibility ("offer A", "pause 3"):
 * - offers, threads, messages: order of first mention in the player's own knowledge (assertions in acquisition
 *   order), so a branch shares its parent's aliases for the shared past;
 * - notes (`k:N`): the player's own assertions, in order; events: the events the player witnesses, in order;
 * - pauses, decisions, instructions: the session's (all of them concern the player), in order;
 * - proposals: those of the player and of player-side characters at headquarters, in order; batches: in order of
 *   first appearance in the session's events, then the remaining batches.
 * An id the player never saw becomes "offer ?" etc. — never the real id. Director views keep the real ids.
 * Inputs carrying aliases are resolved back (`resolve`); a raw world id from the player is refused by the caller.
 */
import { compareIds } from '../core/ids.js';
import { canAccessDocument, knowledgeOf } from '../core/knowledge.js';
import type { SessionCtx } from './context.js';
import { playerSeesActor, playerSeesFact } from './views/common.js';

export type AliasKind =
  | 'document'
  | 'suggestion'
  | 'authorization'
  | 'reservation'
  | 'offer'
  | 'thread'
  | 'message'
  | 'note'
  | 'event'
  | 'pause'
  | 'proposal'
  | 'batch'
  | 'decision'
  | 'instruction';

/** Every world-object id prefix (core `IdPrefix`) plus event references. */
const WORLD_PREFIX: Record<string, AliasKind> = {
  doc: 'document',
  sug: 'suggestion',
  auth: 'authorization',
  rsv: 'reservation',
  offer: 'offer',
  cmt: 'thread',
  msg: 'message',
  k: 'note',
  event: 'event',
};
const LETTERED = new Set<AliasKind>(['offer', 'thread', 'document']);
const WORLD_ID = /(?<![A-Za-z0-9_])(doc|sug|auth|rsv|offer|cmt|msg|k|event):(\d+)(?!\d)/g;
/** Numeric fields that carry global counters (world versions / event ids): aliased or dropped in player views. */
const EVENT_ID_KEYS = new Set(['eventId']);
const GLOBAL_VERSION_KEYS = new Set(['parentVersion', 'baseVersion', 'worldVersion', 'fromVersion', 'toVersion', 'committedVersion']);
const CONTROL_KIND: Record<string, AliasKind> = { pause: 'pause', b: 'batch', d: 'decision', ins: 'instruction' };

function letters(n: number): string {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class Aliases {
  private readonly forward = new Map<string, string>();
  private readonly backward = new Map<string, string>();
  private readonly counts = new Map<AliasKind, number>();
  private readonly controlPattern: RegExp | null;

  constructor(ctx: SessionCtx) {
    const { harness, sessionId, state, config } = ctx;
    const repo = harness.repo;
    // What the player can see from the start: its accessible documents, the suggestions on them, its own
    // authorizations (each kind in id order).
    const docs = Object.values(state.documents).filter((d) => canAccessDocument(state, 'player', d)).sort((a, b) => compareIds(a.id, b.id));
    for (const d of docs) this.add('document', d.id);
    for (const s of Object.values(state.suggestions).sort((a, b) => compareIds(a.id, b.id))) {
      if (s.target.kind === 'document' && docs.some((d) => d.id === s.target.id)) this.add('suggestion', s.id);
    }
    for (const a of Object.values(state.player.authorizations).sort((x, y) => compareIds(x.id, y.id))) this.add('authorization', a.id);
    // Other world ids, in order of first mention in the player's own knowledge.
    for (const k of knowledgeOf(state, 'player').sort((a, b) => compareIds(a.id, b.id))) {
      this.add('note', k.id);
      const text = `${k.subject} ${JSON.stringify(k.value)} ${k.evidence.ref}`;
      for (const m of text.matchAll(WORLD_ID)) {
        const kind = WORLD_PREFIX[m[1] as string] as AliasKind;
        if (kind === 'event' || kind === 'note') continue;
        const id = `${m[1]}:${m[2]}`;
        this.add(kind, id);
        if (kind === 'offer') {
          const thread = state.offers[id]?.commitmentId;
          if (thread) this.add('thread', thread);
        }
      }
    }
    // Events the player witnesses (its own, or with a fact it sees), in order; batches by first appearance.
    const events = repo.listEvents(sessionId);
    for (const e of events) {
      if (e.actor === 'player' || e.facts.some((f) => playerSeesFact(f, ctx.playerLoc))) this.add('event', `event:${e.version}`);
      if (e.batchId) this.add('batch', e.batchId);
    }
    for (const b of repo.listBatches(sessionId)) this.add('batch', b.batchId);
    for (const p of repo.listPauses(sessionId)) this.add('pause', p.id);
    for (const d of repo.listSessionDecisions(sessionId)) this.add('decision', d.decisionId);
    for (const i of repo.listInstructions(sessionId)) this.add('instruction', i.instructionId);
    for (const p of repo.listSessionProposals(sessionId)) {
      if (playerSeesActor(p.actor, state, config, ctx.playerLoc)) this.add('proposal', p.proposalId);
    }
    // Control ids are prefixed by a session id of the lineage (inherited events keep the parent's batch ids).
    const lineage: string[] = [];
    for (let id: string | null = sessionId, n = 0; id && n < 50; n++) {
      lineage.push(id);
      id = repo.findSession(id)?.parentSessionId ?? null;
    }
    this.controlPattern = new RegExp(`(?:${lineage.map(escape).join('|')})/(?:pause|b|d|ins)\\d+(?:/p\\d+)?`, 'g');
  }

  private add(kind: AliasKind, real: string): void {
    if (this.forward.has(real)) return;
    const n = (this.counts.get(kind) ?? 0) + 1;
    this.counts.set(kind, n);
    const alias = `${kind} ${LETTERED.has(kind) ? letters(n) : String(n)}`;
    this.forward.set(real, alias);
    this.backward.set(alias, real);
  }

  /** Alias of a real id (`<kind> ?` when the player never saw it). */
  aliasOf(real: string): string {
    const known = this.forward.get(real);
    if (known) return known;
    const world = /^(doc|sug|auth|rsv|offer|cmt|msg|k|event):\d+$/.exec(real);
    if (world) return `${WORLD_PREFIX[world[1] as string] as AliasKind} ?`;
    const control = /\/(pause|b|d|ins)\d+(\/p\d+)?$/.exec(real);
    if (control) return `${control[2] ? 'proposal' : (CONTROL_KIND[control[1] as string] as AliasKind)} ?`;
    return real;
  }

  /** The real id behind an alias of `kind` (null: not an alias of that kind). */
  resolve(kind: AliasKind, alias: string): string | null {
    const real = this.backward.get(alias.trim());
    return real !== undefined && alias.trim().startsWith(`${kind} `) ? real : null;
  }

  private rewrite(text: string): string {
    let out = this.controlPattern ? text.replace(this.controlPattern, (m) => this.aliasOf(m)) : text;
    out = out.replace(WORLD_ID, (m) => this.aliasOf(m));
    return out;
  }

  /** Deep copy of a player-view value with every real id (in keys and strings) replaced by its alias. */
  apply<T>(value: T): T {
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') return this.rewrite(v);
      if (Array.isArray(v)) return v.map(walk);
      if (v !== null && typeof v === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, item] of Object.entries(v)) {
          if (EVENT_ID_KEYS.has(k) && typeof item === 'number') out[k] = this.aliasOf(`event:${item}`);
          else if (GLOBAL_VERSION_KEYS.has(k) && typeof item === 'number') out[k] = null;
          else if (k === 'eventVersions' && Array.isArray(item)) out[k] = [];
          else out[this.rewrite(k)] = walk(item);
        }
        return out;
      }
      return v;
    };
    return walk(value) as T;
  }
}
