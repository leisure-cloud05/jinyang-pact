import { describe, expect, it } from 'vitest';
import { letterScenes, mapScenes, reliefPlan, routePoint, type MapSnapshot } from '../../web/src/map-motion.js';
import type { OfferCardView, WorldView } from '../../src/server/api-types.js';

describe('courier route', () => {
  it('keeps travel bounded by the two endpoints', () => {
    expect(routePoint(-1)).toEqual({ x: 100, y: 265 });
    expect(routePoint(2)).toEqual({ x: 530, y: 65 });
  });
  it('passes through the intermediate road location and interpolates both directions', () => {
    expect(routePoint(0.5)).toEqual({ x: 310, y: 180 });
    expect(routePoint(0.125)).toEqual({ x: 150, y: 235 });
    expect(routePoint(0.875)).toEqual({ x: 485, y: 82.5 });
  });
});

const card: OfferCardView = {
  offerId: 'offer A', direction: 'out', from: 'shi_jingtang', to: 'yelu_deguang', termsVersion: 1,
  stage: 'proposed', believedStatus: 'sent', sinceDay: 0, statusDay: 0, dueDay: 5, position: 0,
  withdrawal: null, segment: 1, segmentRound: 0,
  terms: { vassal: true, filial: true, cession: 'yanmen_north', annual_silk: 0, immediate_silk: 50000, aid_cavalry: 30000, aid_arrival_days: 15, neutrality: false, marriage_alliance: false, secret_clauses: [] },
};
const empty: MapSnapshot = { cards: [], draft: { docId: 'doc A', version: 1 }, relief: null };

describe('map events', () => {
  it('seals then leaves headquarters without inventing travel days', () => {
    const scenes = mapScenes(empty, { ...empty, cards: [card] });
    expect(scenes.map((s) => s.kind)).toEqual(['seal', 'courier']);
    expect(scenes[1]).toMatchObject({ departure: true, from: 0, to: 0 });
  });
  it('does not replay unchanged polling snapshots', () => {
    const snapshot = { ...empty, cards: [card] };
    expect(mapScenes(snapshot, structuredClone(snapshot))).toEqual([]);
  });
  it('starts a continuing journey at the last known position', () => {
    const before = { ...card, position: 0.25 };
    expect(letterScenes({ ...card, position: 0.75 }, before)[0]).toMatchObject({ from: 0.25, to: 0.75 });
  });
  it('brings known acceptance and rejection replies back before showing their result', () => {
    for (const stage of ['confirmed', 'rejected'] as const) {
      const scenes = letterScenes({ ...card, stage, position: 1 }, { ...card, stage: 'awaiting', position: 1 });
      expect(scenes[0]).toMatchObject({ kind: 'courier', from: 1, to: 0 });
      expect(scenes[1]?.kind).toBe(stage === 'confirmed' ? 'confirmation' : 'closed');
    }
  });
  it('queues a draft revision before a newly sent request', () => {
    const scenes = mapScenes(empty, { ...empty, draft: { docId: 'doc A', version: 2 }, cards: [card] });
    expect(scenes.map((s) => s.kind)).toEqual(['draft', 'seal', 'courier']);
  });
  it('does not discard multiple letters first observed in the same update', () => {
    const incoming = { ...card, offerId: 'offer B', direction: 'in' as const, stage: 'received' as const, termsVersion: 2 };
    expect(mapScenes(empty, { ...empty, cards: [card, incoming] }).map((s) => s.kind)).toEqual(['seal', 'courier', 'courier']);
  });
});

describe('relief projection', () => {
  const confirmed = { ...card, stage: 'confirmed' as const };
  const terminal: WorldView['terminal'] = { kind: 'pact_concluded', day: 10, round: 3, detail: { confirmedDay: 5, khitanArrivalDay: 20 } };
  it('only projects an agreed relief schedule after the pact ends the chapter', () => {
    expect(reliefPlan(confirmed, terminal)).toEqual({ cavalry: 30000, confirmedDay: 5, arrivalDay: 20 });
    expect(reliefPlan(card, terminal)).toBeNull();
    expect(reliefPlan(confirmed, null)).toBeNull();
    expect(reliefPlan(confirmed, { ...terminal, kind: 'jinyang_falls' })).toBeNull();
    expect(reliefPlan({ ...confirmed, terms: null }, terminal)).toBeNull();
    expect(reliefPlan(confirmed, { ...terminal, detail: {} })).toBeNull();
  });
  it('plays confirmation before projected relief, once per observed schedule', () => {
    const next = { ...empty, cards: [confirmed], relief: reliefPlan(confirmed, terminal) };
    const scenes = mapScenes({ ...empty, cards: [card] }, next);
    expect(scenes.map((s) => s.kind)).toEqual(['courier', 'confirmation', 'relief']);
    expect(scenes.at(-1)?.title).toContain('Projected');
    expect(mapScenes(next, structuredClone(next))).toEqual([]);
  });
});
