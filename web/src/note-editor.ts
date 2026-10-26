import type { CatalogView, Lang, TermsView } from '../../src/server/api-types.js';
import { containsHan, displayText } from '../../src/display-language.js';

/** A summary is labelled explicitly; it is not a translation of the original free-text note. */
export function notePresentation(original: string, terms: TermsView, catalog: CatalogView, lang: Lang): { text: string; summarized: boolean } {
  if (lang !== 'en' || !containsHan(original)) return { text: original, summarized: false };
  const translated = displayText(original, lang);
  if (translated !== 'Recorded in Chinese; no English translation is available.') return { text: translated, summarized: false };
  const values = terms as unknown as Record<string, unknown>;
  const parts = catalog.terms.filter((entry) => entry.applicable).map((entry) => {
    const value = values[entry.key];
    const label = entry.values.find((option) => option.value === value)?.label.en;
    const formatted = typeof value === 'boolean' ? (value ? 'yes' : 'no') : typeof value === 'number' ? value.toLocaleString('en-US') : label ?? String(value ?? 'not specified');
    return `${entry.label.en}: ${formatted}`;
  });
  return { text: parts.length ? `Current draft — ${parts.join('; ')}.` : 'Current draft; see the terms above.', summarized: true };
}

/** An untouched editor must submit the recorded note, never its display-only summary. */
export function noteToSubmit(edited: string | null, original: string): string {
  return edited === null ? original : edited;
}
