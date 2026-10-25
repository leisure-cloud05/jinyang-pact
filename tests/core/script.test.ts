import { describe, expect, it } from 'vitest';
import { CURRENT_VERSION, evaluateCondition, playerDocView, prepareScriptInputs, resolvePlaceholders } from '../../src/core/script.js';
import { A, DOC_TERMS, SANG, SHI, YELU, batch, config, delivered, dispatched, initial, mutate, nextRound, prop } from './helpers.js';

describe('script conditions (player knowledge only)', () => {
  it('always / round_at_least', () => {
    expect(evaluateCondition(initial(), config(), 'always')).toBe(true);
    expect(evaluateCondition(initial(), config(), undefined)).toBe(true);
    expect(evaluateCondition(initial(), config(), { round_at_least: 2 })).toBe(false);
    expect(evaluateCondition(nextRound(initial()), config(), { round_at_least: 2 })).toBe(true);
  });

  it('doc_status follows what the player observed', () => {
    const cond = { doc_status: { docId: 'doc:1', status: 'approved' as const } };
    expect(evaluateCondition(initial(), config(), cond)).toBe(false);
    const approved = batch(initial(), [prop(SHI, A.approve())]).state;
    expect(evaluateCondition(approved, config(), cond)).toBe(true);
    // A remote approval the player could not observe does not count.
    const away = mutate(initial(), (x) => {
      x.player.location = 'luoyang_court';
    });
    expect(evaluateCondition(batch(away, [prop(SHI, A.approve())]).state, config(), cond)).toBe(false);
  });

  it('player_received / player_not_received use only messages the player has evidence of', () => {
    const got = { player_received: { kind: 'response' as const, from: YELU } };
    const notYet = { player_not_received: { kind: 'response' as const, from: YELU } };
    let s = batch(delivered(), [prop(YELU, A.confirm('cmt:1', 'offer:1', 1))]).state;
    expect(evaluateCondition(s, config(), got)).toBe(false); // in transit
    expect(evaluateCondition(s, config(), notYet)).toBe(true);
    s = nextRound(s); // delivered to Shi; the player observes his correspondence
    expect(evaluateCondition(s, config(), got)).toBe(true);
    expect(evaluateCondition(s, config(), notYet)).toBe(false);
    expect(evaluateCondition(s, config(), { player_received: { kind: 'response', from: 'li_congke' } })).toBe(false);
    // Intel delivered to Li is invisible to the player.
    expect(Object.values(s.messages).some((m) => m.kind === 'intel' && m.status === 'delivered')).toBe(true);
    expect(evaluateCondition(s, config(), { player_received: { kind: 'intel' } })).toBe(false);
  });
});

describe('"$current" placeholder', () => {
  it('resolves to the version the player can see', () => {
    const action = A.revise(1, DOC_TERMS);
    (action.args as Record<string, unknown>).baseDocVersion = CURRENT_VERSION;
    const r1 = resolvePlaceholders(initial(), action);
    expect(r1.ok && (r1.action as { args: { baseDocVersion: number } }).args.baseDocVersion).toBe(1);
    const revised = batch(initial(), [prop(SANG, A.revise(1, { ...DOC_TERMS, annual_silk: 100000 }))]).state;
    expect(playerDocView(revised, 'doc:1')).toEqual({ version: 2, status: 'draft' });
    const r2 = resolvePlaceholders(revised, action);
    expect(r2.ok && (r2.action as { args: { baseDocVersion: number } }).args.baseDocVersion).toBe(2);
    expect((action.args as Record<string, unknown>).baseDocVersion).toBe(CURRENT_VERSION); // input untouched
    const unseen = resolvePlaceholders(initial(), { type: 'dispatch_document', args: { docId: 'doc:9', docVersion: CURRENT_VERSION } });
    expect(unseen.ok).toBe(false);
  });

  it('prepareScriptInputs applies, skips (with reasons) and keeps probe flags', () => {
    const plan = prepareScriptInputs(dispatched(), config(), [
      { dialogue: { to: [SHI], text: { zh: '请速决。', en: 'Decide quickly.' } } },
      { action: A.timing('hold'), when: { doc_status: { docId: 'doc:1', status: 'draft' } } },
      { action: { type: 'dispatch_document', args: { docId: 'doc:1', docVersion: CURRENT_VERSION } }, probe: true },
      { action: A.wait(), when: { round_at_least: 3 } },
    ], 'en');
    expect(plan.apply.map((p) => [p.index, p.kind, p.probe])).toEqual([[0, 'dialogue', false], [2, 'action', true]]);
    expect(plan.apply[0]?.dialogue?.text).toBe('Decide quickly.');
    expect((plan.apply[1]?.action as { args: { docVersion: number } }).args.docVersion).toBe(1);
    expect(plan.skipped.map((s) => s.index)).toEqual([1, 3]);
    expect(plan.skipped[0]?.reason).toContain('condition not met');
  });
});
