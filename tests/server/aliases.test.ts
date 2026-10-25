/**
 * Player-scoped ids: global counters (offer:N, cmt:N, msg:N, k:N, event:N, <session>/pauseN, /bN, /bN/pM, /dN)
 * never reach a player view. In C4 Luoyang's bid is offer:1 (hidden, already on the road), Hedong's request
 * becomes offer:2 — yet the player's first visible offer is "offer A". Inputs use the aliases.
 */
import { describe, expect, it } from 'vitest';
import type { StateView } from '../../src/server/api-types.js';
import { addressCouncil, advance, createSession, get, input, makeApp, post, rid, state } from './helpers.js';

const RAW_IDS = /(?<![A-Za-z0-9_])(offer|cmt|msg|k|event):\d+|\/(pause|b|d|ins)\d+/;
const ENDPOINTS = ['state', 'pauses', 'events', 'proposals', 'dialogue', 'narration', 'usage', 'audit', 'timeline', 'diff'];

describe('player-scoped aliases', () => {
  it('C4: the hidden Tang offer exists, yet the first offer the player sees is "offer A"', async () => {
    const { app, manager } = await makeApp();
    const id = await createSession(app, 'C4');
    const hidden = Object.values(manager.ctx(id).state.offers).find((o) => o.from === 'li_congke');
    expect(hidden?.id).toBe('offer:1');
    await addressCouncil(app, id, '表已誊毕，另有一纸封缄。请明公用印遣使。')((await state(app, id)).json);
    await advance(app, id);
    const paused = (await state(app, id)).json;
    expect(paused.control.pauseId).toMatch(/^pause \d+$/);
    // Decisions take the alias.
    const d = await post(app, `/api/sessions/${id}/decision`, { requestId: rid('dec'), pauseId: paused.control.pauseId, option: 'endorse', wait: 10_000 });
    expect(d.status).toBe(200);
    const s = (await state(app, id)).json as StateView;
    const sent = Object.values(manager.ctx(id).state.offers).find((o) => o.from === 'shi_jingtang');
    expect(sent?.id).toBe('offer:2');
    expect(s.world.negotiation.offers.map((o) => o.offerId)).toEqual(['offer A']);
    expect(s.world.negotiation.offers[0]?.commitmentId).toBe('thread A');
    for (const ep of ENDPOINTS) {
      const r = await get(app, `/api/sessions/${id}/${ep}`);
      expect(r.status, ep).toBe(200);
      expect(RAW_IDS.exec(r.text)?.[0] ?? null, `${ep} leaks a raw id`).toBeNull();
    }
    expect((await get(app, `/api/sessions/${id}/narration`)).text).toContain('offer A');
    // Inputs naming an offer use its alias; the raw id (or an unseen one) is refused.
    const alias = await input(app, id, {
      requestId: rid('sug'),
      kind: 'action',
      action: { type: 'suggest_revision', args: { target: { kind: 'offer', id: 'offer A' }, terms: { vassal: null, filial: null, cession: null, annual_silk: null, immediate_silk: null, aid_cavalry: null, aid_arrival_days: null, neutrality: null, marriage_alliance: null, secret_clauses: null }, reason: 'note' } },
    });
    expect(alias.status).toBe(200);
    for (const bad of ['offer:2', 'offer:1', 'offer B']) {
      const r = await input(app, id, {
        requestId: rid('bad'),
        kind: 'action',
        action: { type: 'suggest_revision', args: { target: { kind: 'offer', id: bad }, terms: { vassal: null, filial: null, cession: null, annual_silk: null, immediate_silk: null, aid_cavalry: null, aid_arrival_days: null, neutrality: null, marriage_alliance: null, secret_clauses: null }, reason: 'probe' } },
      });
      expect(r.status, bad).toBe(400);
      expect(r.json.error).toBe('unknown_reference');
    }
    // The director view keeps the real ids.
    await post(app, `/api/sessions/${id}/director`, { requestId: rid('dir') });
    const dir = await get(app, `/api/sessions/${id}/events?view=director`);
    expect(dir.text).toContain('offer:2');
  });

  it('aliases are stable as more becomes visible, and a branch shares its parent’s aliases', async () => {
    const { app } = await makeApp();
    const id = await createSession(app, 'C1');
    await addressCouncil(app, id)((await state(app, id)).json);
    await advance(app, id);
    const p1 = (await state(app, id)).json.control.pauseId;
    await post(app, `/api/sessions/${id}/decision`, { requestId: rid('dec'), pauseId: p1, option: 'endorse', wait: 10_000 });
    const before = (await state(app, id)).json.world.negotiation.offers.map((o) => o.offerId);
    await advance(app, id);
    const after = (await state(app, id)).json.world.negotiation.offers.map((o) => o.offerId);
    expect(after.slice(0, before.length)).toEqual(before);
    const pauses = await get(app, `/api/sessions/${id}/pauses`);
    expect(pauses.json.history[0].id).toBe(p1);
    const child = (await post(app, `/api/sessions/${id}/branch`, { requestId: rid('br'), round: 2, wait: 10_000 })).json.sessionId as string;
    const childOffers = (await state(app, child)).json.world.negotiation.offers.map((o) => o.offerId);
    expect(childOffers).toEqual(before);
  });
});
