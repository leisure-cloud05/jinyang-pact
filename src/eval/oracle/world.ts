/**
 * World-state reading for the oracle, re-implemented from PLAN §3–§4 (never from src/core):
 * presence, sides, knowledge assertions (latest assertion per subject/predicate), secret-clause knowledge,
 * negotiation threads, term semantics (payer, trigger, reservable resource, exclusivity pool), burden and limits.
 */
import type {
  ActorId,
  CharId,
  Commitment,
  CoreConfig,
  Document,
  FactionId,
  KnowledgeItem,
  LocId,
  Offer,
  PairId,
  ResourceKey,
  TermLimits,
  TermSet,
  WorldState,
} from '../../core/types.js';
import { byIdNum, idNum } from './patch.js';

export const CHARS: readonly CharId[] = ['shi_jingtang', 'sang_weihan', 'liu_zhiyuan', 'yelu_deguang', 'li_congke'];
export const PERSONS: readonly ActorId[] = [...CHARS, 'player'];
export const HEDONG_KHITAN: PairId = 'hedong-khitan';
const PAIRS: readonly PairId[] = ['hedong-khitan', 'hedong-tang', 'khitan-tang'];

export function isChar(a: string): a is CharId {
  return (CHARS as readonly string[]).includes(a);
}

export function locationOf(s: WorldState, a: ActorId): LocId | null {
  if (a === 'player') return s.player.location;
  if (a === 'system') return null;
  return s.characters[a]?.location ?? null;
}

export function aliveIn(s: WorldState, a: ActorId): boolean {
  return !isChar(a) || s.characters[a]?.status === 'alive';
}

export function together(s: WorldState, a: ActorId, b: ActorId): boolean {
  const la = locationOf(s, a);
  return la !== null && la === locationOf(s, b);
}

export function factionOf(s: WorldState, c: CoreConfig, a: ActorId): FactionId | null {
  if (a === 'player') return c.player.faction;
  if (a === 'system') return null;
  return s.characters[a]?.faction ?? null;
}

export function principalOf(c: CoreConfig, f: FactionId): CharId {
  return c.factions[f].principal;
}

export function shiOf(c: CoreConfig): CharId {
  return principalOf(c, 'hedong');
}

export function playerSide(s: WorldState, c: CoreConfig, a: ActorId): boolean {
  return a !== 'system' && factionOf(s, c, a) === c.player.faction;
}

/** People present (alive) at a location. */
export function presentAt(s: WorldState, loc: string): ActorId[] {
  return PERSONS.filter((p) => aliveIn(s, p) && locationOf(s, p) === loc);
}

// ---------------------------------------------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------------------------------------------

export function assertionsOf(s: WorldState, holder: ActorId): KnowledgeItem[] {
  return Object.values(s.knowledge)
    .filter((k) => k.holder === holder)
    .sort((a, b) => byIdNum(a.id, b.id));
}

/** Latest assertion (highest id) of holder about (subject, predicate). */
export function latest(s: WorldState, holder: ActorId, subject: string, predicate: string): KnowledgeItem | null {
  let best: KnowledgeItem | null = null;
  for (const k of Object.values(s.knowledge)) {
    if (k.holder !== holder || k.subject !== subject || k.predicate !== predicate) continue;
    if (!best || idNum(k.id) > idNum(best.id)) best = k;
  }
  return best;
}

export function believedStatus(s: WorldState, holder: ActorId, subject: string): string | null {
  const k = latest(s, holder, subject, 'status');
  return k && typeof k.value === 'string' ? k.value : null;
}

export function knowsAbout(s: WorldState, holder: ActorId, subject: string): boolean {
  return Object.values(s.knowledge).some((k) => k.holder === holder && k.subject === subject);
}

function tvOf(v: unknown): number | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const tv = (v as Record<string, unknown>).termsVersion;
  return typeof tv === 'number' ? tv : null;
}

/** Receipt evidence of an offer's terms at termsVersion (PLAN H08). */
export function hasReceipt(s: WorldState, holder: ActorId, offerId: string, termsVersion: number): boolean {
  return Object.values(s.knowledge).some((k) => k.holder === holder && k.subject === offerId && k.predicate === 'terms' && tvOf(k.value) === termsVersion);
}

/** Clause ids contained in an assertion value (`value.terms.secret_clauses[].id`). */
export function clauseIdsIn(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const terms = (value as Record<string, unknown>).terms;
  if (typeof terms !== 'object' || terms === null) return [];
  const list = (terms as Record<string, unknown>).secret_clauses;
  if (!Array.isArray(list)) return [];
  return list.map((c) => (typeof c === 'object' && c !== null ? (c as { id?: unknown }).id : c)).filter((id): id is string => typeof id === 'string');
}

/** A person knows a clause if listed in knownBy or holds an assertion whose terms contain it. */
export function knowsClause(s: WorldState, c: CoreConfig, who: ActorId, clauseId: string): boolean {
  const def = c.catalog.secretClauses[clauseId];
  if (def && def.knownBy.includes(who)) return true;
  return Object.values(s.knowledge).some((k) => k.holder === who && clauseIdsIn(k.value).includes(clauseId));
}

// ---------------------------------------------------------------------------------------------------------------
// Documents and negotiation
// ---------------------------------------------------------------------------------------------------------------

/** The consenting sender of a document: the principal of its holder's faction. */
export function senderOf(s: WorldState, c: CoreConfig, doc: Document): CharId {
  return principalOf(c, s.characters[doc.holder].faction);
}

export function pairOf(a: FactionId, b: FactionId): PairId | null {
  if (a === b) return null;
  return PAIRS.find((p) => p === `${a}-${b}` || p === `${b}-${a}`) ?? null;
}

export function docPair(s: WorldState, c: CoreConfig, doc: Document): PairId | null {
  const sender = senderOf(s, c, doc);
  const to = s.characters[doc.to];
  return to ? pairOf(s.characters[sender].faction, to.faction) : null;
}

export function canAccess(s: WorldState, who: ActorId, doc: Document): boolean {
  return doc.accessibleBy.includes(who) && aliveIn(s, who) && together(s, who, doc.holder);
}

export function threadsOf(s: WorldState, pair: PairId): Commitment[] {
  return Object.values(s.commitments)
    .filter((t) => t.pair === pair)
    .sort((a, b) => byIdNum(a.id, b.id));
}

export function offersOf(s: WorldState, pair: PairId): Offer[] {
  return Object.values(s.offers)
    .filter((o) => s.commitments[o.commitmentId]?.pair === pair)
    .sort((a, b) => byIdNum(a.id, b.id));
}

export function openThread(s: WorldState, pair: PairId): Commitment | null {
  return threadsOf(s, pair).find((t) => t.status === 'negotiating') ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// Terms (PLAN §3.2, §4.2)
// ---------------------------------------------------------------------------------------------------------------

type Scalar = Exclude<keyof TermSet, 'secret_clauses'>;
export const SCALARS: readonly Scalar[] = ['vassal', 'filial', 'cession', 'annual_silk', 'immediate_silk', 'aid_cavalry', 'aid_arrival_days', 'neutrality', 'marriage_alliance'];
const CESSIONS = ['none', 'yanmen_north', 'lulong_only', 'sixteen_prefectures'];
const DEFAULTS: Record<Scalar, unknown> = {
  vassal: false,
  filial: false,
  cession: 'none',
  annual_silk: 0,
  immediate_silk: 0,
  aid_cavalry: 0,
  aid_arrival_days: 0,
  neutrality: false,
  marriage_alliance: false,
};
const INTEGER: ReadonlySet<Scalar> = new Set(['annual_silk', 'immediate_silk', 'aid_cavalry', 'aid_arrival_days']);

/** Payer of a term in a pair: Hedong/Tang (non-Khitan) pay vassalage, rites, land and silk; Khitan pays cavalry and neutrality; Tang pays the marriage. */
export function payer(key: Scalar | 'secret_clauses', pair: PairId): FactionId | null {
  const [a, b] = pair.split('-') as [FactionId, FactionId];
  const has = (f: FactionId) => a === f || b === f;
  switch (key) {
    case 'aid_cavalry':
    case 'neutrality':
      return has('khitan') ? 'khitan' : null;
    case 'marriage_alliance':
      return has('tang') ? 'tang' : null;
    case 'aid_arrival_days':
      return null;
    default:
      return has('khitan') ? (a === 'khitan' ? b : a) : null;
  }
}

/** Reservable on-confirm resource per term (immediate silk, relief cavalry). */
export function onConfirmResource(key: Scalar): ResourceKey | null {
  return key === 'immediate_silk' ? 'silk' : key === 'aid_cavalry' ? 'cavalry' : null;
}

export function poolOf(key: Scalar): string | null {
  return key === 'aid_cavalry' || key === 'neutrality' ? 'khitan_stance' : null;
}

export function isDefault(key: Scalar, v: unknown): boolean {
  return v === DEFAULTS[key];
}

/** H01 semantic check of a full term set for a pair against the catalog. */
export function termProblems(t: TermSet, pair: PairId, c: CoreConfig): string[] {
  const out: string[] = [];
  for (const key of SCALARS) {
    const v = t[key];
    const entry = c.catalog.terms[key];
    if (!entry) continue;
    if (!isDefault(key, v) && !entry.applicable_pairs.includes(pair)) out.push(`${key} not applicable to ${pair}`);
    else if (!isDefault(key, v) && key !== 'aid_arrival_days' && payer(key, pair) === null) out.push(`${key} has no payer in ${pair}`);
    if (INTEGER.has(key)) {
      const n = v as number;
      if (!Number.isInteger(n) || n < 0) out.push(`${key} must be a non-negative integer`);
      else {
        if (entry.min !== null && n < entry.min) out.push(`${key} below ${entry.min}`);
        if (entry.max !== null && n > entry.max) out.push(`${key} above ${entry.max}`);
        if (entry.step !== null && entry.step > 0 && (n - (entry.min ?? 0)) % entry.step !== 0) out.push(`${key} not a multiple of ${entry.step}`);
      }
    }
    if (key === 'cession' && !CESSIONS.includes(v as string)) out.push(`cession ${String(v)} invalid`);
  }
  const seen = new Set<string>();
  for (const cl of t.secret_clauses) {
    if (seen.has(cl.id)) out.push(`clause ${cl.id} twice`);
    seen.add(cl.id);
    const def = c.catalog.secretClauses[cl.id];
    if (!def) out.push(`clause ${cl.id} not in catalog`);
    else if (!def.applicable_pairs.includes(pair)) out.push(`clause ${cl.id} not applicable to ${pair}`);
  }
  return out;
}

/** Burden paid by the non-Khitan party of the pair (all terms if the pair has no Khitan). */
export function limitBurden(t: TermSet, c: CoreConfig, pair: PairId): number {
  const who = payer('vassal', pair);
  let total = 0;
  for (const key of SCALARS) {
    const entry = c.catalog.terms[key];
    if (!entry || !entry.applicable_pairs.includes(pair)) continue;
    if (who !== null && payer(key, pair) !== who) continue;
    const v = t[key];
    if (typeof v === 'boolean') total += v ? entry.burden_weight : 0;
    else if (typeof v === 'number') total += (entry.burden_weight * v) / (entry.burden_unit ?? 1);
    else total += entry.burden_by_value?.[v] ?? 0;
  }
  if (who === null || payer('secret_clauses', pair) === who) {
    for (const cl of t.secret_clauses) total += c.catalog.secretClauses[cl.id]?.burden_weight ?? 0;
  }
  return Math.round(total * 1e6) / 1e6;
}

export function limitViolations(t: TermSet, l: TermLimits, c: CoreConfig, pair: PairId): string[] {
  const v: string[] = [];
  for (const key of ['vassal', 'filial', 'neutrality', 'marriage_alliance'] as const) {
    if (l[key] !== null && t[key] !== l[key]) v.push(`${key} must be ${String(l[key])}`);
  }
  const rank = (x: string) => x === 'none' ? 0 : x === 'sixteen_prefectures' ? 2 : CESSIONS.includes(x) ? 1 : -1;
  if (l.cession_min !== null && rank(t.cession) < rank(l.cession_min)) v.push(`cession below ${l.cession_min}`);
  if (l.cession_max !== null && rank(t.cession) > rank(l.cession_max)) v.push(`cession beyond ${l.cession_max}`);
  for (const key of ['annual_silk', 'immediate_silk', 'aid_cavalry', 'aid_arrival_days'] as const) {
    const min = l[`${key}_min`];
    const max = l[`${key}_max`];
    if (min !== null && t[key] < min) v.push(`${key} below ${min}`);
    if (max !== null && t[key] > max) v.push(`${key} above ${max}`);
  }
  if (l.burden_min !== null || l.burden_max !== null) {
    const b = limitBurden(t, c, pair);
    if (l.burden_min !== null && b < l.burden_min) v.push(`burden ${b} below ${l.burden_min}`);
    if (l.burden_max !== null && b > l.burden_max) v.push(`burden ${b} above ${l.burden_max}`);
  }
  if (l.secret_clauses_allowed === false && t.secret_clauses.length > 0) v.push('secret clauses not allowed');
  return v;
}

/** Resource needs and pool claims a consenting payer faction takes on (PLAN §4.2). */
export function consentNeeds(t: TermSet, pair: PairId, faction: FactionId): { resources: Map<ResourceKey, number>; pools: string[] } {
  const resources = new Map<ResourceKey, number>();
  const pools: string[] = [];
  for (const key of SCALARS) {
    if (isDefault(key, t[key]) || payer(key, pair) !== faction) continue;
    const r = onConfirmResource(key);
    if (r && (t[key] as number) > 0) resources.set(r, (resources.get(r) ?? 0) + (t[key] as number));
    const pool = poolOf(key);
    if (pool) pools.push(pool);
  }
  return { resources, pools };
}

/** Held/debited claims on a pool by threads other than `exclude`. */
export function poolClaimThreads(s: WorldState, pool: string, exclude: string | null): string[] {
  const ids = new Set<string>();
  for (const r of Object.values(s.reservations)) {
    if (r.exclusivityKey === pool && (r.status === 'held' || r.status === 'debited') && r.commitmentId !== exclude) ids.add(r.commitmentId);
  }
  return [...ids];
}

export function available(s: WorldState, f: FactionId, r: ResourceKey): number {
  return s.factions[f].resources[r] - s.factions[f].reserved[r];
}

/** Term set expanded from args with the given clause ids (clause text from the catalog). */
export function expandTerms(args: Record<string, unknown>, c: CoreConfig, preserved: TermSet['secret_clauses'] = []): TermSet {
  const ids = Array.isArray(args.secret_clauses) ? (args.secret_clauses as string[]) : [];
  const clauses: TermSet['secret_clauses'] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const def = c.catalog.secretClauses[id];
    clauses.push(def ? { id, text: def.text, canary: def.canary, knownBy: [...def.knownBy] } : { id, text: { zh: '', en: '' }, canary: '', knownBy: [] });
  }
  for (const p of preserved) if (!seen.has(p.id)) clauses.push(p);
  return {
    vassal: args.vassal as boolean,
    filial: args.filial as boolean,
    cession: args.cession as TermSet['cession'],
    annual_silk: args.annual_silk as number,
    immediate_silk: args.immediate_silk as number,
    aid_cavalry: args.aid_cavalry as number,
    aid_arrival_days: args.aid_arrival_days as number,
    neutrality: args.neutrality as boolean,
    marriage_alliance: args.marriage_alliance as boolean,
    secret_clauses: clauses,
  };
}
