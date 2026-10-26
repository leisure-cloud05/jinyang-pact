/** Presentation only: leave recorded values intact and never pretend to translate free prose. */
export function containsHan(text: string): boolean {
  return /\p{Script=Han}/u.test(text);
}

export function proseMatchesLanguage(text: string, lang: 'zh' | 'en'): boolean {
  return lang === 'en' ? /[A-Za-z]/u.test(text) && !containsHan(text) : containsHan(text);
}

export function displayText(text: string, lang: 'zh' | 'en'): string {
  if (lang !== 'en' || !containsHan(text)) return text;
  const separator = text.lastIndexOf(' / ');
  const english = separator < 0 ? '' : text.slice(separator + 3).trim();
  if (english && proseMatchesLanguage(english, 'en')) return english;
  return 'Recorded in Chinese; no English translation is available.';
}

/** Choose localized values recursively before formatting nested changes, terms or knowledge. */
export function displayValue(value: unknown, lang: 'zh' | 'en'): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return displayText(value, lang);
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return value.length ? value.map((v) => displayValue(v, lang)).join('; ') : 'None';
  const record = value as Record<string, unknown>;
  if (typeof record[lang] === 'string') return displayText(record[lang] as string, lang);
  return Object.entries(record).map(([key, v]) => `${displayText(key, lang).replace(/_/g, ' ')}: ${displayValue(v, lang)}`).join('; ');
}
