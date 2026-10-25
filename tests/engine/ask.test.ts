/** `ask` during a pause (PLAN §7): in-character answers, no world change, budget/leak/idempotency rules. */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { blockedAnswerLine, noAnswerLine } from '../../src/agents/answer.js';
import { buildNames } from '../../src/agents/names.js';
import { secretsUnknownTo } from '../../src/agents/narration/index.js';
import { findCase } from '../../src/content/loader.js';
import { CallbackDecisionSource, EngineRecords, EngineSession, PolicyDecisionSource, type DecisionContext, type EngineEvent } from '../../src/engine/index.js';
import { Harness } from '../../src/harness/index.js';
import { registerSecret } from '../../src/llm/redact.js';
import { content, dbIn, invariantProblems, mockFactory, onCleanup, run, tempDir, testClock } from './helpers.js';

/** Asks once on the first pause of `category` (optionally naming whom), then follows the case policy. */
function askOnce(caseId: string, category: string, question: string, to: string | null = null): { source: CallbackDecisionSource; asks: DecisionContext[] } {
  const policy = new PolicyDecisionSource(findCase(content(), caseId).decision_policy);
  const asks: DecisionContext[] = [];
  const source = new CallbackDecisionSource((ctx) => {
    if (ctx.pause.category === category && asks.length === 0) {
      asks.push(ctx);
      return { option: 'ask', question, ...(to ? { to: to as never } : {}), by: 'user' };
    }
    return policy.decide(ctx);
  });
  return { source, asks };
}

describe('ask during a pause', () => {
  it('C1 full: the named character answers in character; the pause stays open; world hash and replay are unchanged', async () => {
    const clean = await run('C1', 'full');
    const { source, asks } = askOnce('C1', 'dispatch_request', '桑公，此表所许，契丹必允乎？', 'sang_weihan');
    const events: EngineEvent[] = [];
    const r = await run('C1', 'full', { decisions: source, hooks: { onEvent: (e) => events.push(e) } });
    expect(asks).toHaveLength(1);
    expect(asks[0]!.askable).toEqual(['shi_jingtang', 'sang_weihan', 'liu_zhiyuan']);
    expect(r.outcome).toBe(clean.outcome);
    expect(r.finalHash).toBe(clean.finalHash);
    expect(r.version).toBe(clean.version);
    const h = r.harness;
    // The pause took an ask (pause stayed open) and then the policy's endorse.
    const pause = h.repo.listPauses(r.sessionId).find((p) => p.category === 'dispatch_request')!;
    expect(h.repo.listSessionDecisions(r.sessionId).filter((d) => d.pauseId === pause.id).map((d) => d.option)).toEqual(['ask', 'endorse']);
    // Question to Sang, answer by Sang heard by the player (and those present).
    const dialogue = h.repo.listDialogue(r.sessionId);
    const question = dialogue.filter((d) => d.kind === 'question' && d.text === '桑公，此表所许，契丹必允乎？');
    expect(question.some((d) => d.listeners.includes('sang_weihan'))).toBe(true);
    const answer = dialogue.find((d) => d.kind === 'answer');
    expect(answer?.speaker).toBe('sang_weihan');
    expect(answer?.listeners).toContain('player');
    expect(answer?.text.length).toBeGreaterThan(0);
    // No world version change at the ask: the answer was recorded on the version the pause opened at.
    expect(answer?.worldVersion).toBe(question[0]?.worldVersion);
    const answerEvent = events.find((e) => e.type === 'answer');
    expect(answerEvent).toEqual(expect.objectContaining({ type: 'answer', charId: 'sang_weihan', outcome: 'answered', dialogueSeq: answer?.seq }));
    // Exactly one answer call, logged and budgeted like any call.
    expect(r.callsByRole.answer).toBe(1);
    expect(r.engine!.records.logs(r.sessionId, 'answer')).toEqual([expect.objectContaining({ data: expect.objectContaining({ outcome: 'answered', charId: 'sang_weihan' }) })]);
    expect(h.replay(r.sessionId, 'patch').ok).toBe(true);
    expect(h.replay(r.sessionId, 'rederive').mismatches).toEqual([]);
    expect(invariantProblems(h, r.sessionId)).toEqual([]);
  });

  it('without a name, the actor of the paused proposal answers; an unaskable name falls back (logged)', async () => {
    const { source } = askOnce('C1', 'dispatch_request', 'Why now?', 'yelu_deguang');
    const r = await run('C1', 'full', { decisions: source, lang: 'en' });
    const answer = r.harness.repo.listDialogue(r.sessionId).find((d) => d.kind === 'answer');
    expect(answer?.speaker).toBe('shi_jingtang');
    const ask = r.engine!.records.logs(r.sessionId, 'ask')[0]?.data as { rejected: string | null; to: string };
    expect(ask.to).toBe('shi_jingtang');
    expect(ask.rejected).toMatch(/yelu_deguang cannot be asked/);
  });

  it('an over-budget ask records the templated no-answer line and keeps the pause open (no error_recovery pause)', async () => {
    const { source } = askOnce('C1', 'dispatch_request', '为何如此？');
    // Round 1 uses 3 character calls + 1 Judge call: the answer is the 5th call and is refused.
    const r = await run('C1', 'full', { decisions: source, budget: { maxCalls: 4 } });
    const answer = r.harness.repo.listDialogue(r.sessionId).find((d) => d.kind === 'answer');
    expect(answer?.text).toBe(noAnswerLine(buildNames(content()), 'shi_jingtang', 'zh'));
    expect(r.engine!.records.logs(r.sessionId, 'answer')[0]?.data).toEqual(expect.objectContaining({ outcome: 'no_answer', errorKind: 'budget' }));
    expect(r.harness.repo.listPauses(r.sessionId).some((p) => p.category === 'error_recovery')).toBe(false);
    const pause = r.harness.repo.listPauses(r.sessionId).find((p) => p.category === 'dispatch_request')!;
    expect(r.harness.repo.listSessionDecisions(r.sessionId).filter((d) => d.pauseId === pause.id).map((d) => d.option)).toEqual(['ask', 'endorse']);
  });

  it('an answer that would leak a secret the player does not know is blocked (C4)', async () => {
    const { source } = askOnce('C4', 'dispatch_request', '封缄之中写的是什么？', 'sang_weihan');
    const probe = await run('C4', 'full');
    const canary = secretsUnknownTo(probe.harness.getSession(probe.sessionId).config, probe.harness.getState(probe.sessionId), 'player')[0]?.canary as string;
    expect(canary).toBeTruthy();
    const leaky = mockFactory({}, {}, (m) => m.register('answer', () => ({ speech: `封中所书，乃${canary}也。` })));
    const r = await run('C4', 'full', { decisions: source, llm: leaky.factory });
    const answer = r.harness.repo.listDialogue(r.sessionId).find((d) => d.kind === 'answer');
    expect(answer?.text).toBe(blockedAnswerLine(buildNames(content()), 'sang_weihan', 'zh'));
    expect(r.harness.repo.listDialogue(r.sessionId).some((d) => d.text.includes(canary))).toBe(false);
    const logged = r.engine!.records.logs(r.sessionId, 'answer')[0]?.data as { outcome: string; leakHits: unknown[] };
    expect(logged.outcome).toBe('blocked');
    expect(logged.leakHits.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.engine!.records.exportSession(r.sessionId))).not.toContain(canary);
  });

  it('is idempotent across a restart: a call in flight at the crash is never repeated', async () => {
    const dir = tempDir();
    const copy = path.join(dir, 'crash during answer.sqlite');
    const h = Harness.open(dbIn(dir));
    onCleanup(() => h.close());
    const clock = testClock();
    const { source } = askOnce('C1', 'dispatch_request', '为何如此？');
    // The answer handler snapshots the database while its call is in flight (the "crash"), then answers.
    const mocks = mockFactory({}, {}, (m) =>
      m.register('answer', () => {
        h.exportDatabase(copy);
        return { speech: '吾意已决。' };
      }),
    );
    const engine = EngineSession.create(h, { content: content(), llm: mocks.factory(h.usageSink()), decisions: source, clock }, { sessionId: 'A', caseId: 'C1', mode: 'full', rep: 1 });
    await engine.run();

    const restored = Harness.open(copy);
    onCleanup(() => restored.close());
    const records = new EngineRecords(restored.store);
    expect(records.logs('A', 'answer_call')).toHaveLength(1);
    expect(records.logs('A', 'answer')).toHaveLength(0);
    const policy = new PolicyDecisionSource(findCase(content(), 'C1').decision_policy);
    const again = mockFactory({}, {}, (m) => m.register('answer', () => ({ speech: 'SHOULD NOT BE CALLED' })));
    const resumed = EngineSession.open(restored, { content: content(), llm: again.factory(restored.usageSink()), decisions: policy, clock }, 'A');
    const summary = await resumed.run();
    expect(summary.outcome).toBe('valid_terminal:pact_concluded');
    expect(summary.callsByRole.answer ?? 0).toBe(0);
    const answers = restored.repo.listDialogue('A').filter((d) => d.kind === 'answer');
    expect(answers).toHaveLength(1);
    expect(answers[0]?.text).toBe(noAnswerLine(buildNames(content()), 'shi_jingtang', 'zh'));
    expect(records.logs('A', 'answer')[0]?.data).toEqual(expect.objectContaining({ outcome: 'no_answer', reason: expect.stringMatching(/not repeated/) }));
  });
});

describe('ask: review 40 regressions', () => {
  it('a crash between the answer dialogue and its completion marker leaves neither (atomic); restart completes without H06', async () => {
    class SimulatedCrash extends Error {}
    const dir = tempDir();
    const dbPath = dbIn(dir);
    const clock = testClock();
    const h = Harness.open(dbPath);
    const { source } = askOnce('C1', 'dispatch_request', '为何如此？');
    const engine = EngineSession.create(h, { content: content(), llm: mockFactory().factory(h.usageSink()), decisions: source, clock }, { sessionId: 'W', caseId: 'C1', mode: 'full', rep: 1 });
    const records = engine.records;
    const original = records.log.bind(records);
    let crashed = false;
    records.log = (sessionId, round, epoch, kind, data, key) => {
      if (kind === 'answer' && !crashed) {
        crashed = true;
        throw new SimulatedCrash('process died after the answer dialogue was written');
      }
      return original(sessionId, round, epoch, kind, data, key);
    };
    await expect(engine.run()).rejects.toThrow(SimulatedCrash);
    // The dialogue row was rolled back with the marker.
    expect(h.repo.listDialogue('W').filter((d) => d.kind === 'answer')).toEqual([]);
    h.close();

    const reopened = Harness.open(dbPath);
    onCleanup(() => reopened.close());
    const policy = new PolicyDecisionSource(findCase(content(), 'C1').decision_policy);
    const resumed = EngineSession.open(reopened, { content: content(), llm: mockFactory().factory(reopened.usageSink()), decisions: policy, clock }, 'W');
    const summary = await resumed.run();
    expect(summary.outcome).toBe('valid_terminal:pact_concluded');
    const answers = reopened.repo.listDialogue('W').filter((d) => d.kind === 'answer');
    expect(answers).toHaveLength(1);
    expect(answers[0]?.text).toBe(noAnswerLine(buildNames(content()), 'shi_jingtang', 'zh'));
    expect(summary.callsByRole.answer).toBe(1); // the call made before the crash; never repeated
  });

  it('recovery reads back an answer dialogue that was persisted without its marker (no second row, no H06)', async () => {
    const dir = tempDir();
    const copy = path.join(dir, 'after the answer.sqlite');
    const h = Harness.open(dbIn(dir));
    onCleanup(() => h.close());
    const clock = testClock();
    const { source } = askOnce('C1', 'dispatch_request', '为何如此？');
    let snapped = false;
    const engine = EngineSession.create(
      h,
      {
        content: content(),
        llm: mockFactory().factory(h.usageSink()),
        decisions: source,
        clock,
        hooks: { onEvent: (e) => void (e.type === 'answer' && !snapped && ((snapped = true), h.exportDatabase(copy))) },
      },
      { sessionId: 'R', caseId: 'C1', mode: 'full', rep: 1 },
    );
    await engine.run();
    const restored = Harness.open(copy);
    onCleanup(() => restored.close());
    // Simulate an older store that wrote the dialogue but lost the completion marker.
    restored.store.db.prepare(`DELETE FROM engine_log WHERE session_id = 'R' AND kind = 'answer'`).run();
    const policy = new PolicyDecisionSource(findCase(content(), 'C1').decision_policy);
    const resumed = EngineSession.open(restored, { content: content(), llm: mockFactory().factory(restored.usageSink()), decisions: policy, clock }, 'R');
    const summary = await resumed.run();
    expect(summary.outcome).toBe('valid_terminal:pact_concluded');
    const answers = restored.repo.listDialogue('R').filter((d) => d.kind === 'answer');
    expect(answers).toHaveLength(1);
    expect(new EngineRecords(restored.store).logs('R', 'answer')[0]?.data).toEqual(expect.objectContaining({ recovered: true, dialogueSeq: answers[0]?.seq }));
  });

  it('a credential pasted into the question is redacted once at ingestion: never in the answer request nor in events', async () => {
    const secret = 'synthetic-api-key-ZX81-do-not-ship-0123456789';
    registerSecret(secret);
    const captured: string[] = [];
    const mocks = mockFactory({}, {}, (m) =>
      m.register('answer', (req) => {
        captured.push(req.messages.map((x) => x.content).join('\n'));
        return { speech: '吾意已决。' };
      }),
    );
    const { source } = askOnce('C1', 'dispatch_request', `我的钥匙是 ${secret}，此表可乎？`);
    const events: EngineEvent[] = [];
    const r = await run('C1', 'full', { decisions: source, llm: mocks.factory, hooks: { onEvent: (e) => events.push(e) } });
    expect(captured).toHaveLength(1);
    expect(captured[0]).not.toContain(secret);
    expect(captured[0]).toContain('[REDACTED]');
    const answer = events.find((e) => e.type === 'answer') as Extract<EngineEvent, { type: 'answer' }>;
    expect(answer.question).not.toContain(secret);
    expect(answer.question).toContain('[REDACTED]');
    expect(JSON.stringify(r.harness.repo.listDialogue(r.sessionId))).not.toContain(secret);
    expect(JSON.stringify(r.engine!.records.exportSession(r.sessionId))).not.toContain(secret);
  });
});
