/**
 * Permissive executor semantics for the baseline (PLAN §4.3): apply each action's natural effects with no
 * H02–H14 checks and no reservation feasibility (balances may go negative). If effects are inapplicable
 * (referenced object missing, malformed args) the attempt is `unapplied` — not a commit. On-behalf actions are
 * applied to the named target with the consent attributed to the actual actor (e.g. Sang confirming records the
 * pending party's consent with `by: sang_weihan`), so the oracle can flag them.
 */
import { resolveAction, type DialogueDraft } from './resolve.js';
import { parseProposalAction } from './rules.js';
import type { ActorId, AnyAction, CoreConfig, EffectDraft, WorldState } from './types.js';

export type PermissiveResult =
  | { status: 'applied'; action: AnyAction; effect: EffectDraft | null; dialogue: DialogueDraft | null }
  | { status: 'unapplied'; reason: string };

export function applyPermissive(state: WorldState, config: CoreConfig, actor: ActorId, rawAction: unknown): PermissiveResult {
  const parsed = parseProposalAction(actor, rawAction);
  if (!parsed.ok) return { status: 'unapplied', reason: `malformed action: ${parsed.reason}` };
  const resolved = resolveAction(state, actor, parsed.action, { config, permissive: true });
  if (!resolved.ok) return { status: 'unapplied', reason: resolved.reason };
  return { status: 'applied', action: parsed.action, effect: resolved.effect, dialogue: resolved.dialogue };
}
