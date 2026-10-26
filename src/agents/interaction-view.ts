/**
 * The interaction part of a character's authorized context (PLAN §9.2, §10.4): why the character is called now,
 * the unresolved items it is responsible for (questions, answers, feedback, offers, deliveries, the clerk's words),
 * its own requests and wait, and items resolved by facts since its last turn. Built by the engine from the
 * interaction ledger (only items whose responsible character is this one, plus its own requests), rendered here.
 * Every item says what its text is: another's claim, a verified harness record, or the character's own record.
 */
import type { ActorId, CharId } from '../core/types.js';
import type { WaitOn } from './schemas.js';

export type ViewItemKind = 'offer' | 'delivery' | 'address' | 'advice' | 'request' | 'reply' | 'feedback' | 'wait';
export type ViewItemStatus = 'open' | 'seen' | 'waiting' | 'resolved' | 'obsolete';
export type ViewItemBasis = 'claim' | 'verified' | 'own';

export interface ViewAttempt {
  type: string;
  args: Record<string, unknown> | null;
  proposalId: string;
  status: string;
}

export interface ViewWait {
  on: WaitOn;
  who: string | null;
  round: number | null;
  reason: string;
  requestItemIds: string[];
}

export interface ItemView {
  id: string;
  kind: ViewItemKind;
  from: ActorId | null;
  topic: string | null;
  text: string;
  basis: ViewItemBasis;
  status: ViewItemStatus;
  /** Round.step of creation, e.g. "r2.s1" (s0 = before the round's first step). */
  since: string;
  /** Times shown to you before this turn. */
  shown: number;
  refs: string[];
  /** Triggers this activation. */
  now: boolean;
  attempted: ViewAttempt | null;
  repeats: number;
  how: string | null;
  waiting: ViewWait | null;
  satisfied: string | null;
}

export interface RequestView {
  id: string;
  to: CharId;
  topic: string | null;
  question: string;
  status: 'awaiting' | 'seen_unanswered' | 'answered' | 'declined' | 'acted' | 'closed';
  reply: string | null;
}

export interface InteractionContextView {
  round: number;
  step: number;
  maxSteps: number;
  activation: { tier: string; reason: string } | null;
  /** Item ids that trigger this activation. */
  triggeredBy: string[];
  items: ItemView[];
  myRequests: RequestView[];
  waiting: ItemView | null;
  resolvedSinceLastTurn: Array<{ id: string; kind: ViewItemKind; text: string; closure: string }>;
  notes: string[];
  /** Ids of every item this context shows (recorded with the turn). */
  supplied: string[];
}

const BASIS: Record<ViewItemBasis, string> = {
  claim: 'claim (what someone said or wrote; not verified)',
  verified: 'harness record (verified)',
  own: 'your own record',
};

/** One serialized line object per item (names resolved by the caller). */
export function itemLine(it: ItemView, nameOf: (id: ActorId) => string, compact = false): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: it.id,
    kind: it.kind,
    ...(it.from !== null && it.from !== 'system' ? { from: nameOf(it.from), fromId: it.from } : {}),
    ...(it.topic ? { topic: it.topic } : {}),
    basis: BASIS[it.basis],
    text: compact && it.text.length > 90 ? `${it.text.slice(0, 89)}…` : it.text,
    since: it.since,
    status: it.status === 'seen' ? 'seen before, not dealt with' : it.status,
    ...(it.shown > 0 ? { shownBefore: it.shown } : {}),
    ...(it.now ? { needsAttentionNow: true } : {}),
    ...(it.refs.length > 0 ? { refs: it.refs } : {}),
  };
  if (it.attempted) out.attempted = { action: it.attempted.type, args: it.attempted.args, outcome: it.attempted.status };
  if (it.repeats > 0) out.repeatedFailures = it.repeats;
  if (it.waiting) out.waitingFor = it.waiting;
  if (it.satisfied) out.conditionMet = it.satisfied;
  if (compact && it.text.length > 90) out.fullTextIn = it.refs[0] ?? it.id;
  return out;
}
