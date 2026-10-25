/**
 * The world as a proposal would find it: a batch's base state plus a dry run (core `executeBatch`, `dryRun: true`)
 * of the batch's earlier executable proposals in commit order, with the batch's decisions. A batch that revises the
 * draft, approves and then dispatches therefore shows the dispatch against the revised draft — what endorsing it
 * actually sends. Used by the harness to render pause facts and by the play server's views (one implementation).
 * Pure.
 */
import { executeBatch, orderProposals, type ExecuteInput, type ExecuteOptions } from './execute.js';
import type { WorldState } from './types.js';

export function stateBeforeProposal(base: WorldState, batch: ExecuteInput, proposalId: string, opts: Omit<ExecuteOptions, 'dryRun'>): WorldState {
  const ordered = orderProposals(batch.proposals, opts.config);
  const index = ordered.findIndex((p) => p.proposalId === proposalId);
  if (index <= 0) return base;
  return executeBatch(base, { kind: batch.kind, proposals: ordered.slice(0, index), decisions: [...batch.decisions] }, { ...opts, dryRun: true }).state;
}
