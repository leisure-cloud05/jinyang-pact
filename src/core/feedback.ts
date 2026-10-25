/**
 * Rejection feedback (PLAN §8.6). The full reason is always kept for logs/inspector; the feedback given back to
 * the actor is the reason only when every fact it depends on is known to the actor (per its assertions or its
 * own faction's public state). Otherwise the actor gets a generic message, so rejections never leak hidden state.
 */
import type { RuleId } from './types.js';

export const GENERIC_FEEDBACK = 'The action could not be carried out as proposed.';

export interface RuleFailure {
  ok: false;
  rule: RuleId;
  /** Full reason (logs, inspector, oracle comparison). */
  reason: string;
  /** What the actor is told. */
  feedback: string;
  redacted: boolean;
  /** Optional machine-readable sub-case (e.g. H13 `segment_exhausted` vs `global_cap`). */
  code: string | null;
}

export interface FailureOptions {
  /** False when the failing check depends on facts the actor does not know. Default true. */
  knownToActor?: boolean;
  /** Actor-facing text when known (defaults to the reason). */
  feedback?: string;
  code?: string;
}

export function failure(rule: RuleId, reason: string, opts: FailureOptions = {}): RuleFailure {
  const known = opts.knownToActor ?? true;
  return {
    ok: false,
    rule,
    reason,
    feedback: known ? (opts.feedback ?? reason) : GENERIC_FEEDBACK,
    redacted: !known,
    code: opts.code ?? null,
  };
}
