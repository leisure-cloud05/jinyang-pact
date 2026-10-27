/**
 * Term sets (PLAN §3.2): fixed shape, fixed semantics per key (type, trigger, resource, exclusivity pool, payer),
 * content-tunable ranges/weights/applicability via the terms catalog.
 */
import { own } from './ids.js';
import type { TermSetArgs } from './actions.js';
import {
  CESSION_VALUES,
  PAIR_IDS,
  SCALAR_TERM_KEYS,
  type Cession,
  type FactionId,
  type ObligationTrigger,
  type PairId,
  type ResourceKey,
  type ScalarTermKey,
  type SecretClause,
  type TermLimits,
  type TermSet,
  type TermsCatalog,
  type TermSuggestion,
} from './types.js';

export const KHITAN_STANCE_POOL = 'khitan_stance';

export type PayerRule = 'non_khitan' | 'khitan' | 'tang' | 'none';

export interface TermSemantics {
  type: 'boolean' | 'integer' | 'enum';
  trigger: ObligationTrigger;
  /** Resource the obligation is denominated in (reserved/debited only for `on_confirm`). */
  resource: ResourceKey | null;
  exclusivityPool: string | null;
  payer: PayerRule;
}

/** Fixed semantics (never content-tunable). */
export const TERM_SEMANTICS: Record<ScalarTermKey, TermSemantics> = {
  vassal: { type: 'boolean', trigger: 'standing', resource: null, exclusivityPool: null, payer: 'non_khitan' },
  filial: { type: 'boolean', trigger: 'standing', resource: null, exclusivityPool: null, payer: 'non_khitan' },
  cession: { type: 'enum', trigger: 'on_victory', resource: null, exclusivityPool: null, payer: 'non_khitan' },
  annual_silk: {
    type: 'integer',
    trigger: 'annual_after_confirm',
    resource: 'silk',
    exclusivityPool: null,
    payer: 'non_khitan',
  },
  immediate_silk: { type: 'integer', trigger: 'on_confirm', resource: 'silk', exclusivityPool: null, payer: 'non_khitan' },
  aid_cavalry: {
    type: 'integer',
    trigger: 'on_confirm',
    resource: 'cavalry',
    exclusivityPool: KHITAN_STANCE_POOL,
    payer: 'khitan',
  },
  aid_arrival_days: { type: 'integer', trigger: 'parameter', resource: null, exclusivityPool: null, payer: 'none' },
  neutrality: { type: 'boolean', trigger: 'standing', resource: null, exclusivityPool: KHITAN_STANCE_POOL, payer: 'khitan' },
  marriage_alliance: { type: 'boolean', trigger: 'standing', resource: null, exclusivityPool: null, payer: 'tang' },
};

export const DEFAULT_TERMS: TermSet = {
  vassal: false,
  filial: false,
  cession: 'none',
  annual_silk: 0,
  immediate_silk: 0,
  aid_cavalry: 0,
  aid_arrival_days: 0,
  neutrality: false,
  marriage_alliance: false,
  secret_clauses: [],
};

export const NO_LIMITS: TermLimits = {
  vassal: null,
  filial: null,
  neutrality: null,
  marriage_alliance: null,
  cession_min: null,
  cession_max: null,
  annual_silk_min: null,
  annual_silk_max: null,
  immediate_silk_min: null,
  immediate_silk_max: null,
  aid_cavalry_min: null,
  aid_cavalry_max: null,
  aid_arrival_days_min: null,
  aid_arrival_days_max: null,
  burden_min: null,
  burden_max: null,
  secret_clauses_allowed: null,
};

// ---------------------------------------------------------------------------------------------------------------
// Pairs
// ---------------------------------------------------------------------------------------------------------------

export function pairOf(a: FactionId, b: FactionId): PairId | null {
  if (a === b) return null;
  const candidate = [`${a}-${b}`, `${b}-${a}`].find((p) => (PAIR_IDS as readonly string[]).includes(p));
  return (candidate as PairId | undefined) ?? null;
}

export function pairFactions(pair: PairId): [FactionId, FactionId] {
  const [a, b] = pair.split('-') as [FactionId, FactionId];
  return [a, b];
}

export function otherFaction(pair: PairId, faction: FactionId): FactionId {
  const [a, b] = pairFactions(pair);
  return faction === a ? b : a;
}

export function payerFor(key: ScalarTermKey | 'secret_clauses', pair: PairId): FactionId | null {
  const rule: PayerRule = key === 'secret_clauses' ? 'non_khitan' : TERM_SEMANTICS[key].payer;
  const factions = pairFactions(pair);
  switch (rule) {
    case 'khitan':
      return factions.includes('khitan') ? 'khitan' : null;
    case 'tang':
      return factions.includes('tang') ? 'tang' : null;
    case 'non_khitan':
      return factions.includes('khitan') ? (factions.find((f) => f !== 'khitan') ?? null) : null;
    case 'none':
      return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------------------------

export function cessionRank(value: Cession): number {
  return value === 'none' ? 0 : value === 'sixteen_prefectures' ? 2 : 1;
}

export function isDefaultValue(key: ScalarTermKey, value: TermSet[ScalarTermKey]): boolean {
  return value === DEFAULT_TERMS[key];
}

export function termsToArgs(terms: TermSet): TermSetArgs {
  return {
    vassal: terms.vassal,
    filial: terms.filial,
    cession: terms.cession,
    annual_silk: terms.annual_silk,
    immediate_silk: terms.immediate_silk,
    aid_cavalry: terms.aid_cavalry,
    aid_arrival_days: terms.aid_arrival_days,
    neutrality: terms.neutrality,
    marriage_alliance: terms.marriage_alliance,
    secret_clauses: terms.secret_clauses.map((c) => c.id),
  };
}

export type ExpandResult = { ok: true; terms: TermSet } | { ok: false; unknownClauseIds: string[] };

/**
 * Turns LLM/player term args into a world TermSet. Clause ids are resolved with `lookup` (null = unknown to the
 * actor). `preserved` clauses (present in the edited object but hidden from the actor) are kept: an actor can
 * never remove what it cannot see.
 */
export function expandTermArgs(
  args: TermSetArgs,
  lookup: (clauseId: string) => SecretClause | null,
  preserved: readonly SecretClause[] = [],
): ExpandResult {
  const clauses: SecretClause[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const id of args.secret_clauses) {
    if (seen.has(id)) continue;
    seen.add(id);
    const clause = lookup(id);
    if (clause) clauses.push(structuredClone(clause));
    else unknown.push(id);
  }
  if (unknown.length > 0) return { ok: false, unknownClauseIds: unknown };
  for (const clause of preserved) {
    if (!seen.has(clause.id)) {
      seen.add(clause.id);
      clauses.push(structuredClone(clause));
    }
  }
  return {
    ok: true,
    terms: {
      vassal: args.vassal,
      filial: args.filial,
      cession: args.cession,
      annual_silk: args.annual_silk,
      immediate_silk: args.immediate_silk,
      aid_cavalry: args.aid_cavalry,
      aid_arrival_days: args.aid_arrival_days,
      neutrality: args.neutrality,
      marriage_alliance: args.marriage_alliance,
      secret_clauses: clauses,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Validation against the catalog (semantic part of H01)
// ---------------------------------------------------------------------------------------------------------------

function checkInteger(key: ScalarTermKey, value: number, catalog: TermsCatalog, problems: string[]): void {
  const entry = catalog.terms[key];
  if (!Number.isInteger(value) || value < 0) {
    problems.push(`${key} must be a non-negative integer`);
    return;
  }
  if (entry.min !== null && value < entry.min) problems.push(`${key}=${value} is below the minimum ${entry.min}`);
  if (entry.max !== null && value > entry.max) problems.push(`${key}=${value} exceeds the maximum ${entry.max}`);
  if (entry.step !== null && entry.step > 0) {
    const base = entry.min ?? 0;
    if ((value - base) % entry.step !== 0) problems.push(`${key}=${value} is not a multiple of ${entry.step}`);
  }
}

/** Problems with a full term set for a principal pair (empty = valid). */
export function validateTerms(terms: TermSet, pair: PairId, catalog: TermsCatalog): string[] {
  const problems: string[] = [];
  for (const key of SCALAR_TERM_KEYS) {
    const value = terms[key];
    const entry = catalog.terms[key];
    const sem = TERM_SEMANTICS[key];
    const applicable = entry.applicable_pairs.includes(pair);
    if (!isDefaultValue(key, value) && !applicable) {
      problems.push(`${key} is not applicable to ${pair}`);
      continue;
    }
    if (!isDefaultValue(key, value) && sem.trigger !== 'parameter' && payerFor(key, pair) === null) {
      problems.push(`${key} has no payer in ${pair}`);
    }
    if (sem.type === 'integer') checkInteger(key, value as number, catalog, problems);
    if (sem.type === 'enum' && !(CESSION_VALUES as readonly string[]).includes(value as string)) {
      problems.push(`${key}=${String(value)} is not a valid value`);
    }
  }
  const seen = new Set<string>();
  for (const clause of terms.secret_clauses) {
    if (seen.has(clause.id)) problems.push(`secret clause ${clause.id} is listed twice`);
    seen.add(clause.id);
    const def = own(catalog.secretClauses, clause.id);
    if (!def) problems.push(`secret clause ${clause.id} is not in the catalog`);
    else if (!def.applicable_pairs.includes(pair)) problems.push(`secret clause ${clause.id} is not applicable to ${pair}`);
  }
  return problems;
}

/** Problems with the non-null values of a suggestion (ranges only; applicability is the target's business). */
export function validateSuggestion(terms: TermSuggestion, catalog: TermsCatalog): string[] {
  const problems: string[] = [];
  for (const key of SCALAR_TERM_KEYS) {
    const value = terms[key];
    if (value === null) continue;
    if (TERM_SEMANTICS[key].type === 'integer') checkInteger(key, value as number, catalog, problems);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// Burden and limits
// ---------------------------------------------------------------------------------------------------------------

export interface BurdenOptions {
  /** Count only keys applicable to this pair. */
  pair?: PairId;
  /** Count only obligations paid by this faction (requires `pair`). */
  payer?: FactionId;
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** Catalog-weighted burden of a term set (§3.2). */
export function burden(terms: TermSet, catalog: TermsCatalog, opts: BurdenOptions = {}): number {
  let total = 0;
  for (const key of SCALAR_TERM_KEYS) {
    const entry = catalog.terms[key];
    if (opts.pair && !entry.applicable_pairs.includes(opts.pair)) continue;
    if (opts.pair && opts.payer && payerFor(key, opts.pair) !== opts.payer) continue;
    const value = terms[key];
    switch (TERM_SEMANTICS[key].type) {
      case 'boolean':
        if (value === true) total += entry.burden_weight;
        break;
      case 'integer':
        total += (entry.burden_weight * (value as number)) / (entry.burden_unit ?? 1);
        break;
      case 'enum':
        total += entry.burden_by_value?.[value as string] ?? 0;
        break;
    }
  }
  const clausePayerOk = !(opts.pair && opts.payer) || payerFor('secret_clauses', opts.pair as PairId) === opts.payer;
  if (clausePayerOk) {
    for (const clause of terms.secret_clauses) total += own(catalog.secretClauses, clause.id)?.burden_weight ?? 0;
  }
  return round6(total);
}

/** Burden used for limits: what the non-Khitan party of the pair pays (total burden if the pair has no Khitan). */
export function limitBurden(terms: TermSet, catalog: TermsCatalog, pair: PairId): number {
  const payer = payerFor('vassal', pair);
  return payer ? burden(terms, catalog, { pair, payer }) : burden(terms, catalog, { pair });
}

export function withinLimits(
  terms: TermSet,
  limits: TermLimits,
  catalog: TermsCatalog,
  pair: PairId,
): { ok: boolean; violations: string[] } {
  const v: string[] = [];
  for (const key of ['vassal', 'filial', 'neutrality', 'marriage_alliance'] as const) {
    const required = limits[key];
    if (required !== null && terms[key] !== required) v.push(`${key} must be ${String(required)}`);
  }
  if (limits.cession_min !== null && cessionRank(terms.cession) < cessionRank(limits.cession_min)) {
    v.push(`cession below ${limits.cession_min}`);
  }
  if (limits.cession_max !== null && cessionRank(terms.cession) > cessionRank(limits.cession_max)) {
    v.push(`cession beyond ${limits.cession_max}`);
  }
  for (const key of ['annual_silk', 'immediate_silk', 'aid_cavalry', 'aid_arrival_days'] as const) {
    const min = limits[`${key}_min`];
    const max = limits[`${key}_max`];
    if (min !== null && terms[key] < min) v.push(`${key} below ${min}`);
    if (max !== null && terms[key] > max) v.push(`${key} above ${max}`);
  }
  if (limits.burden_min !== null || limits.burden_max !== null) {
    const b = limitBurden(terms, catalog, pair);
    if (limits.burden_min !== null && b < limits.burden_min) v.push(`burden ${b} below ${limits.burden_min}`);
    if (limits.burden_max !== null && b > limits.burden_max) v.push(`burden ${b} above ${limits.burden_max}`);
  }
  if (limits.secret_clauses_allowed === false && terms.secret_clauses.length > 0) v.push('secret clauses not allowed');
  return { ok: v.length === 0, violations: v };
}

/** Applies the non-null values of a suggestion to a term set (clauses are resolved by `lookup`). */
export function applySuggestion(
  terms: TermSet,
  suggestion: TermSuggestion,
  lookup: (clauseId: string) => SecretClause | null,
): TermSet {
  const next: TermSet = structuredClone(terms);
  for (const key of SCALAR_TERM_KEYS) {
    const value = suggestion[key];
    if (value !== null) (next as unknown as Record<string, unknown>)[key] = value;
  }
  if (suggestion.secret_clauses !== null) {
    next.secret_clauses = suggestion.secret_clauses
      .map((id) => lookup(id))
      .filter((c): c is SecretClause => c !== null);
  }
  return next;
}
