/**
 * Display-path regressions (review 31 in docs/review_log.md, checker v10): prose the model returns goes through narrateScene; any
 * numeral-bearing sentence must end in the template fallback, never be displayed.
 */
import { describe, expect, it } from 'vitest';
import { narrateScene } from '../../src/agents/narrator.js';
import { commitEndorsed, content, driver, factsOf, newMock } from './helpers.js';

const SENTENCES = [
  'A quarter of the garrison remained.',
  'Only ¼ of the defenders remained.',
  'The camp held ½ its former inhabitants.',
];

describe('display path: fractional and Unicode numerals fall back', () => {
  it.each(SENTENCES)('%s', async (prose) => {
    const d = driver('C1');
    const r = commitEndorsed(d, [
      { actor: 'shi_jingtang', action: { type: 'approve_document', args: { docId: 'doc:1', docVersion: 1 } } },
      { actor: 'shi_jingtang', action: { type: 'dispatch_document', args: { docId: 'doc:1', docVersion: 1 } } },
    ]);
    const facts = factsOf(r.events, 'jinyang_hq');
    const { mock } = newMock();
    mock.register('narrator', () => ({ prose, mentioned_facts: [0] }));
    const out = await narrateScene({ client: mock, content: content(), config: d.config, state: d.state, scene: 'jinyang_hq', facts, lang: 'en', identity: { round: 1 } });
    expect(out.status).toBe('fallback');
    expect(out.check.checker?.counts.quantity).toBeGreaterThan(0);
    expect(out.displayed).not.toContain(prose);
    expect(out.prose).toBe(prose); // raw prose kept for the record
  });
});
