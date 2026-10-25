/** Mock personas (information-limited, pair-scoped preferences) and the seeded misbehaviour injector. */
import { describe, expect, it } from 'vitest';
import { prepareCharacterCall, runCharacterTurn } from '../../src/agents/character.js';
import {
  CHARACTER_MISBEHAVIOURS,
  FABRICATED_CITES,
  injectCharacter,
  personaTurn,
  registerMockPersonas,
  type InjectionRecord,
  type MisbehaviourKind,
} from '../../src/agents/mock-personas/index.js';
import { narrateScene } from '../../src/agents/narrator.js';
import type { CharId } from '../../src/core/types.js';
import { advance, commitEndorsed, content, driver, factsOf, newMock, personas, type Driver } from './helpers.js';

function turn(d: Driver, caseId: string, charId: CharId, round = d.state.round) {
  const prep = prepareCharacterCall({
    content: content(),
    config: d.config,
    state: d.state,
    charId,
    lang: 'zh',
    variant: 'harness',
    identity: { caseId, rep: 1, round, epoch: 0 },
    persona: personas(caseId)[charId],
  });
  return { prep, out: personaTurn(prep.meta) };
}

function actionsOf(out: ReturnType<typeof personaTurn>) {
  return out.actions.map((a) => ({ type: a.type, args: a.args }));
}

describe('mock personas', () => {
  it('C1: Yelü confirms an offer that meets his reservation once it is delivered (not before)', () => {
    const d = driver('C1');
    expect(actionsOf(turn(d, 'C1', 'yelu_deguang').out)).toEqual([{ type: 'wait', args: {} }]);
    commitEndorsed(d, [
      { actor: 'shi_jingtang', action: { type: 'approve_document', args: { docId: 'doc:1', docVersion: 1 } } },
      { actor: 'shi_jingtang', action: { type: 'dispatch_document', args: { docId: 'doc:1', docVersion: 1 } } },
    ]);
    expect(actionsOf(turn(d, 'C1', 'yelu_deguang').out)).toEqual([{ type: 'wait', args: {} }]);
    advance(d);
    const { out } = turn(d, 'C1', 'yelu_deguang');
    expect(actionsOf(out)).toEqual([{ type: 'confirm_commitment', args: { commitmentId: 'cmt:1', offerId: 'offer:1', termsVersion: 1 } }]);
    const r = commitEndorsed(d, actionsOf(out).map((action) => ({ actor: 'yelu_deguang', action })));
    expect(r.outcomes.map((o) => o.status)).toEqual(['committed']);
  });

  it('C3: Yelü counters toward his reservation, then rejects once only confirm/reject remain; Shi counters within tolerance', () => {
    const d = driver('C3');
    commitEndorsed(d, actionsOf(turn(d, 'C3', 'shi_jingtang').out).map((action) => ({ actor: 'shi_jingtang', action })));
    advance(d);
    const y1 = turn(d, 'C3', 'yelu_deguang').out;
    expect(y1.actions[0]?.type).toBe('respond_to_offer');
    const counter = y1.actions[0];
    if (counter?.type !== 'respond_to_offer') throw new Error('expected a counter');
    expect(counter.args.response).toBe('counter');
    expect(counter.args.counterTerms?.vassal).toBe(true);
    expect(counter.args.counterTerms?.cession).toBe('yanmen_north');
    expect(commitEndorsed(d, actionsOf(y1).map((action) => ({ actor: 'yelu_deguang', action }))).outcomes[0]?.status).toBe('committed');
    advance(d);
    const s = turn(d, 'C3', 'shi_jingtang').out;
    // Yelü's counter (burden ≥ 50, Yanmen north) is within Shi's tolerance (≤ 110): he accepts it.
    expect(s.actions[0]?.type).toBe('confirm_commitment');
    expect(commitEndorsed(d, actionsOf(s).map((action) => ({ actor: 'shi_jingtang', action }))).outcomes[0]?.status).toBe('committed');
  });

  it('C4: Yelü takes one side only — confirms Hedong\'s relief request and rejects Tang\'s neutrality bid', () => {
    const d = driver('C4');
    commitEndorsed(d, actionsOf(turn(d, 'C4', 'shi_jingtang').out).map((action) => ({ actor: 'shi_jingtang', action })));
    advance(d);
    const { out } = turn(d, 'C4', 'yelu_deguang');
    const hedongOffer = d.state.documents['doc:1']?.sentOfferId;
    const types = out.actions.map((a) => `${a.type}:${'offerId' in a.args ? a.args.offerId : ''}`);
    expect(types).toContain(`confirm_commitment:${hedongOffer}`);
    expect(out.actions.some((a) => a.type === 'respond_to_offer' && a.args.response === 'reject')).toBe(true);
    const r = commitEndorsed(d, actionsOf(out).map((action) => ({ actor: 'yelu_deguang', action })));
    expect(r.outcomes.every((o) => o.status === 'committed')).toBe(true);
  });

  it('Li presses the siege when he has no bid to make; personas never see what their context lacks', () => {
    const d = driver('C1');
    const { out, prep } = turn(d, 'C1', 'li_congke');
    expect(actionsOf(out)).toEqual([{ type: 'allocate_resources', args: { faction: 'tang', resource: 'reserve_troops', amount: 5000, purpose: 'intensify_siege' } }]);
    expect(JSON.stringify(prep.meta)).not.toContain('doc:1');
  });

  it('handlers refuse requests without agent meta', async () => {
    const { mock } = newMock();
    registerMockPersonas(mock);
    const r = await mock.complete({
      role: 'character',
      actor: 'shi_jingtang',
      messages: [{ role: 'user', content: 'hi' }],
      schema: (await import('../../src/agents/schemas.js')).CharacterOutputSchema,
      schemaName: 'x',
    });
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.message).toMatch(/no character meta/);
  });
});

describe('misbehaviour injector', () => {
  it('is off by default and deterministic per (case, rep, actor, round, epoch, callTag)', () => {
    const d = driver('C1');
    const { prep, out } = turn(d, 'C1', 'shi_jingtang');
    expect(injectCharacter(prep.meta, out, undefined)).toBe(out);
    expect(injectCharacter(prep.meta, out, { rate: 0 })).toBe(out);
    const logA: InjectionRecord[] = [];
    const logB: InjectionRecord[] = [];
    const a = injectCharacter(prep.meta, out, { rate: 1, log: logA });
    const b = injectCharacter(prep.meta, out, { rate: 1, log: logB });
    expect(a).toEqual(b);
    expect(logA).toEqual(logB);
    expect(logA).toHaveLength(1);
    const kinds = new Set<string>();
    for (let tag = 0; tag < 40; tag++) {
      const meta = { ...prep.meta, identity: { ...prep.meta.identity, callTag: `t${tag}` } };
      const log: InjectionRecord[] = [];
      injectCharacter(meta, out, { rate: 1, log });
      kinds.add(log[0]?.kind ?? '');
    }
    expect(kinds.size).toBeGreaterThan(3);
  });

  it('each injected misbehaviour is caught by validation or cite stripping', async () => {
    const expected: Record<Exclude<MisbehaviourKind, 'contradicting_prose' | 'fabricated_cites'>, string[]> = {
      on_behalf_consent: ['H02'],
      answer_before_delivery: ['H02', 'H04', 'H08', 'H09'],
      overdraft: ['H07', 'H01'],
      duplicate_dispatch: ['H11', 'H12', 'H04'],
      stale_version: ['H04', 'H02', 'H11'],
    };
    for (const [kind, rules] of Object.entries(expected) as [keyof typeof expected, string[]][]) {
      const actor: CharId = kind === 'on_behalf_consent' ? 'sang_weihan' : 'shi_jingtang';
      const d = driver('C1');
      const { prep, out } = turn(d, 'C1', actor);
      const injected = injectCharacter(prep.meta, out, { rate: 1, kinds: [kind] });
      const extra = injected.actions[injected.actions.length - 1];
      expect(extra?.rationale).toBe('injected misbehaviour');
      const r = commitEndorsed(d, actionsOf(injected).map((action) => ({ actor, action })));
      const rejected = r.outcomes.filter((o) => o.status === 'rejected');
      expect(rejected.length, kind).toBeGreaterThan(0);
      expect(rules, `${kind}: ${rejected.map((o) => o.rule).join(',')}`).toContain(rejected[0]?.rule);
    }
    const { mock } = newMock();
    registerMockPersonas(mock, { misbehaviourRate: 1, misbehaviourKinds: ['fabricated_cites'] });
    const d = driver('C1');
    const r = await runCharacterTurn({ client: mock, content: content(), config: d.config, state: d.state, charId: 'shi_jingtang', lang: 'zh', variant: 'harness', identity: { caseId: 'C1', rep: 1, round: 1 } });
    expect(r.citeErrors).toBe(FABRICATED_CITES.length * r.output!.actions.length);
    expect(r.drafts.flatMap((x) => x.cites)).not.toContain('zztj280-999');
    expect(CHARACTER_MISBEHAVIOURS).not.toContain('contradicting_prose');
  });

  it('contradicting prose is replaced by the template fallback', async () => {
    const d = driver('C1');
    const r = commitEndorsed(d, [
      { actor: 'shi_jingtang', action: { type: 'approve_document', args: { docId: 'doc:1', docVersion: 1 } } },
      { actor: 'shi_jingtang', action: { type: 'dispatch_document', args: { docId: 'doc:1', docVersion: 1 } } },
    ]);
    const facts = factsOf(r.events, 'jinyang_hq');
    for (let tag = 0; tag < 6; tag++) {
      const { mock } = newMock();
      const handle = registerMockPersonas(mock, { misbehaviourRate: 1 });
      const out = await narrateScene({ client: mock, content: content(), config: d.config, state: d.state, scene: 'jinyang_hq', facts, lang: tag % 2 ? 'en' : 'zh', identity: { caseId: 'C1', rep: 1, round: 1, callTag: `n${tag}` } });
      expect(handle.injections.map((i) => i.kind)).toEqual(['contradicting_prose']);
      expect(out.status, out.prose ?? '').toBe('fallback');
      expect(out.check.checker?.ok).toBe(false);
    }
  });
});
