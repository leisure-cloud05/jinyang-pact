/**
 * The clerk's dispatch seal (遣, play UI): the draft view records which version went out, on which day and who sent
 * it, so the draft panel keeps the clerk's seal only for a request the player sent. A stale version is refused (H04)
 * and nothing goes out, which is when the confirmation asks the player to review the terms again.
 */
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { StateView } from '../../src/server/api-types.js';
import { addressCouncil, advance, createSession, input, makeApp, playToEnd, policyChooser, post, rid, state } from './helpers.js';

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

const dispatch = (docId: string, docVersion: number) => ({ requestId: rid('send'), kind: 'action', action: { type: 'dispatch_document', args: { docId, docVersion } } });

describe('who sent the request', () => {
  it('records the clerk as the sender of the version they transmit, after refusing a stale version (C6)', async () => {
    const { app } = await makeApp();
    const id = await createSession(app, 'C6');
    await addressCouncil(app, id)((await state(app, id)).json);
    expect((await advance(app, id)).status).toBe(200);
    const doc = (await untilPlayerTurn(app, id)).document!;
    expect(doc.transmit.ok).toBe(true);
    expect(doc.sent).toBeNull();

    const stale = await input(app, id, dispatch(doc.docId, doc.version + 1));
    expect(stale.json.outcomes[0]).toMatchObject({ status: expect.not.stringMatching(/^committed$/u), rule: 'H04' });
    expect((await state(app, id)).json.document?.sent).toBeNull();

    const sent = await input(app, id, dispatch(doc.docId, doc.version));
    expect(sent.json.outcomes[0].status).toBe('committed');
    const after = (await state(app, id)).json;
    expect(after.document?.status).toBe('sent');
    expect(after.document?.sent).toEqual({ version: doc.version, day: after.world.day, by: 'player' });
  });

  it('names the character who sent it when the clerk did not (C1)', async () => {
    const { app } = await makeApp();
    const id = await createSession(app, 'C1');
    await playToEnd(app, id, { onTurn: addressCouncil(app, id) });
    const s = (await state(app, id)).json;
    const first = s.negotiationTrack.cards.find((c) => c.direction === 'out');
    expect(s.document?.sent).toEqual({ version: first?.termsVersion, day: first?.sinceDay, by: 'shi_jingtang' });
  });
});
