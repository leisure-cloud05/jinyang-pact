import { describe, expect, it } from 'vitest';
import type { CatalogView, NegotiationTrackView, OfferCardView, TermsView } from '../../src/server/api-types.js';
import { STAGE_LABELS, TALK_STEPS, talkStep, termChanges, trackCaption } from '../../web/src/negotiation.js';

const TERMS: TermsView = { vassal: true, filial: true, cession: 'none', annual_silk: 100_000, immediate_silk: 0, aid_cavalry: 30_000, aid_arrival_days: 15, neutrality: false, marriage_alliance: false, secret_clauses: [] };

const CATALOG = {
  pair: 'hedong-khitan',
  burdenPayer: 'hedong',
  terms: [
    { key: 'vassal', label: { zh: '称臣', en: 'Vassalage' }, type: 'boolean', values: [] },
    { key: 'cession', label: { zh: '割地', en: 'Cession' }, type: 'enum', values: [{ value: 'none', label: { zh: '不割地', en: 'none' } }, { value: 'sixteen_prefectures', label: { zh: '燕云十六州', en: 'the Sixteen Prefectures' } }] },
    { key: 'annual_silk', label: { zh: '岁帛', en: 'Annual silk' }, type: 'integer', values: [] },
  ],
  limitKeys: [],
  delegableCategories: [],
} as unknown as CatalogView;

function card(o: Partial<OfferCardView>): OfferCardView {
  return { offerId: 'offer A', direction: 'out', from: 'shi_jingtang', to: 'yelu_deguang', termsVersion: 1, stage: 'proposed', believedStatus: 'sent', sinceDay: 0, statusDay: 0, dueDay: 5, position: 0, withdrawal: null, terms: TERMS, segment: 1, segmentRound: 0, ...o };
}

function track(cards: OfferCardView[]): NegotiationTrackView {
  return {
    near: { charId: 'shi_jingtang', name: { zh: '石敬瑭', en: 'Shi Jingtang' }, place: { zh: '晋阳帅府', en: 'Jinyang headquarters' } },
    far: { charId: 'yelu_deguang', name: { zh: '耶律德光', en: 'Yelü Deguang' }, place: { zh: '契丹牙帐', en: 'the Khitan court' } },
    travelDays: 5,
    cards,
    roundCap: 2,
  };
}

describe('where the talks stand', () => {
  it('maps the last letter to one of the four steps, or none once the talks ended', () => {
    expect(TALK_STEPS.map((s) => STAGE_LABELS[s])).toEqual(['Proposed', 'Awaiting reply', 'Counter-offer received', 'Both confirmed']);
    expect(talkStep(undefined)).toBe(-1);
    expect(talkStep(card({ stage: 'awaiting' }))).toBe(1);
    expect(talkStep(card({ direction: 'in', stage: 'received' }))).toBe(2);
    expect(talkStep(card({ stage: 'confirmed' }))).toBe(3);
    expect(talkStep(card({ stage: 'rejected' }))).toBe(-1);
  });

  it('words the caption by what the clerk can know', () => {
    expect(trackCaption(track([]))).toBe('No letter has gone to Yelü Deguang yet. A courier needs 5 days each way.');
    expect(trackCaption(track([card({ stage: 'proposed', dueDay: 15, termsVersion: 3 })]))).toBe('v3 is on the road to the Khitan court: due there on day 15 by the courier’s schedule.');
    expect(trackCaption(track([card({ stage: 'awaiting' })]))).toBe('By the courier’s schedule v1 reached the Khitan court on day 5. No reply has reached headquarters yet.');
    expect(trackCaption(track([card({ direction: 'in', stage: 'received', termsVersion: 2, sinceDay: 10, dueDay: null })]))).toBe('Yelü Deguang’s counter-offer v2 reached headquarters on day 10. It is for Shi Jingtang to answer.');
    expect(trackCaption(track([card({ stage: 'rejected', statusDay: 20 })]))).toBe('Yelü Deguang rejected v1; the reply reached headquarters on day 20.');
    expect(trackCaption(track([card({ stage: 'awaiting', withdrawal: 'pending' })]))).toContain('A withdrawal is on its way.');
  });
});

describe('what a counter-offer changed', () => {
  it('lists changed terms with catalog labels and display values', () => {
    const counter: TermsView = { ...TERMS, cession: 'sixteen_prefectures', annual_silk: 300_000 };
    expect(termChanges(TERMS, counter, CATALOG, 'en')).toEqual([
      { key: 'cession', label: 'Cession', from: 'none', to: 'the Sixteen Prefectures' },
      { key: 'annual_silk', label: 'Annual silk', from: '100,000', to: '300,000' },
    ]);
  });

  it('notes a known secret article added, and says nothing when either side’s terms are unknown', () => {
    const withArticle: TermsView = { ...TERMS, secret_clauses: [{ id: 'sc_x', text: { zh: '密约', en: 'A hidden promise' } }] };
    expect(termChanges(TERMS, withArticle, CATALOG, 'en')).toEqual([{ key: 'sc_x', label: 'Secret article', from: '—', to: 'A hidden promise' }]);
    expect(termChanges(null, TERMS, CATALOG, 'en')).toEqual([]);
  });
});
