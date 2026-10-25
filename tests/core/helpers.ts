/** Shared fixtures and builders for core tests (pure; no network, no clock). */
import { fileURLToPath } from 'node:url';
import { buildCoreConfig, buildInitialState, caseCoreConfig, loadContent, type ContentBundle, type StateOverrides } from '../../src/content/loader.js';
import type { TermSetArgs } from '../../src/core/actions.js';
import { executeBatch, type BatchDecision, type BatchProposal, type ExecuteResult } from '../../src/core/execute.js';
import { planPauses } from '../../src/core/plan.js';
import { runAdvance, runPrepare } from '../../src/core/system.js';
import type {
  ActorId,
  BatchKind,
  CoreConfig,
  DecisionOption,
  FactionId,
  Mode,
  PauseCategory,
  ResourceKey,
  WorldState,
} from '../../src/core/types.js';

export const FIXTURE_ROOT = fileURLToPath(new URL('../fixtures/content/', import.meta.url));
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

let bundle: ContentBundle | null = null;
let cfg: CoreConfig | null = null;

export function fixture(): ContentBundle {
  bundle ??= loadContent(FIXTURE_ROOT, { requireSources: true });
  return bundle;
}

export function config(): CoreConfig {
  cfg ??= buildCoreConfig(fixture());
  return cfg;
}

/** Rules configuration of a fixture case (its clause library applied). */
export function configFor(caseId: string): CoreConfig {
  return caseCoreConfig(fixture(), caseId);
}

export function initial(overrides: StateOverrides = {}): WorldState {
  return buildInitialState(fixture(), overrides);
}

/** Clone-and-modify for synthetic states. */
export function mutate(state: WorldState, fn: (s: WorldState) => void): WorldState {
  const copy = structuredClone(state);
  fn(copy);
  return copy;
}

let counter = 0;
export function prop(actor: ActorId, action: unknown, opts: { id?: string; askPlayer?: { question: string } } = {}): BatchProposal {
  counter += 1;
  return { proposalId: opts.id ?? `p${counter}`, actor, seq: counter, action, askPlayer: opts.askPlayer ?? null };
}

export function decide(
  proposal: BatchProposal | BatchProposal[],
  category: PauseCategory,
  option: DecisionOption = 'endorse',
  extra: Partial<BatchDecision> = {},
): BatchDecision {
  counter += 1;
  const list = Array.isArray(proposal) ? proposal : [proposal];
  return { decisionId: `d${counter}`, category, option, proposalIds: list.map((p) => p.proposalId), ...extra };
}

export interface BatchOpts {
  kind?: BatchKind;
  decisions?: BatchDecision[];
  mode?: Mode;
}

export function batch(state: WorldState, proposals: BatchProposal[], opts: BatchOpts = {}): ExecuteResult {
  return executeBatch(
    state,
    { kind: opts.kind ?? 'character', proposals, decisions: opts.decisions ?? [] },
    { config: config(), mode: opts.mode ?? 'full' },
  );
}

/** Executes a character batch after endorsing every mandatory/prompt pause the plan requires. */
export function endorsed(state: WorldState, proposals: BatchProposal[], mode: Mode = 'full'): ExecuteResult {
  const decisions: BatchDecision[] = [];
  for (let i = 0; i <= proposals.length; i++) {
    const plan = planPauses(state, { kind: 'character', proposals, decisions }, { config: config(), mode });
    const open = plan.required.filter((r) => r.kind !== 'control');
    if (open.length === 0) break;
    for (const r of open) decisions.push({ decisionId: `auto-${decisions.length + 1}`, category: r.category, option: 'endorse', proposalIds: r.proposalIds });
  }
  return batch(state, proposals, { decisions, mode });
}

export function prepare(state: WorldState): WorldState {
  return runPrepare(state, config()).state;
}

export function advance(state: WorldState): WorldState {
  return runAdvance(state, config()).state;
}

/** ADVANCE then PREPARE of the next round. */
export function nextRound(state: WorldState): WorldState {
  return prepare(advance(state));
}

export function T(partial: Partial<TermSetArgs> = {}): TermSetArgs {
  return {
    vassal: false,
    filial: false,
    cession: 'none',
    annual_silk: 0,
    immediate_silk: 0,
    aid_cavalry: 0,
    aid_arrival_days: 0,
    neutrality: false,
    marriage_alliance: false,
    secret_clauses: [],
    ...partial,
  };
}

/** The fixture's initial doc:1 terms. */
export const DOC_TERMS = T({ vassal: true, immediate_silk: 50000, aid_cavalry: 30000, aid_arrival_days: 20 });

export const A = {
  approve: (docVersion = 1, docId = 'doc:1') => ({ type: 'approve_document', args: { docId, docVersion } }),
  dispatch: (docVersion = 1, docId = 'doc:1') => ({ type: 'dispatch_document', args: { docId, docVersion } }),
  revise: (baseDocVersion: number, terms: TermSetArgs, note = 'rev', docId = 'doc:1') => ({
    type: 'revise_document',
    args: { docId, baseDocVersion, terms, note },
  }),
  timing: (mode: 'now' | 'delay' | 'hold', rounds: number | null = null, docId = 'doc:1') => ({
    type: 'set_dispatch_timing',
    args: { docId, mode, rounds },
  }),
  propose: (to: string, terms: TermSetArgs, note: string | null = null) => ({ type: 'propose_terms', args: { to, terms, note } }),
  counter: (offerId: string, terms: TermSetArgs, reason = 'counter') => ({
    type: 'respond_to_offer',
    args: { offerId, response: 'counter', counterTerms: terms, reason },
  }),
  reject: (offerId: string, reason = 'no') => ({ type: 'respond_to_offer', args: { offerId, response: 'reject', counterTerms: null, reason } }),
  confirm: (commitmentId: string, offerId: string, termsVersion: number) => ({
    type: 'confirm_commitment',
    args: { commitmentId, offerId, termsVersion },
  }),
  withdraw: (offerId: string) => ({ type: 'withdraw_offer', args: { offerId } }),
  allocate: (faction: FactionId, resource: ResourceKey, amount: number, purpose: 'intensify_siege' | 'pay_troops') => ({
    type: 'allocate_resources',
    args: { faction, resource, amount, purpose },
  }),
  abandon: (reason = 'enough') => ({ type: 'abandon_request', args: { reason } }),
  speak: (to: string[], text = 'words') => ({ type: 'speak', args: { to, text } }),
  letter: (to: string, text = 'a letter') => ({ type: 'send_letter', args: { to, text } }),
  wait: () => ({ type: 'wait', args: {} }),
  suggest: (kind: 'document' | 'offer', id: string, partial: Record<string, unknown>, reason = 'suggestion') => ({
    type: 'suggest_revision',
    args: {
      target: { kind, id },
      terms: {
        vassal: null,
        filial: null,
        cession: null,
        annual_silk: null,
        immediate_silk: null,
        aid_cavalry: null,
        aid_arrival_days: null,
        neutrality: null,
        marriage_alliance: null,
        secret_clauses: null,
        ...partial,
      },
      reason,
    },
  }),
  revoke: (authId: string) => ({ type: 'revoke_authorization', args: { authId } }),
};

export const SHI = 'shi_jingtang' as const;
export const SANG = 'sang_weihan' as const;
export const LIU = 'liu_zhiyuan' as const;
export const YELU = 'yelu_deguang' as const;
export const LI = 'li_congke' as const;

/** Round 1: Shi approves and dispatches doc:1 (endorsed). Returns the state after the batch (still round 1). */
export function dispatched(state: WorldState = initial()): WorldState {
  const result = endorsed(state, [prop(SHI, A.approve()), prop(SHI, A.dispatch())]);
  const bad = result.outcomes.filter((o) => o.status !== 'committed');
  if (bad.length > 0) throw new Error(`dispatch setup failed: ${JSON.stringify(bad)}`);
  return result.state;
}

/** Round 2 after PREPARE: the dispatched offer:1 has been delivered to Yelü. */
export function delivered(state: WorldState = initial()): WorldState {
  return nextRound(dispatched(state));
}

/** Outcome of a given proposal (outcomes are in commit order, not input order). */
export function outcomeOf(result: ExecuteResult, proposal: BatchProposal): ExecuteResult['outcomes'][number] {
  const outcome = result.outcomes.find((o) => o.proposalId === proposal.proposalId);
  if (!outcome) throw new Error(`no outcome for ${proposal.proposalId}`);
  return outcome;
}
