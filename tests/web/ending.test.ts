/**
 * Ending CG copy and summary (pure): every ending of the game has fixed English copy, the pact's lines follow the
 * land it gives, and the summary carries only what the negotiation track and the siege at headquarters carry.
 */
import { describe, expect, it } from 'vitest';
import { TERMINAL_KINDS } from '../../src/core/types.js';
import type { NegotiationTrackView, OfferCardView, TermsView } from '../../src/server/api-types.js';
import { ENDING_TIMELINE, ENDINGS, endingKey, endingLines, endingSummary, isEndingKind, type EndingFacts } from '../../web/src/ending.js';

const TERMS: TermsView = { vassal: true, filial: true, cession: 'yanmen_north', annual_silk: 0, immediate_silk: 30_000, aid_cavalry: 30_000, aid_arrival_days: 15, neutrality: false, marriage_alliance: false, secret_clauses: [] };

function card(o: Partial<OfferCardView>): OfferCardView {
  return { offerId: 'offer A', direction: 'out', from: 'shi_jingtang', to: 'yelu_deguang', termsVersion: 1, stage: 'confirmed', believedStatus: 'accepted', sinceDay: 0, statusDay: 10, dueDay: 5, position: 1, withdrawal: null, terms: TERMS, segment: 1, segmentRound: 0, ...o };
}

function facts(kind: string, cards: OfferCardView[], detail: Record<string, unknown> = {}): EndingFacts {
  const track: NegotiationTrackView = {
    near: { charId: 'shi_jingtang', name: { zh: '石敬瑭', en: 'Shi Jingtang' }, place: { zh: '晋阳帅府', en: 'Jinyang headquarters' } },
    far: { charId: 'yelu_deguang', name: { zh: '耶律德光', en: 'Yelü Deguang' }, place: { zh: '契丹牙帐', en: 'the Khitan court' } },
    travelDays: 5,
    cards,
    roundCap: 2,
  };
  return { terminal: { kind, round: 3, day: 10, detail }, track, siege: { grain: 0, pressure: 96, morale: 35 } };
}

const CJK = /[㐀-鿿]/u;
const sentences = (s: string): number => s.match(/[.!?](?=\s|$)/gu)?.length ?? 0;

describe('ending specs', () => {
  it('cover every terminal of the game, with English titles', () => {
    for (const kind of TERMINAL_KINDS) expect(isEndingKind(kind)).toBe(true);
    expect(isEndingKind('max_rounds')).toBe(false);
    expect(Object.values(ENDINGS).map((e) => e.title)).toEqual(['A Pact at a Price', 'Jinyang Falls', 'Standing Alone', 'The Road Closes']);
    for (const e of Object.values(ENDINGS)) expect(`${e.title} ${e.alt} ${e.review} ${e.epilogue ?? ''}`).not.toMatch(CJK);
  });

  it('mark only the pact’s scene as a possible future', () => {
    expect(Object.entries(ENDINGS).filter(([, e]) => e.epilogue !== null).map(([k, e]) => [k, e.epilogue])).toEqual([['pact_concluded', 'Epilogue · A possible future']]);
  });

  it('run 8–10 seconds from the map to the full ending card', () => {
    const total = Object.values(ENDING_TIMELINE).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(8000);
    expect(total).toBeLessThanOrEqual(10_000);
  });
});

describe('lines', () => {
  const variants = [
    ...['none', 'yanmen_north', 'lulong_only', 'sixteen_prefectures'].map((cession) => facts('pact_concluded', [card({ terms: { ...TERMS, cession } })])),
    facts('jinyang_falls', [], { cause: 'grain' }),
    facts('jinyang_falls', [], { cause: 'pressure' }),
    facts('no_assistance', []),
    facts('no_assistance', [card({ stage: 'withdrawn' })]),
    facts('talks_failed', [card({ stage: 'rejected' })]),
    facts('talks_failed', [card({ direction: 'in', stage: 'rejected' })]),
    facts('jinyang_falls', [], { cause: 'missed_opportunity', deadlineRound: 6 }),
  ];

  it('give each outcome its own English lines, at most two sentences', () => {
    const lines = variants.map(endingLines);
    expect(new Set(lines).size).toBe(variants.length);
    for (const l of lines) {
      expect(l).not.toMatch(CJK);
      expect(sentences(l)).toBeGreaterThanOrEqual(1);
      expect(sentences(l)).toBeLessThanOrEqual(2);
    }
  });

  it('follow the land the pact gives, how the city fell, and who turned the talks down', () => {
    const [none, yanmen, lulong, all, grain, pressure, never, withdrawn, khitan, shi, missed] = variants.map(endingLines);
    expect(none).toContain('without giving up a single prefecture');
    expect(yanmen).toContain('north of Yanmen Pass are pledged away');
    expect(lulong).toContain('the Lulong circuit is pledged away');
    expect(all).toContain('all of Lulong');
    expect(grain).toContain('grain is gone');
    expect(pressure).toContain('breaks through');
    expect(never).toContain('No envoy rides north');
    expect(withdrawn).toContain('The request is withdrawn');
    expect(khitan).toMatch(/^Yelü Deguang has turned down the last offer/u);
    expect(shi).toMatch(/^Shi Jingtang refuses/u);
    expect(missed).toContain('No pact was sealed in time');
  });
});

describe('result summary', () => {
  it('lists the confirmed terms the clerk knows', () => {
    expect(endingSummary(facts('pact_concluded', [card({})]))).toEqual([
      { label: 'Territory pledged', value: 'North of Yanmen Pass only' },
      { label: 'Immediate silk', value: '30,000 bolts' },
      { label: 'Relief promised', value: '30,000 cavalry, within 15 days of confirmation' },
      { label: 'Concluded', value: 'Day 10, on version 1' },
    ]);
  });

  it('leaves out terms the clerk does not know', () => {
    expect(endingSummary(facts('pact_concluded', [card({ terms: null })]))).toEqual([{ label: 'Concluded', value: 'Day 10, on version 1' }]);
  });

  it('gives the cause of a fall and the last count at headquarters', () => {
    expect(endingSummary(facts('jinyang_falls', [], { cause: 'grain' }))).toEqual([
      { label: 'Cause', value: 'The grain ran out' },
      { label: 'Fell on', value: 'Day 10' },
      { label: 'Last count', value: 'grain for 0 days · pressure 96 / 100 · morale 35 / 100' },
    ]);
  });

  it('names a missed deadline as the cause when the chapter runs out of time', () => {
    expect(endingSummary(facts('jinyang_falls', [], { cause: 'missed_opportunity', deadlineRound: 6 }))[0]).toEqual({ label: 'Cause', value: 'No pact before the deadline (round 6)' });
  });

  it('says whether a request ever went out, and how the talks ended', () => {
    expect(endingSummary(facts('no_assistance', []))[0]).toEqual({ label: 'Request', value: 'Never sent' });
    expect(endingSummary(facts('talks_failed', [card({ stage: 'countered' }), card({ termsVersion: 3, stage: 'rejected' })]))).toEqual([
      { label: 'Letters exchanged', value: '2' },
      { label: 'Last offer', value: 'Version 3, rejected by Yelü Deguang' },
      { label: 'Talks ended', value: 'Day 10' },
    ]);
  });
});

it('remembers a played ending per session and ending', () => {
  expect(endingKey('C1-full-1', 'pact_concluded')).toBe('jinyang.ending.C1-full-1.pact_concluded');
});
