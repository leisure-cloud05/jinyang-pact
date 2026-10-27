import { expect, it } from 'vitest';
import { cessionRank } from '../../src/core/terms.js';
import { cessionRank as personaRank } from '../../src/agents/mock-personas/terms.js';
import { createSession, input, makeApp, rid, state } from './helpers.js';

it('offers Lulong independently and saves it through the real draft-edit API', async () => {
  const { app } = await makeApp();
  const id = await createSession(app, 'FREE', { lang: 'en' });
  const before = (await state(app, id)).json;
  const entry = before.catalog.terms.find(t => t.key === 'cession')!;
  expect(entry.values.map(v => v.value)).toEqual(['none', 'yanmen_north', 'lulong_only', 'sixteen_prefectures']);
  expect(entry.burdenByValue?.lulong_only).toBe(entry.burdenByValue?.yanmen_north);
  const doc = before.document!;
  const result = await input(app, id, { requestId: rid('lulong'), kind: 'action', action: { type: 'revise_document', args: { docId: doc.docId, baseDocVersion: doc.version, terms: { ...doc.terms, cession: 'lulong_only', secret_clauses: [] }, note: 'Cede the Lulong circuit only.' } } });
  expect(result.status).toBe(200);
  expect(result.json.outcomes[0].status).toBe('committed');
  const after = (await state(app, id)).json;
  expect(after.document?.terms.cession).toBe('lulong_only');
  expect(after.document?.version).toBe(doc.version + 1);
});

it('keeps both partial cessions at the same level without changing full-cession limits', () => {
  for (const rank of [cessionRank, personaRank]) {
    expect(rank('none')).toBe(0);
    expect(rank('lulong_only')).toBe(rank('yanmen_north'));
    expect(rank('lulong_only')).toBe(1);
    expect(rank('sixteen_prefectures')).toBe(2);
  }
});
