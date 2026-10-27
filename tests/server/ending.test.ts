/**
 * Ending CG data (play UI): at the end of real chapters, the CG's lines and summary are built from the final state
 * view — the terminal, the negotiation track and the siege at headquarters — and agree with it. Offline personas;
 * the clerk addresses the council each turn and the case policy decides the pauses.
 */
import { describe, expect, it } from 'vitest';
import type { StateView } from '../../src/server/api-types.js';
import { endingFacts, endingLines, endingSummary } from '../../web/src/ending.js';
import { addressCouncil, createSession, makeApp, playToEnd, state } from './helpers.js';

async function ending(caseId: string): Promise<{ s: StateView; lines: string; rows: Record<string, string> }> {
  const { app } = await makeApp();
  const id = await createSession(app, caseId);
  expect((await playToEnd(app, id, { onTurn: addressCouncil(app, id) })).state).toBe('finished');
  const s = (await state(app, id)).json;
  const facts = endingFacts(s);
  if (!facts) throw new Error('no terminal');
  return { s, lines: endingLines(facts), rows: Object.fromEntries(endingSummary(facts).map((r) => [r.label, r.value])) };
}

describe('ending CG from real chapters', () => {
  it('C1: the pact’s summary is the confirmed letter as the clerk knows it', async () => {
    const { s, lines, rows } = await ending('C1');
    expect(s.world.terminal?.kind).toBe('pact_concluded');
    const confirmed = s.negotiationTrack.cards.find((c) => c.stage === 'confirmed');
    expect(confirmed?.terms).not.toBeNull();
    expect(rows['Immediate silk']).toBe(`${confirmed?.terms?.immediate_silk.toLocaleString('en-US')} bolts`);
    expect(rows['Relief promised']).toBe(`${confirmed?.terms?.aid_cavalry.toLocaleString('en-US')} cavalry, within ${confirmed?.terms?.aid_arrival_days} days of confirmation`);
    expect(rows.Concluded).toBe(`Day ${s.world.terminal?.day}, on version ${confirmed?.termsVersion}`);
    expect(lines).toMatch(/^The pact is sealed/u);
  });

  it('C3: the talks end on the rejected third letter', async () => {
    const { s, lines, rows } = await ending('C3');
    expect(s.world.terminal?.kind).toBe('talks_failed');
    expect(rows).toEqual({ 'Letters exchanged': '3', 'Last offer': 'Version 3, rejected by Yelü Deguang', 'Talks ended': `Day ${s.world.terminal?.day}` });
    expect(lines).toMatch(/^Yelü Deguang has turned down the last offer/u);
  });

  it('C5: Jinyang falls when the grain runs out, with the last count from headquarters', async () => {
    const { s, lines, rows } = await ending('C5');
    expect(s.world.terminal).toMatchObject({ kind: 'jinyang_falls', detail: { cause: 'grain' } });
    const n = s.siegeWatch.now;
    expect(rows).toEqual({
      Cause: 'The grain ran out',
      'Fell on': `Day ${s.world.terminal?.day}`,
      'Last count': `grain for ${n.grain} days · pressure ${n.pressure} / 100 · morale ${n.morale} / 100`,
    });
    expect(lines).toContain('grain is gone');
  });
});
