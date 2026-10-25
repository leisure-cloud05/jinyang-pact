/**
 * Term arithmetic for mock personas, computed ONLY from the structured context the prompt was built from (the
 * catalog view with weights and payers, term views with their burden, the persona's pair-scoped preferences).
 * No world state, no content files: the mocks obey the same information limits as the models.
 */
import type { TermSetArgs } from '../../core/actions.js';
import type { Cession, FactionId, PairId, TermLimits } from '../../core/types.js';
import type { CatalogEntryView, CharacterContext, OfferContextView, PreferenceView } from '../context.js';
import type { TermsView } from '../util.js';

export const CESSION_ORDER: readonly Cession[] = ['none', 'yanmen_north', 'sixteen_prefectures'];

export function cessionRank(c: Cession): number {
  return CESSION_ORDER.indexOf(c);
}

export function toArgs(t: TermsView | TermSetArgs): TermSetArgs {
  return {
    vassal: t.vassal,
    filial: t.filial,
    cession: t.cession,
    annual_silk: t.annual_silk,
    immediate_silk: t.immediate_silk,
    aid_cavalry: t.aid_cavalry,
    aid_arrival_days: t.aid_arrival_days,
    neutrality: t.neutrality,
    marriage_alliance: t.marriage_alliance,
    secret_clauses: [...t.secret_clauses],
  };
}

/** The paying (limit-burden) side of a pair: the non-Khitan faction. */
export function limitPayer(pair: PairId): FactionId {
  const [a, b] = pair.split('-') as [FactionId, FactionId];
  return a === 'khitan' ? b : a;
}

function entryBurden(entry: CatalogEntryView, value: boolean | number | string): number {
  switch (entry.type) {
    case 'boolean':
      return value === true ? entry.burden_weight : 0;
    case 'integer':
      return (entry.burden_weight * (value as number)) / (entry.burden_unit ?? 1);
    case 'enum':
      return entry.burden_by_value?.[value as string] ?? 0;
  }
}

/** Burden of the scalar terms carried by the pair's paying side (secret-article weights are not visible here). */
export function scalarBurden(ctx: CharacterContext, terms: TermSetArgs, pair: PairId): number {
  const payer = limitPayer(pair);
  let total = 0;
  for (const entry of ctx.catalog) {
    const p = entry.pairs.find((x) => x.pair === pair);
    if (!p || p.paidBy !== payer) continue;
    total += entryBurden(entry, (terms as unknown as Record<string, boolean | number | string>)[entry.key] as boolean | number | string);
  }
  return Math.round(total * 1e6) / 1e6;
}

/** Burden of modified terms, keeping the offer's known burden of secret articles (view.burden − scalar part). */
export function burdenOf(ctx: CharacterContext, base: TermsView, next: TermSetArgs, pair: PairId): number {
  const extra = base.burden === null ? 0 : base.burden - scalarBurden(ctx, toArgs(base), pair);
  return Math.round((scalarBurden(ctx, next, pair) + extra) * 1e6) / 1e6;
}

export function preferenceFor(ctx: CharacterContext, kind: PreferenceView['kind'], pair: PairId): Partial<TermLimits> | null {
  return ctx.self.preferences.find((p) => p.kind === kind && p.pair === pair)?.limits ?? null;
}

/** Violations of a persona preference (empty = acceptable). Mirrors core `withinLimits` on the visible terms. */
export function preferenceViolations(terms: TermSetArgs, burden: number | null, limits: Partial<TermLimits>): string[] {
  const v: string[] = [];
  for (const key of ['vassal', 'filial', 'neutrality', 'marriage_alliance'] as const) {
    const required = limits[key];
    if (required !== undefined && required !== null && terms[key] !== required) v.push(`${key} must be ${String(required)}`);
  }
  if (limits.cession_min && cessionRank(terms.cession) < cessionRank(limits.cession_min)) v.push(`cession below ${limits.cession_min}`);
  if (limits.cession_max && cessionRank(terms.cession) > cessionRank(limits.cession_max)) v.push(`cession beyond ${limits.cession_max}`);
  for (const key of ['annual_silk', 'immediate_silk', 'aid_cavalry', 'aid_arrival_days'] as const) {
    const min = limits[`${key}_min`];
    const max = limits[`${key}_max`];
    if (min !== undefined && min !== null && terms[key] < min) v.push(`${key} below ${min}`);
    if (max !== undefined && max !== null && terms[key] > max) v.push(`${key} above ${max}`);
  }
  if (burden !== null) {
    if (limits.burden_min !== undefined && limits.burden_min !== null && burden < limits.burden_min) v.push(`burden below ${limits.burden_min}`);
    if (limits.burden_max !== undefined && limits.burden_max !== null && burden > limits.burden_max) v.push(`burden above ${limits.burden_max}`);
  }
  if (limits.secret_clauses_allowed === false && terms.secret_clauses.length > 0) v.push('secret clauses not allowed');
  return v;
}

export function catalogEntry(ctx: CharacterContext, key: string): CatalogEntryView | undefined {
  return ctx.catalog.find((e) => e.key === key);
}

export function isApplicable(ctx: CharacterContext, key: string, pair: PairId): boolean {
  return catalogEntry(ctx, key)?.pairs.some((p) => p.pair === pair) ?? false;
}

/** Rounds `value` down to the catalog step and range of `key`. */
export function clampToCatalog(ctx: CharacterContext, key: string, value: number): number {
  const e = catalogEntry(ctx, key);
  let v = Math.max(0, value);
  if (e?.max !== null && e?.max !== undefined) v = Math.min(v, e.max);
  if (e?.step) v = Math.floor(v / e.step) * e.step;
  return v;
}

export interface AwaitingOffer {
  pair: PairId;
  offer: OfferContextView;
  onlyConfirmOrReject: boolean;
}

/** Live offers delivered to this character and not yet answered, in pair order. */
export function awaitingOffers(ctx: CharacterContext): AwaitingOffer[] {
  const out: AwaitingOffer[] = [];
  for (const n of ctx.negotiations) {
    for (const t of n.threads) {
      for (const o of t.offers) if (o.awaitingMyAnswer) out.push({ pair: n.pair, offer: o, onlyConfirmOrReject: n.onlyConfirmOrReject });
    }
  }
  return out;
}

/** Available (unreserved) stock of a resource of the character's faction. */
export function available(ctx: CharacterContext, resource: string): number {
  return (ctx.resources.available[resource] ?? 0) - (ctx.resources.reserved[resource] ?? 0);
}
