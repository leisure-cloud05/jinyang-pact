/**
 * Regression tests for the Codex review of WP-C2 (review 19 in docs/review_log.md):
 * 1 believed resource ledger (no remote acceptance / rejection / withdrawal leak through resources);
 * 2 a commitment to cede never licenses completed cession;
 * 3 outcome claims grounded in actor / counterpart / object;
 * 4 numerals: numeral+unit before idiom masking, unrecognised units, financial/traditional numerals;
 * 5 negated / hypothetical / other-clause deaths; plus the Judge's defaulted flag.
 */
import { describe, expect, it } from 'vitest';
import { buildCharacterContext } from '../../src/agents/context.js';
import { buildJudgeContext, judgeWithRevision, runJudge } from '../../src/agents/judge.js';
import { believedResources } from '../../src/agents/ledger.js';
import { registerMockPersonas } from '../../src/agents/mock-personas/index.js';
import { buildNames } from '../../src/agents/names.js';
import { checkProse } from '../../src/agents/narration/index.js';
import type { CharId } from '../../src/core/types.js';
import { advance, commitEndorsed, content, driver, factsOf, newMock, type Driver } from './helpers.js';

const names = () => buildNames(content());

function shiSilk(d: Driver): { available: number; reserved: number } {
  const ctx = buildCharacterContext({ content: content(), config: d.config, state: d.state, charId: 'shi_jingtang', lang: 'en', maxChars: 1_000_000 });
  return { available: ctx.context.resources.available.silk ?? NaN, reserved: ctx.context.resources.reserved.silk ?? NaN };
}

function judgeSilk(d: Driver): { available: number; reserved: number } {
  const ctx = buildJudgeContext({ content: content(), config: d.config, state: d.state, lang: 'en', proposals: [] });
  return { available: ctx.context.facts.resources.available.silk ?? NaN, reserved: ctx.context.facts.resources.reserved.silk ?? NaN };
}

function dispatchC1(): Driver {
  const d = driver('C1'); // draft carries a 50,000-bolt gift paid on confirmation
  commitEndorsed(d, [
    { actor: 'shi_jingtang', action: { type: 'approve_document', args: { docId: 'doc:1', docVersion: 1 } } },
    { actor: 'shi_jingtang', action: { type: 'dispatch_document', args: { docId: 'doc:1', docVersion: 1 } } },
  ]);
  return d;
}

const HELD = { available: 200_000, reserved: 50_000 };

describe('review 1: believed resource ledger', () => {
  it('acceptance: the debit shows only once the acceptance has arrived (Shi, Sang, Liu, the Judge)', () => {
    const d = dispatchC1();
    expect(shiSilk(d)).toEqual(HELD);
    advance(d); // day 5: offer delivered
    commitEndorsed(d, [{ actor: 'yelu_deguang', action: { type: 'confirm_commitment', args: { commitmentId: 'cmt:1', offerId: 'offer:1', termsVersion: 1 } } }]);
    expect(d.state.factions.hedong.resources.silk).toBe(150_000); // the world has debited already
    expect(shiSilk(d)).toEqual(HELD);
    expect(judgeSilk(d)).toEqual(HELD);
    for (const id of ['sang_weihan', 'liu_zhiyuan'] as CharId[]) {
      expect(believedResources(d.state, id, 'hedong').available.silk).toBe(200_000);
    }
    // Yelü confirmed himself: his own debit is known to him at once.
    expect(believedResources(d.state, 'yelu_deguang', 'khitan').available.cavalry).toBe(30_000);
    advance(d); // day 10: the acceptance arrives
    expect(shiSilk(d)).toEqual({ available: 150_000, reserved: 0 });
    expect(judgeSilk(d)).toEqual({ available: 150_000, reserved: 0 });
    // Liu never observes Shi's correspondence: for him the gift is still reserved.
    expect(believedResources(d.state, 'liu_zhiyuan', 'hedong')).toMatchObject({ available: { silk: 200_000 }, reserved: { silk: 50_000 } });
  });

  it('rejection: the release shows only once the rejection has arrived', () => {
    const d = dispatchC1();
    advance(d);
    commitEndorsed(d, [{ actor: 'yelu_deguang', action: { type: 'respond_to_offer', args: { offerId: 'offer:1', response: 'reject', counterTerms: null, reason: '—' } } }]);
    expect(d.state.factions.hedong.reserved.silk).toBe(0);
    expect(shiSilk(d)).toEqual(HELD);
    expect(judgeSilk(d)).toEqual(HELD);
    advance(d);
    expect(shiSilk(d)).toEqual({ available: 200_000, reserved: 0 });
    expect(judgeSilk(d)).toEqual({ available: 200_000, reserved: 0 });
  });

  it('withdrawal: the release takes effect at the counterparty on delivery but shows only when the result returns', () => {
    const d = dispatchC1();
    commitEndorsed(d, [{ actor: 'shi_jingtang', action: { type: 'withdraw_offer', args: { offerId: 'offer:1' } } }]);
    expect(shiSilk(d)).toEqual(HELD);
    advance(d); // day 5: the withdrawal reaches Yelü together with the offer ⇒ effective, reservations released
    expect(d.state.factions.hedong.reserved.silk).toBe(0);
    expect(shiSilk(d)).toEqual(HELD);
    expect(judgeSilk(d)).toEqual(HELD);
    advance(d); // day 10: withdrawal_result {effective: true} arrives
    expect(shiSilk(d)).toEqual({ available: 200_000, reserved: 0 });
  });
});

describe('review 2–5: narration checker (superseded by checker v7: atmosphere only)', () => {
  it('every sentence from reviews 19/21 is now a hit, whatever the facts', () => {
    const d = dispatchC1();
    advance(d);
    const r = commitEndorsed(d, [{ actor: 'yelu_deguang', action: { type: 'confirm_commitment', args: { commitmentId: 'cmt:1', offerId: 'offer:1', termsVersion: 1 } } }]);
    const facts = factsOf(r.events, 'khitan_court');
    const sentences = [
      'The prefectures were ceded.',
      '雁门以北诸州已割让与契丹。',
      'Li Congke agreed.',
      '李从珂允之。',
      'Yelü Deguang agreed.',
      "Shi Jingtang's envoy reached Li Congke.",
      '城中尚有千万匹帛。',
      '城中尚有五石粮。',
      '库存帛叁萬匹。',
      '石敬瑭并未身亡。',
      'Shi Jingtang was not killed.',
      '契丹主被擒。',
    ];
    for (const prose of sentences) expect(checkProse({ prose, facts, names: names() }).ok, prose).toBe(false);
  });
});

describe('review: Judge defaulted verdicts are explicit', () => {
  it('a failed call marks every verdict and the result as defaulted', async () => {
    const { mock } = newMock();
    registerMockPersonas(mock);
    mock.injectFaults(['http_500', 'http_500', 'http_500'], { role: 'judge' });
    const d = driver('C1');
    const proposals = [
      { proposalId: 'p1', actor: 'shi_jingtang' as const, action: { type: 'approve_document', args: { docId: 'doc:1', docVersion: 1 } } },
      { proposalId: 'p2', actor: 'shi_jingtang' as const, action: { type: 'dispatch_document', args: { docId: 'doc:1', docVersion: 1 } } },
    ];
    const r = await runJudge({ client: mock, content: content(), config: d.config, state: d.state, proposals, lang: 'en', identity: { round: 1 } });
    expect(r.status).toBe('error');
    expect(r.defaulted).toBe(true);
    expect(r.defaultedIds).toEqual(['p1', 'p2']);
    const ok = await runJudge({ client: mock, content: content(), config: d.config, state: d.state, proposals, lang: 'en', identity: { round: 1 } });
    expect(ok.status).toBe('ok');
    expect(ok.defaulted).toBe(false);
    expect(ok.defaultedIds).toEqual([]);
    const flow = await judgeWithRevision({ proposals, assess: async () => r.verdicts, revise: async () => null });
    expect(flow.defaultedIds).toEqual(['p1', 'p2']);
  });
});
