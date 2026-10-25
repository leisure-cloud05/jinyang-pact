/**
 * WP-B2: every reference trace (C1–C6, D1–D3) replays through the pure core (src/core/simulate.ts) with the case's
 * own rules config (`caseCoreConfig`), with no unexpected rejection, reaching its expected terminal in its expected
 * round (≤ 6), and is consistent with
 *   - the §10.3 scene scheduler (all tiers; trace actors are always activated by tiers 1/1b/2 alone, so they do not
 *     depend on the tier-3/4 conventions),
 *   - the case's decision policy (first matching rule),
 *   - the case script (the trace's player inputs are the script's inputs),
 *   - the case's checkpoint annotations (compared with instances derived independently from the run).
 * Per-case invariants are checked on every intermediate world state reconstructed by patch replay.
 */
import { describe, expect, it } from 'vitest';
import { caseInitialState, toTraceSpec } from '../../src/content/loader.js';
import type { TraceConfig } from '../../src/content/schema.js';
import { prepareScriptInputs, type ScriptInputLike } from '../../src/core/script.js';
import { knowsClause } from '../../src/core/knowledge.js';
import { poolClaims } from '../../src/core/obligations.js';
import { simulateTrace, type TraceSpec } from '../../src/core/simulate.js';
import { KHITAN_STANCE_POOL, withinLimits } from '../../src/core/terms.js';
import { CHAR_IDS } from '../../src/core/types.js';
import { MAX_ACTIVE, checkPolicy, deriveCheckpoints, prepareVersion, replay, schedule, selectVersion, type Replay } from './analysis.js';
import { TRACE_IDS, caseConfig, configOf, content } from './helpers.js';

function traceOf(id: string): TraceConfig {
  const t = content().traces[id];
  if (!t) throw new Error(`no trace ${id}`);
  return t;
}

/**
 * The player inputs of a round as the harness applies them (PLAN §12.4): the script inputs whose `when` holds on the
 * player's knowledge after PREPARE, with "$current" resolved; dialogue becomes `speak` with the zh text.
 */
function appliedScript(r: Replay, round: number): { actions: unknown[]; skipped: number[]; probes: number } {
  const inputs = (r.config.script.find((s) => s.round === round)?.inputs ?? []) as unknown as ScriptInputLike[];
  const plan = prepareScriptInputs(r.stateAt(prepareVersion(r, round)), r.cfg, inputs, 'zh');
  return {
    actions: plan.apply.map((a) => (a.kind === 'dialogue' && a.dialogue ? { type: 'speak', args: { to: a.dialogue.to, text: a.dialogue.text } } : a.action)),
    skipped: plan.skipped.map((s) => s.index),
    probes: plan.apply.filter((a) => a.probe).length,
  };
}

/** True if the run reached the PLAYER step of `round` (not terminal at or before PREPARE). */
function reachedPlayer(r: Replay, round: number): boolean {
  // simulateTrace logs at least one character batch for every round that gets past PREPARE.
  return r.run.batches.some((b) => b.round === round && b.kind !== 'system_outcome');
}

function withRounds(id: string, edit: (rounds: TraceSpec['rounds']) => TraceSpec['rounds'], expected: TraceSpec['expected']): TraceSpec {
  const base = toTraceSpec(traceOf(id));
  return { ...base, rounds: edit(base.rounds), expected };
}

describe('reference traces replay through the core', () => {
  for (const id of TRACE_IDS) {
    for (const mode of ['full', 'no_judge'] as const) {
      it(`${id} reaches its expected terminal with exactly the declared rejections (${mode})`, () => {
        const trace = traceOf(id);
        const c = configOf(id);
        const run = simulateTrace(caseInitialState(content(), id), caseConfig(id), toTraceSpec(trace), mode);
        expect(run.mismatches).toEqual([]);
        expect(run.terminal?.kind ?? null).toBe(trace.expected.terminal);
        expect(run.terminal?.round ?? null).toBe(trace.expected.round);
        expect(run.lastRound).toBeLessThanOrEqual(c.max_rounds);
        if (run.terminal) expect(c.valid_terminals).toContain(run.terminal.kind);
        expect(run.state.factions.hedong.resources.grain).toBeGreaterThanOrEqual(0);
        const executed = run.batches.filter(
          (b) => !(b.kind === 'character' && run.batches.some((x) => x.round === b.round && x.kind === 'character' && x.generation > b.generation)),
        );
        const rejected = executed.flatMap((b) => b.outcomes).filter((o) => o.status === 'rejected');
        const declared = trace.rounds
          .flatMap((r) => [...r.player, ...r.proposals, ...r.regenerations.flatMap((g) => g.proposals)])
          .filter((p) => p.expect?.status === 'rejected');
        expect(rejected.length).toBe(declared.length);
      });
    }
  }
});

describe('reference traces respect the §10.3 scene scheduler', () => {
  for (const id of TRACE_IDS) {
    it(`${id}: every acting character is activated, by tiers 1/1b/2 alone (cap ${MAX_ACTIVE})`, () => {
      const r = replay(id);
      const scheduled = schedule(r);
      for (const spec of r.spec.rounds) {
        const sched = scheduled.get(spec.round);
        for (const gen of [{ proposals: spec.proposals }, ...spec.regenerations]) {
          for (const p of gen.proposals) {
            if (p.actor === 'player' || p.actor === 'system') continue;
            expect(sched?.selected, `${id} R${spec.round}: ${p.actor} not scheduled (${JSON.stringify(sched?.tiers)})`).toContain(p.actor);
            const robust = [...(sched?.tiers.t1 ?? []), ...(sched?.tiers.t1b ?? []), ...(sched?.tiers.t2 ?? [])];
            expect(robust, `${id} R${spec.round}: ${p.actor} relies on tier 3/4`).toContain(p.actor);
          }
        }
        if (sched) expect(sched.selected.length).toBeLessThanOrEqual(MAX_ACTIVE);
      }
    });
  }

  it('derives the expected tiers in known rounds (all tiers)', () => {
    const c1 = schedule(replay('C1'));
    // R1: Shi and Sang addressed; Sang's round_start agenda; Li's periodic activation (rounds 1, 3, 5).
    expect(c1.get(1)?.tiers).toMatchObject({ t1: [], t1b: [], t2: ['shi_jingtang', 'sang_weihan'], t4: ['li_congke'] });
    expect(c1.get(1)?.selected).toContain('li_congke');
    // R2: Yelü holds the delivered offer (tier 1); Li received the G08 intelligence (tier 1b).
    expect(c1.get(2)?.tiers).toMatchObject({ t1: ['yelu_deguang'], t1b: ['li_congke'] });
    expect(schedule(replay('C3')).get(5)?.tiers.t1b).toEqual(['shi_jingtang']);
  });

  it('negative fixtures: a character that no tier activates is not selected', () => {
    const c1 = schedule(replay('C1'));
    // Yelü in R1: nothing delivered, not at the player's scene, no periodic activation.
    expect(c1.get(1)?.selected).not.toContain('yelu_deguang');
    // Li in R2 of C5: no delivery (nothing is ever sent), not addressed, not at the scene, even round.
    expect(schedule(replay('C5')).get(2)?.selected).not.toContain('li_congke');
  });
});

describe('reference traces agree with their case', () => {
  for (const id of TRACE_IDS) {
    it(`${id}: every decision is the case policy's first-match choice and states its category`, () => {
      expect(checkPolicy(replay(id))).toEqual([]);
    });

    it(`${id}: the trace's player inputs are exactly the script inputs that apply (when / "$current"), no probes`, () => {
      const r = replay(id);
      const trace = traceOf(id);
      for (let round = 1; round <= r.spec.max_rounds; round++) {
        const traced = trace.rounds.find((t) => t.round === round)?.player.map((p) => p.action) ?? [];
        if (!reachedPlayer(r, round)) {
          expect(traced, `${id} R${round} is never reached`).toEqual([]);
          continue;
        }
        const applied = appliedScript(r, round);
        expect(traced, `${id} R${round}`).toEqual(applied.actions);
        expect(applied.probes, `${id} R${round}: probes belong in programmatic fixtures`).toBe(0);
      }
    });

    it(`${id}: expected_checkpoints equal the checkpoint instances derived from the reference run`, () => {
      const derived = deriveCheckpoints(replay(id)).map((i) => `${i.type}|R${i.round}|${i.object}`).sort();
      const annotated = configOf(id).expected_checkpoints.map((e) => `${e.type}|R${e.round}|${e.object}`).sort();
      expect(annotated).toEqual(derived);
    });
  }
});

describe('trajectory-robust scripts (PLAN §12.4): delayed replies and intervening revisions', () => {
  const wait = { ref: 'wait', actor: 'yelu_deguang' as const, action: { type: 'wait', args: {} }, ask_player: null, expect: null };

  /** The reference trace up to `lastRound`, with Yelü waiting instead of answering in `waitRound`. */
  function delayed(id: string, waitRound: number, lastRound: number): TraceSpec {
    const base = toTraceSpec(traceOf(id));
    const rounds = base.rounds
      .filter((x) => x.round <= lastRound)
      .map((x) => (x.round === waitRound ? { ...x, proposals: [...x.proposals.filter((p) => p.actor !== 'yelu_deguang'), wait], decisions: [] } : x));
    return { ...base, rounds, max_rounds: lastRound + 1, expected: { terminal: null, round: null } };
  }

  it('C3: if Yelü has not answered by R3, the "answer has come" dialogue is skipped and the waiting one applies', () => {
    const r = replay('C3', delayed('C3', 2, 2));
    expect(r.run.mismatches).toEqual([]);
    const applied = appliedScript(r, 3);
    expect(applied.skipped).toEqual([0]);
    expect(applied.actions).toEqual([{ type: 'speak', args: { to: ['shi_jingtang'], text: '北使尚无回音。契丹若索地，宁增岁帛，不可割地。' } }]);
    // On the reference trajectory the answer has arrived: the other input applies.
    expect(appliedScript(replay('C3'), 3).skipped).toEqual([1]);
  });

  it('D2: if Yelü has not answered by R3, no dialogue asserts that he did', () => {
    const r = replay('D2', delayed('D2', 2, 2));
    expect(r.run.mismatches).toEqual([]);
    expect(appliedScript(r, 3).actions).toEqual([]);
  });

  it('C4: while Yelü is still weighing both bids at R3, the "no word yet" dialogue applies', () => {
    const r = replay('C4', delayed('C4', 2, 2));
    expect(r.run.mismatches).toEqual([]);
    expect(appliedScript(r, 3).actions).toHaveLength(1);
    expect(reachedPlayer(replay('C4'), 3)).toBe(false); // reference: the pact is concluded at R3's PREPARE
  });

  it('C1/C2/C4: dialogue that says the envoy has gone applies only once the request was sent', () => {
    // C2 R1 keeps the draft on hold for two rounds; if Shi never dispatches, the R3 dialogue is skipped.
    const base = toTraceSpec(traceOf('C2'));
    const spec: TraceSpec = {
      ...base,
      rounds: base.rounds.filter((x) => x.round <= 2).map((x) => (x.round === 2 ? { ...x, proposals: [], decisions: [] } : x)),
      max_rounds: 3,
      expected: { terminal: null, round: null },
    };
    const r = replay('C2', spec);
    expect(r.run.mismatches).toEqual([]);
    expect(appliedScript(r, 3)).toMatchObject({ actions: [], skipped: [0] });
  });

  it('C6: a revision by Sang in R1 does not make the scripted repair stale — it binds to the version the player sees', () => {
    const base = toTraceSpec(traceOf('C6'));
    const sangRevise = {
      ref: 'sang_revise',
      actor: 'sang_weihan' as const,
      action: {
        type: 'revise_document',
        args: {
          docId: 'doc:1',
          baseDocVersion: 1,
          terms: { vassal: true, filial: false, cession: 'none', annual_silk: 0, immediate_silk: 60000, aid_cavalry: 30000, aid_arrival_days: 15, neutrality: false, marriage_alliance: false, secret_clauses: [] },
          note: '桑维翰改为即奉帛六万匹。',
        },
      },
      ask_player: null,
      expect: null,
    };
    const r1Only = { ...base, rounds: base.rounds.filter((x) => x.round === 1).map((x) => ({ ...x, proposals: [...x.proposals, sangRevise] })), max_rounds: 2, expected: { terminal: null, round: null } };
    const first = replay('C6', r1Only);
    expect(first.run.mismatches).toEqual([]);
    const applied = appliedScript(first, 2);
    const revise = applied.actions[0] as { type: string; args: { baseDocVersion: number } };
    expect(revise.type).toBe('revise_document');
    expect(revise.args.baseDocVersion).toBe(2); // not the stale 1 of the reference trajectory
    // The whole variant still reaches a valid terminal: v3 is approved, dispatched and accepted.
    const rounds = base.rounds.map((x) => {
      if (x.round === 1) return { ...x, proposals: [...x.proposals, sangRevise] };
      if (x.round !== 2) return x;
      return {
        ...x,
        player: applied.actions.map((action) => ({ action, expect: null })),
        proposals: x.proposals.map((p) => {
          const a = p.action as { type: string; args: Record<string, unknown> };
          return a.type === 'approve_document' || a.type === 'dispatch_document' ? { ...p, action: { ...a, args: { ...a.args, docVersion: 3 } } } : p;
        }),
      };
    });
    const full = replay('C6', { ...base, rounds, expected: { terminal: 'pact_concluded', round: 4 } });
    expect(full.run.mismatches).toEqual([]);
    expect(full.run.state.offers['offer:1']?.terms.immediate_silk).toBe(40000);
  });
});

describe('re-review fixes (review 16 in docs/review_log.md)', () => {
  const noop = (actor: 'shi_jingtang' | 'yelu_deguang') => ({ ref: null, actor, action: { type: 'wait', args: {} }, ask_player: null, expect: null });
  const say = (to: string[], text: string) => ({ action: { type: 'speak', args: { to, text } }, expect: null });

  it('9: no evaluation case (C1–C6) carries an enforcement probe; probes live in programmatic fixtures only', () => {
    for (const id of ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']) {
      for (const s of configOf(id).script) for (const input of s.inputs) expect(input.probe ?? false, `${id} R${s.round}`).toBe(false);
    }
  });

  it('10: D3\'s amendment binds to the visible version — an intervening revision by Sang before the first dispatch pause', () => {
    const policyAmend = configOf('D3').decision_policy.find((p) => p.choose === 'amend')?.amend;
    expect(policyAmend?.baseDocVersion).toBe('$current');
    expect(traceOf('D3').rounds[0]?.decisions[0]?.amend).toEqual(policyAmend); // the trace uses exactly the policy's payload
    const base = toTraceSpec(traceOf('D3'));
    const r1 = base.rounds.find((x) => x.round === 1);
    const r2 = base.rounds.find((x) => x.round === 2);
    if (!r1 || !r2) throw new Error('D3 trace shape');
    const sangRevise = {
      ref: 'sang_revise',
      actor: 'sang_weihan' as const,
      action: {
        type: 'revise_document',
        args: {
          docId: 'doc:1',
          baseDocVersion: 1,
          terms: { vassal: true, filial: true, cession: 'yanmen_north', annual_silk: 0, immediate_silk: 100000, aid_cavalry: 30000, aid_arrival_days: 20, neutrality: false, marriage_alliance: false, secret_clauses: [] },
          note: '桑维翰润色。',
        },
      },
      ask_player: null,
      expect: null,
    };
    const bump = (gen: { proposals: TraceSpec['rounds'][number]['proposals'] }, v: number) =>
      gen.proposals.map((p) => {
        const a = p.action as { type: string; args: Record<string, unknown> };
        return { ...p, action: { ...a, args: { ...a.args, docVersion: v } } };
      });
    const spec: TraceSpec = {
      ...base,
      max_rounds: 4,
      rounds: [
        { ...r1, proposals: [noop('shi_jingtang'), sangRevise], decisions: [], regenerations: [] }, // v2, still 100,000 bolts
        { ...r1, round: 2, player: [], proposals: bump(r1, 2), regenerations: r1.regenerations.map((g) => ({ ...g, proposals: bump(g, 3) })) },
        { ...r2, round: 3 },
      ],
      expected: { terminal: 'pact_concluded', round: 4 },
    };
    const r = replay('D3', spec);
    expect(r.run.mismatches).toEqual([]);
    const amendEvent = r.run.events.find((e) => e.kind === 'revise_document' && e.actor === 'player');
    expect(r.stateAt(amendEvent?.version ?? 0).documents['doc:1']?.version).toBe(3); // amended v2, not the stale v1
    expect(r.run.state.offers['offer:1']?.terms.immediate_silk).toBe(50000);
  });

  it('2: C4 without overlap — Yelü settles the Tang bid in R2 before Hedong dispatches in R3 ⇒ valid talks_failed in R5, no exposure', () => {
    const base = toTraceSpec(traceOf('C4'));
    const r1 = base.rounds.find((x) => x.round === 1);
    if (!r1) throw new Error('C4 trace shape');
    const spec: TraceSpec = {
      ...base,
      rounds: [
        { ...r1, proposals: [noop('shi_jingtang')], decisions: [] },
        {
          round: 2, player: [], decisions: [], regenerations: [], mutiny: null,
          proposals: [{ ref: 'confirm_tang', actor: 'yelu_deguang', action: { type: 'confirm_commitment', args: { commitmentId: 'cmt:1', offerId: 'offer:1', termsVersion: 1 } }, ask_player: null, expect: null }],
        },
        { ...r1, round: 3, player: [say(['shi_jingtang'], '契丹尚无回音，宜静观其变。')] },
        {
          round: 4, player: [say(['sang_weihan'], '桑公，若洛阳亦遣使北去，契丹将何所择？')], decisions: [], regenerations: [], mutiny: null,
          proposals: [{ ref: 'reject_hedong', actor: 'yelu_deguang', action: { type: 'respond_to_offer', args: { offerId: 'offer:2', response: 'reject', counterTerms: null, reason: '已许唐廷中立，不可两从。' } }, ask_player: null, expect: null }],
        },
      ],
      expected: { terminal: 'talks_failed', round: 5 },
    };
    const r = replay('C4', spec);
    expect(r.run.mismatches).toEqual([]);
    expect(configOf('C4').valid_terminals).toContain(r.run.terminal?.kind);
    for (const round of [1, 2, 3, 4]) expect(appliedScript(r, round).actions, `R${round}`).toEqual(spec.rounds.find((x) => x.round === round)?.player.map((p) => p.action));
    // Conflict exposure never happens: no SELECT state has live delivered offers of both pairs before Yelü.
    for (let round = 1; round <= 5; round++) {
      const s = r.stateAt(selectVersion(r, round));
      const pairs = Object.values(s.commitments)
        .filter((t) => t.status === 'negotiating' && s.offers[t.liveOfferId]?.to === 'yelu_deguang' && s.offers[t.liveOfferId]?.status === 'delivered')
        .map((t) => t.pair);
      expect(pairs.length, `R${round}`).toBeLessThan(2);
    }
  });

  it('7: checkpoint instances survive the removal of every control record (batches, pauses, decisions, outcomes)', () => {
    for (const id of TRACE_IDS) {
      const r = replay(id);
      const derived = deriveCheckpoints(r);
      const stripped: Replay = { ...r, run: { ...r.run, batches: [] } };
      expect(deriveCheckpoints(stripped), id).toEqual(derived);
      const noPauses: Replay = { ...r, run: { ...r.run, batches: r.run.batches.filter((b) => b.kind !== 'system_outcome').map((b) => ({ ...b, pauses: [], decisions: [] })) } };
      expect(deriveCheckpoints(noPauses), id).toEqual(derived);
    }
    expect(deriveCheckpoints({ ...replay('C5'), run: { ...replay('C5').run, batches: [] } }).map((i) => i.type)).toContain('mutiny');
    expect(deriveCheckpoints({ ...replay('C3'), run: { ...replay('C3').run, batches: [] } }).map((i) => i.type)).toContain('negotiation_deadlock');
  });

  it('7: a missing mutiny decision record is detectable — the instance exists while the control log has no decision for it', () => {
    const r = replay('C5');
    const mutiny = deriveCheckpoints(r).find((i) => i.type === 'mutiny');
    const mutated = r.run.batches.filter((b) => b.kind !== 'system_outcome'); // decision record removed
    const decided = mutated.some((b) => b.round === mutiny?.round && b.decisions.some((d) => d.category === 'mutiny'));
    expect(mutiny?.round).toBe(3);
    expect(decided).toBe(false); // an oracle comparing instances with decisions would flag this run
  });
});

describe('case-specific invariants on every world version', () => {
  it('C1: the dispatch is paused (dispatch_request) and the pact follows Shi\'s receipt of the acceptance', () => {
    const r = replay('C1');
    const r1 = r.run.batches.find((b) => b.round === 1 && b.kind === 'character');
    expect(r1?.pauses.map((p) => p.category)).toEqual(['dispatch_request']);
    expect(r.run.terminal).toMatchObject({ kind: 'pact_concluded', round: 3, detail: { confirmedDay: 5, khitanArrivalDay: 20 } });
  });

  it('C2: no dispatch while delayed; Li learns only that an envoy left, five days after dispatch', () => {
    const r = replay('C2');
    expect(r.run.events.find((e) => e.kind === 'dispatch_document')?.round).toBe(2);
    const intel = Object.values(r.run.state.messages).find((m) => m.kind === 'intel');
    expect(intel?.to).toBe('li_congke');
    expect((intel?.arrivalDay ?? 0) - (intel?.sentDay ?? 0)).toBe(5);
    expect(Object.values(r.run.state.knowledge).some((k) => k.holder === 'li_congke' && k.subject.startsWith('offer:'))).toBe(false);
    expect(r.run.state.siege.pressure).toBe(88);
  });

  it('C3: counters use the whole segment, the deadlock pause comes at R5, urge_stop opens segment 2, talks fail', () => {
    const r = replay('C3');
    const r5 = r.run.batches.filter((b) => b.round === 5);
    expect(r5.map((b) => `${b.kind}:${b.generation}`)).toEqual(['player:0', 'character:0', 'player:0', 'character:1']);
    expect(r5[1]?.pauses.map((p) => p.category)).toEqual(['negotiation_deadlock']);
    expect(r.run.state.negotiation['hedong-khitan']).toMatchObject({ segment: 2, roundsInSegment: 0, offersTotal: 3, deadlockPending: false });
    const offers = Object.values(r.run.state.offers);
    expect(offers.map((o) => o.segmentRound)).toEqual([0, 1, 2]);
    for (const o of offers.filter((x) => x.from === 'shi_jingtang')) {
      expect(withinLimits(o.terms, r.run.state.player.goal.limits, r.cfg.catalog, 'hedong-khitan').ok).toBe(true);
    }
  });

  it('C3 alternative branch: if Yelü confirms at R4 the pact is concluded at R5', () => {
    const spec = withRounds(
      'C3',
      (rounds) =>
        rounds
          .filter((x) => x.round <= 4)
          .map((x) =>
            x.round === 4
              ? { ...x, proposals: [{ ref: 'confirm', actor: 'yelu_deguang' as const, action: { type: 'confirm_commitment', args: { commitmentId: 'cmt:1', offerId: 'offer:3', termsVersion: 3 } }, ask_player: null, expect: null }] }
              : x,
          ),
      { terminal: 'pact_concluded', round: 5 },
    );
    const run = simulateTrace(caseInitialState(content(), 'C3'), caseConfig('C3'), spec, 'full');
    expect(run.mismatches).toEqual([]);
    expect(configOf('C3').valid_terminals).toContain(run.terminal?.kind);
  });

  it('C4: the secret article never reaches Li, Liu or the player; khitan_stance backs one obligation; Hedong never learns the Tang bid', () => {
    const r = replay('C4');
    expect(r.cfg.catalog.secretClauses.sc_treasury_share?.knownBy).toEqual(['shi_jingtang', 'sang_weihan']);
    const tangThreads = Object.values(r.run.state.commitments).filter((t) => t.pair === 'khitan-tang').map((t) => t.id);
    const tangOffers = Object.values(r.run.state.offers).filter((o) => tangThreads.includes(o.commitmentId)).map((o) => o.id);
    expect(tangThreads).toHaveLength(1);
    for (let v = 0; v <= r.run.state.version; v++) {
      const s = r.stateAt(v);
      for (const holder of ['li_congke', 'liu_zhiyuan', 'player'] as const) expect(knowsClause(s, r.cfg, holder, 'sc_treasury_share'), `v${v} ${holder}`).toBe(false);
      expect(poolClaims(s, KHITAN_STANCE_POOL).length, `v${v}`).toBeLessThanOrEqual(1);
      const leaked = Object.values(s.knowledge).some(
        (k) => ['shi_jingtang', 'sang_weihan', 'liu_zhiyuan', 'player'].includes(k.holder) && [...tangThreads, ...tangOffers].includes(k.subject),
      );
      expect(leaked, `v${v}`).toBe(false);
    }
    expect(knowsClause(r.run.state, r.cfg, 'yelu_deguang', 'sc_treasury_share')).toBe(true); // learned by receipt
    // The clause is known to nobody a priori in any other config.
    for (const id of TRACE_IDS.filter((x) => x !== 'C4')) expect(caseConfig(id).catalog.secretClauses.sc_treasury_share?.knownBy, id).toEqual([]);
  });

  it('C5: the reference run exercises the mutiny pause (urge_payment) before any fall; no_assistance carries the projection', () => {
    const r = replay('C5');
    const outcome = r.run.batches.find((b) => b.kind === 'system_outcome');
    expect(outcome?.round).toBe(3);
    expect(outcome?.decisions.map((d) => d.option)).toEqual(['urge_payment']);
    expect(r.run.events.some((e) => e.kind === 'mutiny_outbreak')).toBe(false);
    const averted = r.run.events.find((e) => e.kind === 'mutiny_averted_for_now');
    const atMutiny = r.stateAt((averted?.version ?? 1) - 1);
    expect(atMutiny.terminal).toBeNull();
    expect(atMutiny.factions.hedong.resources.grain).toBe(7);
    expect(atMutiny.siege.morale).toBe(30);
    expect(r.run.terminal).toMatchObject({ kind: 'no_assistance', round: 4, detail: { projected: true, fallDay: 25, fallCause: 'grain' } });
    expect(r.run.events.some((e) => e.kind === 'dispatch_document')).toBe(false);
    expect(r.run.state.documents['doc:1']?.status).toBe('withdrawn');
  });

  it('C5 alternative branch: paying the troops at R3 prevents the mutiny — a valid run in which the conditional mutiny constraint is not exercised', () => {
    const spec = withRounds(
      'C5',
      (rounds) =>
        rounds.map((x) =>
          x.round === 3
            ? {
                ...x,
                mutiny: null,
                proposals: [{ ref: 'pay', actor: 'shi_jingtang' as const, action: { type: 'allocate_resources', args: { faction: 'hedong', resource: 'silk', amount: 50000, purpose: 'pay_troops' } }, ask_player: null, expect: null }],
              }
            : x.round === 4
              ? { ...x, proposals: x.proposals.filter((p) => (p.action as { type: string }).type === 'abandon_request') }
              : x,
        ),
      { terminal: 'no_assistance', round: 4 },
    );
    const r = replay('C5', spec);
    expect(r.run.mismatches).toEqual([]);
    expect(r.run.batches.some((b) => b.kind === 'system_outcome')).toBe(false);
    expect(deriveCheckpoints(r).some((i) => i.type === 'mutiny')).toBe(false);
    expect(configOf('C5').valid_terminals).toContain(r.run.terminal?.kind);
    const mutinyConstraint = configOf('C5').constraints.find((c) => c.id === 'c5-mutiny');
    expect(mutinyConstraint?.kind).toBe('checkpoint_decided_if_occurs');
  });

  it('C6: overdraft and on-behalf attempts by characters are rejected with the right rules; no balance ever goes negative', () => {
    const r = replay('C6');
    const rejected = r.run.batches.flatMap((b) => b.outcomes.filter((o) => o.status === 'rejected').map((o) => `${b.round}:${o.actor}:${o.rule}`));
    expect(rejected.sort()).toEqual(['1:sang_weihan:H02', '1:sang_weihan:H02', '1:shi_jingtang:H07', '1:shi_jingtang:H07', '2:shi_jingtang:H09'].sort());
    for (let v = 0; v <= r.run.state.version; v++) {
      const s = r.stateAt(v);
      for (const f of Object.values(s.factions)) {
        for (const [key, amount] of Object.entries(f.resources)) expect(amount - (f.reserved as Record<string, number>)[key]!, `v${v}`).toBeGreaterThanOrEqual(0);
      }
    }
    const consent = r.run.state.commitments['cmt:1']?.consents;
    expect(consent?.shi_jingtang?.by).toBe('shi_jingtang');
    expect(consent?.yelu_deguang?.by).toBe('yelu_deguang');
    // No scripted player action in the live case is an enforcement probe (PLAN §12.4); see probes.test.ts.
    expect(configOf('C6').script.flatMap((s) => s.inputs).some((i) => 'action' in i && (i.action as { type: string }).type === 'dispatch_document')).toBe(false);
  });

  it('D3: the amend obsoletes the paused batch and the regenerated dispatch is of version 2', () => {
    const r = replay('D3');
    const r1 = r.run.batches.filter((b) => b.round === 1);
    expect(r1.map((b) => `${b.kind}:${b.generation}`)).toEqual(['player:0', 'character:0', 'player:0', 'character:1']);
    const dispatch = r.run.events.find((e) => e.kind === 'dispatch_document');
    expect(r.stateAt(dispatch?.version ?? 0).documents['doc:1']?.version).toBe(2);
    expect(r.run.state.offers['offer:1']?.terms.immediate_silk).toBe(50000);
  });

  it('every character exists in every configuration (five-character cast)', () => {
    for (const id of TRACE_IDS) for (const c of CHAR_IDS) expect(caseInitialState(content(), id).characters[c].status).toBe('alive');
  });
});
