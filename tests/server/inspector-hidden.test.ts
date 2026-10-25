/**
 * The inspector tells the player only *whether* an event had effects outside the clerk's vantage, never how many
 * (a count measures offstage activity); the director view keeps the counts.
 */
import { describe, expect, it } from 'vitest';
import { addressCouncil, createSession, get, makeApp, playToEnd } from './helpers.js';

describe('inspector hidden-change marker', () => {
  it('is 0/1 in the player view and a count in the director view', async () => {
    const { app } = await makeApp(); // the director view unlocks once the chapter has ended
    const id = await createSession(app, 'C1');
    await playToEnd(app, id, { onTurn: addressCouncil(app, id) });
    const player = (await get(app, `/api/sessions/${id}/events`)).json.events as { hiddenChanges: number }[];
    const director = (await get(app, `/api/sessions/${id}/events?view=director`)).json.events as { hiddenChanges: number }[];
    expect(player.length).toBeGreaterThan(0);
    for (const e of player) expect([0, 1]).toContain(e.hiddenChanges);
    expect(player.some((e) => e.hiddenChanges === 1)).toBe(true);
    expect(director.length).toBeGreaterThanOrEqual(player.length);
  });
});
