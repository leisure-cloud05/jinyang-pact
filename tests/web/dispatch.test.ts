/**
 * Dispatch ceremony (pure): the clerk's seal has its own glyph, it goes down in about 0.8 s and stays about 0.5 s
 * before the scroll rolls up, and a refused dispatch says why — a stale version asks for a fresh review of the terms.
 */
import { describe, expect, it } from 'vitest';
import { DISPATCH_GLYPH, SEAL_TIMELINE, dispatchProblem } from '../../web/src/dispatch.js';

const CJK = /[㐀-鿿]/u;

describe('dispatch ceremony', () => {
  it('seals with the clerk’s own glyph, neither Shi Jingtang’s approval seal nor the pact’s', () => {
    expect(DISPATCH_GLYPH).toBe('遣');
    expect(['印', '盟']).not.toContain(DISPATCH_GLYPH);
  });

  it('stamps in about 0.8 s and holds about 0.5 s before the scroll rolls up', () => {
    expect(SEAL_TIMELINE.stamp).toBe(800);
    expect(SEAL_TIMELINE.hold).toBe(500);
    expect(SEAL_TIMELINE.roll).toBeLessThanOrEqual(800);
  });

  it('asks for a fresh review when the version changed (H04), and keeps the server’s reason otherwise', () => {
    expect(dispatchProblem({ status: 'refused', rule: 'H04', feedback: 'stale document version: dispatching v2, current v3' }, 'en')).toEqual({
      review: true,
      text: 'The draft has changed. Review its terms again before you seal it.',
    });
    expect(dispatchProblem({ status: 'refused', rule: 'H12', feedback: 'doc A was already dispatched' }, 'en')).toEqual({ review: false, text: 'This request has already been sent.' });
    expect(dispatchProblem({ status: 'refused', rule: 'H11', feedback: 'doc A is on hold' }, 'en')).toEqual({ review: false, text: 'It did not go out — refused (H11): doc A is on hold' });
    expect(dispatchProblem({ status: 'error', rule: null, feedback: null }, 'en')).toEqual({ review: false, text: 'It did not go out — error' });
  });

  it('speaks the page’s language', () => {
    for (const rule of ['H04', 'H12', 'H11']) {
      expect(dispatchProblem({ status: 'refused', rule, feedback: null }, 'en').text).not.toMatch(CJK);
      expect(dispatchProblem({ status: 'refused', rule, feedback: null }, 'zh').text).toMatch(CJK);
    }
  });
});
