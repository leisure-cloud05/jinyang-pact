/** Play-server test utilities: an app on a temp database (path with spaces), inject helpers, a scripted player. */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppOptions, type PlayApp } from '../../src/server/app.js';
import type { ControlView, StateView } from '../../src/server/api-types.js';
import { content } from '../engine/helpers.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    try {
      await cleanup.pop()?.();
    } catch {
      /* best effort */
    }
  }
});

export function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jinyang server test '));
  cleanup.unshift(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export async function makeApp(opts: Partial<AppOptions> = {}): Promise<PlayApp & { dir: string }> {
  const dir = tempDir();
  const play = await buildApp({ dbPath: path.join(dir, 'play db.sqlite'), content: content(), staticDir: null, logger: false, ...opts });
  cleanup.push(() => play.app.close());
  return { ...play, dir };
}

let seq = 0;
export function rid(prefix = 'req'): string {
  seq += 1;
  return `${prefix}-${seq}-${Date.now().toString(36)}`;
}

export interface Res<T = any> {
  status: number;
  json: T;
  headers: Record<string, string | string[] | number | undefined>;
  text: string;
}

export async function get<T = any>(app: FastifyInstance, url: string): Promise<Res<T>> {
  const r = await app.inject({ method: 'GET', url });
  let json: T;
  try {
    json = r.json() as T;
  } catch {
    json = undefined as T;
  }
  return { status: r.statusCode, json, headers: r.headers, text: r.body };
}

export async function post<T = any>(app: FastifyInstance, url: string, body: Record<string, unknown>): Promise<Res<T>> {
  const r = await app.inject({ method: 'POST', url, payload: body });
  let json: T;
  try {
    json = r.json() as T;
  } catch {
    json = undefined as T;
  }
  return { status: r.statusCode, json, headers: r.headers, text: r.body };
}

export async function createSession(app: FastifyInstance, caseId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await post(app, '/api/sessions', { requestId: rid('create'), caseId, wait: 10_000, ...extra });
  if (r.status !== 200) throw new Error(`create failed: ${r.status} ${r.text}`);
  return r.json.sessionId as string;
}

export async function state(app: FastifyInstance, id: string, view: 'player' | 'director' = 'player'): Promise<Res<StateView>> {
  return get<StateView>(app, `/api/sessions/${id}/state?wait=10000${view === 'director' ? '&view=director' : ''}`);
}

/** The token of the awaited player turn (throws when it is not the player's turn). */
export async function turnOf(app: FastifyInstance, id: string): Promise<string> {
  const s = await state(app, id);
  if (!s.json.control.turn) throw new Error(`not the player's turn: ${s.json.control.state}`);
  return s.json.control.turn;
}

/** POST /input within the current turn. */
export async function input<T = any>(app: FastifyInstance, id: string, body: Record<string, unknown>): Promise<Res<T>> {
  return post<T>(app, `/api/sessions/${id}/input`, { turn: await turnOf(app, id), ...body });
}

/** POST /advance ending the current turn. */
export async function advance<T = any>(app: FastifyInstance, id: string, body: Record<string, unknown> = {}): Promise<Res<T>> {
  const s = await state(app, id);
  return post<T>(app, `/api/sessions/${id}/advance`, { requestId: rid('adv'), wait: 10_000, turn: s.json.control.turn, ...body });
}

export type Chooser = (s: StateView) => Record<string, unknown> | null;

/** The case policy's suggestion (or endorse / the first non-ask option). */
export const policyChooser: Chooser = (s) => {
  const p = s.pendingPause;
  if (!p) return null;
  const sug = p.suggestion;
  if (sug && p.options.includes(sug.option)) {
    const body: Record<string, unknown> = { option: sug.option };
    if (sug.advice !== null) body.advice = sug.advice;
    if (sug.authorization !== null) body.authorization = sug.authorization;
    if (sug.goalLimits !== null) body.goalLimits = sug.goalLimits;
    if (sug.counterTerms !== null) body.counterTerms = sug.counterTerms;
    if (sug.amend !== null) body.amend = sug.amend;
    return body;
  }
  const option = p.options.find((o) => o === 'endorse' || o === 'let_it_happen' || o === 'retry' || o === 'resume') ?? p.options.find((o) => o !== 'ask') ?? 'endorse';
  return { option };
};

/**
 * Plays a session through the API until the chapter ends: ends each player turn, decides each pause with
 * `chooser`, and calls `each` with every state seen (for leak checks).
 */
export interface PlayOptions {
  chooser?: Chooser;
  /** Called with every state seen (leak checks). */
  each?: (s: StateView) => Promise<void> | void;
  /** Player inputs at the start of each turn (before it is ended). */
  onTurn?: (s: StateView) => Promise<void> | void;
  maxSteps?: number;
}

/** Addresses Shi and Sang at the start of every turn (the council acts when addressed or by its agendas). */
export function addressCouncil(app: FastifyInstance, id: string, text = '明公，表已誊毕，请用印遣使。'): (s: StateView) => Promise<void> {
  return async (s: StateView) => {
    const r = await post(app, `/api/sessions/${id}/input`, { requestId: rid('talk'), turn: s.control.turn, kind: 'dialogue', to: ['shi_jingtang', 'sang_weihan'], text });
    if (r.status !== 200) throw new Error(`input ${r.status}: ${r.text}`);
  };
}

export async function playToEnd(app: FastifyInstance, id: string, opts: PlayOptions = {}): Promise<ControlView> {
  const chooser = opts.chooser ?? policyChooser;
  for (let i = 0; i < (opts.maxSteps ?? 80); i++) {
    const s = await state(app, id);
    if (s.status !== 200) throw new Error(`state ${s.status}: ${s.text}`);
    await opts.each?.(s.json);
    const c = s.json.control;
    if (c.state === 'finished' || c.state === 'stopped' || c.state === 'error' || c.state === 'unavailable') return c;
    if (c.state === 'awaiting_player') {
      await opts.onTurn?.(s.json);
      const r = await post(app, `/api/sessions/${id}/advance`, { requestId: rid('adv'), wait: 10_000, turn: c.turn });
      if (r.status !== 200) throw new Error(`advance ${r.status}: ${r.text}`);
    } else if (c.state === 'awaiting_decision') {
      const choice = chooser(s.json);
      if (!choice) throw new Error('awaiting a decision but no pending pause in the state view');
      const r = await post(app, `/api/sessions/${id}/decision`, { requestId: rid('dec'), pauseId: c.pauseId, wait: 10_000, ...choice });
      if (r.status !== 200) throw new Error(`decision ${r.status}: ${r.text}`);
    } else if (c.state === 'suspended') {
      throw new Error(`suspended: ${c.suspendedReason ?? ''}`);
    }
  }
  throw new Error('did not finish');
}
