/** Regression tests for the Codex review of WP-A Phase 1 (review 13 in docs/review_log.md, findings 1–8). */
import { describe, expect, it } from 'vitest';
import { caseInitialState, toTraceSpec, validateContent } from '../../src/content/loader.js';
import { GENERIC_FEEDBACK } from '../../src/core/feedback.js';
import { knowsClause, playerView } from '../../src/core/knowledge.js';
import { optionsForPause } from '../../src/core/pauses.js';
import { planPauses } from '../../src/core/plan.js';
import { PatchError, applyPatch } from '../../src/core/reducer.js';
import { validate } from '../../src/core/rules.js';
import { simulateTrace } from '../../src/core/simulate.js';
import type { ActorId, WorldState } from '../../src/core/types.js';
import {
  A,
  DOC_TERMS,
  LI,
  SANG,
  SHI,
  T,
  YELU,
  batch,
  config,
  decide,
  delivered,
  dispatched,
  endorsed,
  fixture,
  initial,
  mutate,
  nextRound,
  outcomeOf,
  prop,
} from './helpers.js';

const CANARY = 'JYP-CANARY-7F3A';
const check = (s: WorldState, actor: ActorId, action: unknown) => validate(s, { actor, action }, { config: config(), mode: 'full' });

describe('#1 no prototype traversal', () => {
  it('rejects prototype-like ids as malformed (H01) without polluting Object.prototype', () => {
    const revoke = prop('player', A.revoke('__proto__'));
    const r = batch(initial(), [revoke], { kind: 'player' });
    expect(outcomeOf(r, revoke)).toMatchObject({ status: 'rejected', rule: 'H01' });
    expect((Object.prototype as Record<string, unknown>).revoked).toBeUndefined();
    const approve = prop(SHI, A.approve(1, 'toString'));
    expect(outcomeOf(batch(initial(), [approve]), approve)).toMatchObject({ status: 'rejected', rule: 'H01' });
  });

  it('baseline records such attempts as unapplied instead of throwing', () => {
    const revoke = prop('player', A.revoke('__proto__'));
    const approve = prop(SHI, A.approve(1, 'toString'));
    const r = batch(initial(), [revoke, approve], { mode: 'baseline' });
    expect(outcomeOf(r, revoke).status).toBe('unapplied');
    expect(outcomeOf(r, approve).status).toBe('unapplied');
    expect((Object.prototype as Record<string, unknown>).revoked).toBeUndefined();
  });

  it('well-formed ids naming inherited members resolve to nothing (own-property lookups)', () => {
    const clause = prop(SANG, A.revise(1, { ...DOC_TERMS, secret_clauses: ['constructor'] }));
    expect(outcomeOf(batch(initial(), [clause]), clause)).toMatchObject({ status: 'rejected', rule: 'H08' });
    expect(outcomeOf(batch(initial(), [clause], { mode: 'baseline' }), clause).status).toBe('unapplied');
    expect(knowsClause(initial(), config(), SANG, 'toString')).toBe(false);
  });

  it('the reducer refuses prototype path segments', () => {
    for (const path of ['/__proto__/revoked', '/a/constructor', '/prototype']) {
      expect(() => applyPatch({ a: {} }, [{ op: 'add', path, value: true }])).toThrow(PatchError);
    }
    expect((Object.prototype as Record<string, unknown>).revoked).toBeUndefined();
  });
});

describe('#2 transmitting a document never grants hidden clauses', () => {
  const approvedFx3 = () => batch(caseInitialState(fixture(), 'FX3'), [prop(SHI, A.approve())]).state;
  const playerKnowledge = (s: WorldState) => JSON.stringify(Object.values(s.knowledge).filter((k) => k.holder === 'player'));

  it('player dispatch: the player does not learn the secret clause', () => {
    const s = approvedFx3();
    expect(knowsClause(s, config(), 'player', 'sc_private_tribute')).toBe(false);
    const send = prop('player', A.dispatch());
    const r = batch(s, [send], { kind: 'player' });
    expect(outcomeOf(r, send).status).toBe('committed');
    expect(knowsClause(r.state, config(), 'player', 'sc_private_tribute')).toBe(false);
    expect(playerKnowledge(r.state)).not.toContain(CANARY);
    expect(JSON.stringify(playerView(r.state, config()))).not.toContain(CANARY);
    // Shi, the consenting party, holds the full terms.
    expect(JSON.stringify(Object.values(r.state.knowledge).filter((k) => k.holder === SHI && k.subject === 'offer:1'))).toContain(CANARY);
  });

  it('Shi dispatch: readers (player, Liu) see filtered terms', () => {
    const r = endorsed(approvedFx3(), [prop(SHI, A.dispatch())]);
    expect(playerKnowledge(r.state)).not.toContain(CANARY);
    expect(knowsClause(r.state, config(), 'liu_zhiyuan', 'sc_private_tribute')).toBe(false);
  });
});

describe('#3 withheld or invalid confirmations do not suppress the exhaustion checkpoint', () => {
  function awaitingShi(): WorldState {
    const t = (extra: Partial<Parameters<typeof T>[0]> = {}) => T({ vassal: true, immediate_silk: 50000, aid_cavalry: 30000, aid_arrival_days: 20, ...extra });
    let s = batch(initial(), [prop(YELU, A.propose(SHI, t({ filial: true })))]).state;
    s = nextRound(s);
    const c1 = prop(SHI, A.counter('offer:1', t()));
    s = batch(s, [c1], { decisions: [decide(c1, 'major_commitment')] }).state;
    s = nextRound(s);
    s = batch(s, [prop(YELU, A.counter('offer:2', t({ cession: 'yanmen_north' })))]).state;
    return nextRound(s);
  }
  const categories = (s: WorldState, proposals: ReturnType<typeof prop>[], decisions: ReturnType<typeof decide>[] = []) =>
    planPauses(s, { kind: 'character', proposals, decisions }, { config: config(), mode: 'full' }).required.map((r) => r.category);

  it('a withheld confirmation leaves Shi to move: the deadlock pause is required', () => {
    const s = awaitingShi();
    const confirm = prop(SHI, A.confirm('cmt:1', 'offer:3', 3));
    expect(categories(s, [confirm])).toEqual(['major_commitment']);
    expect(categories(s, [confirm], [decide(confirm, 'major_commitment', 'withhold')])).toEqual(['negotiation_deadlock']);
  });

  it('a confirmation with the wrong termsVersion (H04) does not suppress it either', () => {
    const s = awaitingShi();
    const wrong = prop(SHI, A.confirm('cmt:1', 'offer:3', 999));
    const plan = planPauses(s, { kind: 'character', proposals: [wrong], decisions: [] }, { config: config(), mode: 'full' });
    expect(plan.rejected).toEqual([{ proposalId: wrong.proposalId, rule: 'H04' }]);
    expect(plan.required.map((r) => r.category)).toEqual(['negotiation_deadlock']);
  });
});

describe('#4 the player view shows only what the player knows', () => {
  it('no negotiation counters before the player has any assertion about an offer', () => {
    const s = batch(initial(), [prop(YELU, A.propose(SHI, T({ vassal: true, aid_cavalry: 20000, aid_arrival_days: 20 })))]).state;
    expect(s.negotiation['hedong-khitan'].offersTotal).toBe(1);
    expect(playerView(s, config()).negotiation).toEqual({ offers: [], segment: 0, roundsUsed: 0 });
    const after = nextRound(s); // delivered to Shi; the player observes his correspondence
    expect(playerView(after, config()).negotiation).toMatchObject({ segment: 1, roundsUsed: 0, offers: [{ offerId: 'offer:1', believedStatus: 'delivered' }] });
  });

  it('documents whose holder is elsewhere are not shown', () => {
    const away = mutate(initial(), (x) => {
      x.characters.shi_jingtang.location = 'khitan_court';
    });
    expect(playerView(initial(), config()).documents).toHaveLength(1);
    expect(playerView(away, config()).documents).toEqual([]);
  });
});

describe('#5 abandon_request checks the world for a confirmed thread', () => {
  it('rejects abandonment after Yelü confirmed, with redacted feedback while Shi has no evidence', () => {
    const s = batch(delivered(), [prop(YELU, A.confirm('cmt:1', 'offer:1', 1))]).state;
    const r = check(s, SHI, A.abandon());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.rule).toBe('H04');
      expect(r.feedback).toBe(GENERIC_FEEDBACK);
      expect(r.reason).toContain('cmt:1');
    }
  });

  it('keeps the race: abandonment first, acceptance before the withdrawal arrives ⇒ the pact stands', () => {
    const abandon = prop(SHI, A.abandon());
    const confirm = prop(YELU, A.confirm('cmt:1', 'offer:1', 1));
    const r = batch(delivered(), [abandon, confirm], { decisions: [decide(abandon, 'strategic_turn')] });
    expect(outcomeOf(r, abandon).status).toBe('committed');
    expect(outcomeOf(r, confirm).status).toBe('committed');
    expect(nextRound(r.state).terminal?.kind).toBe('pact_concluded');
  });
});

describe('#6 rejection feedback never reveals whether a hidden object exists', () => {
  const pairs: Array<[string, ActorId, unknown]> = [
    ['confirm', LI, A.confirm('cmt:1', 'offer:1', 1)],
    ['reject', LI, A.reject('offer:1')],
    ['counter', LI, A.counter('offer:1', DOC_TERMS)],
    ['withdraw', LI, A.withdraw('offer:1')],
    ['confirm before arrival', YELU, A.confirm('cmt:1', 'offer:1', 1)],
  ];
  for (const [name, actor, action] of pairs) {
    it(`${name}: identical generic feedback whether or not the referenced offer exists`, () => {
      const absent = check(initial(), actor, action);
      const present = check(dispatched(), actor, action);
      expect(absent.ok || present.ok).toBe(false);
      if (!absent.ok && !present.ok) {
        expect(absent.feedback).toBe(GENERIC_FEEDBACK);
        expect(present.feedback).toBe(GENERIC_FEEDBACK);
        expect(absent.redacted && present.redacted).toBe(true);
      }
    });
  }

  it('documents: a nonexistent and an inaccessible document get the same feedback', () => {
    const withHidden = mutate(initial(), (x) => {
      const doc = structuredClone(x.documents['doc:1']);
      if (!doc) throw new Error('doc missing');
      x.documents['doc:2'] = { ...doc, id: 'doc:2', accessibleBy: [SHI] };
    });
    const action = A.revise(1, DOC_TERMS, 'n', 'doc:2');
    const absent = check(initial(), SANG, action);
    const present = check(withHidden, SANG, action);
    expect(!absent.ok && absent.feedback).toBe(GENERIC_FEEDBACK);
    expect(!present.ok && present.feedback).toBe(GENERIC_FEEDBACK);
  });
});

describe('#7 reference traces must use feasible decisions', () => {
  it('an infeasible choice for the concrete pause is a mismatch', () => {
    const spec = toTraceSpec(fixture().traces.FX1!);
    const mutated = {
      ...spec,
      rounds: spec.rounds.map((r) =>
        r.round === 1 ? { ...r, decisions: r.decisions.map((d) => (d.ref === 'dispatch' ? { ...d, choose: 'let_it_happen' as const } : d)) } : r,
      ),
    };
    const run = simulateTrace(caseInitialState(fixture(), 'FX1'), config(), mutated, 'full');
    expect(run.mismatches.some((m) => m.includes('"let_it_happen"') && m.includes('dispatch_request') && m.includes('feasible: endorse'))).toBe(true);
    expect(run.terminal).toBeNull();
  });

  it('deadlock options follow the global-cap restriction', () => {
    const s = mutate(initial(), (x) => {
      x.negotiation['hedong-khitan'].offersTotal = 5;
    });
    expect(optionsForPause(s, config(), 'negotiation_deadlock', 'hedong-khitan', [])).toEqual(['urge_stop', 'ask']);
    expect(optionsForPause(initial(), config(), 'prompt_request', null, [A.speak([SANG])])).toEqual(['endorse', 'withhold', 'ask']);
    expect(optionsForPause(initial(), config(), 'goal_conflict', null, [A.dispatch()])).toContain('amend');
  });
});

describe('#8 every case needs a reference trace', () => {
  it('reports a case without a trace', () => {
    const b = structuredClone(fixture());
    delete (b.traces as Record<string, unknown>).FX1;
    expect(validateContent(b)).toContain('cases/FX1: missing reference trace traces/FX1.trace.yaml');
  });
});
