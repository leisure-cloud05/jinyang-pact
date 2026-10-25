/**
 * Regression tests for the Codex re-review of WP-E (review 41 in docs/review_log.md):
 * #8 save recovery never re-saves the current state · #7 no global counters (event ids, parent versions, offstage
 * narration totals) while locked · (B) no raw id of any kind in any player payload or SSE message · #9 comparison
 * on player texts normalized with each session's aliases (a hidden extra offer is not a divergence).
 */
import { describe, expect, it } from 'vitest';
import { personaTurn } from '../../src/agents/mock-personas/index.js';
import type { CharacterMeta } from '../../src/agents/character.js';
import { createdSessionId } from '../../src/server/manager.js';
import { addressCouncil, advance, createSession, get, makeApp, post, rid, state, turnOf } from './helpers.js';

/** Any `prefix:N` world/event id, and the control-id formats (`<session>/pauseN`, `/bN`, `/bN/pM`, `/dN`, `/insN`). */
const RAW_ID = /\b[a-z_]+:\d+\b|\/(?:pause|b|d|ins|n)\d+\b/;

function rawIdIn(text: string): string | null {
  return RAW_ID.exec(text)?.[0] ?? null;
}

describe('#8 save is idempotent across state changes', () => {
  it('a save that failed after its effect is recovered as round 1 even after the story moved to round 2', async () => {
    let armed = true;
    const { app, manager } = await makeApp({
      faults: {
        beforeReceipt: (route) => {
          if (route === 'save' && armed) {
            armed = false;
            throw new Error('injected crash between the checkpoint and its receipt');
          }
        },
      },
    });
    const id = await createSession(app, 'C1');
    const body = { requestId: rid('save'), name: 'opening' };
    expect((await post(app, `/api/sessions/${id}/save`, body)).status).toBe(500);
    const records = manager.recordsOf(manager.main);
    const saved = records.findCheckpoint('opening', id);
    expect(saved?.round).toBe(1);
    await advance(app, id);
    expect((await state(app, id)).json.control.round).toBe(2);
    const retry = await post(app, `/api/sessions/${id}/save`, body);
    expect(retry.status).toBe(200);
    expect(retry.json.recovered).toBe(true);
    expect(retry.json.checkpoint.round).toBe(1);
    const after = records.findCheckpoint('opening', id);
    expect(after?.round).toBe(1);
    expect(after?.version).toBe(saved?.version);
    // A new request (another requestId) does save the current round start.
    const fresh = await post(app, `/api/sessions/${id}/save`, { requestId: rid('save2'), name: 'later' });
    expect(fresh.json.checkpoint.round).toBe(2);
  });
});

describe('#7 locked player views carry no global counters', () => {
  it('no approval event ids, no parent world version, narration totals of the player scene only', async () => {
    const { app } = await makeApp();
    const id = await createSession(app, 'C1');
    await addressCouncil(app, id)((await state(app, id)).json);
    await advance(app, id);
    const s = (await state(app, id)).json;
    await post(app, `/api/sessions/${id}/decision`, { requestId: rid('dec'), pauseId: s.control.pauseId, option: 'endorse', wait: 10_000 });
    await advance(app, id); // round 2: Yelü's answer is narrated at the Khitan court (offstage)
    const child = (await post(app, `/api/sessions/${id}/branch`, { requestId: rid('br'), round: 2, wait: 10_000 })).json.sessionId as string;
    for (const sid of [id, child]) {
      for (const ep of ['state', 'events', 'diff?fromRound=1', 'audit', 'proposals', 'narration']) {
        const r = await get(app, `/api/sessions/${sid}/${ep}`);
        expect(r.text, `${ep}: numeric eventId`).not.toMatch(/"eventId":\d/);
        expect(r.text, `${ep}: parent version`).not.toMatch(/"(parent|base|world|from|to|committed)Version":\d/);
      }
    }
    const audit = await get(app, `/api/sessions/${child}/audit`);
    expect(audit.json.lineage.parentVersion).toBeNull();
    // Narration totals: the parent narrated scenes at headquarters and at the Khitan court; the player counts its own.
    await post(app, `/api/sessions/${id}/director`, { requestId: rid('dir') });
    const all = (await get(app, `/api/sessions/${id}/audit?view=director`)).json.counts.narrations as Record<string, number>;
    const mine = (await get(app, `/api/sessions/${id}/audit`)).json.counts.narrations as Record<string, number>;
    const sum = (o: Record<string, number>): number => Object.values(o).reduce((a, b) => a + b, 0);
    expect(sum(all)).toBeGreaterThan(sum(mine));
  });
});

describe('(B) no raw id of any kind reaches the player', () => {
  it('C4 played through: every player payload, POST response and SSE message is free of raw ids', async () => {
    const { app } = await makeApp();
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const seen: Array<{ where: string; text: string }> = [];
    const record = (where: string, text: string): void => {
      seen.push({ where, text });
    };
    const created = await post(app, '/api/sessions', { requestId: rid('c'), caseId: 'C4', wait: 10_000 });
    record('create', created.text);
    const id = created.json.sessionId as string;
    const scan = async (): Promise<void> => {
      for (const ep of ['state', 'pauses', 'events', 'proposals', 'dialogue', 'narration', 'narration?lang=en', 'usage', 'audit', 'timeline', 'diff?fromRound=1']) {
        const r = await get(app, `/api/sessions/${id}/${ep}`);
        record(ep, r.text);
      }
      record('sessions', (await get(app, '/api/sessions')).text);
      record('session', (await get(app, `/api/sessions/${id}`)).text);
    };
    for (let i = 0; i < 40; i++) {
      await scan();
      const s = (await state(app, id)).json;
      const c = s.control;
      if (c.state === 'finished' || c.state === 'stopped' || c.state === 'error') break;
      if (c.state === 'awaiting_player') {
        const doc = s.document!;
        record('input', (await post(app, `/api/sessions/${id}/input`, { requestId: rid('t'), turn: c.turn, kind: 'dialogue', to: ['shi_jingtang', 'sang_weihan'], text: '请明公用印遣使。' })).text);
        if (c.round === 1) {
          const sug = { vassal: null, filial: null, cession: null, annual_silk: null, immediate_silk: 40_000, aid_cavalry: null, aid_arrival_days: null, neutrality: null, marriage_alliance: null, secret_clauses: null };
          record('suggest', (await post(app, `/api/sessions/${id}/input`, { requestId: rid('sg'), turn: c.turn, kind: 'action', action: { type: 'suggest_revision', args: { target: { kind: 'document', id: doc.docId }, terms: sug, reason: 'a lighter gift' } } })).text);
          record('save', (await post(app, `/api/sessions/${id}/save`, { requestId: rid('sv'), name: 'r1' })).text);
          record('replay', (await post(app, `/api/sessions/${id}/replay`, { requestId: rid('rp'), mode: 'rederive' })).text);
        }
        record('advance', (await post(app, `/api/sessions/${id}/advance`, { requestId: rid('a'), turn: c.turn, wait: 10_000 })).text);
      } else if (c.state === 'awaiting_decision') {
        const option = s.pendingPause?.suggestion?.option ?? 'endorse';
        record('decision', (await post(app, `/api/sessions/${id}/decision`, { requestId: rid('d'), pauseId: c.pauseId, option, wait: 10_000 })).text);
      }
    }
    // The SSE stream from the beginning.
    const res = await fetch(`${base}/api/sessions/${id}/stream?since=0`);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let sse = '';
    const deadline = Date.now() + 800;
    while (Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), Math.max(1, deadline - Date.now())))]);
      if (chunk === null || chunk.done) break;
      sse += new TextDecoder().decode(chunk.value);
    }
    await reader.cancel().catch(() => undefined);
    record('sse', sse.replace(/^id: \d+$/gm, ''));
    expect(sse).toContain('event: pause');
    expect(seen.length).toBeGreaterThan(50);
    for (const { where, text } of seen) expect(rawIdIn(text), `${where} leaks a raw id`).toBeNull();
    // The aliases are what the player sees.
    const final = (await get(app, `/api/sessions/${id}/state`)).json;
    expect(final.document.docId).toBe('document A');
    expect(JSON.stringify(final)).toContain('offer A');
  });
});

describe('#9 comparison is computed on the texts the player reads', () => {
  it('a hidden extra offer elsewhere shifts the raw ids but is not a divergence', async () => {
    const reqA = rid('plain');
    const reqB = rid('hidden');
    const hiddenSession = createdSessionId('C1', 'full', reqB);
    const { app, manager } = await makeApp({
      mockSetup: (mock) =>
        mock.register({ role: 'character', actor: 'li_congke' }, (req) => {
          const meta = req.meta as unknown as CharacterMeta;
          const out = personaTurn(meta);
          if (meta.identity.sessionId !== hiddenSession || meta.identity.round !== 1) return out;
          // Luoyang quietly bids for Khitan neutrality in round 1 (offstage): an extra offer is allocated first.
          const bid = {
            type: 'propose_terms',
            args: {
              to: 'yelu_deguang',
              terms: { vassal: false, filial: false, cession: 'none', annual_silk: 100_000, immediate_silk: 0, aid_cavalry: 0, aid_arrival_days: 0, neutrality: true, marriage_alliance: false, secret_clauses: [] },
              note: null,
            },
            rationale: 'Cut Hedong off.',
            cites: [],
          };
          return { ...out, actions: [...out.actions.slice(0, 2), bid] };
        }),
    });
    const a = (await post(app, '/api/sessions', { requestId: reqA, caseId: 'C1', wait: 10_000 })).json.sessionId as string;
    const b = (await post(app, '/api/sessions', { requestId: reqB, caseId: 'C1', wait: 10_000 })).json.sessionId as string;
    expect(b).toBe(hiddenSession);
    for (const id of [a, b]) {
      await advance(app, id); // round 1: the council is not addressed; Luoyang moves in session b only
      await post(app, `/api/sessions/${id}/input`, { requestId: rid('t'), turn: await turnOf(app, id), kind: 'dialogue', to: ['shi_jingtang', 'sang_weihan'], text: '请明公用印遣使。' });
      await advance(app, id);
      const s = (await state(app, id)).json;
      expect(s.control.state).toBe('awaiting_decision');
      await post(app, `/api/sessions/${id}/decision`, { requestId: rid('d'), pauseId: s.control.pauseId, option: 'endorse', wait: 10_000 });
    }
    const offersA = Object.values(manager.ctx(a).state.offers);
    const offersB = Object.values(manager.ctx(b).state.offers);
    expect(offersA.find((o) => o.from === 'shi_jingtang')?.id).toBe('offer:1');
    expect(offersB.find((o) => o.from === 'shi_jingtang')?.id).toBe('offer:2');
    expect(offersB.some((o) => o.from === 'li_congke')).toBe(true);
    const cmp = await get(app, `/api/compare?a=${a}&b=${b}`);
    expect(cmp.status).toBe(200);
    expect(cmp.json.divergence).toBeNull();
    expect(cmp.json.sharedPrefix).toBe(cmp.json.a.items.length);
    expect(cmp.json.a.items.map((i: { text: string }) => i.text)).toEqual(cmp.json.b.items.map((i: { text: string }) => i.text));
    expect(cmp.json.a.items.some((i: { text: string }) => i.text.includes('offer A'))).toBe(true);
  });
});
