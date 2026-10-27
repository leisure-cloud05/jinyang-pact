import { describe, expect, it } from 'vitest';
import type { StateView, TermsView } from '../../src/server/api-types.js';
import { characterTopics } from '../../web/src/character-topics.js';

function visible(terms: Partial<TermsView> | null, alerts = false) {
  return {
    document: terms ? { terms: { cession: 'none', filial: false, immediate_silk: 0, annual_silk: 0, ...terms } } : null,
    siegeWatch: { alerts: alerts ? [{ code: 'morale_falls' }] : [] },
  } as Pick<StateView, 'document' | 'siegeWatch'>;
}

describe('character conversation openings', () => {
  it('prioritizes a visible siege alert and offers only terms present in the draft', () => {
    const topics = characterTopics('sang_weihan', visible({ cession: 'lulong_only', filial: true }, true));
    expect(topics.map((p) => p.id)).toEqual(['siege', 'land', 'rites', 'counsel']);
    expect(topics.some((p) => p.id === 'silk')).toBe(false);
  });

  it('updates the openings when terms change and handles an unavailable draft', () => {
    expect(characterTopics('shi_jingtang', visible({ immediate_silk: 50000 })).map((p) => p.id)).toEqual(['silk', 'counsel']);
    expect(characterTopics('liu_zhiyuan', visible(null)).map((p) => p.id)).toEqual(['counsel']);
  });

  it('tailors counsel to each role without asserting Liu’s unspoken position', () => {
    const sang = characterTopics('sang_weihan', visible(null))[0]!;
    const liu = characterTopics('liu_zhiyuan', visible(null))[0]!;
    expect(sang.label.en).toBe('A credible appeal');
    expect(liu.label.en).toBe('Defending Jinyang');
    expect(liu.text.zh).toContain('依你之见');
    for (const id of ['shi_jingtang', 'sang_weihan', 'liu_zhiyuan']) {
      for (const topic of characterTopics(id, visible({ filial: true, cession: 'sixteen_prefectures', annual_silk: 100000 }, true))) {
        expect(topic.text.zh).toMatch(/^（附耳低语）/u);
        expect(topic.text.en).toMatch(/^\(quietly\)/u);
      }
    }
  });
});
