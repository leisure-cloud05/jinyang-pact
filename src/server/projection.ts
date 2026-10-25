/**
 * What a proposal looked like at the moment it would commit, and which of its terms the player can know.
 *
 * - `stateBefore`: the world just before a proposal in its batch — the batch's base state plus a dry run of the
 *   batch's earlier proposals in commit order (core `stateBeforeProposal`, also used by the harness for pause facts). A batch that revises the draft, approves and dispatches therefore shows the
 *   revised terms at the dispatch, i.e. what endorsing actually sends.
 * - `termsOf`: player view resolves terms only through the engine's `playerVisibleTerms` (accessible documents,
 *   the player's own assertions, terms written in the proposal restricted to known clauses) — never live hidden
 *   world objects; unknown terms are reported as unknown. Director view reads the projected world directly.
 * Nothing here re-implements a rule.
 */
import { stateBeforeProposal } from '../core/before.js';
import type { ActorId, WorldState } from '../core/types.js';
import { playerVisibleTerms } from '../engine/index.js';
import { executableProposals, toBatchDecision } from '../harness/commit.js';
import type { TermsView, ViewMode } from './api-types.js';
import type { SessionCtx } from './context.js';
import { stateAt } from './history.js';
import { actionTermsRaw, termsFor } from './views/common.js';

export class Projection {
  private readonly ctx: SessionCtx;
  private readonly bases = new Map<string, WorldState>();
  private readonly before = new Map<string, WorldState>();

  constructor(ctx: SessionCtx) {
    this.ctx = ctx;
  }

  private base(batchId: string, baseVersion: number): WorldState {
    let s = this.bases.get(batchId);
    if (!s) {
      s = stateAt(this.ctx.harness, this.ctx.sessionId, baseVersion);
      this.bases.set(batchId, s);
    }
    return s;
  }

  /** The world just before `proposalId` would commit in its batch (base state when it is not executable). */
  stateBefore(batchId: string, proposalId: string): WorldState {
    const key = `${batchId}\u0000${proposalId}`;
    const cached = this.before.get(key);
    if (cached) return cached;
    const repo = this.ctx.harness.repo;
    const batch = repo.findBatch(batchId);
    if (!batch) return this.ctx.state;
    // The same projection the harness uses for pause facts (core `stateBeforeProposal`, harness batch inputs).
    const input = {
      kind: batch.kind,
      proposals: executableProposals(repo.listProposals(batchId)),
      decisions: repo.listDecisions(batchId).filter((d) => d.option !== 'ask').map(toBatchDecision),
    };
    const state = stateBeforeProposal(this.base(batchId, batch.baseVersion), input, proposalId, { config: this.ctx.config, mode: this.ctx.session.mode });
    this.before.set(key, state);
    return state;
  }

  /** Terms of an action as the viewer can know them on `state`. */
  termsOf(state: WorldState, actor: string, action: unknown, viewer: ViewMode): { terms: TermsView | null; unknown: string | null } {
    const config = this.ctx.config;
    if (viewer === 'director') return { terms: termsFor(actionTermsRaw(action, state), state, config, 'director'), unknown: null };
    const a = action as { type?: unknown; args?: { terms?: unknown } } | null;
    // Revisions and suggestions carry their terms in the proposal itself (seen at headquarters); clauses the player
    // does not know are dropped by `termsFor`.
    if (a && (a.type === 'revise_document' || a.type === 'suggest_revision')) {
      return { terms: a.type === 'revise_document' ? termsFor(a.args?.terms, state, config, 'player') : null, unknown: null };
    }
    const v = playerVisibleTerms(state, config, actor as ActorId, action);
    if (v.kind === 'none') return { terms: null, unknown: null };
    if (v.kind === 'unknown') return { terms: null, unknown: v.reason };
    return { terms: termsFor(v.terms, state, config, 'player'), unknown: null };
  }
}
