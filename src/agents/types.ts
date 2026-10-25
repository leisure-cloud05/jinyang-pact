/**
 * Shared types of the agents layer (WP-C2). The agents never write world state: they turn authorized
 * context into LLM requests and model output into proposal drafts, narration records and interpretations
 * that the harness/engine then validates ("agent proposes, harness disposes").
 */
import type { ContentBundle } from '../content/loader.js';
import type { CharacterConfig } from '../content/schema.js';
import type { Action } from '../core/actions.js';
import type { ActorId, CharId } from '../core/types.js';
import type { LlmErrorKind } from '../llm/types.js';

export const LANGS = ['zh', 'en'] as const;
/** Language of narrative/dialogue fields (NARRATIVE_LANG). Instructions are always English. */
export type Lang = (typeof LANGS)[number];

/** The parts of the content bundle the agents read. */
export type AgentContent = Pick<ContentBundle, 'scenario' | 'characters' | 'sources'>;

/** Persona overrides (e.g. a case's `effectiveCharacter`); defaults to `content.characters[id]`. */
export type PersonaMap = Partial<Record<CharId, CharacterConfig>>;

export type DialogueKind = 'speech' | 'advice' | 'question' | 'answer';

/**
 * One dialogue row (PLAN §3.3). Structurally compatible with the store's `DialogueRecord`, so rows read from the
 * store can be passed as they are. Dialogue is never world state: listeners see it as a claim.
 */
export interface DialogueRow {
  seq: number;
  round: number;
  epoch: number;
  worldVersion: number;
  speaker: ActorId;
  listeners: ActorId[];
  text: string;
  kind: DialogueKind;
  /** Structured content of advice (e.g. counter_draft terms). */
  payload?: unknown;
}

/** Redacted feedback on one of the actor's earlier proposals (PLAN §8.6); `feedback` is what the actor may know. */
export interface FeedbackRow {
  round: number;
  seq: number;
  actionType: string;
  status: 'rejected' | 'withheld' | 'format_error' | 'unapplied' | 'stale_epoch' | 'obsolete';
  feedback: string | null;
}

/**
 * A proposal as produced by an agent, before the engine wraps it into the §3.4 envelope (proposalId, batchId,
 * epoch, baseVersion, status …). `action` has passed the core action schema (H01 shape); every other rule is
 * the harness's business.
 */
export interface ProposalDraft {
  actor: ActorId;
  source: 'llm';
  seq: number;
  action: Action;
  rationale: string;
  cites: string[];
  askPlayer: { question: string } | null;
}

/** Summary of the LLM call behind an agent result (the full record goes to the usage sink). */
export interface LlmCallSummary {
  ok: boolean;
  errorKind: LlmErrorKind | null;
  errorMessage: string | null;
  attempts: number;
  repairUsed: boolean;
  latencyMs: number;
  /** Raw model text (redacted by the client); null when no reply was received. */
  raw: string | null;
}

/**
 * How an agent call ended: `ok`; `format_error` (no usable output after the single repair retry: parse, schema,
 * truncation or content filter — a character's output is then treated as `wait`); `error` (timeout, HTTP,
 * network, budget, abort, configuration — the engine decides between retry, skip and suspend).
 */
export type AgentStatus = 'ok' | 'format_error' | 'error';

export const FORMAT_ERROR_KINDS: readonly LlmErrorKind[] = ['parse', 'schema', 'truncated', 'filtered'];

export function agentStatusOf(kind: LlmErrorKind | null): AgentStatus {
  if (kind === null) return 'ok';
  return FORMAT_ERROR_KINDS.includes(kind) ? 'format_error' : 'error';
}

/** Seed identity of a call (PLAN §9.3): mock personas derive their misbehaviour seed from it. */
export interface CallIdentity {
  sessionId?: string;
  caseId?: string;
  rep?: number;
  round: number;
  epoch?: number;
  callTag?: string;
}
