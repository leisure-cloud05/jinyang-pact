import { describe, expect, it } from 'vitest';
import { content } from '../content-real/helpers.js';
import { createSession, makeApp, state } from './helpers.js';

describe('public character profiles', () => {
  it('serves curated bilingual profiles without serializing private persona data', async () => {
    const { app } = await makeApp({ content: content() });
    const id = await createSession(app, 'C4');
    const response = await state(app, id);
    expect(response.status).toBe(200);
    for (const charId of ['shi_jingtang', 'sang_weihan', 'liu_zhiyuan'] as const) {
      const character = response.json.characters.find((c) => c.id === charId)!;
      expect(character.profile).toEqual(content().characters[charId].public_profile);
      for (const section of Object.values(character.profile!)) {
        expect(section.zh.length).toBeGreaterThan(0);
        expect(section.en.length).toBeGreaterThan(0);
      }
      expect(character).not.toHaveProperty('private_memory');
      expect(character).not.toHaveProperty('goals');
    }
    expect(JSON.stringify(response.json.characters)).not.toContain('玄鸾十七号密押');
    expect(response.json.characters.find((c) => c.id === 'yelu_deguang')?.profile).toBeNull();
  });
});
