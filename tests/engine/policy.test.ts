/** Scripted-user decision policy (content/README.md §6): first match, within_limits, feasibility, payloads. */
import { describe, expect, it } from 'vitest';
import { caseCoreConfig, caseInitialState, findCase } from '../../src/content/loader.js';
import { PolicyRuleSchema } from '../../src/content/schema.js';
import type { BatchProposal } from '../../src/core/execute.js';
import { optionsForPause } from '../../src/core/pauses.js';
import { playerView } from '../../src/core/knowledge.js';
import type { DecisionOption, PauseCategory, WorldState } from '../../src/core/types.js';
import { choosePolicy, pausedWithinLimits, PolicyDecisionSource, type PolicyRule } from '../../src/engine/policy.js';
import type { DecisionContext } from '../../src/engine/types.js';
import type { PauseRecord, ProposalRecord } from '../../src/store/repo.js';
import { content } from './helpers.js';

function rules(caseId: string): PolicyRule[] {
  return findCase(content(), caseId).decision_policy;
}

function rule(r: unknown): PolicyRule {
  return PolicyRuleSchema.parse(r);
}

function ctx(
  caseId: string,
  category: PauseCategory,
  opts: { options?: DecisionOption[]; within?: boolean; actor?: string; action?: unknown; asked?: number; state?: WorldState } = {},
): DecisionContext {
  const state = opts.state ?? caseInitialState(content(), caseId);
  const config = caseCoreConfig(content(), caseId);
  const action = opts.action ?? { type: 'dispatch_document', args: { docId: 'doc:1', docVersion: 1 } };
  const pause = {
    id: 'S/pause1',
    sessionId: 'S',
    batchId: 'S/b1',
    round: 1,
    epoch: 0,
    kind: 'mandatory',
    category,
    proposalIds: ['S/b1/p1'],
    pair: null,
    visibleFacts: [],
    question: { zh: '?', en: '?' },
    options: opts.options ?? optionsForPause(state, config, category, null, [action]),
    status: 'open',
    decisionId: null,
    controlSeq: 1,
  } as PauseRecord;
  const proposal = { proposalId: 'S/b1/p1', actor: opts.actor ?? 'shi_jingtang', action } as ProposalRecord;
  return {
    sessionId: 'S',
    mode: 'full',
    lang: 'zh',
    round: 1,
    pause,
    proposals: [proposal],
    state,
    config,
    withinLimits: opts.within,
    termsUnknown: [],
    asked: opts.asked ?? 0,
    askable: [],
  };
}

describe('policy matching', () => {
  it('first match wins, keyed on category and within_limits', () => {
    expect(choosePolicy(rules('C1'), ctx('C1', 'dispatch_request', { within: true }))).toEqual(expect.objectContaining({ option: 'endorse', ruleIndex: 0, by: 'policy' }));
    const out = choosePolicy(rules('C1'), ctx('C1', 'dispatch_request', { within: false }));
    expect(out.option).toBe('withhold');
    expect(out.ruleIndex).toBe(1);
    expect(out.advice).toMatch(/revise before sending/);
  });

  it('a within_limits rule never matches a pause without terms; the fallback is logged', () => {
    const out = choosePolicy(rules('C1'), ctx('C1', 'dispatch_request', { within: undefined }));
    expect(out.ruleIndex).toBeNull();
    expect(out.option).toBe('endorse');
    expect(out.note).toMatch(/fallback/);
  });

  it('uses the category-specific payloads (delegate authorization, counter_draft terms, adjust_goal limits)', () => {
    const delegate = choosePolicy(rules('C1'), ctx('C1', 'major_commitment', { within: true, action: { type: 'confirm_commitment', args: { commitmentId: 'cmt:1', offerId: 'offer:2', termsVersion: 2 } } }));
    expect(delegate.option).toBe('delegate');
    expect(delegate.authorization?.grantee).toBe('shi_jingtang');
    expect(delegate.authorization?.categories).toEqual(['major_commitment']);
    const counter = choosePolicy(rules('C1'), ctx('C1', 'major_commitment', { within: false, action: { type: 'confirm_commitment', args: { commitmentId: 'cmt:1', offerId: 'offer:2', termsVersion: 2 } } }));
    expect(counter.option).toBe('counter_draft');
    expect((counter.counterTerms as { immediate_silk: number }).immediate_silk).toBe(50000);
    const deadlock = choosePolicy(rules('C1'), ctx('C1', 'negotiation_deadlock'));
    expect(deadlock.option).toBe('adjust_goal');
    expect(deadlock.goalLimits?.annual_silk_max).toBe(200000);
  });

  it('skips a matching rule whose option is not feasible for the concrete pause, and tries the next', () => {
    const custom = [rule({ match: { category: 'prompt_request' }, choose: 'amend' }), rule({ match: { category: 'prompt_request' }, choose: 'endorse' })];
    const out = choosePolicy(custom, ctx('C1', 'prompt_request', { action: { type: 'wait', args: {} } }));
    expect(out.option).toBe('endorse');
    expect(out.skippedRules[0]).toMatch(/not an option/);
  });

  it('skips a delegate rule whose grantee is not the paused actor', () => {
    const custom = [
      rule({ match: { category: 'dispatch_request' }, choose: 'delegate', authorization: { grantee: 'sang_weihan', categories: ['dispatch_request'] } }),
      rule({ match: { category: 'dispatch_request' }, choose: 'withhold' }),
    ];
    const out = choosePolicy(custom, ctx('C1', 'dispatch_request'));
    expect(out.option).toBe('withhold');
    expect(out.skippedRules[0]).toMatch(/grantee/);
  });

  it('resolves "$current" in amend payloads to the version the player sees at decision time', () => {
    const state = caseInitialState(content(), 'D3');
    const out = choosePolicy(rules('D3'), ctx('D3', 'dispatch_request', { within: false, state }));
    expect(out.option).toBe('amend');
    expect(out.amend?.baseDocVersion).toBe(1);
    expect(out.amend?.docId).toBe('doc:1');
  });

  it('matches actor and action_type keys', () => {
    const custom = [
      rule({ match: { category: 'strategic_turn', actor: 'shi_jingtang', action_type: 'abandon_request' }, choose: 'endorse' }),
      rule({ match: { category: 'strategic_turn' }, choose: 'withhold' }),
    ];
    expect(choosePolicy(custom, ctx('C1', 'strategic_turn', { action: { type: 'abandon_request', args: { reason: 'x' } } })).option).toBe('endorse');
    expect(choosePolicy(custom, ctx('C1', 'strategic_turn', { action: { type: 'respond_to_offer', args: { offerId: 'offer:1', response: 'reject', counterTerms: null, reason: 'x' } } })).option).toBe('withhold');
  });

  it('never chooses ask (PLAN §7: ask is for interactive play only)', () => {
    const custom = [rule({ match: { category: 'dispatch_request' }, choose: 'ask', advice: 'why?' }), rule({ match: { category: 'dispatch_request' }, choose: 'endorse' })];
    const out = choosePolicy(custom, ctx('C1', 'dispatch_request'));
    expect(out.option).toBe('endorse');
    expect(out.skippedRules[0]).toMatch(/never choose ask/);
  });

  it('covers mutiny, user_requested and error_recovery pauses with the case rules or safe fallbacks', () => {
    const source = new PolicyDecisionSource(rules('D3'));
    expect(source.decide(ctx('D3', 'mutiny', { action: { type: 'mutiny_outbreak', args: {} }, actor: 'system' })).option).toBe('urge_payment');
    expect(source.decide(ctx('D3', 'user_requested', { options: ['resume', 'ask'] })).option).toBe('resume');
    expect(source.decide(ctx('D3', 'error_recovery', { options: ['retry', 'skip_actor', 'stop'] })).option).toBe('retry');
    expect(choosePolicy([], ctx('C1', 'mutiny', { options: ['let_it_happen', 'urge_payment', 'ask'] })).option).toBe('let_it_happen');
    expect(choosePolicy([], ctx('C1', 'negotiation_deadlock', { options: ['adjust_goal', 'urge_accept', 'urge_stop', 'ask'] })).option).toBe('urge_stop');
  });
});

describe('within_limits', () => {
  const approve = (v: number): BatchProposal => ({ proposalId: 'p-approve', actor: 'shi_jingtang', seq: 2, action: { type: 'approve_document', args: { docId: 'doc:1', docVersion: v } }, askPlayer: null });
  const dispatch = (v: number): BatchProposal => ({ proposalId: 'p-dispatch', actor: 'shi_jingtang', seq: 3, action: { type: 'dispatch_document', args: { docId: 'doc:1', docVersion: v } }, askPlayer: null });

  it('evaluates the dispatched document against the player goal (C1 within, D3 beyond)', () => {
    const c1 = caseInitialState(content(), 'C1');
    expect(pausedWithinLimits(c1, caseCoreConfig(content(), 'C1'), 'full', [approve(1), dispatch(1)], [], ['p-dispatch']).within).toBe(true);
    const d3 = caseInitialState(content(), 'D3');
    expect(pausedWithinLimits(d3, caseCoreConfig(content(), 'D3'), 'full', [approve(1), dispatch(1)], [], ['p-dispatch']).within).toBe(false);
  });

  it('uses the state just before the proposal in commit order (an earlier revision in the batch counts)', () => {
    const state = caseInitialState(content(), 'C1');
    const config = caseCoreConfig(content(), 'C1');
    const doc = state.documents['doc:1'];
    if (!doc) throw new Error('no doc:1');
    const terms = { ...doc.terms, immediate_silk: 200000, secret_clauses: [] };
    const revise: BatchProposal = { proposalId: 'p-revise', actor: 'shi_jingtang', seq: 1, action: { type: 'revise_document', args: { docId: 'doc:1', baseDocVersion: 1, terms, note: 'more silk' } }, askPlayer: null };
    // v2 does not exist yet: the player cannot see its terms ⇒ unknown ⇒ conservatively not within (logged).
    const unseen = pausedWithinLimits(state, config, 'full', [dispatch(2)], [], ['p-dispatch']);
    expect(unseen.within).toBe(false);
    expect(unseen.unknown[0]).toMatch(/sees v1, not v2/);
    expect(pausedWithinLimits(state, config, 'full', [dispatch(1)], [], ['p-dispatch']).within).toBe(true);
    expect(pausedWithinLimits(state, config, 'full', [revise, approve(2), dispatch(2)], [], ['p-dispatch']).within).toBe(false);
  });

  it('is undefined for proposals without terms', () => {
    const state = caseInitialState(content(), 'C1');
    expect(pausedWithinLimits(state, caseCoreConfig(content(), 'C1'), 'full', [approve(1)], [], ['p-approve']).within).toBeUndefined();
  });

  it('sees only player-visible terms (a secret clause the player does not know is ignored)', () => {
    const state = caseInitialState(content(), 'C4');
    const config = caseCoreConfig(content(), 'C4');
    expect(state.documents['doc:1']?.terms.secret_clauses.length).toBeGreaterThan(0);
    state.player.goal.limits = { ...state.player.goal.limits, secret_clauses_allowed: false };
    expect(pausedWithinLimits(state, config, 'full', [approve(1), dispatch(1)], [], ['p-dispatch']).within).toBe(true);
  });

  it('never reads hidden world terms: an off-scene draft with the same player view gives the same answer', () => {
    const config = caseCoreConfig(content(), 'C1');
    const base = caseInitialState(content(), 'C1');
    // The draft is kept where the player cannot see it; the player's last observation (v1, within) is what counts.
    const offScene = structuredClone(base);
    offScene.documents['doc:1']!.accessibleBy = ['shi_jingtang', 'sang_weihan'];
    const changed = structuredClone(offScene);
    changed.documents['doc:1']!.terms.immediate_silk = 900000;
    expect(playerView(changed, config)).toEqual(playerView(offScene, config));
    const a = pausedWithinLimits(offScene, config, 'full', [dispatch(1)], [], ['p-dispatch']);
    const b = pausedWithinLimits(changed, config, 'full', [dispatch(1)], [], ['p-dispatch']);
    expect(b).toEqual(a);
  });

  it('confirming an offer the player holds no terms of is unknown ⇒ not within (and reported)', () => {
    const state = caseInitialState(content(), 'C1');
    const confirm: BatchProposal = { proposalId: 'p-confirm', actor: 'shi_jingtang', seq: 1, action: { type: 'confirm_commitment', args: { commitmentId: 'cmt:1', offerId: 'offer:1', termsVersion: 1 } }, askPlayer: null };
    const r = pausedWithinLimits(state, caseCoreConfig(content(), 'C1'), 'full', [confirm], [], ['p-confirm']);
    expect(r.within).toBe(false);
    expect(r.unknown[0]).toMatch(/holds no terms of offer:1/);
  });
});
