/** Small pure helpers shared by the agents layer (hashing, localization, JSON sanitizing, term views). */
import { sha256Hex } from '../core/hash.js';
import { limitBurden } from '../core/terms.js';
import { SCALAR_TERM_KEYS } from '../core/types.js';
import type { Cession, JsonValue, Localized, PairId, SecretClause, TermSet, TermsCatalog } from '../core/types.js';
import type { Lang } from './types.js';

export { sha256Hex };

export function langName(lang: Lang): string {
  return lang === 'zh' ? 'Simplified Chinese (简体中文)' : 'English';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isLocalized(v: unknown): v is Localized {
  return isRecord(v) && typeof v.zh === 'string' && typeof v.en === 'string';
}

/**
 * Removes a leading meta parenthetical such as "（人设偏好，Harness 不强制）" or "(Persona preference; never
 * enforced by the Harness.)" from persona notes: authoring commentary, not something the character thinks.
 */
export function stripMetaNote(text: string): string {
  return text.replace(/^\s*[（(][^）)]*(?:Harness|harness|人设)[^）)]*[）)]\s*/u, '').trim();
}

function isClauseLike(v: Record<string, unknown>): boolean {
  return typeof v.id === 'string' && isLocalized(v.text) && typeof v.canary === 'string';
}

/**
 * Deep copy of a JSON value that localizes `{zh, en}` leaves and never carries secret-clause objects: a
 * clause-like object is reduced to `{secret_article: <id>}` (clause text is shown only inside the documents
 * and offers where it appears, PLAN §9.2 / content README §8).
 */
export function sanitizeJson(value: unknown, lang: Lang): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value as JsonValue;
  }
  if (Array.isArray(value)) return value.map((v) => sanitizeJson(v, lang));
  if (isRecord(value)) {
    if (isClauseLike(value)) return { secret_article: value.id as string };
    if (isLocalized(value)) {
      const out: Record<string, JsonValue> = { text: lang === 'zh' ? value.zh : value.en };
      for (const [k, v] of Object.entries(value)) if (k !== 'zh' && k !== 'en') out[k] = sanitizeJson(v, lang);
      return out;
    }
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      if (v !== undefined) out[key] = sanitizeJson(v, lang);
    }
    return out;
  }
  return null;
}

/** Coerces a stored JSON value into a TermSet (beliefs keep offer/doc terms as JSON), or null. */
export function asTermSet(value: unknown): TermSet | null {
  if (!isRecord(value)) return null;
  for (const key of SCALAR_TERM_KEYS) if (!(key in value)) return null;
  const clauses = Array.isArray(value.secret_clauses) ? value.secret_clauses : [];
  const secret: SecretClause[] = [];
  for (const c of clauses) {
    if (isRecord(c) && typeof c.id === 'string' && isLocalized(c.text) && typeof c.canary === 'string') {
      secret.push({
        id: c.id,
        text: { zh: c.text.zh, en: c.text.en },
        canary: c.canary,
        knownBy: Array.isArray(c.knownBy) ? (c.knownBy.filter((x) => typeof x === 'string') as SecretClause['knownBy']) : [],
      });
    }
  }
  return {
    vassal: value.vassal === true,
    filial: value.filial === true,
    cession: (value.cession as Cession) ?? 'none',
    annual_silk: Number(value.annual_silk) || 0,
    immediate_silk: Number(value.immediate_silk) || 0,
    aid_cavalry: Number(value.aid_cavalry) || 0,
    aid_arrival_days: Number(value.aid_arrival_days) || 0,
    neutrality: value.neutrality === true,
    marriage_alliance: value.marriage_alliance === true,
    secret_clauses: secret,
  };
}

/**
 * Terms as a character sees and writes them: the scalar keys and clause ids in action-argument shape (so they
 * can be copied into `terms` / `counterTerms`), the texts of the secret articles the viewer knows, and the
 * burden carried by the paying (non-Khitan) side.
 */
export interface TermsView {
  vassal: boolean;
  filial: boolean;
  cession: Cession;
  annual_silk: number;
  immediate_silk: number;
  aid_cavalry: number;
  aid_arrival_days: number;
  neutrality: boolean;
  marriage_alliance: boolean;
  secret_clauses: string[];
  secret_articles: { id: string; text: string }[];
  burden: number | null;
}

/** `terms` must already be filtered for the viewer (core `filterTermsFor`). */
export function termsView(terms: TermSet, catalog: TermsCatalog | null, pair: PairId | null, lang: Lang): TermsView {
  let b: number | null = null;
  if (catalog && pair) {
    try {
      b = limitBurden(terms, catalog, pair);
    } catch {
      b = null;
    }
  }
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
    secret_articles: terms.secret_clauses.map((c) => ({ id: c.id, text: lang === 'zh' ? c.text.zh : c.text.en })),
    burden: b,
  };
}

/** Deterministic compact JSON (object keys in insertion order; builders insert keys in a fixed order). */
export function jsonLine(value: unknown): string {
  return JSON.stringify(value);
}

/** Groups thousands with commas, independent of the host locale (e.g. 150000 → "150,000"). */
export function groupThousands(n: number): string {
  const sign = n < 0 ? '-' : '';
  const digits = String(Math.abs(Math.trunc(n)));
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
