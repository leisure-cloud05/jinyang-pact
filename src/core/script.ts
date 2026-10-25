/**
 * Trajectory-robust scripts (PLAN §12.4): `when` conditions evaluated at the PLAYER step against the player's own
 * knowledge only, and the `"$current"` placeholder for `baseDocVersion` / `docVersion`, resolved to the document
 * version the player can currently see. Pure.
 */
import { executeBatch } from './execute.js';
import { own } from './ids.js';
import { knowledgeOf, latestBelief } from './knowledge.js';
import type { CharId, CoreConfig, DocumentStatus, JsonValue, MessageKind, Mode, WorldState } from './types.js';

export const CURRENT_VERSION = '$current';

export type ReceivableKind = Extract<MessageKind, 'offer' | 'response' | 'letter' | 'withdrawal_result' | 'intel'>;

export interface ReceivedSpec {
  kind: ReceivableKind;
  from?: CharId | undefined;
}

export type ScriptCondition =
  | 'always'
  | { player_received: ReceivedSpec }
  | { player_not_received: ReceivedSpec }
  | { doc_status: { docId: string; status: DocumentStatus } }
  | { round_at_least: number };

/**
 * Messages the player has evidence of: those referenced by the player's own assertions (received or observed
 * deliveries). World messages are looked up only through these references.
 */
function playerReceived(state: WorldState, spec: ReceivedSpec): boolean {
  for (const item of knowledgeOf(state, 'player')) {
    const msg = own(state.messages, item.evidence.ref);
    if (!msg || msg.status !== 'delivered') continue;
    if (msg.kind === spec.kind && (spec.from === undefined || msg.from === spec.from)) return true;
  }
  return false;
}

/** The document version and status as the player last observed them (null if never observed). */
export function playerDocView(state: WorldState, docId: string): { version: number; status: string } | null {
  const belief = latestBelief(state, 'player', docId, 'content');
  if (!belief || typeof belief.value !== 'object' || belief.value === null || Array.isArray(belief.value)) return null;
  const value = belief.value as Record<string, JsonValue>;
  return typeof value.version === 'number' && typeof value.status === 'string' ? { version: value.version, status: value.status } : null;
}

export function evaluateCondition(state: WorldState, _config: CoreConfig, condition: ScriptCondition | undefined | null): boolean {
  if (condition === undefined || condition === null || condition === 'always') return true;
  if ('player_received' in condition) return playerReceived(state, condition.player_received);
  if ('player_not_received' in condition) return !playerReceived(state, condition.player_not_received);
  if ('doc_status' in condition) return playerDocView(state, condition.doc_status.docId)?.status === condition.doc_status.status;
  return state.round >= condition.round_at_least;
}

export type PlaceholderResult = { ok: true; action: unknown } | { ok: false; reason: string };

/** Replaces `"$current"` in `args.baseDocVersion` / `args.docVersion` with the player's visible version of `args.docId`. */
export function resolvePlaceholders(state: WorldState, action: unknown): PlaceholderResult {
  if (typeof action !== 'object' || action === null) return { ok: true, action };
  const copy = structuredClone(action) as { args?: Record<string, unknown> };
  const args = copy.args;
  if (!args || typeof args !== 'object') return { ok: true, action: copy };
  for (const key of ['baseDocVersion', 'docVersion'] as const) {
    if (args[key] !== CURRENT_VERSION) continue;
    const docId = typeof args.docId === 'string' ? args.docId : null;
    const view = docId ? playerDocView(state, docId) : null;
    if (!view) return { ok: false, reason: `${key} "${CURRENT_VERSION}": the player cannot see ${docId ?? 'the document'}` };
    args[key] = view.version;
  }
  return { ok: true, action: copy };
}

export interface ScriptInputLike {
  when?: ScriptCondition | null;
  probe?: boolean;
  action?: unknown;
  dialogue?: { to: string[]; text: string | { zh: string; en: string } };
}

export interface PreparedInput {
  index: number;
  probe: boolean;
  kind: 'action' | 'dialogue';
  action: unknown | null;
  dialogue: { to: string[]; text: string } | null;
}

export interface ScriptPlan {
  apply: PreparedInput[];
  skipped: Array<{ index: number; reason: string }>;
}

/**
 * Decides which scripted inputs of a round apply; pure. `when` conditions are evaluated at the PLAYER step (on the
 * state the player sees when the step starts, PLAN §12.4), so inputs guarded by the same condition apply together.
 * `"$current"` placeholders are resolved immediately before each action, against the state the player sees after
 * the inputs before it (a dry run of those actions in order), so a second revision binds to the first one's
 * version. The returned actions are the resolved ones the caller commits and stores.
 */
export function prepareScriptInputs(
  state: WorldState,
  config: CoreConfig,
  inputs: readonly ScriptInputLike[],
  lang: 'zh' | 'en' = 'zh',
  mode: Mode = 'full',
): ScriptPlan {
  const plan: ScriptPlan = { apply: [], skipped: [] };
  let evolving = state;
  inputs.forEach((input, index) => {
    if (!evaluateCondition(state, config, input.when)) {
      plan.skipped.push({ index, reason: `condition not met: ${JSON.stringify(input.when)}` });
      return;
    }
    if (input.dialogue) {
      const text = typeof input.dialogue.text === 'string' ? input.dialogue.text : input.dialogue.text[lang];
      plan.apply.push({ index, probe: input.probe ?? false, kind: 'dialogue', action: null, dialogue: { to: [...input.dialogue.to], text } });
      return;
    }
    const resolved = resolvePlaceholders(evolving, input.action);
    if (!resolved.ok) {
      plan.skipped.push({ index, reason: resolved.reason });
      return;
    }
    plan.apply.push({ index, probe: input.probe ?? false, kind: 'action', action: resolved.action, dialogue: null });
    evolving = executeBatch(
      evolving,
      { kind: 'player', proposals: [{ proposalId: `script-${index}`, actor: 'player', seq: 1, action: resolved.action, askPlayer: null }], decisions: [] },
      { config, mode },
    ).state;
  });
  return plan;
}
