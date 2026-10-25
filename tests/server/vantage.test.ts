/**
 * Player vantage (C4) and the SSE stream. C4's draft carries a secret article known only to Shi and Sang (canary
 * 玄鸾十七号密押) and Luoyang's envoy is on the road to the Khitan with a rival bid: no player-view response may carry
 * the article (canary or text) or Luoyang's letter, at any point of the chapter, and the leak guard must never have
 * to seal anything (the views are correct by construction). The director view, once open, does show them.
 */
import { describe, expect, it } from 'vitest';
import type { StateView } from '../../src/server/api-types.js';
import { addressCouncil, createSession, get, input, makeApp, playToEnd, rid } from './helpers.js';

const CANARY = '玄鸾十七号密押';
const FORBIDDEN = [CANARY, '唐室府库所藏金帛', 'shared equally between Hedong and the Khitan', '大唐天子致书契丹主', '以公主和亲'];
const ENDPOINTS = ['state', 'pauses', 'events', 'proposals', 'dialogue', 'narration', 'narration?lang=en', 'usage', 'audit', 'timeline', 'diff'];

describe('player vantage in C4 (conflicting secret commitments)', () => {
  it('no player view ever carries the secret article or the other factions’ correspondence', async () => {
    const { app } = await makeApp();
    const id = await createSession(app, 'C4');
    let checks = 0;
    const checkAll = async (): Promise<void> => {
      for (const ep of ENDPOINTS) {
        const r = await get(app, `/api/sessions/${id}/${ep}`);
        expect(r.status, ep).toBe(200);
        expect(r.headers['x-jinyang-view'], ep).toBe('player');
        expect(r.headers['x-jinyang-leak-guard'], `${ep}: the leak guard had to seal text`).toBe('0');
        for (const f of FORBIDDEN) expect(r.text.includes(f), `${ep} contains ${f}`).toBe(false);
        checks += 1;
      }
    };
    const end = await playToEnd(app, id, {
      onTurn: addressCouncil(app, id, '表已誊毕，另有一纸封缄，仆未敢启视。请明公用印遣使。'),
      each: async (s: StateView) => {
        await checkAll();
        // The Tang–Khitan thread never appears in what the clerk knows.
        for (const o of s.world.negotiation.offers) expect([o.from, o.to]).not.toContain('li_congke');
        expect(JSON.stringify(s.world.beliefs)).not.toContain('li_congke');
        // The draft shows no hidden article, yet its hidden article is preserved in the world.
        expect(s.document?.terms.secret_clauses ?? []).toHaveLength(0);
      },
    });
    expect(end.state).toBe('finished');
    expect(end.outcome).toMatch(/^valid_terminal:/);
    const sent = await get(app, `/api/sessions/${id}/events`);
    expect(sent.json.events.some((e: { kind: string }) => e.kind === 'dispatch_document')).toBe(true);
    await checkAll();
    expect(checks).toBeGreaterThan(ENDPOINTS.length * 3);
    // After the chapter the director view opens and does contain what the player never saw.
    const director = await get(app, `/api/sessions/${id}/state?view=director`);
    expect(director.status).toBe(200);
    expect(director.text).toContain(CANARY);
    const dirEvents = await get(app, `/api/sessions/${id}/events?view=director`);
    expect(dirEvents.text).toContain('li_congke');
  });

  it('a player revision of the draft keeps the hidden article (hidden, not deleted)', async () => {
    const { app, manager } = await makeApp();
    const id = await createSession(app, 'C4');
    const s = (await get<StateView>(app, `/api/sessions/${id}/state`)).json;
    const doc = s.document!;
    const r = await input(app, id, {
      requestId: rid('rev'),
      kind: 'action',
      action: { type: 'revise_document', args: { docId: doc.docId, baseDocVersion: doc.version, terms: { ...doc.terms, secret_clauses: [] }, note: doc.note } },
    });
    expect(r.json.outcomes[0].status).toBe('committed');
    expect(r.text.includes(CANARY)).toBe(false);
    const world = manager.ctx(id).state;
    expect(world.documents['doc:1']?.terms.secret_clauses.map((c) => c.id)).toEqual(['sc_treasury_share']);
  });
});

async function readEvents(res: Response, until: (type: string, data: any) => boolean, timeoutMs = 10_000): Promise<Array<{ type: string; data: any }>> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const out: Array<{ type: string; data: any }> = [];
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), Math.max(1, deadline - Date.now())))]);
    if (chunk === null || chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const type = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!type || data === undefined) continue;
      const parsed = JSON.parse(data) as unknown;
      out.push({ type, data: parsed });
      if (until(type, parsed)) {
        await reader.cancel();
        return out;
      }
    }
  }
  await reader.cancel().catch(() => undefined);
  return out;
}

describe('SSE stream', () => {
  it('emits control changes, the pause and the player-scene narration (and nothing from remote scenes)', async () => {
    const { app } = await makeApp();
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const json = async (url: string, body?: unknown): Promise<any> => {
      const r = await fetch(`${base}${url}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return r.json();
    };
    const created = await json('/api/sessions', { requestId: rid('c'), caseId: 'C1', wait: 10_000 });
    const id = created.sessionId as string;
    const stream = await fetch(`${base}/api/sessions/${id}/stream?since=0`);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const turn = created.control.turn as string;
    await json(`/api/sessions/${id}/input`, { requestId: rid('t'), turn, kind: 'dialogue', to: ['shi_jingtang', 'sang_weihan'], text: '请明公用印遣使。' });
    await json(`/api/sessions/${id}/advance`, { requestId: rid('a'), turn, wait: 10_000 });
    const first = await readEvents(stream, (t) => t === 'pause');
    const types = first.map((e) => e.type);
    expect(types).toContain('control');
    expect(types).toContain('phase');
    expect(types).toContain('pause');
    const pause = first.find((e) => e.type === 'pause')!.data;
    expect(pause.category).toBe('dispatch_request');

    const s = await json(`/api/sessions/${id}/state`);
    const stream2 = await fetch(`${base}/api/sessions/${id}/stream`, { headers: { 'Last-Event-ID': String(first.length > 0 ? 0 : 0) } });
    await json(`/api/sessions/${id}/decision`, { requestId: rid('d'), pauseId: s.control.pauseId, option: 'endorse', wait: 10_000 });
    const second = await readEvents(stream2, (t, d) => t === 'narration' && d.scene === 'jinyang_hq');
    const narration = second.find((e) => e.type === 'narration');
    expect(narration?.data.scene).toBe('jinyang_hq');
    expect(typeof narration?.data.text).toBe('string');
    expect(second.every((e) => e.type !== 'narration' || e.data.scene === 'jinyang_hq')).toBe(true);
    expect(second.some((e) => e.type === 'decision' && e.data.option === 'endorse')).toBe(true);
  });
});
