/**
 * Negotiation track (谈判拉锯, play UI): the cards follow what the clerk believes, never the true status of a letter
 * on the road. An outgoing letter is placed by the courier's schedule (5 days between Jinyang and the Khitan court)
 * and a reply shows only once it has reached headquarters. C4's rival Tang thread never appears.
 */
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { StateView } from '../../src/server/api-types.js';
import { offerPosition, offerStage } from '../../src/server/views/negotiation-track.js';
import { reliefPlan } from '../../web/src/map-motion.js';
import { addressCouncil, advance, createSession, input, makeApp, playToEnd, policyChooser, post, rid, state } from './helpers.js';

describe('offer stage and place on the road (pure)', () => {
  it('follows the clerk’s belief, and the schedule while a letter is believed sent', () => {
    expect(offerStage('out', 'sent', 0, 5)).toBe('proposed');
    expect(offerStage('out', 'sent', 5, 5)).toBe('awaiting');
    expect(offerStage('out', null, 2, 5)).toBe('proposed');
    expect(offerStage('in', 'delivered', 10, null)).toBe('received');
    expect(offerStage('out', 'countered', 10, 5)).toBe('countered');
    expect(offerStage('in', 'accepted', 15, null)).toBe('confirmed');
    expect(offerStage('out', 'rejected', 20, 15)).toBe('rejected');
    expect(offerStage('out', 'withdrawn', 3, 5)).toBe('withdrawn');
  });

  it('moves a letter by the days it has travelled; a reply rests at Jinyang, an answered letter at the far court', () => {
    expect(offerPosition('out', 'proposed', 0, 0, 5)).toBe(0);
    expect(offerPosition('out', 'proposed', 2, 0, 5)).toBeCloseTo(0.4);
    expect(offerPosition('out', 'awaiting', 5, 0, 5)).toBe(1);
    expect(offerPosition('out', 'countered', 10, 0, 5)).toBe(1);
    expect(offerPosition('in', 'received', 10, 10, 5)).toBe(0);
  });
});

/** Decides pauses by the case policy until the player's turn (or the end). */
async function untilPlayerTurn(app: FastifyInstance, id: string): Promise<StateView> {
  for (let i = 0; i < 20; i++) {
    const s = (await state(app, id)).json;
    if (s.control.state !== 'awaiting_decision') return s;
    const r = await post(app, `/api/sessions/${id}/decision`, { requestId: rid('dec'), pauseId: s.control.pauseId, wait: 10_000, ...policyChooser(s) });
    expect(r.status).toBe(200);
  }
  throw new Error('no player turn');
}

describe('negotiation track in the state view', () => {
  it('provides a known projected relief schedule when a real C1 session concludes', async () => {
    const { app } = await makeApp();
    const id = await createSession(app, 'C1');
    await playToEnd(app, id, { onTurn: addressCouncil(app, id) });
    const final = (await state(app, id)).json;
    expect(final.world.terminal?.kind).toBe('pact_concluded');
    const plan = reliefPlan(final.negotiationTrack.cards.at(-1), final.world.terminal);
    expect(plan).not.toBeNull();
    expect(plan?.arrivalDay).toBe(final.world.terminal?.detail.khitanArrivalDay);
    expect(plan?.cavalry).toBeGreaterThan(0);
  });
  it('starts as an empty road between Jinyang and the Khitan court', async () => {
    const { app } = await makeApp();
    const id = await createSession(app, 'C1');
    expect((await state(app, id)).json.negotiationTrack).toEqual({
      near: { charId: 'shi_jingtang', name: expect.objectContaining({ en: 'Shi Jingtang' }), place: { zh: '晋阳帅府', en: 'Jinyang headquarters' } },
      far: { charId: 'yelu_deguang', name: expect.objectContaining({ en: 'Yelü Deguang' }), place: { zh: '契丹牙帐', en: 'the Khitan court' } },
      travelDays: 5,
      cards: [],
      roundCap: 2,
    });
  });

  it('a request the clerk transmits sets out from Jinyang and is due at the Khitan court five days later (C6)', async () => {
    const { app } = await makeApp();
    const id = await createSession(app, 'C6');
    await addressCouncil(app, id)((await state(app, id)).json);
    expect((await advance(app, id)).status).toBe(200);
    const before = await untilPlayerTurn(app, id);
    const doc = before.document!;
    expect(doc.transmit.ok).toBe(true);
    const sent = await input(app, id, { requestId: rid('send'), kind: 'action', action: { type: 'dispatch_document', args: { docId: doc.docId, docVersion: doc.version } } });
    expect(sent.json.outcomes[0].status).toBe('committed');
    const out = (await state(app, id)).json;
    expect(out.negotiationTrack.cards).toMatchObject([{ direction: 'out', termsVersion: 1, stage: 'proposed', sinceDay: out.world.day, dueDay: out.world.day + 5, position: 0 }]);
    expect((await advance(app, id)).status).toBe(200);
    const next = await untilPlayerTurn(app, id);
    expect(next.negotiationTrack.cards[0]).toMatchObject({ stage: next.control.state === 'finished' ? 'confirmed' : 'awaiting', position: 1 });
  });

  it('follows belief, not the truth: a delivered letter is still awaiting reply, and the counter-offer shows once it reaches Jinyang (C3)', async () => {
    const { app } = await makeApp();
    const id = await createSession(app, 'C3', { director: true });
    const seen = new Map<number, { cards: string[]; truth: Record<string, string> }>();
    const end = await playToEnd(app, id, {
      onTurn: addressCouncil(app, id),
      each: async (s) => {
        const full = (await state(app, id, 'director')).json.full as { offers: Record<string, { status: string }> };
        seen.set(s.world.day, {
          cards: s.negotiationTrack.cards.map((c) => `${c.direction} v${c.termsVersion} ${c.stage}`),
          truth: Object.fromEntries(Object.entries(full.offers).map(([k, o]) => [k, o.status])),
        });
        for (const c of s.negotiationTrack.cards) expect(c.stage).toBe(offerStage(c.direction, c.believedStatus, s.world.day, c.dueDay));
      },
    });
    expect(end.state).toBe('finished');
    expect(seen.get(5)).toEqual({ cards: ['out v1 awaiting'], truth: { 'offer:1': 'delivered' } });
    expect(seen.get(10)?.cards).toEqual(['out v1 countered', 'in v2 received']);
    expect(seen.get(15)?.cards).toEqual(['out v1 countered', 'in v2 countered', 'out v3 awaiting']);
    const last = (await state(app, id)).json.negotiationTrack.cards;
    expect(last.map((c) => `${c.direction} v${c.termsVersion} ${c.stage}`)).toEqual(['out v1 countered', 'in v2 countered', 'out v3 rejected']);
    expect(last[2]).toMatchObject({ sinceDay: 10, dueDay: 15, statusDay: 20 });
    // Shi's counter raised the yearly silk (the case policy's counter-terms), as the clerk knows the terms.
    expect([last[0]?.terms?.annual_silk, last[2]?.terms?.annual_silk]).toEqual([100_000, 200_000]);
  });

  it('never shows the Tang court’s thread or a hidden article (C4)', async () => {
    const { app } = await makeApp();
    const id = await createSession(app, 'C4');
    let cards = 0;
    await playToEnd(app, id, {
      onTurn: addressCouncil(app, id, '表已誊毕，另有一纸封缄，仆未敢启视。请明公用印遣使。'),
      each: (s) => {
        const text = JSON.stringify(s.negotiationTrack);
        expect(text).not.toContain('li_congke');
        expect(text).not.toContain('玄鸾十七号密押');
        for (const c of s.negotiationTrack.cards) expect(c.terms?.secret_clauses ?? []).toEqual([]);
        cards = Math.max(cards, s.negotiationTrack.cards.length);
      },
    });
    expect(cards).toBeGreaterThan(0);
  });
});
