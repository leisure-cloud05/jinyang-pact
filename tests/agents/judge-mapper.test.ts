/** Judge (player-visible context, verdict normalization, REVISE flow) and mapper. */
import { describe, expect, it } from 'vitest';
import {
  buildJudgeContext,
  judgeWithRevision,
  normalizeVerdicts,
  runJudge,
  type JudgeProposalInput,
  type JudgeVerdict,
} from '../../src/agents/judge.js';
import { runMapper } from '../../src/agents/mapper.js';
import { registerMockPersonas } from '../../src/agents/mock-personas/index.js';
import { secretsUnknownTo } from '../../src/agents/narration/index.js';
import { commitEndorsed, content, driver, newMock } from './helpers.js';

const CANARY = '玄鸾十七号密押';

describe('judge', () => {
  it('builds its context from the player\'s knowledge only (C4: no secret article, no Tang–Khitan thread)', () => {
    const d = driver('C4');
    const proposals: JudgeProposalInput[] = [
      { proposalId: 'p1', actor: 'shi_jingtang', action: { type: 'approve_document', args: { docId: 'doc:1', docVersion: 1 } } },
      { proposalId: 'p2', actor: 'shi_jingtang', action: { type: 'dispatch_document', args: { docId: 'doc:1', docVersion: 1 } } },
      { proposalId: 'p3', actor: 'sang_weihan', action: { type: 'send_letter', args: { to: 'yelu_deguang', text: `密约押以${CANARY}，事成中分府库。` } } },
      { proposalId: 'p4', actor: 'shi_jingtang', action: { type: 'speak', args: { to: ['sang_weihan'], text: 'PRIVATE-TO-SANG' } } },
    ];
    const built = buildJudgeContext({ content: content(), config: d.config, state: d.state, proposals, lang: 'zh' });
    expect(built.text).not.toContain(CANARY);
    expect(built.text).not.toContain('sc_treasury_share');
    expect(built.text).not.toContain('PRIVATE-TO-SANG');
    expect(built.text).not.toContain('khitan-tang');
    expect(built.text).not.toContain('li_congke');
    const p2 = built.context.proposals.find((p) => p.proposal_id === 'p2');
    expect(p2?.mandatoryCategory).toBe('dispatch_request');
    expect(p2?.goalCheck?.withinGoal).toBe(true); // checked on the player-visible terms (burden 65 ≤ 85)
    expect(p2?.terms?.secret_clauses).toEqual([]);
  });

  it('mock Judge pauses on goal conflicts and open objections; questions stay player-safe', async () => {
    const d = driver('D1'); // default draft: sixteen prefectures, burden 95 > goal 80
    commitEndorsed(d, [
      {
        actor: 'liu_zhiyuan',
        action: {
          type: 'suggest_revision',
          args: {
            target: { kind: 'document', id: 'doc:1' },
            reason: '不必许以土田。',
            terms: { vassal: null, filial: false, cession: 'none', annual_silk: null, immediate_silk: null, aid_cavalry: null, aid_arrival_days: null, neutrality: null, marriage_alliance: null, secret_clauses: null },
          },
        },
      },
    ]);
    const { mock } = newMock();
    registerMockPersonas(mock);
    const proposals: JudgeProposalInput[] = [
      { proposalId: 'a', actor: 'shi_jingtang', action: { type: 'approve_document', args: { docId: 'doc:1', docVersion: 1 } } },
      { proposalId: 'b', actor: 'shi_jingtang', action: { type: 'set_dispatch_timing', args: { docId: 'doc:1', mode: 'delay', rounds: 1 } } },
      { proposalId: 'c', actor: 'sang_weihan', action: { type: 'speak', args: { to: ['player'], text: '善。' } } },
    ];
    const r = await runJudge({ client: mock, content: content(), config: d.config, state: d.state, proposals, lang: 'zh', identity: { round: 1 } });
    expect(r.status).toBe('ok');
    expect(r.verdicts.map((v) => [v.proposalId, v.verdict, v.category])).toEqual([
      ['a', 'PAUSE', 'internal_disagreement'],
      ['b', 'CONTINUE', null],
      ['c', 'CONTINUE', null],
    ]);
    expect(r.verdicts[0]?.question).toBeTruthy();
    expect(r.context.context.disagreements).toHaveLength(1);
  });

  it('normalizes verdicts: missing → CONTINUE, bad category → ambiguity, REVISE on re-assessment → PAUSE, secrets scrubbed', () => {
    const d = driver('C4');
    const secrets = secretsUnknownTo(d.config, d.state, 'player');
    const proposals: JudgeProposalInput[] = ['p1', 'p2', 'p3'].map((id) => ({ proposalId: id, actor: 'shi_jingtang', action: { type: 'wait', args: {} } }));
    const { verdicts, unknownIds } = normalizeVerdicts(
      [
        { proposal_id: 'p1', verdict: 'PAUSE', category: null, reason: 'unclear', question: null },
        { proposal_id: 'p2', verdict: 'REVISE', category: 'goal_conflict', reason: 'x', question: null },
        { proposal_id: 'zz', verdict: 'PAUSE', category: 'ambiguity', reason: 'x', question: 'q' },
      ],
      proposals,
      { lang: 'en', secrets, reassessment: true },
    );
    expect(unknownIds).toEqual(['zz']);
    expect(verdicts.map((v) => [v.verdict, v.category, v.defaulted])).toEqual([
      ['PAUSE', 'ambiguity', false],
      ['PAUSE', 'ambiguity', false],
      ['CONTINUE', null, true],
    ]);
    expect(verdicts[0]?.question).toBeTruthy();
    const leaky = normalizeVerdicts(
      [{ proposal_id: 'p1', verdict: 'PAUSE', category: 'goal_conflict', reason: 'sealed article', question: `Accept the article sealed ${CANARY}?` }],
      proposals.slice(0, 1),
      { lang: 'en', secrets, reassessment: false },
    );
    expect(leaky.verdicts[0]?.sanitized).toBe(true);
    expect(leaky.verdicts[0]?.question).not.toContain(CANARY);
  });

  it('REVISE flow: one revision call per character, one re-assessment, a second REVISE becomes PAUSE', async () => {
    const proposals: JudgeProposalInput[] = [
      { proposalId: 'p1', actor: 'sang_weihan', action: { type: 'wait', args: {} } },
      { proposalId: 'p2', actor: 'shi_jingtang', action: { type: 'wait', args: {} } },
      { proposalId: 'p3', actor: 'liu_zhiyuan', action: { type: 'wait', args: {} } },
    ];
    const v = (id: string, verdict: JudgeVerdict['verdict']): JudgeVerdict => ({
      proposalId: id, verdict, category: verdict === 'CONTINUE' ? null : 'goal_conflict', reason: 'r', question: null, sanitized: false, defaulted: false,
    });
    const calls: string[][] = [];
    const flow = await judgeWithRevision({
      proposals,
      assess: async (ps, re) => {
        calls.push(ps.map((p) => p.proposalId));
        if (!re) return [v('p1', 'REVISE'), v('p2', 'CONTINUE'), v('p3', 'REVISE')];
        return ps.map((p) => v(p.proposalId, p.proposalId === 'p1r' ? 'REVISE' : 'CONTINUE'));
      },
      revise: async (actor) => (actor === 'sang_weihan' ? [{ proposalId: 'p1r', actor, action: { type: 'wait', args: {} } }] : null),
    });
    expect(flow.judgeCalls).toBe(2);
    expect(flow.revisionCalls).toBe(2);
    expect(calls).toEqual([['p1', 'p2', 'p3'], ['p1r']]);
    expect(flow.replaced).toEqual(['p1']);
    expect(flow.revisedActors).toEqual(['sang_weihan']);
    const byId = Object.fromEntries(flow.verdicts.map((x) => [x.proposalId, [x.verdict, x.category]]));
    expect(byId).toEqual({ p2: ['CONTINUE', null], p3: ['PAUSE', 'ambiguity'], p1r: ['PAUSE', 'ambiguity'] });
    expect(flow.proposals.map((p) => p.proposalId).sort()).toEqual(['p1r', 'p2', 'p3']);
  });

  it('a failed Judge call defaults to CONTINUE and says so', async () => {
    const { mock } = newMock();
    registerMockPersonas(mock);
    mock.injectFaults(['http_400'], { role: 'judge' });
    const d = driver('C1');
    const r = await runJudge({
      client: mock, content: content(), config: d.config, state: d.state, lang: 'en', identity: { round: 1 },
      proposals: [{ proposalId: 'p1', actor: 'shi_jingtang', action: { type: 'wait', args: {} } }],
    });
    expect(r.status).toBe('error');
    expect(r.verdicts[0]).toMatchObject({ verdict: 'CONTINUE', defaulted: true });
  });
});

describe('mapper', () => {
  async function map(text: string, lang: 'zh' | 'en' = 'zh') {
    const { mock } = newMock();
    registerMockPersonas(mock);
    const d = driver('C1');
    return runMapper({ client: mock, content: content(), config: d.config, state: d.state, text, lang, identity: { round: 1 } });
  }

  it('maps amounts to a full revise_document, delays to timing, addressing to dialogue', async () => {
    const r = await map('把即付之帛改为十万匹。');
    expect(r.kind).toBe('action');
    expect(r.action?.type).toBe('revise_document');
    if (r.action?.type === 'revise_document') {
      expect(r.action.args.terms.immediate_silk).toBe(100_000);
      expect(r.action.args.terms.cession).toBe('yanmen_north');
      expect(r.action.args.baseDocVersion).toBe(1);
    }
    expect((await map('Delay the letter a little.', 'en')).action).toEqual({ type: 'set_dispatch_timing', args: { docId: 'doc:1', mode: 'delay', rounds: 1 } });
    const talk = await map('刘知远，城守如何？');
    expect(talk.kind).toBe('dialogue');
    expect(talk.dialogue?.to).toEqual(['liu_zhiyuan']);
  });

  it('refuses consent on someone\'s behalf and asks when unclear', async () => {
    expect((await map('替明公允约。')).kind).toBe('unsupported');
    expect((await map('遣使！')).kind).toBe('clarify'); // not approved yet
    expect((await map('嗯。')).kind).toBe('clarify');
  });

  it('downgrades a model action outside the player permissions to clarify', async () => {
    const { mock } = newMock();
    mock.register('mapper', () => ({
      kind: 'action',
      action: { type: 'speak', args: { to: ['shi_jingtang'], text: 'x' } },
      dialogue: null,
      question: null,
      reason: null,
    }));
    const d = driver('C1');
    const config = { ...d.config, player: { ...d.config.player, permissions: d.config.player.permissions.filter((p) => p !== 'speak') } };
    const r = await runMapper({ client: mock, content: content(), config, state: d.state, text: 'x', lang: 'en', identity: { round: 1 } });
    expect(r.kind).toBe('clarify');
    expect(r.downgraded).toMatch(/not a player permission/);
  });
});
