import { describe, expect, it } from 'vitest';
import { isPlayerSide } from '../../src/core/knowledge.js';
import { FEASIBLE_OPTIONS, feasibleOptions, isOptionFeasible, mandatoryCategory, pauseKindOf } from '../../src/core/pauses.js';
import { planPauses } from '../../src/core/plan.js';
import type { AnyAction, WorldState } from '../../src/core/types.js';
import {
  A,
  DOC_TERMS,
  LI,
  LIU,
  SANG,
  SHI,
  T,
  YELU,
  batch,
  config,
  decide,
  initial,
  nextRound,
  outcomeOf,
  prop,
} from './helpers.js';

const plan = (state: WorldState, proposals: ReturnType<typeof prop>[], decisions: ReturnType<typeof decide>[] = [], mode: 'full' | 'no_judge' | 'baseline' = 'full') =>
  planPauses(state, { kind: 'character', proposals, decisions }, { config: config(), mode });

describe('mandatory categories (§4 P column)', () => {
  it('classifies critical actions of player-side actors only', () => {
    const s = initial();
    const cat = (actor: typeof SHI | typeof YELU | 'player', action: unknown) => mandatoryCategory(s, config(), actor, action as AnyAction);
    expect(cat(SHI, A.dispatch())).toBe('dispatch_request');
    expect(cat('player', A.dispatch())).toBe('dispatch_request');
    expect(cat(SHI, A.propose(YELU, DOC_TERMS))).toBe('major_commitment');
    expect(cat(SHI, A.counter('offer:1', DOC_TERMS))).toBe('major_commitment');
    expect(cat(SHI, A.confirm('cmt:1', 'offer:1', 1))).toBe('major_commitment');
    expect(cat(SHI, A.reject('offer:1'))).toBe('strategic_turn');
    expect(cat(SHI, A.abandon())).toBe('strategic_turn');
    expect(cat(SHI, A.approve())).toBeNull();
    expect(cat(SHI, A.timing('delay', 1))).toBeNull();
    expect(cat(YELU, A.counter('offer:1', DOC_TERMS))).toBeNull();
    expect(cat(YELU, A.confirm('cmt:1', 'offer:1', 1))).toBeNull();
    expect(mandatoryCategory(s, config(), 'system', { type: 'mutiny_outbreak', args: {} })).toBe('mutiny');
  });

  it('feasible options follow §7 (amend only with a document, counter_draft only with an offer)', () => {
    expect(FEASIBLE_OPTIONS.dispatch_request).toEqual(['endorse', 'withhold', 'amend', 'delegate', 'ask']);
    expect(isOptionFeasible('mutiny', 'endorse')).toBe(false);
    expect(isOptionFeasible('negotiation_deadlock', 'urge_stop')).toBe(true);
    expect(feasibleOptions('goal_conflict', { document: false, offer: true })).toEqual(['endorse', 'withhold', 'counter_draft', 'ask']);
    expect(feasibleOptions('prompt_request', { document: false, offer: false })).toEqual(['endorse', 'withhold', 'ask']);
    expect(pauseKindOf('negotiation_deadlock')).toBe('control');
    expect(pauseKindOf('risky_delay')).toBe('semantic');
  });
});

describe('pause plan recomputation (§7)', () => {
  it('withholding an earlier proposal can make a later one feasible and newly require a pause', () => {
    const s = batch(initial(), [prop(SHI, A.approve())]).state;
    const dispatch = prop(SHI, A.dispatch());
    const propose = prop(SHI, A.propose(YELU, DOC_TERMS));
    const p1 = plan(s, [dispatch, propose]);
    expect(p1.required.map((r) => r.category)).toEqual(['dispatch_request']);
    expect(p1.rejected).toEqual([{ proposalId: propose.proposalId, rule: 'H04' }]);

    const withhold = decide(dispatch, 'dispatch_request', 'withhold');
    const p2 = plan(s, [dispatch, propose], [withhold]);
    expect(p2.required.map((r) => [r.category, r.proposalIds[0]])).toEqual([['major_commitment', propose.proposalId]]);

    const r = batch(s, [dispatch, propose], { decisions: [withhold, decide(propose, 'major_commitment')] });
    expect(outcomeOf(r, dispatch).status).toBe('withheld');
    expect(outcomeOf(r, propose)).toMatchObject({ status: 'committed', gate: 'decision' });
    expect(r.state.documents['doc:1']?.status).toBe('approved');
  });

  it('askPlayer opens a prompt pause in every mode, including baseline', () => {
    const ask = prop(SANG, A.suggest('document', 'doc:1', { annual_silk: 100000 }), { askPlayer: { question: 'Add silk?' } });
    for (const mode of ['full', 'no_judge', 'baseline'] as const) {
      expect(plan(initial(), [ask], [], mode).required).toEqual([
        { kind: 'prompt', category: 'prompt_request', proposalIds: [ask.proposalId], pair: null, checkpoint: null },
      ]);
    }
    const r = batch(initial(), [ask], { decisions: [decide(ask, 'prompt_request', 'withhold')], mode: 'baseline' });
    expect(outcomeOf(r, ask).status).toBe('withheld');
    expect(r.events).toEqual([]);
  });

  it('baseline raises no mandatory pauses', () => {
    const s = batch(initial(), [prop(SHI, A.approve())]).state;
    expect(plan(s, [prop(SHI, A.dispatch())], [], 'baseline').required).toEqual([]);
  });
});

describe('delegation and authorizations', () => {
  /** Yelü opens (R1), Shi counters with `delegate` (R2), Yelü counters (R3): R4 Shi holds offer:3. */
  function withDelegation(limits: Partial<WorldState['player']['goal']['limits']> = {}): WorldState {
    let s = batch(initial(), [prop(YELU, A.propose(SHI, T({ vassal: true, filial: true, immediate_silk: 50000, aid_cavalry: 30000, aid_arrival_days: 20 })))]).state;
    s = nextRound(s);
    const counter = prop(SHI, A.counter('offer:1', T({ vassal: true, immediate_silk: 50000, aid_cavalry: 30000, aid_arrival_days: 20 })));
    const delegate = decide(counter, 'major_commitment', 'delegate', {
      authorization: { grantee: SHI, categories: ['major_commitment'], limits: { ...s.player.goal.limits, ...limits }, expiresRound: null },
    });
    const r = batch(s, [counter], { decisions: [delegate] });
    expect(outcomeOf(r, counter)).toMatchObject({ status: 'committed', gate: 'decision' });
    expect(r.state.player.authorizations['auth:1']).toMatchObject({ grantee: SHI, categories: ['major_commitment'], grantedRound: 2, revoked: false });
    expect(r.events[0]?.kind).toBe('authorization_granted'); // decision effects first
    s = nextRound(r.state);
    s = batch(s, [prop(YELU, A.counter('offer:2', T({ vassal: true, filial: true, immediate_silk: 50000, aid_cavalry: 30000, aid_arrival_days: 20 })))]).state;
    return nextRound(s);
  }

  it('a later critical decision within the limits proceeds under the authorization without a pause', () => {
    const s = withDelegation();
    const confirm = prop(SHI, A.confirm('cmt:1', 'offer:3', 3));
    expect(plan(s, [confirm]).required).toEqual([]);
    const r = batch(s, [confirm]);
    expect(outcomeOf(r, confirm)).toMatchObject({ status: 'committed', gate: 'authorization', authorizationId: 'auth:1' });
  });

  it('terms beyond the authorization limits still require a pause', () => {
    const s = withDelegation({ burden_max: 40 }); // offer:3 burden = 30 + 20 + 5 = 55
    const confirm = prop(SHI, A.confirm('cmt:1', 'offer:3', 3));
    expect(plan(s, [confirm]).required.map((r) => r.category)).toEqual(['major_commitment']);
  });

  it('a revoked authorization no longer covers', () => {
    let s = withDelegation();
    const revoke = prop('player', A.revoke('auth:1'));
    s = batch(s, [revoke], { kind: 'player' }).state;
    expect(s.player.authorizations['auth:1']?.revoked).toBe(true);
    const confirm = prop(SHI, A.confirm('cmt:1', 'offer:3', 3));
    expect(plan(s, [confirm]).required.map((r) => r.category)).toEqual(['major_commitment']);
    expect(outcomeOf(batch(s, [confirm]), confirm)).toMatchObject({ status: 'rejected', rule: 'H10' });
  });
});

describe('synthetic death and allegiance outcomes (§6: mechanism only)', () => {
  const sys = (action: unknown) => ({ proposalId: 'sys', actor: 'system' as const, seq: 1, action, askPlayer: null });

  it('death is a mandatory pause; endorse applies it, withhold does not', () => {
    const p = sys({ type: 'character_death', args: { charId: LI } });
    const run = (option: 'endorse' | 'withhold' | null, mode: 'full' | 'baseline' = 'full') =>
      batch(initial(), [p], { kind: 'system_outcome', mode, decisions: option ? [decide(p, 'death', option)] : [] });
    expect(planPauses(initial(), { kind: 'system_outcome', proposals: [p], decisions: [] }, { config: config(), mode: 'full' }).required.map((r) => r.category)).toEqual(['death']);
    expect(run('endorse').state.characters.li_congke.status).toBe('dead');
    expect(run('withhold').state.characters.li_congke.status).toBe('alive');
    expect(run(null).outcomes[0]).toMatchObject({ status: 'rejected', rule: 'H10' });
    expect(run(null, 'baseline').state.characters.li_congke.status).toBe('dead');
    const dead = run('endorse').state;
    const act = prop(LI, A.wait());
    expect(outcomeOf(batch(dead, [act]), act)).toMatchObject({ rule: 'H03' });
  });

  it('allegiance change is a mandatory pause and changes who is player-side', () => {
    const p = sys({ type: 'allegiance_change', args: { charId: LIU, faction: 'khitan' } });
    const r = batch(initial(), [p], { kind: 'system_outcome', decisions: [decide(p, 'allegiance')] });
    expect(r.state.characters.liu_zhiyuan.faction).toBe('khitan');
    expect(isPlayerSide(r.state, config(), LIU)).toBe(false);
  });

  it('only the system proposes system outcomes', () => {
    const p = prop(SHI, { type: 'mutiny_outbreak', args: {} });
    expect(outcomeOf(batch(initial(), [p]), p)).toMatchObject({ rule: 'H02' });
  });
});
