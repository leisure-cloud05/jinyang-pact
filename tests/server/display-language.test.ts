import { describe, expect, it } from 'vitest';
import { displayText, displayValue, proseMatchesLanguage } from '../../src/display-language.js';
import type { StoryView } from '../../src/server/api-types.js';
import { addressCouncil, createSession, get, makeApp, playToEnd } from './helpers.js';

describe('English dynamic presentation', () => {
  it('selects English recursively without losing nested fields or truncating content', () => {
    const source = { note: { zh: '中文附言', en: 'English note' }, status: 'sent', items: [{ text: { zh: '中文消息', en: 'A'.repeat(200) } }] };
    const before = JSON.stringify(source);
    const text = displayValue(source, 'en');
    expect(text).toContain('English note');
    expect(text).toContain('status: sent');
    expect(text).toContain('A'.repeat(200));
    expect(text).not.toMatch(/\p{Script=Han}/u);
    expect(JSON.stringify(source)).toBe(before);
    expect(displayValue(source.note, 'zh')).toBe('中文附言');
  });

  it('handles legacy bilingual strings and clearly labels Chinese-only records', () => {
    expect(displayText('中文 / English note', 'en')).toBe('English note');
    expect(displayText('中文', 'en')).toContain('no English translation');
    expect(displayText('English / alternative', 'en')).toBe('English / alternative');
    expect(displayText('中文 / English 中文', 'en')).toContain('no English translation');
    expect(displayText('中文', 'zh')).toBe('中文');
    expect(proseMatchesLanguage('English mixed 中文', 'en')).toBe(false);
    expect(proseMatchesLanguage('123', 'en')).toBe(false);
  });

  it('renders a Chinese session in English without changing stored narration or replay state', async () => {
    const { app, manager } = await makeApp();
    const id = await createSession(app, 'C1', { lang: 'zh' });
    await playToEnd(app, id, { onTurn: addressCouncil(app, id) });
    const ctx = manager.ctx(id);
    const stored = ctx.harness.repo.listNarrations(id);
    expect(stored.some((n) => n.status === 'ok')).toBe(true);
    const world = JSON.stringify(ctx.state);
    const translated = await get<StoryView>(app, `/api/sessions/${id}/narration?lang=en`);
    expect(translated.status).toBe(200);
    const narrations = translated.json.items.filter((item) => item.kind === 'narration');
    expect(narrations.length).toBeGreaterThan(0);
    for (const item of narrations) {
      expect(item.proseLang).toBe('en');
      expect(item.prose).not.toMatch(/\p{Script=Han}/u);
      expect(item.headerLines.join(' ')).not.toMatch(/\p{Script=Han}/u);
    }
    expect(narrations.some((item) => item.fallbackReason === 'language_mismatch')).toBe(true);
    expect(ctx.harness.repo.listNarrations(id)).toEqual(stored);
    expect(JSON.stringify(manager.ctx(id).state)).toBe(world);
    const original = await get<StoryView>(app, `/api/sessions/${id}/narration?lang=zh`);
    expect(original.json.items.some((item) => item.kind === 'narration' && /\p{Script=Han}/u.test(item.prose))).toBe(true);
  });
});
