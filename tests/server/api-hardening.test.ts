/**
 * Regression tests for the Codex review of WP-E (review 35 in docs/review_log.md), one block per finding:
 * 1 hidden terms in /proposals · 2 evaluation purpose in /api/config · 3 stale decision terms · 4 stale mapper
 * completions and stale POSTs · 5 write-ahead idempotency (fault injection, restart) · 6 loopback-only binding ·
 * 7 player-scoped telemetry while the director view is locked.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapperMock, personaTurn } from '../../src/agents/mock-personas/index.js';
import type { CharacterMeta } from '../../src/agents/character.js';
import type { MapperMeta } from '../../src/agents/mapper.js';
import { buildApp } from '../../src/server/app.js';
import type { StateView } from '../../src/server/api-types.js';
import { LOOPBACK_HOST, parseServerArgs, startServer } from '../../src/server/index.js';
import { content } from '../engine/helpers.js';
import { addressCouncil, advance, createSession, get, input, makeApp, playToEnd, post, rid, state, tempDir, turnOf } from './helpers.js';

const TANG_TERMS = ['和亲', '契丹中立', 'marriage alliance', 'Khitan neutrality'];

describe('#1 /proposals never resolves hidden terms (C4)', () => {
  it('the hidden Tang bid cannot even be referenced, and its terms never appear', async () => {
    const { app, manager } = await makeApp();
    const id = await createSession(app, 'C4');
    const tang = Object.values(manager.ctx(id).state.offers).find((o) => o.from === 'li_congke');
    expect(tang).toBeDefined();
    const r = await input(app, id, {
      requestId: rid('confirm'),
      kind: 'action',
      action: { type: 'confirm_commitment', args: { commitmentId: tang!.commitmentId, offerId: tang!.id, termsVersion: tang!.termsVersion } },
    });
    // Raw world ids are refused: the player names offers only by the aliases it was shown.
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('unknown_reference');
    const props = await get(app, `/api/sessions/${id}/proposals`);
    for (const t of TANG_TERMS) expect(props.text.includes(t), t).toBe(false);
    // Terms are resolved through the player's knowledge only: Shi's dispatch (round 1) shows the draft the clerk sees.
    await addressCouncil(app, id)((await state(app, id)).json);
    await advance(app, id);
    const pending = (await state(app, id)).json.pendingPause!;
    expect(pending.proposals[0]?.terms?.cession).toBe('yanmen_north');
    expect(pending.proposals[0]?.terms?.secret_clauses).toEqual([]);
    for (const t of TANG_TERMS) expect(JSON.stringify(pending).includes(t), t).toBe(false);
    // The director (after an explicit unlock) does see the live Tang offer.
    await post(app, `/api/sessions/${id}/director`, { requestId: rid('dir') });
    const dir = await get(app, `/api/sessions/${id}/state?view=director`);
    expect(dir.text).toContain('marriage_alliance":true');
  });
});

describe('#2 evaluation purposes stay out of player views', () => {
  it('/api/config carries generic player-safe descriptions; the purpose is in director views only', async () => {
    const { app } = await makeApp();
    const cfg = await get(app, '/api/config');
    const c4 = cfg.json.configs.find((c: { id: string }) => c.id === 'C4');
    expect(c4.purpose).toBeUndefined();
    expect(c4.description.en).toMatch(/director view/);
    const purpose = content().cases.C4!.purpose;
    expect(cfg.text.includes(purpose.zh.slice(0, 12))).toBe(false);
    expect(cfg.text.includes(purpose.en.slice(0, 30))).toBe(false);
    const id = await createSession(app, 'C4');
    expect((await state(app, id)).json.session.purpose).toBeNull();
    await post(app, `/api/sessions/${id}/director`, { requestId: rid('dir') });
    expect((await state(app, id)).json.session.purpose).toBeNull();
    const dir = await get<StateView>(app, `/api/sessions/${id}/state?view=director`);
    expect(dir.json.session.purpose?.en).toBe(purpose.en);
  });
});

const C1_TERMS = { vassal: true, filial: true, cession: 'yanmen_north', annual_silk: 0, immediate_silk: 80_000, aid_cavalry: 30_000, aid_arrival_days: 15, neutrality: false, marriage_alliance: false, secret_clauses: [] };

describe('#3 decision terms are those of the projected state before the paused proposal', () => {
  it('Shi revises 50,000 → 80,000, approves and dispatches in one batch: the pause shows 80,000, and 80,000 is sent', async () => {
    const { app, manager } = await makeApp({
      mockSetup: (mock) =>
        mock.register({ role: 'character', actor: 'shi_jingtang' }, (req) => {
          const out = personaTurn(req.meta as unknown as CharacterMeta);
          const approve = out.actions.find((a) => a.type === 'approve_document');
          const dispatch = out.actions.find((a) => a.type === 'dispatch_document');
          if (!approve || !dispatch) return out;
          const v = (approve.args as { docVersion: number }).docVersion;
          return {
            ...out,
            actions: [
              { type: 'revise_document', args: { docId: 'doc:1', baseDocVersion: v, terms: C1_TERMS, note: 'Shi raises the gift.' }, rationale: 'A larger gift.', cites: [] },
              { ...approve, args: { ...approve.args, docVersion: v + 1 } },
              { ...dispatch, args: { ...dispatch.args, docVersion: v + 1 } },
            ],
          };
        }),
    });
    const id = await createSession(app, 'C1', { mode: 'no_judge' });
    await addressCouncil(app, id)((await state(app, id)).json);
    await advance(app, id);
    const s = (await state(app, id)).json;
    expect(s.control.state).toBe('awaiting_decision');
    const pause = s.pendingPause!;
    expect(pause.category).toBe('dispatch_request');
    // The draft the player sees is still v1 with 50,000 (the batch has not committed) …
    expect(s.document?.terms.immediate_silk).toBe(50_000);
    // … but the decision shows what endorsing actually sends.
    expect(pause.proposals[0]?.terms?.immediate_silk).toBe(80_000);
    const facts = JSON.stringify(pause.visibleFacts);
    expect(facts).toContain('80000');
    expect(facts).not.toContain('50000');
    const d = await post(app, `/api/sessions/${id}/decision`, { requestId: rid('dec'), pauseId: pause.id, option: 'endorse', wait: 10_000 });
    expect(d.status).toBe(200);
    const sent = Object.values(manager.ctx(id).state.offers).find((o) => o.from === 'shi_jingtang');
    expect(sent?.terms.immediate_silk).toBe(80_000);
  });
});

describe('#4 inputs are bound to their turn', () => {
  it('a mapper completion that arrives after the turn ended is refused, and stale POSTs get a clear 409', async () => {
    let release!: () => void;
    let gate = new Promise<void>((r) => (release = r));
    const { app, manager } = await makeApp({
      mockSetup: (mock) =>
        mock.register('mapper', async (req) => {
          await gate;
          return mapperMock(req.meta as unknown as MapperMeta);
        }),
    });
    const id = await createSession(app, 'C1');
    const t1 = await turnOf(app, id);
    const pending = app.inject({ method: 'POST', url: `/api/sessions/${id}/input`, payload: { requestId: rid('map'), turn: t1, kind: 'text', text: '暂缓发遣' } });
    await new Promise((r) => setTimeout(r, 50));
    const adv = await advance(app, id);
    expect(adv.status).toBe(200);
    expect(adv.json.control.turn).not.toBe(t1);
    release();
    const late = await pending;
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toBe('stale_mapping');
    expect(manager.ctx(id).state.documents['doc:1']?.timing.mode).toBe('now');
    // Stale POSTs (an old token) are refused; the current token works.
    const old = await post(app, `/api/sessions/${id}/input`, { requestId: rid('old'), turn: t1, kind: 'dialogue', to: ['liu_zhiyuan'], text: '…' });
    expect(old.status).toBe(409);
    expect(old.json.error).toBe('stale_turn');
    const oldAdv = await post(app, `/api/sessions/${id}/advance`, { requestId: rid('oldadv'), turn: t1, wait: 5_000 });
    expect(oldAdv.status).toBe(409);
    expect(oldAdv.json.error).toBe('stale_turn');
    // A completion after a world change within the same turn is refused too.
    gate = new Promise<void>((r) => (release = r));
    const t2 = await turnOf(app, id);
    const pending2 = app.inject({ method: 'POST', url: `/api/sessions/${id}/input`, payload: { requestId: rid('map2'), turn: t2, kind: 'text', text: '暂缓发遣' } });
    await new Promise((r) => setTimeout(r, 50));
    const docAlias = (await state(app, id)).json.document!.docId;
    const hold = await input(app, id, { requestId: rid('hold'), kind: 'action', action: { type: 'set_dispatch_timing', args: { docId: docAlias, mode: 'hold', rounds: null } } });
    expect(hold.json.outcomes[0].status).toBe('committed');
    release();
    const late2 = await pending2;
    expect(late2.statusCode).toBe(409);
    expect(late2.json().error).toBe('stale_mapping');
    expect(manager.ctx(id).state.documents['doc:1']?.timing.mode).toBe('hold');
  });
});

describe('#5 write-ahead idempotency: a retried advance never ends a second turn', () => {
  const crashOnce = (): { faults: { beforeReceipt: (route: string) => void }; fired: () => boolean } => {
    let armed = true;
    let fired = false;
    return {
      fired: () => fired,
      faults: {
        beforeReceipt: (route) => {
          if (route === 'advance' && armed) {
            armed = false;
            fired = true;
            throw new Error('injected crash between the effect and its receipt');
          }
        },
      },
    };
  };

  it('in process: the receipt write fails after the turn ended; the retry recovers instead of ending round 2', async () => {
    const crash = crashOnce();
    const { app, manager } = await makeApp({ faults: crash.faults });
    const id = await createSession(app, 'C1');
    const body = { requestId: rid('adv'), turn: await turnOf(app, id), wait: 10_000 };
    const first = await post(app, `/api/sessions/${id}/advance`, body);
    expect(crash.fired()).toBe(true);
    expect(first.status).toBe(500);
    const s1 = (await state(app, id)).json;
    expect(s1.control.state).toBe('awaiting_player');
    expect(s1.control.round).toBe(2);
    const retry = await post(app, `/api/sessions/${id}/advance`, body);
    expect(retry.status).toBe(200);
    expect(retry.json.recovered).toBe(true);
    expect(retry.headers['x-idempotent-replay']).toBe('true');
    const s2 = (await state(app, id)).json;
    expect(s2.control.round).toBe(2);
    expect(s2.control.state).toBe('awaiting_player');
    const records = manager.recordsOf(manager.main);
    expect(records.findTurn(id, 2)).toBeNull();
    // A third retry is a plain replay of the stored receipt.
    const third = await post(app, `/api/sessions/${id}/advance`, body);
    expect(third.json).toEqual(retry.json);
  });

  it('across a restart: the pending intent is recovered from the persisted turn record', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'play db.sqlite');
    const crash = crashOnce();
    const first = await buildApp({ dbPath, content: content(), staticDir: null, faults: crash.faults });
    const id = await createSession(first.app, 'C1');
    const body = { requestId: rid('adv'), turn: await turnOf(first.app, id), wait: 10_000 };
    expect((await post(first.app, `/api/sessions/${id}/advance`, body)).status).toBe(500);
    await first.app.close();
    const second = await buildApp({ dbPath, content: content(), staticDir: null });
    try {
      const retry = await post(second.app, `/api/sessions/${id}/advance`, body);
      expect(retry.status).toBe(200);
      expect(retry.json.recovered).toBe(true);
      const s = (await state(second.app, id)).json;
      expect(s.control.round).toBe(2);
      expect(s.control.state).toBe('awaiting_player');
      expect(second.manager.recordsOf(second.manager.main).findTurn(id, 2)).toBeNull();
    } finally {
      await second.app.close();
    }
  });
});

describe('#6 the server binds the loopback address only', () => {
  it('refuses any other --host and listens on 127.0.0.1', async () => {
    expect(parseServerArgs([]).host).toBe(LOOPBACK_HOST);
    expect(parseServerArgs(['--host', '127.0.0.1']).host).toBe('127.0.0.1');
    for (const host of ['0.0.0.0', '::', 'localhost', '::1', '192.168.1.5']) {
      expect(() => parseServerArgs(['--host', host]), host).toThrow(/refused/);
    }
    const dir = tempDir();
    const server = await startServer({ ...parseServerArgs(['--port', '0', '--db', path.join(dir, 'p.sqlite'), '--no-static']), staticDir: null }, { content: content() });
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await server.app.close();
    }
  });
});

async function readAll(url: string, ms = 800): Promise<Array<{ type: string; data: any }>> {
  const res = await fetch(url);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), Math.max(1, deadline - Date.now())))]);
    if (chunk === null || chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
  }
  await reader.cancel().catch(() => undefined);
  return buffer
    .split('\n\n')
    .map((block) => ({ type: /^event: (.*)$/m.exec(block)?.[1], data: /^data: (.*)$/m.exec(block)?.[1] }))
    .filter((m): m is { type: string; data: string } => m.type !== undefined && m.data !== undefined)
    .map((m) => ({ type: m.type, data: JSON.parse(m.data) as unknown }));
}

describe('#7 locked player views carry only player-scoped counters', () => {
  it('no offstage call telemetry, no remote progress on the stream, no world versions', async () => {
    const { app } = await makeApp();
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const id = await createSession(app, 'C1');
    // Round 1: the request goes out; round 2: Yelü answers at the Khitan court (offstage) — stop before the end.
    await addressCouncil(app, id)((await state(app, id)).json);
    await advance(app, id);
    const s = (await state(app, id)).json;
    await post(app, `/api/sessions/${id}/decision`, { requestId: rid('dec'), pauseId: s.control.pauseId, option: 'endorse', wait: 10_000 });
    const r2 = (await state(app, id)).json;
    expect(r2.control.round).toBe(2);
    expect(r2.session.directorAllowed).toBe(false);
    const usage = await get(app, `/api/sessions/${id}/usage`);
    expect(usage.json.detailed).toBe(false);
    expect(usage.json.calls).toBeNull();
    expect(usage.json.byRole).toBeNull();
    expect(usage.json.totals).toBeNull();
    expect(usage.json.player.actions.total).toBeGreaterThanOrEqual(0);
    expect([0, 0.25, 0.5, 0.75, 1]).toContain(usage.json.player.budgetUsed);
    expect(r2.world.version).toBeNull();
    const events = await get(app, `/api/sessions/${id}/events`);
    expect(events.json.events.every((e: { version: unknown }) => e.version === null)).toBe(true);
    expect(JSON.stringify(events.json.events.flatMap((e: { changes: Array<{ path: string }> }) => e.changes.map((c) => c.path)))).not.toContain('"/version"');
    const props = await get(app, `/api/sessions/${id}/proposals`);
    expect(props.json.proposals.every((p: { eventVersions: unknown[] }) => p.eventVersions.length === 0)).toBe(true);
    const tl = await get(app, `/api/sessions/${id}/timeline`);
    expect(tl.json.rounds.every((r: { version: unknown }) => r.version === null)).toBe(true);
    const diff = await get(app, `/api/sessions/${id}/diff?fromRound=1`);
    expect(diff.json.unit).toBe('round');
    // Round 2's offstage work (Yelü at the Khitan court) leaves no trace on the stream.
    await advance(app, id);
    const messages = await readAll(`${base}/api/sessions/${id}/stream?since=0`);
    expect(messages.length).toBeGreaterThan(5);
    const allowed = new Set(['prepare', 'player', 'generate:opened', 'generate:called', 'generate:submitted', 'assess', 'decide', 'advance']);
    for (const m of messages) {
      if (m.type === 'phase') expect(allowed.has(m.data.step), m.data.step).toBe(true);
      if (m.type === 'narration') expect(m.data.scene).toBe('jinyang_hq');
      if (m.type === 'progress') expect(['player_input', 'narration_regenerated']).toContain(m.data.kind);
      if (m.type === 'control') expect(['narrate', 'commit'].includes(m.data.lastStep)).toBe(false);
    }
    // Once the chapter has ended (director view allowed), the full telemetry is available.
    await playToEnd(app, id, { onTurn: addressCouncil(app, id) });
    const after = await get(app, `/api/sessions/${id}/usage`);
    expect(after.json.detailed).toBe(true);
    expect(after.json.calls.length).toBeGreaterThan(0);
  });
});
