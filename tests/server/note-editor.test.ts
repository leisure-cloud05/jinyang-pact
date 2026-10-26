import { describe, expect, it } from 'vitest';
import type { CatalogView, TermsView } from '../../src/server/api-types.js';
import { notePresentation, noteToSubmit } from '../../web/src/note-editor.js';

const terms: TermsView = {
  vassal: true, filial: false, cession: 'yanmen_north', annual_silk: 0, immediate_silk: 50000,
  aid_cavalry: 30000, aid_arrival_days: 15, neutrality: false, marriage_alliance: false, secret_clauses: [],
};
const catalog: CatalogView = { pair: 'hedong-khitan', burdenPayer: null, limitKeys: [], delegableCategories: [], terms: [
  { key: 'vassal', label: { zh: '称臣', en: 'Vassalage' }, type: 'boolean', min: null, max: null, step: null, values: [], applicable: true, burdenWeight: 0, burdenUnit: null, burdenByValue: null, payer: null },
  { key: 'cession', label: { zh: '割地', en: 'Territory' }, type: 'enum', min: null, max: null, step: null, values: [{ value: 'yanmen_north', label: { zh: '雁门关以北诸州', en: 'Prefectures north of Yanmen' } }], applicable: true, burdenWeight: 0, burdenUnit: null, burdenByValue: null, payer: null },
  { key: 'immediate_silk', label: { zh: '即付之帛', en: 'Immediate silk' }, type: 'integer', min: 0, max: 100000, step: 1, values: [], applicable: true, burdenWeight: 0, burdenUnit: null, burdenByValue: null, payer: null },
] };

describe('English note editor', () => {
  it('shows an explicitly marked terms summary for a Chinese-only note', () => {
    const original = '已依众议删改：称臣，父礼另议。';
    const presentation = notePresentation(original, terms, catalog, 'en');
    expect(presentation.summarized).toBe(true);
    expect(presentation.text).toContain('Vassalage: yes');
    expect(presentation.text).toContain('Territory: Prefectures north of Yanmen');
    expect(presentation.text).toContain('50,000');
    expect(presentation.text).not.toMatch(/\p{Script=Han}/u);
    expect(noteToSubmit(null, original)).toBe(original);
  });

  it('uses existing English text and leaves blank or English-only notes alone', () => {
    expect(notePresentation('中文 / English note', terms, catalog, 'en')).toEqual({ text: 'English note', summarized: false });
    expect(notePresentation('English note', terms, catalog, 'en')).toEqual({ text: 'English note', summarized: false });
    expect(notePresentation('', terms, catalog, 'en')).toEqual({ text: '', summarized: false });
    expect(notePresentation('中文', terms, catalog, 'zh')).toEqual({ text: '中文', summarized: false });
  });

  it('submits an explicit edit, including clearing a note, rather than restoring the original', () => {
    expect(noteToSubmit('Revised after discussion.', '原文')).toBe('Revised after discussion.');
    expect(noteToSubmit('', '原文')).toBe('');
    expect(noteToSubmit(null, '中文 / English note')).toBe('中文 / English note');
  });
});
