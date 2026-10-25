/**
 * Typed access to the language-neutral narration facts core emits (`NarrationFact.data`), shared by the header
 * renderer, the fallback prose and the checker. Every kind core emits is listed in `NARRATION_FACT_KINDS`
 * (a test scans src/core for fact kinds and fails on any kind missing here).
 */
import type { Cession, JsonValue, NarrationFact } from '../../core/types.js';

export const NARRATION_FACT_KINDS = [
  'document_revised',
  'suggestion_made',
  'document_approved',
  'dispatch_timing_set',
  'document_dispatched',
  'terms_proposed',
  'offer_countered',
  'offer_rejected',
  'withdrawal_sent',
  'offer_delivered',
  'response_delivered',
  'withdrawal_effective',
  'withdrawal_late',
  'withdrawal_result_delivered',
  'letter_delivered',
  'intel_delivered',
  'commitment_confirmed',
  'resources_allocated',
  'assistance_abandoned',
  'authorization_revoked',
  'authorization_granted',
  'letter_sent',
  'mutiny_outbreak',
  'mutiny_averted_for_now',
  'character_death',
  'allegiance_change',
  'goal_adjusted',
  'deadlock_resolved',
  'time_advanced',
  'terminal',
] as const;
export type NarrationFactKind = (typeof NARRATION_FACT_KINDS)[number];

export interface FactTerms {
  vassal: boolean;
  filial: boolean;
  cession: Cession;
  annual_silk: number;
  immediate_silk: number;
  aid_cavalry: number;
  aid_arrival_days: number;
  neutrality: boolean;
  marriage_alliance: boolean;
  secret_clause_ids: string[];
}

type Data = Record<string, JsonValue>;

export function str(data: Data, key: string): string | null {
  const v = data[key];
  return typeof v === 'string' ? v : null;
}

export function num(data: Data, key: string): number | null {
  const v = data[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function bool(data: Data, key: string): boolean | null {
  const v = data[key];
  return typeof v === 'boolean' ? v : null;
}

/** Terms as core writes them into facts (`factTerms`: scalars + clause ids; clause text never). */
export function factTerms(value: JsonValue | undefined): FactTerms | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const n = (k: string): number => (typeof value[k] === 'number' ? (value[k] as number) : 0);
  const b = (k: string): boolean => value[k] === true;
  const ids = Array.isArray(value.secret_clause_ids)
    ? (value.secret_clause_ids.filter((x) => typeof x === 'string') as string[])
    : [];
  return {
    vassal: b('vassal'),
    filial: b('filial'),
    cession: (typeof value.cession === 'string' ? value.cession : 'none') as Cession,
    annual_silk: n('annual_silk'),
    immediate_silk: n('immediate_silk'),
    aid_cavalry: n('aid_cavalry'),
    aid_arrival_days: n('aid_arrival_days'),
    neutrality: b('neutrality'),
    marriage_alliance: b('marriage_alliance'),
    secret_clause_ids: ids,
  };
}

/** All term sets carried by a fact (terms, counterTerms). */
export function termsOfFact(fact: NarrationFact): FactTerms[] {
  const out: FactTerms[] = [];
  for (const key of ['terms', 'counterTerms']) {
    const t = factTerms(fact.data[key]);
    if (t) out.push(t);
  }
  return out;
}
