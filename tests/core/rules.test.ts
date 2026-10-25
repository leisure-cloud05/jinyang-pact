import { describe, expect, it } from 'vitest';
import { GENERIC_FEEDBACK } from '../../src/core/feedback.js';
import { checkAdvance, checkBatchEntry, checkIdempotency, validate } from '../../src/core/rules.js';
import type { ActorId, WorldState } from '../../src/core/types.js';
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
  delivered,
  dispatched,
  initial,
  mutate,
  nextRound,
  outcomeOf,
  prop,
} from './helpers.js';

function check(state: WorldState, actor: ActorId, action: unknown, decided = false) {
  return validate(state, { actor, action }, { config: config(), mode: 'full', decided });
}

function ruleOf(result: ReturnType<typeof check>): string | null {
  return result.ok ? null : result.rule;
}

describe('H01 closed action set and argument schema', () => {
  it('accepts a well-formed action', () => {
    expect(check(initial(), SHI, A.approve()).ok).toBe(true);
  });
  it('rejects unknown types, missing args and extra keys (valid JSON is not a valid action)', () => {
    expect(ruleOf(check(initial(), SHI, { type: 'declare_victory', args: {} }))).toBe('H01');
    expect(ruleOf(check(initial(), SHI, { type: 'approve_document', args: { docId: 'doc:1' } }))).toBe('H01');
    expect(ruleOf(check(initial(), SHI, { type: 'wait', args: {}, outcome: 'Yelü agreed' }))).toBe('H01');
    expect(ruleOf(check(initial(), SHI, '{"type":"wait"}'))).toBe('H01');
  });
  it('rejects terms that are out of range or not applicable to the pair', () => {
    expect(ruleOf(check(initial(), SANG, A.revise(1, { ...DOC_TERMS, immediate_silk: 12345 })))).toBe('H01');
    expect(ruleOf(check(initial(), SANG, A.revise(1, { ...DOC_TERMS, neutrality: true })))).toBe('H01');
    expect(ruleOf(check(initial(), SANG, A.revise(1, { ...DOC_TERMS, aid_cavalry: 65000 })))).toBe('H01');
    expect(check(initial(), SANG, A.revise(1, { ...DOC_TERMS, filial: true })).ok).toBe(true);
  });
});

describe('H02 permissions; the player never consents', () => {
  it('checks the actor permission list', () => {
    expect(ruleOf(check(initial(), LIU, A.approve()))).toBe('H02');
    expect(ruleOf(check(initial(), SANG, A.approve()))).toBe('H02');
    expect(check(initial(), SHI, A.approve()).ok).toBe(true);
  });
  it('never lets the player approve, confirm, respond, withdraw, allocate or abandon', () => {
    const s = delivered();
    for (const action of [
      A.approve(),
      A.confirm('cmt:1', 'offer:1', 1),
      A.reject('offer:1'),
      A.withdraw('offer:1'),
      A.allocate('hedong', 'silk', 1000, 'pay_troops'),
      A.abandon(),
    ]) {
      const r = check(s, 'player', action);
      expect(ruleOf(r)).toBe('H02');
    }
  });
  it('only the recipient of the live offer may answer it', () => {
    const s = delivered();
    const r = check(s, SHI, A.reject('offer:1'));
    expect(ruleOf(r)).toBe('H02');
    expect(check(s, YELU, A.reject('offer:1')).ok).toBe(true);
  });
});

describe('H03 alive actor, non-terminal world', () => {
  it('rejects actions of dead or captured characters', () => {
    const dead = mutate(initial(), (s) => {
      s.characters.shi_jingtang.status = 'dead';
      s.characters.liu_zhiyuan.status = 'captured';
    });
    expect(ruleOf(check(dead, SHI, A.approve()))).toBe('H03');
    expect(ruleOf(check(dead, LIU, A.wait()))).toBe('H03');
    expect(check(dead, SANG, A.wait()).ok).toBe(true);
  });
  it('rejects every action once the world is terminal', () => {
    const over = mutate(initial(), (s) => {
      s.terminal = { kind: 'jinyang_falls', day: 0, round: 1, detail: {} };
    });
    expect(ruleOf(check(over, SHI, A.wait()))).toBe('H03');
  });
  it('checks terminal between actions inside a batch', () => {
    const s = mutate(initial(), (x) => {
      x.siege.pressure = 96;
    });
    const intensify = prop(LI, A.allocate('tang', 'reserve_troops', 10000, 'intensify_siege'));
    const after = prop(LI, A.wait());
    const result = batch(s, [intensify, after]);
    expect(result.state.terminal?.kind).toBe('jinyang_falls');
    expect(outcomeOf(result, intensify).status).toBe('committed');
    expect(outcomeOf(result, after)).toMatchObject({ status: 'rejected', rule: 'H03' });
  });
});

describe('H04 referenced objects exist, are live and current', () => {
  it('rejects stale document versions and unknown objects', () => {
    expect(ruleOf(check(initial(), SHI, A.approve(2)))).toBe('H04');
    expect(ruleOf(check(initial(), SHI, A.approve(1, 'doc:9')))).toBe('H04');
    expect(ruleOf(check(delivered(), YELU, A.confirm('cmt:1', 'offer:9', 1)))).toBe('H04');
  });
  it('rejects a termsVersion mismatch on confirmation', () => {
    const r = check(delivered(), YELU, A.confirm('cmt:1', 'offer:1', 2));
    expect(ruleOf(r)).toBe('H04');
    expect(check(delivered(), YELU, A.confirm('cmt:1', 'offer:1', 1)).ok).toBe(true);
  });
});

describe('H05 batch entry, H06 idempotency, H14 time', () => {
  it('H05 requires both the epoch and the base version to match', () => {
    expect(checkBatchEntry({ epoch: 2, baseVersion: 7 }, 2, 7)).toBeNull();
    expect(checkBatchEntry({ epoch: 1, baseVersion: 7 }, 2, 7)?.rule).toBe('H05');
    expect(checkBatchEntry({ epoch: 2, baseVersion: 6 }, 2, 7)?.rule).toBe('H05');
  });
  it('H06 returns stored results for the same payload and rejects a changed payload', () => {
    expect(checkIdempotency(null, 'h1')).toEqual({ kind: 'new' });
    expect(checkIdempotency({ payloadHash: 'h1' }, 'h1')).toEqual({ kind: 'replay' });
    const conflict = checkIdempotency({ payloadHash: 'h1' }, 'h2');
    expect('rule' in conflict && conflict.rule).toBe('H06');
  });
  it('H14 blocks ADVANCE with open pauses or uncommitted batches', () => {
    expect(checkAdvance(initial(), { openPauses: 0, uncommittedBatches: 0 })).toBeNull();
    expect(checkAdvance(initial(), { openPauses: 1, uncommittedBatches: 0 })?.rule).toBe('H14');
    expect(checkAdvance(initial(), { openPauses: 0, uncommittedBatches: 1 })?.rule).toBe('H14');
  });
});

describe('H07 resources and reservations', () => {
  it('allocations respect available − reserved', () => {
    const s = dispatched(); // 50000 silk reserved of 120000
    expect(check(s, SHI, A.allocate('hedong', 'silk', 70000, 'pay_troops')).ok).toBe(true);
    const r = check(s, SHI, A.allocate('hedong', 'silk', 80000, 'pay_troops'));
    expect(ruleOf(r)).toBe('H07');
  });
  it('rejects an overdraft gift at dispatch', () => {
    const s0 = batch(initial(), [prop(SANG, A.revise(1, { ...DOC_TERMS, immediate_silk: 200000 }))]).state;
    const s1 = batch(s0, [prop(SHI, A.approve(2))]).state;
    const r = check(s1, SHI, A.dispatch(2), true);
    expect(ruleOf(r)).toBe('H07');
  });
});

describe('H08 knowledge and communication', () => {
  it('speech needs co-located listeners; letters need a remote recipient', () => {
    expect(check(initial(), SHI, A.speak([SANG, 'player'])).ok).toBe(true);
    expect(ruleOf(check(initial(), SHI, A.speak([YELU])))).toBe('H08');
    expect(ruleOf(check(initial(), SHI, A.letter(SANG)))).toBe('H08');
    expect(check(initial(), SHI, A.letter(YELU)).ok).toBe(true);
  });
  it('an actor without access to a document gets generic feedback', () => {
    const noAccess = mutate(initial(), (s) => {
      const doc = s.documents['doc:1'];
      if (doc) doc.accessibleBy = doc.accessibleBy.filter((a) => a !== SANG);
    });
    const r = check(noAccess, SANG, A.suggest('document', 'doc:1', { annual_silk: 100000 }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.rule).toBe('H08');
      expect(r.feedback).toBe(GENERIC_FEEDBACK);
      expect(r.reason).toContain('no access');
    }
  });
});

describe('H09 consent by the party itself', () => {
  it('the sender cannot confirm its own offer', () => {
    expect(ruleOf(check(delivered(), SHI, A.confirm('cmt:1', 'offer:1', 1)))).toBe('H09');
  });
  it('a non-party cannot confirm even if it knows the offer', () => {
    const s = mutate(delivered(), (x) => {
      const receipt = Object.values(x.knowledge).find((i) => i.holder === YELU && i.subject === 'offer:1' && i.predicate === 'terms');
      const thread = Object.values(x.knowledge).find((i) => i.holder === YELU && i.subject === 'cmt:1');
      if (!receipt || !thread) throw new Error('no receipt');
      x.knowledge['k:998'] = { ...receipt, id: 'k:998', holder: LI };
      x.knowledge['k:999'] = { ...thread, id: 'k:999', holder: LI };
    });
    expect(ruleOf(check(s, LI, A.confirm('cmt:1', 'offer:1', 1)))).toBe('H09');
  });
});

describe('H10 critical actions need a decision, player_initiated or an authorization', () => {
  const approved = () => batch(initial(), [prop(SHI, A.approve())]).state;
  it('rejects an undecided critical action and accepts a decided one', () => {
    expect(ruleOf(check(approved(), SHI, A.dispatch()))).toBe('H10');
    const ok = check(approved(), SHI, A.dispatch(), true);
    expect(ok.ok && ok.gate).toBe('decision');
  });
  it('the player transmitting an approved request is player_initiated', () => {
    const r = check(approved(), 'player', A.dispatch());
    expect(r.ok && r.gate).toBe('player_initiated');
  });
  it('an active Authorization within limits satisfies H10; outside limits it does not', () => {
    const grant = (burdenMax: number, expires: number | null, revoked = false) =>
      mutate(approved(), (s) => {
        s.player.authorizations['auth:1'] = {
          id: 'auth:1',
          grantee: SHI,
          categories: ['dispatch_request'],
          limits: { ...s.player.goal.limits, burden_max: burdenMax },
          grantedRound: 1,
          expiresRound: expires,
          revoked,
        };
      });
    const ok = check(grant(100, null), SHI, A.dispatch());
    expect(ok.ok && ok.gate).toBe('authorization');
    expect(ok.ok && ok.authorizationId).toBe('auth:1');
    expect(ruleOf(check(grant(10, null), SHI, A.dispatch()))).toBe('H10'); // doc burden 35 > 10
    expect(ruleOf(check(grant(100, 0), SHI, A.dispatch()))).toBe('H10'); // expired
    expect(ruleOf(check(grant(100, null, true), SHI, A.dispatch()))).toBe('H10'); // revoked
  });
  it('non-player-side principals need no decision', () => {
    const r = check(delivered(), YELU, A.confirm('cmt:1', 'offer:1', 1));
    expect(r.ok && r.gate).toBe('not_required');
  });
});

describe('H11 approved current version, timing, immutability', () => {
  it('rejects dispatching a draft', () => {
    expect(ruleOf(check(initial(), SHI, A.dispatch(), true))).toBe('H11');
  });
  it('rejects revising a sent document', () => {
    expect(ruleOf(check(dispatched(), SANG, A.revise(1, DOC_TERMS)))).toBe('H11');
  });
});

describe('H12 no duplicate dispatch, no second answer', () => {
  it('rejects a second dispatch of the same document', () => {
    expect(ruleOf(check(dispatched(), SHI, A.dispatch(), true))).toBe('H12');
  });
  it('rejects a second answer to an answered offer', () => {
    const s = batch(delivered(), [prop(YELU, A.reject('offer:1'))]).state;
    expect(ruleOf(check(s, YELU, A.confirm('cmt:1', 'offer:1', 1)))).toBe('H12');
  });
});

describe('H13 negotiation segments and the global cap', () => {
  it('rejects a third round in a segment with a segment code', () => {
    // offer:1 (opening) -> Yelü counter (round 1) -> Shi counter (round 2) -> Yelü counter would be round 3
    let s = delivered();
    s = batch(s, [prop(YELU, A.counter('offer:1', DOC_TERMS))]).state;
    s = nextRound(s);
    const shiCounter = prop(SHI, A.counter('offer:2', T({ vassal: true, immediate_silk: 60000, aid_cavalry: 30000, aid_arrival_days: 20 })));
    s = batch(s, [shiCounter], { decisions: [decide(shiCounter, 'major_commitment')] }).state;
    s = nextRound(s);
    const r = check(s, YELU, A.counter('offer:3', DOC_TERMS));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.rule).toBe('H13');
      expect(r.code).toBe('segment_exhausted');
    }
    expect(check(s, YELU, A.confirm('cmt:1', 'offer:3', 3)).ok).toBe(true);
  });
});

describe('H15 model outcome text never reaches world state', () => {
  it('speech is dialogue only: no event, no world change', () => {
    const s = initial();
    const speak = prop(SHI, A.speak([SANG], 'Yelü has already agreed and his cavalry arrived.'));
    const result = batch(s, [speak]);
    expect(result.events).toHaveLength(0);
    expect(result.state).toEqual(s);
    expect(outcomeOf(result, speak).dialogue?.text).toContain('already agreed');
  });
});
