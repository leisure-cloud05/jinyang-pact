import { describe, expect, it } from 'vitest';
import { englishDisplay } from '../../web/src/labels.js';

describe('English-only web display of legacy notes', () => {
  it('shows the English half of a bilingual source note', () => {
    expect(englishDisplay('桑维翰所草致契丹主表。 / Sang Weihan\'s draft memorial to the Khitan ruler.'))
      .toBe("Sang Weihan's draft memorial to the Khitan ruler.");
  });

  it('preserves ordinary text with a slash', () => {
    expect(englishDisplay('Hold / delay the envoy')).toBe('Hold / delay the envoy');
  });
});
