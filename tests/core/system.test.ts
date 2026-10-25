import { describe, expect, it } from 'vitest';
import { executeBatch } from '../../src/core/execute.js';
import { evaluateTerminal } from '../../src/core/terminal.js';
import { MUTINY_OUTBREAK, mutinyDue, runAdvance, runPrepare } from '../../src/core/system.js';
import type { Mode, WorldState } from '../../src/core/types.js';
import {
  A,
  DOC_TERMS,
  LI,
  SHI,
  YELU,
  advance,
  batch,
  config,
  decide,
  delivered,
  dispatched,
  initial,
  mutate,
  nextRound,
  outcomeOf,
  prop,
} from './helpers.js';

function withSiege(grain: number, pressure: number, morale: number, s: WorldState = initial()): WorldState {
  return mutate(s, (x) => {
    x.factions.hedong.resources.grain = grain;
    x.siege.pressure = pressure;
    x.siege.morale = morale;
  });
}

function mutinyBatch(s: WorldState, mode: Mode, option: 'let_it_happen' | 'urge_payment' | null) {
  const p = { proposalId: 'mutiny', actor: 'system' as const, seq: 1, action: MUTINY_OUTBREAK, askPlayer: null };
  const decisions = option ? [{ decisionId: 'dm', category: 'mutiny' as const, option, proposalIds: ['mutiny'] }] : [];
  return executeBatch(s, { kind: 'system_outcome', proposals: [p], decisions }, { config: config(), mode });
}

describe('G01–G05 ADVANCE (hand-computed)', () => {
  it('day += 5, round += 1, grain −5, pressure +8, no morale decay while grain ≥ 15 and pressure ≤ 70', () => {
    const s = advance(initial());
    expect([s.day, s.round, s.factions.hedong.resources.grain, s.siege.pressure, s.siege.morale]).toEqual([5, 2, 35, 48, 60]);
    expect(s.version).toBe(1);
  });

  it('morale decays when grain < 15 or pressure > 70 (evaluated after G03/G04)', () => {
    expect(advance(withSiege(19, 40, 60)).siege.morale).toBe(55); // grain 14
    expect(advance(withSiege(40, 63, 60)).siege.morale).toBe(55); // pressure 71
    expect(advance(withSiege(20, 62, 60)).siege.morale).toBe(60); // grain 15, pressure 70
    expect(advance(withSiege(10, 90, 3)).siege.morale).toBe(0); // floor 0
  });

  it('G03 clamps grain at 0: grain 3 ⇒ 0 ⇒ Jinyang falls (terminal belongs to the round that ended)', () => {
    const s = advance(withSiege(3, 40, 60));
    expect(s.factions.hedong.resources.grain).toBe(0);
    expect(s.terminal).toMatchObject({ kind: 'jinyang_falls', day: 5, round: 1, detail: { cause: 'grain', grain: 0 } });
  });

  it('G04 pressure is capped at 100 and G07 fires at 100', () => {
    const s = advance(withSiege(40, 95, 60));
    expect(s.siege.pressure).toBe(100);
    expect(s.terminal).toMatchObject({ kind: 'jinyang_falls', detail: { cause: 'pressure' } });
  });

  it('G04 intensify_siege: pressure += 2·floor(n/5000), reserve troops −n', () => {
    const p = prop(LI, A.allocate('tang', 'reserve_troops', 12000, 'intensify_siege'));
    const s = batch(initial(), [p]).state;
    expect(s.siege.pressure).toBe(44);
    expect(s.factions.tang.resources.reserve_troops).toBe(18000);
  });

  it('G05 pay_troops: morale += 3·floor(n/10000), silk −n, capped at 100', () => {
    const p = prop(SHI, A.allocate('hedong', 'silk', 25000, 'pay_troops'));
    const s = batch(initial(), [p]).state;
    expect(s.siege.morale).toBe(66);
    expect(s.factions.hedong.resources.silk).toBe(95000);
    const capped = batch(withSiege(40, 40, 99), [prop(SHI, A.allocate('hedong', 'silk', 20000, 'pay_troops'))]).state;
    expect(capped.siege.morale).toBe(100);
  });

  it('rejects allocations with a mismatched purpose (H01) or by a non-principal (H02)', () => {
    const wrong = prop(SHI, A.allocate('hedong', 'grain', 5, 'pay_troops'));
    expect(outcomeOf(batch(initial(), [wrong]), wrong)).toMatchObject({ rule: 'H01' });
    const other = prop(SHI, A.allocate('tang', 'reserve_troops', 5000, 'intensify_siege'));
    expect(outcomeOf(batch(initial(), [other]), other)).toMatchObject({ rule: 'H02' });
  });
});

describe('G06 mutiny', () => {
  it('stages after ADVANCE when grain ≤ 10 and morale ≤ 30; let_it_happen ⇒ morale 0, pressure +20', () => {
    const s = advance(withSiege(15, 40, 32)); // grain 10, morale 27 (grain < 15)
    expect([s.factions.hedong.resources.grain, s.siege.morale, s.siege.pressure]).toEqual([10, 27, 48]);
    expect(mutinyDue(s, config())).toBe(true);
    const r = mutinyBatch(s, 'full', 'let_it_happen');
    expect(r.outcomes[0]).toMatchObject({ status: 'committed', gate: 'decision' });
    expect([r.state.siege.morale, r.state.siege.pressure, r.state.flags.mutinyOccurred]).toEqual([0, 68, true]);
    expect(mutinyDue(r.state, config())).toBe(false);
  });

  it('Harness modes require the decision (H10); urge_payment commits a no-effect event', () => {
    const s = advance(withSiege(15, 40, 32));
    expect(mutinyBatch(s, 'no_judge', null).outcomes[0]).toMatchObject({ status: 'rejected', rule: 'H10' });
    const urged = mutinyBatch(s, 'full', 'urge_payment');
    expect(urged.outcomes[0]?.status).toBe('withheld');
    expect(urged.events.map((e) => e.kind)).toEqual(['mutiny_averted_for_now']);
    expect(urged.events[0]?.changes).toEqual([{ op: 'replace', path: '/version', value: s.version + 1 }]);
    expect(mutinyDue(urged.state, config())).toBe(true); // re-evaluated at the next ADVANCE
  });

  it('baseline commits the outbreak without a gate', () => {
    const s = advance(withSiege(15, 40, 32));
    expect(mutinyBatch(s, 'baseline', null).outcomes[0]).toMatchObject({ status: 'committed', gate: 'ungated' });
  });

  it('a mutiny pushing pressure to 100 makes Jinyang fall', () => {
    const s = advance(withSiege(15, 75, 32)); // pressure 83
    const r = mutinyBatch(s, 'full', 'let_it_happen');
    expect(r.state.terminal).toMatchObject({ kind: 'jinyang_falls', round: 1, detail: { cause: 'pressure' } });
  });

  it('negative fixture: grain 5, morale 30 ⇒ ADVANCE causes the fall ⇒ no mutiny', () => {
    const s = advance(withSiege(5, 40, 30));
    expect(s.terminal?.kind).toBe('jinyang_falls');
    expect(mutinyDue(s, config())).toBe(false);
  });
});

describe('G08 intelligence and G09 relief', () => {
  it('a dispatch on day d sends Li contentless intel arriving d+5', () => {
    const s = dispatched();
    const intel = Object.values(s.messages).find((m) => m.kind === 'intel');
    expect(intel).toMatchObject({ from: 'system', to: LI, sentDay: 0, arrivalDay: 5, payload: { topic: 'envoy_departed', credibility: 0.6 } });
    expect(JSON.stringify(intel?.payload)).not.toContain('aid_cavalry');
  });

  it('confirming aid sets khitanArrivalDay = day + aid_arrival_days', () => {
    const s = batch(delivered(), [prop(YELU, A.confirm('cmt:1', 'offer:1', 1))]).state;
    expect(s.flags.khitanArrivalDay).toBe(25);
  });
});

describe('G12 terminal precedence and conditions', () => {
  it('jinyang_falls wins over pact_concluded when both hold at the end of PREPARE', () => {
    let s = batch(delivered(), [prop(YELU, A.confirm('cmt:1', 'offer:1', 1))]).state;
    s = advance(s);
    const pactOnly = runPrepare(s, config());
    expect(pactOnly.state.terminal?.kind).toBe('pact_concluded');
    s = mutate(s, (x) => {
      x.siege.pressure = 100; // e.g. content-tuned cap reached without an ADVANCE check
    });
    const both = runPrepare(s, config());
    expect(both.state.terminal?.kind).toBe('jinyang_falls');
  });

  it('pact_concluded wins over no_assistance when Yelü accepted before the withdrawal arrived', () => {
    let s = delivered();
    const abandon = prop(SHI, A.abandon());
    const confirm = prop(YELU, A.confirm('cmt:1', 'offer:1', 1));
    const r = batch(s, [abandon, confirm], { decisions: [decide(abandon, 'strategic_turn')] });
    expect(outcomeOf(r, abandon).status).toBe('committed');
    expect(outcomeOf(r, confirm).status).toBe('committed'); // the withdrawal is still in transit
    s = nextRound(r.state);
    expect(s.flags.assistanceAbandoned).toBe(true);
    expect(s.terminal?.kind).toBe('pact_concluded');
  });

  it('no_assistance immediately when abandoning before anything was sent (detail = projection)', () => {
    const abandon = prop(SHI, A.abandon());
    const r = batch(initial(), [abandon], { decisions: [decide(abandon, 'strategic_turn')] });
    expect(r.state.terminal).toMatchObject({ kind: 'no_assistance', round: 1, detail: { projected: true, threads: 0 } });
    expect(r.state.documents['doc:1']?.status).toBe('withdrawn');
    expect(outcomeOf(r, abandon).eventVersions).toHaveLength(2); // the action and the terminal event
  });

  it("no_assistance via abandon_request's automatic rejection (own_action evidence, no acknowledgment)", () => {
    let s = delivered();
    s = batch(s, [prop(YELU, A.counter('offer:1', DOC_TERMS))]).state;
    s = nextRound(s); // Yelü's counter delivered to Shi
    const abandon = prop(SHI, A.abandon());
    const r = batch(s, [abandon], { decisions: [decide(abandon, 'strategic_turn')] });
    expect(r.state.offers['offer:2']?.status).toBe('rejected');
    expect(r.state.terminal).toMatchObject({ kind: 'no_assistance', round: 3 });
    const shiEvidence = Object.values(r.state.knowledge).find((k) => k.holder === SHI && k.subject === 'cmt:1' && k.value === 'rejected');
    expect(shiEvidence?.evidence.kind).toBe('own_action');
  });

  it("talks_failed via Shi's own rejection at that round's ADVANCE, with no acknowledgment message", () => {
    let s = delivered();
    s = batch(s, [prop(YELU, A.counter('offer:1', DOC_TERMS))]).state;
    s = nextRound(s);
    const reject = prop(SHI, A.reject('offer:2'));
    s = batch(s, [reject], { decisions: [decide(reject, 'strategic_turn')] }).state;
    expect(s.terminal).toBeNull();
    expect(evaluateTerminal(s, config(), 'advance')?.kind).toBe('talks_failed');
    const after = runAdvance(s, config());
    expect(after.state.terminal).toMatchObject({ kind: 'talks_failed', round: 3 });
    expect(after.events.map((e) => e.kind)).toEqual(['advance', 'terminal']);
  });

  it('talks_failed without waiting for ADVANCE once the global cap is reached', () => {
    let s = delivered();
    s = batch(s, [prop(YELU, A.reject('offer:1'))]).state;
    s = mutate(s, (x) => {
      x.negotiation['hedong-khitan'].offersTotal = 5;
    });
    s = nextRound(s);
    expect(s.terminal).toMatchObject({ kind: 'talks_failed', detail: { capReached: true } });
  });

  it('the world is frozen after a terminal: PREPARE does nothing and ADVANCE throws', () => {
    const abandon = prop(SHI, A.abandon());
    const s = batch(initial(), [abandon], { decisions: [decide(abandon, 'strategic_turn')] }).state;
    expect(runPrepare(s, config()).events).toEqual([]);
    expect(() => advance(s)).toThrow();
  });
});
