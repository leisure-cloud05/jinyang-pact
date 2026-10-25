/** In-character answers to the player's `ask` (PLAN §7): prompt, strict schema, mock persona, leakage scan. */
import { describe, expect, it } from 'vitest';
import { blockedAnswerLine, noAnswerLine, prepareAnswerCall, runAnswer } from '../../src/agents/answer.js';
import { buildNames } from '../../src/agents/names.js';
import { answerMock, registerMockPersonas } from '../../src/agents/mock-personas/index.js';
import { secretHits, secretsUnknownTo } from '../../src/agents/narration/index.js';
import { ANSWER_SYSTEM, ANSWER_USER, PROMPT_TEMPLATES } from '../../src/agents/prompts/index.js';
import { AGENT_SCHEMAS, AnswerOutputSchema } from '../../src/agents/schemas.js';
import { toStrictJsonSchema } from '../../src/llm/schemas.js';
import { cfg, content, initialOf, newMock, personas } from './helpers.js';

const facts = [{ zh: '石敬瑭：遣使送出doc:1第1版', en: 'shi_jingtang: dispatch doc:1 v1' }];

function opts(caseId: string, charId: 'shi_jingtang' | 'sang_weihan' | 'liu_zhiyuan', lang: 'zh' | 'en' = 'zh') {
  return {
    content: content(),
    config: cfg(caseId),
    state: initialOf(caseId),
    charId,
    lang,
    identity: { caseId, rep: 1, round: 1, epoch: 0, callTag: 'answer.t' },
    question: lang === 'zh' ? '此表所许，可乎？' : 'Is this offer wise?',
    facts,
    persona: personas(caseId)[charId],
  };
}

describe('answer role', () => {
  it('has a strict speech-only schema and versioned prompts in the frozen set', () => {
    expect(AGENT_SCHEMAS.answer.schema).toBe(AnswerOutputSchema);
    const json = toStrictJsonSchema(AnswerOutputSchema) as { properties: object; required: string[]; additionalProperties: boolean };
    expect(Object.keys(json.properties)).toEqual(['speech']);
    expect(json.additionalProperties).toBe(false);
    expect(AnswerOutputSchema.safeParse({ speech: 'x', actions: [] }).success).toBe(false);
    expect(PROMPT_TEMPLATES).toContain(ANSWER_SYSTEM);
    expect(PROMPT_TEMPLATES).toContain(ANSWER_USER);
  });

  it('builds the GENERATE context plus the pause facts and the question, in the narrative language', () => {
    for (const lang of ['zh', 'en'] as const) {
      const { messages, meta } = prepareAnswerCall(opts('C1', 'sang_weihan', lang));
      expect(messages[0]?.content).toContain(lang === 'zh' ? 'Simplified Chinese' : 'English');
      expect(messages[0]?.content).toContain('{"speech": string}');
      expect(messages[1]?.content).toContain(lang === 'zh' ? '此表所许，可乎？' : 'Is this offer wise?');
      expect(messages[1]?.content).toContain(lang === 'zh' ? facts[0]!.zh : facts[0]!.en);
      expect(meta.context.self.id).toBe('sang_weihan');
      expect(meta.agent).toBe('answer');
    }
  });

  it('mock answers are deterministic, in character, and never reveal a secret the player does not know (C4)', async () => {
    const state = initialOf('C4');
    const secrets = secretsUnknownTo(cfg('C4'), state, 'player');
    expect(secrets.length).toBeGreaterThan(0);
    for (const charId of ['shi_jingtang', 'sang_weihan', 'liu_zhiyuan'] as const) {
      const { meta } = prepareAnswerCall({ ...opts('C4', charId), state });
      const a = answerMock(meta);
      expect(answerMock(meta)).toEqual(a);
      expect(a.speech.length).toBeGreaterThan(0);
      expect(secretHits(a.speech, secrets)).toEqual([]);
    }
    const { mock } = newMock();
    registerMockPersonas(mock);
    const r = await runAnswer({ ...opts('C4', 'sang_weihan'), state, client: mock });
    expect(r.outcome).toBe('answered');
    expect(r.status).toBe('ok');
  });

  it('a leaking answer is blocked by the leakage scan (the speech is never returned)', async () => {
    const state = initialOf('C4');
    const canary = secretsUnknownTo(cfg('C4'), state, 'player')[0]?.canary as string;
    const { mock } = newMock();
    registerMockPersonas(mock);
    mock.register('answer', () => ({ speech: `密约之号乃${canary}。` }));
    const r = await runAnswer({ ...opts('C4', 'sang_weihan'), state, client: mock });
    expect(r.outcome).toBe('blocked');
    expect(r.text).toBe(blockedAnswerLine(buildNames(content()), 'sang_weihan', 'zh'));
    expect(r.text).not.toContain(canary);
    expect(JSON.stringify(r.leakHits)).not.toContain(canary);
    expect(r.leakHits.length).toBeGreaterThan(0);
  });

  it('a failed call yields the templated no-answer line', async () => {
    const { mock } = newMock();
    registerMockPersonas(mock);
    mock.injectFaults(['http_400'], { role: 'answer' });
    const r = await runAnswer({ ...opts('C1', 'shi_jingtang', 'en'), client: mock });
    expect(r.outcome).toBe('no_answer');
    expect(r.status).toBe('error');
    expect(r.text).toBe(noAnswerLine(buildNames(content()), 'shi_jingtang', 'en'));
  });
});
