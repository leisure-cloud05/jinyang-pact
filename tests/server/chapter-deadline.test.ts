import { describe, expect, it } from 'vitest';
import { renderFactLine } from '../../src/agents/narration/index.js';
import { personaTurn } from '../../src/agents/mock-personas/index.js';
import type { CharacterMeta } from '../../src/agents/character.js';
import { createSession, get, makeApp, playToEnd, state } from './helpers.js';

describe('chapter deadline in play', () => {
  it('finishes an idle chapter with a visible ending and replays the same world', async () => {
    const { app, manager } = await makeApp({ mockSetup: (mock) => mock.register('character', (req) => ({
      ...personaTurn(req.meta as unknown as CharacterMeta), actions: [],
    })) });
    const id = await createSession(app, 'FREE');
    let sawLastWarning = false;
    const end = await playToEnd(app, id, { each: (s) => {
      if (s.world.round === 6 && !s.world.terminal) {
        const warning = s.siegeWatch.alerts.find((a) => a.code === 'last_round');
        expect(warning?.level).toBe('critical');
        expect(warning?.text.zh).toContain('全面战争');
        sawLastWarning = true;
      }
    } });
    expect(sawLastWarning).toBe(true);
    expect(end.state).toBe('finished');
    expect(end.outcome).toBe('valid_terminal:jinyang_falls');
    const final = (await state(app, id)).json;
    expect(final.world.terminal).toMatchObject({ kind: 'jinyang_falls', day: 30, round: 6, detail: { cause: 'missed_opportunity' } });
    expect(final.siegeWatch.next).toBeNull();
    const story = await get(app, `/api/sessions/${id}/narration?lang=zh`);
    expect(JSON.stringify(story.json)).toContain('错过时机');
    const ctx = manager.ctx(id);
    expect(ctx.harness.replay(id, 'rederive').ok).toBe(true);
    const terminal = ctx.harness.repo.listEvents(id).flatMap((e) => e.facts).find((f) => f.kind === 'terminal');
    expect(terminal).toBeDefined();
    expect(renderFactLine(terminal!, ctx.names, 'en')).toContain('Later Tang besiegers');
  });
});
