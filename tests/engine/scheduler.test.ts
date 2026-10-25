/** Scene scheduler (PLAN §10.3; content/README.md §5): tiers, cap, fixed tie order, carry-forward, agendas, periodic. */
import { describe, expect, it } from 'vitest';
import { caseCoreConfig, caseInitialState, effectiveCharacter, findCase } from '../../src/content/loader.js';
import { executeBatch } from '../../src/core/execute.js';
import { planPauses } from '../../src/core/plan.js';
import { runAdvance, runPrepare } from '../../src/core/system.js';
import { CHAR_IDS, type CharId, type CoreConfig, type Message, type WorldState } from '../../src/core/types.js';
import { deliveryRound, schedule, type LastActivation, type SchedulerInput, type SchedulerPersona } from '../../src/engine/scheduler.js';
import { content } from './helpers.js';

function personas(caseId: string): Record<CharId, SchedulerPersona> {
  const c = findCase(content(), caseId);
  const out = {} as Record<CharId, SchedulerPersona>;
  for (const id of CHAR_IDS) {
    const p = effectiveCharacter(content(), c, id);
    out[id] = { agendaTriggers: p.agendaTriggers, periodicActivation: p.periodicActivation };
  }
  return out;
}

/** Personas without agendas or periodic activation (isolates tiers 1, 1b and 2). */
function quiet(): Record<CharId, SchedulerPersona> {
  const out = {} as Record<CharId, SchedulerPersona>;
  for (const id of CHAR_IDS) out[id] = { agendaTriggers: [], periodicActivation: null };
  return out;
}

function atRound(state: WorldState, round: number): WorldState {
  return { ...structuredClone(state), round, day: (round - 1) * 5 };
}

let msgSeq = 100;
function letter(to: CharId, arrivalDay: number, sentDay = arrivalDay - 5): Message {
  msgSeq += 1;
  return {
    id: `msg:${msgSeq}`,
    from: 'player',
    to,
    kind: 'letter',
    payload: { kind: 'letter', text: 'news' },
    sentDay,
    arrivalDay,
    sendSeq: msgSeq,
    status: 'delivered',
  };
}

function withMessages(state: WorldState, messages: Message[]): WorldState {
  const s = structuredClone(state);
  for (const m of messages) s.messages[m.id] = m;
  return s;
}

function input(state: WorldState, config: CoreConfig, extra: Partial<SchedulerInput> = {}): SchedulerInput {
  return { state, config, personas: quiet(), addressed: [], lastActivation: {}, events: [], ...extra };
}

describe('scheduler tiers', () => {
  const config = caseCoreConfig(content(), 'C1');
  const base = caseInitialState(content(), 'C1');

  it('five simultaneous candidates: the cap of 4 keeps the fixed tie order and skips the fifth (logged)', () => {
    const state = withMessages(atRound(base, 2), CHAR_IDS.map((c) => letter(c, 5)));
    const r = schedule(input(state, config));
    expect(r.tiers['1b']).toEqual(['shi_jingtang', 'sang_weihan', 'liu_zhiyuan', 'yelu_deguang', 'li_congke']);
    expect(r.active.map((a) => a.charId)).toEqual(['shi_jingtang', 'sang_weihan', 'liu_zhiyuan', 'yelu_deguang']);
    expect(r.active.every((a) => a.tier === '1b' && a.reason.includes('msg:'))).toBe(true);
    expect(r.skipped).toEqual([expect.objectContaining({ charId: 'li_congke', tier: '1b' })]);
    expect(r.skipped[0]?.reason).toMatch(/over the cap of 4/);
  });

  it('a recipient skipped by the cap carries forward and gains precedence next round', () => {
    const r2 = withMessages(atRound(base, 2), CHAR_IDS.map((c) => letter(c, 5)));
    const first = schedule(input(r2, config));
    const last: Partial<Record<CharId, LastActivation>> = {};
    for (const a of first.active) last[a.charId] = { round: 2, version: r2.version };
    // Round 3: fresh letters for the four activated characters; Li's round-2 letter is still pending.
    const r3 = withMessages(atRound(r2, 3), ['shi_jingtang', 'sang_weihan', 'liu_zhiyuan', 'yelu_deguang'].map((c) => letter(c as CharId, 10)));
    const second = schedule(input(r3, config, { lastActivation: last }));
    expect(second.active.map((a) => a.charId)).toEqual(['li_congke', 'shi_jingtang', 'sang_weihan', 'liu_zhiyuan']);
    expect(second.active[0]?.reason).toMatch(/since round 2/);
    expect(second.skipped.map((s) => s.charId)).toEqual(['yelu_deguang']);
    // Once activated, the old letter no longer makes Li a candidate.
    last.li_congke = { round: 3, version: r3.version };
    const third = schedule(input(atRound(r3, 4), config, { lastActivation: last }));
    expect(third.tiers['1b']).not.toContain('li_congke');
  });

  it('a co-located message becomes actionable the round after it is sent', () => {
    expect(deliveryRound({ sentDay: 5, arrivalDay: 5 }, 5)).toBe(3);
    expect(deliveryRound({ sentDay: 0, arrivalDay: 5 }, 5)).toBe(2);
    expect(deliveryRound({ sentDay: 0, arrivalDay: 7 }, 5)).toBe(3);
    const state = withMessages(atRound(base, 2), [letter('sang_weihan', 5, 5)]);
    expect(schedule(input(state, config)).tiers['1b']).toEqual([]);
    expect(schedule(input(atRound(state, 3), config)).tiers['1b']).toEqual(['sang_weihan']);
  });

  it('tier 2: characters addressed by the player, after tier 1b, in the fixed order', () => {
    const state = withMessages(atRound(base, 2), [letter('li_congke', 5)]);
    const r = schedule(input(state, config, { addressed: ['liu_zhiyuan', 'shi_jingtang'] }));
    expect(r.active.map((a) => `${a.charId}:${a.tier}`)).toEqual(['li_congke:1b', 'shi_jingtang:2', 'liu_zhiyuan:2']);
  });

  it('tier 1: the holder of a delivered live offer is always included, even beyond the cap', () => {
    // Shi approves and dispatches (endorsed) → ADVANCE → PREPARE delivers the offer to Yelü on day 5.
    let state = runPrepare(base, config).state;
    const proposals = [
      { proposalId: 'p1', actor: 'shi_jingtang' as const, seq: 1, action: { type: 'approve_document', args: { docId: 'doc:1', docVersion: 1 } }, askPlayer: null },
      { proposalId: 'p2', actor: 'shi_jingtang' as const, seq: 2, action: { type: 'dispatch_document', args: { docId: 'doc:1', docVersion: 1 } }, askPlayer: null },
    ];
    const plan = planPauses(state, { kind: 'character', proposals, decisions: [] }, { config, mode: 'no_judge' });
    const decisions = plan.required.map((r, i) => ({ decisionId: `d${i}`, category: r.category, option: 'endorse' as const, proposalIds: r.proposalIds, pair: r.pair }));
    state = executeBatch(state, { kind: 'character', proposals, decisions }, { config, mode: 'no_judge' }).state;
    state = runPrepare(runAdvance(state, config).state, config).state;
    const withLetters = withMessages(state, ['shi_jingtang', 'sang_weihan', 'liu_zhiyuan', 'li_congke'].map((c) => letter(c as CharId, 5)));
    const r = schedule(input(withLetters, config, { addressed: ['shi_jingtang'] }));
    expect(r.tiers['1']).toEqual(['yelu_deguang']);
    expect(r.active[0]).toEqual(expect.objectContaining({ charId: 'yelu_deguang', tier: '1' }));
    expect(r.active[0]?.reason).toMatch(/offer:1/);
    expect(r.active).toHaveLength(4);
  });

  it('tier 3: agendas fire only for owners at the player\'s scene, per README §5 event semantics', () => {
    const state = atRound(base, 2);
    const all = personas('C1');
    const events = [{ version: 7, kind: 'revise_document' }];
    const s7 = { ...state, version: 7 };
    // Liu's document_revised fires if the revision came after his last activation, not otherwise.
    const fresh = schedule(input(s7, config, { personas: all, events, lastActivation: { liu_zhiyuan: { round: 1, version: 3 } } }));
    expect(fresh.tiers['3']).toContain('liu_zhiyuan');
    const stale = schedule(input(s7, config, { personas: all, events, lastActivation: { liu_zhiyuan: { round: 1, version: 7 } } }));
    expect(stale.tiers['3']).not.toContain('liu_zhiyuan');
    // Sang's round_start agenda fires every round; Yelü (not at the player's scene) is never tier 3.
    expect(fresh.tiers['3']).toContain('sang_weihan');
    const yeluOffer = withMessages(s7, [{ ...letter('yelu_deguang', 5), kind: 'offer' }]);
    const r = schedule(input(yeluOffer, config, { personas: all }));
    expect(r.tiers['3']).not.toContain('yelu_deguang');
    // Threshold agendas compare at SELECT.
    const hungry = structuredClone(s7);
    hungry.factions.hedong.resources.grain = 10;
    expect(schedule(input(hungry, config, { personas: all })).active.find((a) => a.charId === 'shi_jingtang')?.agendaIds.length).toBeGreaterThan(0);
  });

  it('tier 4: Li is periodically active in rounds 1, 3, 5 (never 2, 4, 6)', () => {
    const all = personas('C1');
    const rounds = [1, 2, 3, 4, 5, 6].filter((round) => schedule(input(atRound(base, round), config, { personas: all })).tiers['4'].includes('li_congke'));
    expect(rounds).toEqual([1, 3, 5]);
  });

  it('dead characters are never scheduled', () => {
    const state = withMessages(atRound(base, 2), [letter('liu_zhiyuan', 5)]);
    state.characters.liu_zhiyuan.status = 'dead';
    const r = schedule(input(state, config, { addressed: ['liu_zhiyuan'] }));
    expect(r.active.map((a) => a.charId)).not.toContain('liu_zhiyuan');
  });

  it('is deterministic: the same input gives the same selection', () => {
    const state = withMessages(atRound(base, 2), CHAR_IDS.map((c) => letter(c, 5)));
    const i = input(state, config, { personas: personas('C1'), addressed: ['shi_jingtang'] });
    expect(schedule(i)).toEqual(schedule(structuredClone(i)));
  });
});
