import { describe, expect, it } from 'vitest';
import { isPrivateLine, WHISPER_PRESETS, whisperText } from '../../web/src/whisper.js';

describe('private counsel presets (附耳进言)', () => {
  it('offers the three entries, each opening in both narrative languages', () => {
    expect(WHISPER_PRESETS.map((p) => p.id)).toEqual(['cost', 'limits', 'own']);
    for (const p of WHISPER_PRESETS) {
      expect(whisperText(p.id, 'zh')).toMatch(/^（附耳低语）/u);
      expect(whisperText(p.id, 'en')).toMatch(/^\(quietly\)/u);
    }
  });

  it('is advice, never a claimed fact: no preset states a number', () => {
    for (const p of WHISPER_PRESETS) expect(`${p.text.zh} ${p.text.en}`).not.toMatch(/[0-9〇一二三四五六七八九十百千万]/u);
  });

  it('marks a line of the clerk heard by exactly one person as private', () => {
    expect(isPrivateLine({ speaker: 'player', listeners: ['sang_weihan'] })).toBe(true);
    expect(isPrivateLine({ speaker: 'player', listeners: ['shi_jingtang', 'sang_weihan'] })).toBe(false);
    expect(isPrivateLine({ speaker: 'shi_jingtang', listeners: ['player'] })).toBe(false);
  });
});
