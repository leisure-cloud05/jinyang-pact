import { describe, expect, it } from 'vitest';
import { DEFAULT_TERMS, withinLimits } from '../../src/core/terms.js';
import type { TermLimits } from '../../src/core/types.js';
import { burdenBreakdown, burdenOf, burdenScale, draftGoalViolations } from '../../web/src/burden.js';
import type { TermsView } from '../../src/server/api-types.js';
import { content, coreConfig } from '../content-real/helpers.js';
import { createSession, input, makeApp, rid, state } from './helpers.js';

const editable = (terms: TermsView) => ({ ...terms, secret_clauses: terms.secret_clauses.map((clause) => clause.id) });

describe('burden preview and contribution breakdown', () => {
  it('matches the server’s real weighted burden, excluding relief paid by the Khitan', async () => {
    const { app } = await makeApp({ content: content() });
    const id = await createSession(app, 'C1');
    const s = (await state(app, id)).json;
    const terms = { ...editable(s.document!.terms), annual_silk: 250000 };
    const parts = burdenBreakdown(terms, s.catalog);
    expect(parts.map((p) => [p.key, p.amount])).toEqual([
      ['vassal', 20], ['filial', 15], ['cession', 30], ['annual_silk', 25], ['immediate_silk', 5],
    ]);
    expect(parts.some((p) => p.key === 'aid_cavalry')).toBe(false);
    expect(burdenOf(terms, s.catalog)).toBe(95);
    expect(burdenOf(s.document!.terms as unknown as Record<string, unknown>, s.catalog)).toBe(s.document!.burden);
    const violations = draftGoalViolations(terms, s.world.goal.limits, s.catalog);
    expect(violations).toEqual(withinLimits({ ...DEFAULT_TERMS, ...terms, cession: 'yanmen_north', secret_clauses: [] }, s.world.goal.limits as unknown as TermLimits, coreConfig().catalog, 'hedong-khitan').violations);
    const reduced = { ...terms, annual_silk: 0 };
    expect(draftGoalViolations(reduced, s.world.goal.limits, s.catalog)).toEqual([]);
    const result = await input(app, id, { requestId: rid('burden'), kind: 'action', action: { type: 'revise_document', args: { docId: s.document!.docId, baseDocVersion: s.document!.version, terms, note: 'Preview parity check.' } } });
    expect(result.json.outcomes[0].status).toBe('committed');
    expect((await state(app, id)).json.document!.burden).toBe(95);
  });

  it('includes only known secret contributions and keeps edited totals aligned', async () => {
    const { app } = await makeApp({ content: content(), directorOpen: true });
    const id = await createSession(app, 'C4');
    const player = (await state(app, id)).json;
    expect(player.document!.terms.secret_clauses).toEqual([]);
    expect(burdenOf(player.document!.terms as unknown as Record<string, unknown>, player.catalog)).toBe(player.document!.burden);
    const director = (await state(app, id, 'director')).json;
    const doc = director.document!;
    expect(doc.terms.secret_clauses[0]?.burdenWeight).toBe(15);
    expect(burdenOf(editable(doc.terms), director.catalog, doc.terms.secret_clauses)).toBe(doc.burden);
    expect(burdenOf({ ...editable(doc.terms), secret_clauses: [] }, director.catalog, doc.terms.secret_clauses)).toBe(doc.burden - 15);
  });

  it('keeps individual goal violations visible even when the total burden fits', async () => {
    const { app } = await makeApp({ content: content() });
    const id = await createSession(app, 'C1');
    const s = (await state(app, id)).json;
    const terms = { ...editable(s.document!.terms), cession: 'lulong_only', filial: false };
    // Both partial cessions have equal rank in the engine; boolean requirements remain independent.
    expect(draftGoalViolations(terms, { cession_max: 'yanmen_north', filial: true, burden_max: 80 }, s.catalog)).toEqual(['filial must be true']);
  });
});

describe('burden risk scale', () => {
  it('places 95 between the 80 target and the 100 warning threshold', () => {
    expect(burdenScale(95, 80)).toMatchObject({ limit: 80, excess: 15, max: 120, safe: 80 / 120 * 100, caution: 20 / 120 * 100, marker: 95 / 120 * 100 });
    expect(burdenScale(80, 80).excess).toBe(0);
    expect(burdenScale(101, 80).excess).toBe(21);
  });

  it('handles an unset or zero cap and leaves room for an extreme marker', () => {
    for (const [total, goal] of [[0, 0], [95, 0], [0, null], [900, 80], [30, null]] as const) {
      const scale = burdenScale(total, goal);
      expect(Number.isFinite(scale.marker)).toBe(true);
      expect(scale.max).toBeGreaterThan(0);
      expect(scale.safe + scale.caution).toBeLessThanOrEqual(100);
      expect(scale.marker).toBeLessThanOrEqual(100);
    }
    expect(burdenScale(95, 0).excess).toBe(95);
    expect(burdenScale(95, null).limit).toBeNull();
  });
});
