/**
 * Asking at a pause through the API: the pause lists whom the player may ask (characters present or paused,
 * never offstage ones), `to` picks the answerer, and the pause view carries the question/answer thread so the
 * decision modal can show it. The pause stays open.
 */
import { describe, expect, it } from 'vitest';
import type { StateView } from '../../src/server/api-types.js';
import { addressCouncil, advance, createSession, makeApp, post, rid, state } from './helpers.js';

async function untilPause(app: Parameters<typeof state>[0], id: string): Promise<StateView> {
  for (let i = 0; i < 6; i++) {
    const s = (await state(app, id)).json;
    if (s.pendingPause) return s;
    if (s.control.turn) {
      await addressCouncil(app, id)(s);
      await advance(app, id);
    }
  }
  throw new Error('no pause reached');
}

describe('ask at a pause', () => {
  it('lists askable characters, routes the question to the chosen one and returns the thread', async () => {
    const app = await makeApp();
    const id = await createSession(app.app, 'C1');
    const s = await untilPause(app.app, id);
    const pause = s.pendingPause!;
    expect(pause.options).toContain('ask');
    const ids = pause.askable.map((c) => c.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).not.toContain('yelu_deguang');
    expect(ids).not.toContain('li_congke');
    expect(pause.thread).toEqual([]);

    const target = ids.includes('sang_weihan') ? 'sang_weihan' : ids[0]!;
    const r = await post(app.app, `/api/sessions/${id}/decision`, {
      requestId: rid('ask'),
      pauseId: pause.id,
      option: 'ask',
      advice: '此表可否再斟酌？',
      to: target,
      wait: 10_000,
    });
    expect(r.status).toBe(200);

    const after = (await state(app.app, id)).json;
    expect(after.pendingPause?.id).toBe(pause.id);
    const thread = after.pendingPause!.thread;
    expect(thread).toHaveLength(1);
    expect(thread[0]!.question).toBe('此表可否再斟酌？');
    expect(thread[0]!.answer).not.toBeNull();
    const name = pause.askable.find((c) => c.id === target)!.name;
    expect(thread[0]!.answeredBy).toEqual(name);
  });

  it('rejects an unknown addressee', async () => {
    const app = await makeApp();
    const id = await createSession(app.app, 'C1');
    const s = await untilPause(app.app, id);
    const r = await post(app.app, `/api/sessions/${id}/decision`, {
      requestId: rid('ask'),
      pauseId: s.pendingPause!.id,
      option: 'ask',
      advice: '?',
      to: 'nobody',
      wait: 1000,
    });
    expect(r.status).toBe(400);
  });

  it('refuses an offstage or absent addressee before recording anything (no silent substitute)', async () => {
    const app = await makeApp();
    const id = await createSession(app.app, 'C1');
    const s = await untilPause(app.app, id);
    const pause = s.pendingPause!;
    expect(pause.askable.map((c) => c.id)).not.toContain('yelu_deguang');
    const r = await post(app.app, `/api/sessions/${id}/decision`, {
      requestId: rid('ask'),
      pauseId: pause.id,
      option: 'ask',
      advice: '可汗之意如何？',
      to: 'yelu_deguang',
      wait: 1000,
    });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe('not_askable');
    const after = (await state(app.app, id)).json;
    expect(after.pendingPause?.id).toBe(pause.id);
    expect(after.pendingPause!.asked).toBe(0);
    expect(after.pendingPause!.thread).toEqual([]);
  });
});
