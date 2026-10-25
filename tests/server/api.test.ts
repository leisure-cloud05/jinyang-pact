/** Play server API (WP-E): sessions, play to a terminal, idempotency, inputs, interrupts, branch/compare, static. */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StateView } from '../../src/server/api-types.js';
import { addressCouncil, advance, createSession, get, input, makeApp, playToEnd, post, rid, state, turnOf } from './helpers.js';

describe('server basics', () => {
  it('lists configs (cases, dev, pilot, free play) and refuses live without --live', async () => {
    const { app } = await makeApp();
    const cfg = await get(app, '/api/config');
    expect(cfg.status).toBe(200);
    const ids = cfg.json.configs.map((c: { id: string }) => c.id);
    for (const id of ['FREE', 'C1', 'C4', 'D1', 'P1']) expect(ids).toContain(id);
    expect(cfg.json.liveAvailable).toBe(false);
    const live = await post(app, '/api/sessions', { requestId: rid(), caseId: 'C1', llm: 'live' });
    expect(live.status).toBe(400);
    expect(live.json.error).toBe('live_unavailable');
    const bad = await post(app, '/api/sessions', { caseId: 'C1' });
    expect(bad.status).toBe(400);
  });

  it('creates a session that waits for the player; creation is idempotent per requestId', async () => {
    const { app } = await makeApp();
    const requestId = rid('create');
    const a = await post(app, '/api/sessions', { requestId, caseId: 'C1', wait: 10_000 });
    expect(a.status).toBe(200);
    expect(a.json.control.state).toBe('awaiting_player');
    expect(a.headers['x-idempotent-replay']).toBe('false');
    const b = await post(app, '/api/sessions', { requestId, caseId: 'C1', wait: 10_000 });
    expect(b.status).toBe(200);
    expect(b.json.sessionId).toBe(a.json.sessionId);
    expect(b.headers['x-idempotent-replay']).toBe('true');
    const c = await post(app, '/api/sessions', { requestId, caseId: 'C2' });
    expect(c.status).toBe(409);
    expect(c.json.error).toBe('request_id_reused');
    const list = await get(app, '/api/sessions');
    expect(list.json.sessions).toHaveLength(1);
    const s = await state(app, a.json.sessionId);
    expect(s.json.document?.docId).toBe('document A');
    expect(s.json.characters.filter((ch) => ch.present).map((ch) => ch.id).sort()).toEqual(['liu_zhiyuan', 'sang_weihan', 'shi_jingtang']);
  });

  it('free play starts from the scenario draft', async () => {
    const { app } = await makeApp();
    const id = await createSession(app, 'FREE', { lang: 'en' });
    const s = await state(app, id);
    expect(s.json.session.kind).toBe('free');
    expect(s.json.document?.terms.cession).toBe('sixteen_prefectures');
    expect(s.json.control.state).toBe('awaiting_player');
  });
});

describe('play C1 to a terminal through the API', () => {
  it('ends with the pact, with a paused dispatch decided by the player, narration and replay', async () => {
    const { app } = await makeApp();
    const id = await createSession(app, 'C1');
    const seen: string[] = [];
    const end = await playToEnd(app, id, {
      onTurn: addressCouncil(app, id),
      each: (s) => {
        if (s.pendingPause) seen.push(s.pendingPause.category);
      },
    });
    expect(end.state).toBe('finished');
    expect(end.outcome).toBe('valid_terminal:pact_concluded');
    expect(seen).toContain('dispatch_request');
    const pauses = await get(app, `/api/sessions/${id}/pauses`);
    const dispatch = pauses.json.history.find((p: { category: string }) => p.category === 'dispatch_request');
    expect(dispatch.decision.by).toBe('user');
    const story = await get(app, `/api/sessions/${id}/narration`);
    expect(story.json.items.some((i: { kind: string }) => i.kind === 'narration')).toBe(true);
    expect(story.json.items.every((i: { scene?: string }) => i.scene === undefined || i.scene === 'jinyang_hq')).toBe(true);
    const storyEn = await get(app, `/api/sessions/${id}/narration?lang=en`);
    expect(JSON.stringify(storyEn.json)).toContain('Jinyang headquarters');
    const replay = await post(app, `/api/sessions/${id}/replay`, { requestId: rid(), mode: 'rederive' });
    expect(replay.status).toBe(200);
    expect(replay.json.ok).toBe(true);
    const patch = await post(app, `/api/sessions/${id}/replay`, { requestId: rid(), mode: 'patch' });
    expect(patch.json.ok).toBe(true);
    const usage = await get(app, `/api/sessions/${id}/usage`);
    expect(usage.json.totals.calls).toBeGreaterThan(0);
    expect(usage.json.byRole.map((r: { role: string }) => r.role)).toContain('character');
    const timeline = await get(app, `/api/sessions/${id}/timeline`);
    expect(timeline.json.rounds.length).toBeGreaterThanOrEqual(3);
    expect(timeline.json.rounds.some((r: { pauses: Array<{ category: string }> }) => r.pauses.some((p) => p.category === 'dispatch_request'))).toBe(true);
    const events = await get(app, `/api/sessions/${id}/events`);
    expect(events.json.events.some((e: { kind: string }) => e.kind === 'dispatch_document')).toBe(true);
    // Remote events (Yelü's confirmation at the Khitan court) are not in the player's inspector.
    expect(events.json.events.some((e: { kind: string }) => e.kind === 'confirm_commitment')).toBe(false);
    const director = await get(app, `/api/sessions/${id}/events?view=director`);
    expect(director.status).toBe(200);
    expect(director.json.events.some((e: { kind: string }) => e.kind === 'confirm_commitment')).toBe(true);
  });
});

describe('idempotent POSTs', () => {
  it('a retried advance or decision returns the stored result and executes nothing twice', async () => {
    const { app, manager } = await makeApp();
    const id = await createSession(app, 'C1');
    await addressCouncil(app, id)((await state(app, id)).json);
    const adv = { requestId: rid('adv'), wait: 10_000, turn: await turnOf(app, id) };
    const first = await post(app, `/api/sessions/${id}/advance`, adv);
    expect(first.status).toBe(200);
    expect(first.json.control.state).toBe('awaiting_decision');
    const late = await post(app, `/api/sessions/${id}/input`, { requestId: rid('late'), turn: adv.turn, kind: 'dialogue', to: ['liu_zhiyuan'], text: 'late' });
    expect(late.status).toBe(409);
    expect(late.json.error).toBe('not_player_turn');
    const again = await post(app, `/api/sessions/${id}/advance`, adv);
    expect(again.status).toBe(200);
    expect(again.headers['x-idempotent-replay']).toBe('true');
    expect(again.json).toEqual(first.json);
    const s = await state(app, id);
    expect(s.json.control.state).toBe('awaiting_decision');
    const pauseId = s.json.control.pauseId as string;
    const option = s.json.pendingPause?.suggestion?.option ?? 'endorse';
    const dec = { requestId: rid('dec'), pauseId, option, wait: 10_000 };
    const d1 = await post(app, `/api/sessions/${id}/decision`, dec);
    expect(d1.status).toBe(200);
    const version = manager.ctx(id).state.version;
    const d2 = await post(app, `/api/sessions/${id}/decision`, dec);
    expect(d2.status).toBe(200);
    expect(d2.headers['x-idempotent-replay']).toBe('true');
    expect(manager.ctx(id).state.version).toBe(version);
    const decisions = (await get(app, `/api/sessions/${id}/pauses`)).json.history.filter((p: { id: string }) => p.id === pauseId);
    expect(decisions).toHaveLength(1);
    const reused = await post(app, `/api/sessions/${id}/decision`, { ...dec, option: 'withhold' });
    expect(reused.status).toBe(409);
  });
});

describe('player inputs', () => {
  it('revises the draft, sets timing, refuses absent listeners, and refuses input outside the turn', async () => {
    const { app } = await makeApp();
    const id = await createSession(app, 'C1');
    const s0 = (await state(app, id)).json as StateView;
    const doc = s0.document;
    expect(doc).not.toBeNull();
    const terms = { ...doc!.terms, immediate_silk: 30000, secret_clauses: doc!.terms.secret_clauses.map((c) => c.id) };
    const rev = await input(app, id, {
      requestId: rid('rev'),
      kind: 'action',
      action: { type: 'revise_document', args: { docId: doc!.docId, baseDocVersion: doc!.version, terms, note: 'less silk' } },
    });
    expect(rev.status).toBe(200);
    expect(rev.json.outcomes[0].status).toBe('committed');
    const s1 = (await state(app, id)).json as StateView;
    expect(s1.document?.version).toBe(doc!.version + 1);
    expect(s1.document?.terms.immediate_silk).toBe(30000);
    expect(s1.document?.approvedCurrent).toBe(false);
    const stale = await input(app, id, {
      requestId: rid('stale'),
      kind: 'action',
      action: { type: 'revise_document', args: { docId: doc!.docId, baseDocVersion: doc!.version, terms, note: 'stale' } },
    });
    expect(stale.json.outcomes[0].status).toBe('rejected');
    expect(stale.json.outcomes[0].rule).toBe('H04');
    const timing = await input(app, id, {
      requestId: rid('t'),
      kind: 'action',
      action: { type: 'set_dispatch_timing', args: { docId: doc!.docId, mode: 'delay', rounds: 1 } },
    });
    expect(timing.json.outcomes[0].status).toBe('committed');
    const transmit = await input(app, id, {
      requestId: rid('tx'),
      kind: 'action',
      action: { type: 'dispatch_document', args: { docId: doc!.docId, docVersion: doc!.version + 1 } },
    });
    expect(transmit.json.outcomes[0].status).toBe('rejected');
    const absent = await input(app, id, { requestId: rid('d'), kind: 'dialogue', to: ['yelu_deguang'], text: 'Please help us.' });
    expect(absent.status).toBe(400);
    expect(absent.json.error).toBe('not_present');
    const talk = await input(app, id, { requestId: rid('d'), kind: 'dialogue', to: ['liu_zhiyuan'], text: '押牙以为如何？' });
    expect(talk.status).toBe(200);
    const dialogue = await get(app, `/api/sessions/${id}/dialogue`);
    expect(dialogue.json.rows.some((r: { text: string }) => r.text === '押牙以为如何？')).toBe(true);
    const mapped = await input(app, id, { requestId: rid('m'), kind: 'text', text: '请即遣使发出此表' });
    expect(mapped.status).toBe(200);
    expect(mapped.json.mapped.kind).not.toBeNull();
    const unsupported = await input(app, id, { requestId: rid('m'), kind: 'text', text: '我替明公允约' });
    expect(unsupported.json.mapped.kind).toBe('unsupported');
    expect(unsupported.json.applied).toBe(false);
    // The request is delayed one round: the council deliberates, nothing is dispatched, the turn comes back.
    const adv = await advance(app, id);
    expect(adv.status).toBe(200);
    const after = (await state(app, id)).json as StateView;
    expect(after.world.round).toBe(2);
    expect(after.document?.status).not.toBe('sent');
  });
});

describe('interrupts', () => {
  it('an interrupt during a decision obsoletes the pause and the council regenerates with the instruction', async () => {
    const { app } = await makeApp();
    const id = await createSession(app, 'C1');
    await addressCouncil(app, id)((await state(app, id)).json);
    await advance(app, id);
    const s = (await state(app, id)).json as StateView;
    expect(s.control.state).toBe('awaiting_decision');
    const oldPause = s.control.pauseId as string;
    const epoch = s.control.epoch;
    const r = await post(app, `/api/sessions/${id}/interrupt`, { requestId: rid('int'), text: '且慢，请再议条款。', wait: 10_000 });
    expect(r.status).toBe(200);
    expect(r.json.accepted).toBe(true);
    const s2 = (await state(app, id)).json as StateView;
    expect(s2.control.epoch).toBeGreaterThan(epoch);
    expect(['awaiting_decision', 'awaiting_player']).toContain(s2.control.state);
    expect(s2.control.pauseId).not.toBe(oldPause);
    const pauses = await get(app, `/api/sessions/${id}/pauses`);
    expect(pauses.json.history.find((p: { id: string }) => p.id === oldPause)?.status).toBe('obsolete');
    const dialogue = await get(app, `/api/sessions/${id}/dialogue`);
    expect(dialogue.json.rows.some((row: { text: string }) => row.text.includes('且慢'))).toBe(true);
    const end = await playToEnd(app, id, { onTurn: addressCouncil(app, id) });
    expect(end.state).toBe('finished');
  });
});

describe('director view gating', () => {
  it('is locked during play, unlockable explicitly (recorded), and open after the chapter ends', async () => {
    const { app } = await makeApp();
    const id = await createSession(app, 'C1');
    for (const ep of ['state', 'events', 'proposals', 'dialogue', 'narration', 'audit', 'timeline', 'usage', 'pauses']) {
      const r = await get(app, `/api/sessions/${id}/${ep}?view=director`);
      expect(r.status, ep).toBe(403);
      expect(r.json.error).toBe('director_locked');
    }
    const unlock = await post(app, `/api/sessions/${id}/director`, { requestId: rid('dir') });
    expect(unlock.status).toBe(200);
    expect(unlock.json.session.directorUnlockedRound).toBe(1);
    expect((await get(app, `/api/sessions/${id}/state?view=director`)).status).toBe(200);

    const other = await createSession(app, 'C1');
    await playToEnd(app, other, { onTurn: addressCouncil(app, other) });
    const r = await get(app, `/api/sessions/${other}/state?view=director`);
    expect(r.status).toBe(200);
    expect(r.json.full).toBeTruthy();
    expect(r.json.session.directorUnlockedRound).toBeNull();
  });
});

describe('branching and comparison', () => {
  it('branches from a round start, plays a different line and reports the first divergence', async () => {
    const { app } = await makeApp();
    const id = await createSession(app, 'C1');
    await playToEnd(app, id, { onTurn: addressCouncil(app, id) });
    const save = await post(app, `/api/sessions/${id}/save`, { requestId: rid('save'), name: 'after the pact' });
    expect(save.status).toBe(200);
    const branch = await post(app, `/api/sessions/${id}/branch`, { requestId: rid('br'), round: 1, wait: 10_000 });
    expect(branch.status).toBe(200);
    const child = branch.json.sessionId as string;
    expect(branch.json.control.state).toBe('awaiting_player');
    expect(branch.json.session.parentSessionId).toBe(id);
    // A different line: hold the request in round 1.
    const s = (await state(app, child)).json as StateView;
    const hold = await input(app, child, {
      requestId: rid('hold'),
      kind: 'action',
      action: { type: 'set_dispatch_timing', args: { docId: s.document!.docId, mode: 'hold', rounds: null } },
    });
    expect(hold.json.outcomes[0].status).toBe('committed');
    await advance(app, child);
    const same = await get(app, `/api/compare?a=${id}&b=${id}`);
    expect(same.json.divergence).toBeNull();
    const cmp = await get(app, `/api/compare?a=${id}&b=${child}`);
    expect(cmp.status).toBe(200);
    expect(cmp.json.divergence).not.toBeNull();
    expect(cmp.json.divergence.round).toBe(1);
    expect(cmp.json.a.rounds[0].round).toBe(1);
    const tl = await get(app, `/api/sessions/${id}/timeline`);
    expect(tl.json.lineage.children.map((c: { sessionId: string }) => c.sessionId)).toContain(child);
    expect(tl.json.checkpoints.map((c: { name: string }) => c.name)).toContain('after the pact');
    const loaded = await post(app, `/api/sessions/${id}/branch`, { requestId: rid('load'), checkpoint: 'after the pact', wait: 10_000 });
    expect(loaded.status).toBe(200);
    const bad = await post(app, `/api/sessions/${child}/branch`, { requestId: rid('br'), round: 1 });
    expect([200, 409]).toContain(bad.status);
    const diff = await get(app, `/api/sessions/${child}/diff`);
    expect(diff.status).toBe(200);
    expect(Array.isArray(diff.json.entries)).toBe(true);
  });
});

describe('static web app', () => {
  it('serves the built app with an SPA fallback and JSON 404s under /api', async () => {
    const dir = path.join((await makeApp()).dir, 'web dist');
    mkdirSync(path.join(dir, 'assets'), { recursive: true });
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Jinyang</title><script type="module" src="/assets/app.js"></script>');
    writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log("ok")');
    const { app } = await makeApp({ staticDir: dir });
    const index = await get(app, '/');
    expect(index.status).toBe(200);
    expect(index.text).toContain('<title>Jinyang</title>');
    const js = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(js.statusCode).toBe(200);
    expect(String(js.headers['content-type'])).toContain('javascript');
    const deep = await get(app, '/sessions/whatever');
    expect(deep.text).toContain('<title>Jinyang</title>');
    const api404 = await get(app, '/api/nope');
    expect(api404.status).toBe(404);
    expect(api404.json.error).toBe('not_found');
  });
});
