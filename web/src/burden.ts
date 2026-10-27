import type { CatalogView, L10n, TermLimitsView, TermsView } from '../../src/server/api-types.js';

export interface BurdenPart { key: string; label: L10n; amount: number }
type KnownClause = TermsView['secret_clauses'][number];
const round = (value: number): number => Math.round(value * 1e6) / 1e6;

/** Same payer, applicability and weighting rules as core/terms. Only visible clauses may be supplied. */
export function burdenBreakdown(terms: Record<string, unknown>, catalog: CatalogView, knownClauses: readonly KnownClause[] = []): BurdenPart[] {
  const parts: BurdenPart[] = [];
  for (const entry of catalog.terms) {
    if (!entry.applicable || (catalog.burdenPayer !== null && entry.payer !== catalog.burdenPayer)) continue;
    const value = terms[entry.key];
    const amount = entry.type === 'boolean' && value === true ? entry.burdenWeight
      : entry.type === 'integer' && typeof value === 'number' ? entry.burdenWeight * value / (entry.burdenUnit ?? 1)
        : entry.type === 'enum' && typeof value === 'string' ? entry.burdenByValue?.[value] ?? 0 : 0;
    if (amount > 0) parts.push({ key: entry.key, label: entry.label, amount: round(amount) });
  }
  // Secret articles are paid by the non-Khitan party, just as the burden goal is.
  if (Array.isArray(terms.secret_clauses)) {
    for (const clause of terms.secret_clauses) {
      const known = typeof clause === 'string' ? knownClauses.find((c) => c.id === clause) : clause as KnownClause;
      if (known && (known.burdenWeight ?? 0) > 0) parts.push({
        key: `clause:${known.id}`, label: { zh: '已知密约', en: 'Known secret article' }, amount: round(known.burdenWeight!),
      });
    }
  }
  return parts;
}

export function burdenOf(terms: Record<string, unknown>, catalog: CatalogView, knownClauses: readonly KnownClause[] = []): number {
  return round(burdenBreakdown(terms, catalog, knownClauses).reduce((sum, part) => sum + part.amount, 0));
}

export function burdenScale(total: number, goal: unknown) {
  const limit = typeof goal === 'number' && Number.isFinite(goal) && goal >= 0 ? goal : null;
  const max = Math.max(1, limit === null ? total * 1.2 : Math.max(limit * 1.5, total * 1.1));
  return {
    limit, max, excess: limit === null ? 0 : round(Math.max(0, total - limit)),
    marker: Math.min(100, Math.max(0, total / max * 100)),
    safe: limit === null ? 100 : limit / max * 100,
    caution: limit === null ? 0 : limit * 0.25 / max * 100,
  };
}

/** Validate the editable, visible terms; do not keep showing the saved draft's stale goal badge. */
export function draftGoalViolations(terms: Record<string, unknown>, limits: TermLimitsView, catalog: CatalogView, clauses: readonly KnownClause[] = []): string[] {
  const violations: string[] = [];
  for (const key of ['vassal', 'filial', 'neutrality', 'marriage_alliance']) {
    if (typeof limits[key] === 'boolean' && terms[key] !== limits[key]) violations.push(`${key} must be ${limits[key]}`);
  }
  const rank = (value: unknown): number => value === 'none' ? 0 : value === 'sixteen_prefectures' ? 2 : 1;
  for (const bound of ['min', 'max'] as const) {
    const cession = limits[`cession_${bound}`];
    if (typeof cession === 'string' && (bound === 'min' ? rank(terms.cession) < rank(cession) : rank(terms.cession) > rank(cession))) violations.push(`cession ${bound === 'min' ? 'below' : 'beyond'} ${cession}`);
    for (const key of ['annual_silk', 'immediate_silk', 'aid_cavalry', 'aid_arrival_days', 'burden']) {
      const limit = limits[`${key}_${bound}`];
      const value = key === 'burden' ? burdenOf(terms, catalog, clauses) : terms[key];
      if (typeof value === 'number' && typeof limit === 'number' && (bound === 'min' ? value < limit : value > limit)) violations.push(`${key}${key === 'burden' ? ` ${value}` : ''} ${bound === 'min' ? 'below' : 'above'} ${limit}`);
    }
  }
  if (limits.secret_clauses_allowed === false && Array.isArray(terms.secret_clauses) && terms.secret_clauses.length > 0) violations.push('secret clauses not allowed');
  return violations;
}
