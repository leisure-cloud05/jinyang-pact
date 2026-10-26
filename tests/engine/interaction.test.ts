/**
 * Interaction steps and the interaction ledger (PLAN §10.1, §10.3, §10.4), offline with scripted mock characters:
 * question → answer → decision within one round, later steps reading persisted results, persistent feedback, the
 * non-participant wait (Yelü's mother), invalid metadata, bounded repetition, the cap's fairness, budget stops,
 * crash recovery / epochs, replay of recorded outputs, and the three modes sharing the framework.
 */
import { describe, expect, it } from 'vitest';
import type { CharacterMeta } from '../../src/agents/character.js';
import type { CharacterOutput } from '../../src/agents/schemas.js';
import type { CharId, Mode } from '../../src/core/types.js';
import { EngineSession, interactionEnv, replayInteraction, schedule, type Ledger, type PendingCandidate, type StepName } from '../../src/engine/index.js';
import { caseCoreConfig, caseInitialState } from '../../src/content/loader.js';
import type { MockLlmClient } from '../../src/llm/mock/index.js';
import { runCase } from '../../src/engine/runner.js';
import { content, dbIn, mockFactory, onCleanup, run, tempDir, testClock } from './helpers.js';

type Interaction = NonNullable<CharacterOutput['interaction']>;
const out = (speech: string, actions: CharacterOutput['actions'], interaction: Interaction | null = null): CharacterOutput => ({
  speech,
  private_rationale: 'scripted',
  actions,
  ask_player: null,
  interaction,
});
const wait = { type: 'wait' as const, args: {}, rationale: 'w', cites: [] };
const metaOf = (req: { meta?: Record<string, unknown> }): CharacterMeta => req.meta as unknown as CharacterMeta;

/** Shi asks Liu before sealing; Liu answers; Shi seals and sends on the answer. Contexts are captured per actor. */
function qaScript(seen: Partial<Record<CharId, CharacterMeta[]>>) {
  return (m: MockLlmClient): void => {
    m.register({ role: 'character', actor: 'shi_jingtang' }, (req) => {
      const meta = metaOf(req);
      (seen.shi_jingtang ??= []).push(meta);
      const view = meta.context.interaction;
      const doc = meta.context.documents.find((d) => d.basis === 'observed' && d.status !== 'sent');
      const reply = view?.items.find((i) => i.kind === 'reply' && i.from === 'liu_zhiyuan');
      const asked = view?.myRequests.some((r) => r.to === 'liu_zhiyuan') ?? false;
      if (doc && reply) {
        const actions: CharacterOutput['actions'] = [];
        if (!(doc.status === 'approved' && doc.approvedVersion === doc.version)) actions.push({ type: 'approve_document', args: { docId: doc.docId, docVersion: doc.version }, rationale: 'seal', cites: [] });
        actions.push({ type: 'dispatch_document', args: { docId: doc.docId, docVersion: doc.version }, rationale: 'send', cites: [] });
        return out('依知远之言，即日用印遣使。', actions, { addressed: [{ item: reply.id, how: 'acted', note: 'sealed and sent' }], requests: [], wait_for: null });
      }
      if (doc && !asked) {
        return out('知远，此表可行否？', [wait], {
          addressed: [],
          requests: [{ to: 'liu_zhiyuan', topic: 'draft terms', question: '此表可行否？' }],
          wait_for: { on: 'reply', who: 'liu_zhiyuan', round: null, reason: 'need Liu on the terms' },
        });
      }
      return out('', [wait]);
    });
    m.register({ role: 'character', actor: 'liu_zhiyuan' }, (req) => {
      const meta = metaOf(req);
      (seen.liu_zhiyuan ??= []).push(meta);
      const ask = meta.context.interaction?.items.find((i) => i.kind === 'request' && i.from === 'shi_jingtang');
      if (ask) return out('可行，宜速遣使。', [wait], { addressed: [{ item: ask.id, how: 'answered', note: 'agree' }], requests: [], wait_for: null });
      return out('', [wait]);
    });
    m.register({ role: 'character', actor: 'sang_weihan' }, (req) => {
      (seen.sang_weihan ??= []).push(metaOf(req));
      return out('', [wait]);
    });
  };
}

function ledgerOf(r: Awaited<ReturnType<typeof run>>): Ledger {
  return r.engine!.records.ledger(r.sessionId, 'current') as Ledger;
}

function replayOk(r: Awaited<ReturnType<typeof run>>): void {
  expect(r.harness.replay(r.sessionId, 'patch').ok).toBe(true);
  expect(r.harness.replay(r.sessionId, 'rederive').mismatches).toEqual([]);
  expect(replayInteraction(interactionEnv(r.engine!.rt)).mismatches).toEqual([]);
}

describe('question → answer → decision within one world round', () => {
  it('Liu answers in step 2, Shi decides on the answer in step 3 of round 1; later steps read persisted results', async () => {
    const seen: Partial<Record<CharId, CharacterMeta[]>> = {};
    const r = await run('C1', 'no_judge', { llm: mockFactory({}, {}, qaScript(seen)).factory });
    expect(r.stepsByRound['1']).toBe(3);
    const dispatch = r.harness.repo.listEvents(r.sessionId).find((e) => e.kind === 'dispatch_document');
    expect(dispatch?.round).toBe(1);
    // Step 1 ran Shi and Sang in parallel: Sang's step-1 context cannot contain Shi's new question.
    const sangFirst = seen.sang_weihan?.[0];
    expect(sangFirst?.context.dialogue.some((d) => d.text.includes('此表可行否'))).toBe(false);
    // Liu (step 2) reads Shi's committed question; Shi (step 3) reads Liu's committed answer as a reply item.
    const liu = seen.liu_zhiyuan?.[0];
    expect(liu?.identity.callTag).toMatch(/^char\.s2\./);
    expect(liu?.context.dialogue.some((d) => d.text.includes('此表可行否'))).toBe(true);
    expect(liu?.context.interaction?.triggeredBy.length).toBeGreaterThan(0);
    const shiThird = seen.shi_jingtang?.find((m) => m.identity.callTag?.startsWith('char.s3.'));
    expect(shiThird?.context.interaction?.items.find((i) => i.kind === 'reply')?.text).toContain('可行');
    const items = ledgerOf(r).items;
    expect(items.find((i) => i.kind === 'request')?.closure?.reason).toBe('answered');
    expect(items.find((i) => i.kind === 'wait')?.closure?.reason).toBe('condition_met');
    expect(items.find((i) => i.kind === 'reply')?.status).toBe('resolved');
    replayOk(r);
  });

  it('a crash in step 2 restarts with a new epoch: the stale turn has no effect and nothing is lost or duplicated', async () => {
    const seen: Partial<Record<CharId, CharacterMeta[]>> = {};
    const dir = tempDir();
    const base = { caseId: 'C1', mode: 'no_judge' as const, rep: 1, dbPath: dbIn(dir), content: content(), clock: testClock() };
    let crashed = false;
    const hooks = {
      onStep: (s: StepName, info: { round: number; step: number }) => {
        if (!crashed && s === 'generate:called' && info.round === 1 && info.step === 2) {
          crashed = true;
          throw new Error('simulated crash');
        }
      },
    };
    await expect(runCase({ ...base, llm: mockFactory({}, {}, qaScript(seen)).factory, hooks })).rejects.toThrow('simulated crash');
    const r = await runCase({ ...base, llm: mockFactory({}, {}, qaScript(seen)).factory, keepOpen: true });
    const h = r.engine!.harness;
    onCleanup(() => h.close());
    const records = r.engine!.records;
    const ledger = records.ledger(r.sessionId, 'current') as Ledger;
    const keys = ledger.items.map((i) => i.sourceKey);
    expect(new Set(keys).size).toBe(keys.length);
    const request = ledger.items.find((i) => i.kind === 'request');
    expect(request?.events.filter((e) => e.kind === 'responded')).toHaveLength(1);
    expect(h.repo.listEpochs(r.sessionId).map((e) => e.reason)).toContain('recovery');
    const stale = new Set(h.repo.listBatches(r.sessionId).filter((b) => b.status === 'stale').map((b) => b.batchId));
    expect(stale.size).toBeGreaterThan(0);
    // No item event refers to a turn of the stale batch.
    expect(ledger.items.flatMap((i) => i.events).some((e) => e.turnId !== null && stale.has(e.turnId.split(':')[0] ?? ''))).toBe(false);
    expect(records.turns(r.sessionId).length).toBeGreaterThan(0);
    expect(ledger.items.filter((i) => i.kind === 'reply')).toHaveLength(1);
    expect(replayInteraction(interactionEnv(r.engine!.rt)).mismatches).toEqual([]);
  });

  it('replay re-parses the recorded outputs: a tampered turn record is detected', async () => {
    const r = await run('C1', 'no_judge', { llm: mockFactory({}, {}, qaScript({})).factory });
    r.harness.store.db.prepare(`UPDATE engine_turns SET interaction_json = 'null' WHERE session_id = ? AND actor = 'liu_zhiyuan'`).run(r.sessionId);
    expect(replayInteraction(interactionEnv(r.engine!.rt)).ok).toBe(false);
  });
});

it('refuses to resume an engine.v1 run with the v2 interaction ledger', async () => {
  const r = await run('C1', 'no_judge');
  r.harness.store.db.prepare('UPDATE engine_runs SET engine_version = ? WHERE session_id = ?').run('engine.v1', r.sessionId);
  expect(() => EngineSession.open(r.harness, { content: content(), llm: r.engine!.rt.client }, r.sessionId))
    .toThrow(/cannot resume engine\.v1 run with engine\.v2/);
});

describe('feedback, waits and invalid metadata', () => {
  it('feedback on a rejected proposal stays in the actor\'s context rounds later (no last-round filter)', async () => {
    const seen: CharacterMeta[] = [];
    const llm = mockFactory({}, {}, (m) =>
      m.register({ role: 'character', actor: 'sang_weihan' }, (req) => {
        const meta = metaOf(req);
        seen.push(meta);
        if (seen.length === 1) return out('', [{ type: 'allocate_resources', args: { faction: 'hedong', resource: 'silk', amount: 10000, purpose: 'pay_troops' }, rationale: 'x', cites: [] }]);
        return out('', [wait]);
      }),
    ).factory;
    const r = await run('P1', 'no_judge', { llm });
    const late = seen.find((m) => m.identity.round >= 4);
    const fb = late?.context.interaction?.items.find((i) => i.kind === 'feedback' && i.attempted?.type === 'allocate_resources');
    expect(fb).toBeDefined();
    expect(fb?.status).toBe('seen');
    expect(fb?.basis).toBe('verified');
    // Re-activated once for it in round 1 (step 2), then no longer a trigger.
    expect(seen.filter((m) => m.identity.round === 1).length).toBe(2);
    replayOk(r);
  });

  it('waiting for a non-participant (Yelü\'s mother) is returned to him with the limitation; he then decides', async () => {
    const seen: CharacterMeta[] = [];
    const llm = mockFactory({}, {}, (m) =>
      m.register({ role: 'character', actor: 'yelu_deguang' }, (req) => {
        const meta = metaOf(req);
        seen.push(meta);
        const limitation = meta.context.interaction?.items.find((i) => i.kind === 'feedback' && i.text.includes('not a participant'));
        const offer = meta.context.negotiations.flatMap((n) => n.threads.flatMap((t) => t.offers)).find((o) => o.awaitingMyAnswer);
        if (offer && limitation) {
          return out('', [{ type: 'confirm_commitment', args: { commitmentId: offer.commitmentId, offerId: offer.offerId, termsVersion: offer.termsVersion }, rationale: 'decide', cites: [] }], {
            addressed: [{ item: limitation.id, how: 'noted', note: 'decide myself' }],
            requests: [],
            wait_for: null,
          });
        }
        return out('', [wait], { addressed: [], requests: [], wait_for: { on: 'delivery', who: 'mother', round: null, reason: 'must tell my mother first' } });
      }),
    ).factory;
    const r = await run('C1', 'no_judge', { llm });
    expect(r.outcome).toBe('valid_terminal:pact_concluded');
    const confirm = r.harness.repo.listEvents(r.sessionId).find((e) => e.kind === 'confirm_commitment');
    expect(confirm?.round).toBe(seen[0]?.identity.round);
    expect(seen[1]?.identity.callTag).toMatch(/^char\.s2\./);
    expect(ledgerOf(r).items.some((i) => i.kind === 'wait' && i.responsible === 'yelu_deguang')).toBe(false); // never accepted
    replayOk(r);
  });

  it('invalid metadata gets explicit feedback; a request ping-pong is bounded by the step budget and carries over', async () => {
    let n = 0;
    const pingPong = (self: CharId, other: CharId) => (req: { meta?: Record<string, unknown> }) => {
      const view = metaOf(req).context.interaction;
      n += 1;
      const asks = view?.items.filter((i) => i.kind === 'request').map((i) => ({ item: i.id, how: 'answered' as const, note: 'ok' })) ?? [];
      return out('又及。', [wait], {
        addressed: [...asks, { item: 'i9999', how: 'noted', note: 'unknown id' }],
        requests: [
          { to: other, topic: `topic ${n}`, question: '尔意如何？' },
          ...(self === 'shi_jingtang' ? [{ to: 'yelu_deguang', topic: 'far', question: '?' }] : []),
        ],
        wait_for: null,
      });
    };
    const llm = mockFactory({}, {}, (m) => {
      m.register({ role: 'character', actor: 'shi_jingtang' }, pingPong('shi_jingtang', 'sang_weihan'));
      m.register({ role: 'character', actor: 'sang_weihan' }, pingPong('sang_weihan', 'shi_jingtang'));
    }).factory;
    const r = await run('C1', 'no_judge', { llm });
    for (const steps of Object.values(r.stepsByRound)) expect(steps).toBeLessThanOrEqual(4);
    const decisions = r.engine!.records.logs(r.sessionId, 'step_decision').map((l) => (l.data as { reason: string }).reason);
    expect(decisions).toContain('step_budget_exhausted');
    const items = ledgerOf(r).items;
    const meta = items.filter((i) => i.kind === 'feedback' && i.source.type === 'interaction' && i.responsible === 'shi_jingtang');
    expect(meta[0]?.text).toMatch(/not present|not one of your items/);
    // One correction opportunity per round: later invalid-metadata feedback of the same round backs off.
    expect(meta.filter((i) => i.created.round === 1).slice(1).every((i) => i.backoffRound === 2)).toBe(true);
    expect(items.some((i) => i.kind === 'request' && i.responsible === 'yelu_deguang')).toBe(false);
    expect((r.engine!.records.ledger(r.sessionId, 'current') as Ledger).counters.repeatedSpeech).toBeGreaterThan(0);
    expect(r.calls).toBeLessThanOrEqual(160);
    replayOk(r);
  });
});

describe('scheduling cap fairness', () => {
  it('a character left out by the cap keeps its older item and is served first in the next step', () => {
    const config = caseCoreConfig(content(), 'C1');
    const state = { ...caseInitialState(content(), 'C1'), round: 2, day: 5 };
    const quiet = Object.fromEntries(['shi_jingtang', 'sang_weihan', 'liu_zhiyuan', 'yelu_deguang', 'li_congke'].map((c) => [c, { agendaTriggers: [], periodicActivation: null }])) as never;
    const cand = (charId: CharId, seq: number): PendingCandidate => ({ charId, itemId: `i${seq}`, kind: 'request', tier: '1c', seq });
    const first = schedule({ state, config, personas: quiet, addressed: [], lastActivation: {}, events: [], step: 2, pending: [cand('shi_jingtang', 1), cand('sang_weihan', 2), cand('liu_zhiyuan', 3), cand('yelu_deguang', 4), cand('li_congke', 5)] });
    expect(first.skipped.map((s) => s.charId)).toEqual(['li_congke']);
    const next = schedule({ state, config, personas: quiet, addressed: [], lastActivation: {}, events: [], step: 3, pending: [cand('shi_jingtang', 6), cand('sang_weihan', 7), cand('liu_zhiyuan', 8), cand('yelu_deguang', 9), cand('li_congke', 5)] });
    expect(next.active[0]?.charId).toBe('li_congke');
  });
});

describe('budgets and stops', () => {
  it('an exhausted call budget is an execution stop with unresolved items recorded, never a world terminal', async () => {
    const r = await run('C1', 'no_judge', { budget: { maxCalls: 3 } });
    expect(r.outcome).toBe('budget_exhausted');
    expect(r.terminal).toBeNull();
    expect(r.stopReason).toBe('call_budget');
    const stop = r.engine!.records.logs(r.sessionId, 'run_stop')[0]?.data as { worldTerminal: string | null; unresolved: unknown[] };
    expect(stop.worldTerminal).toBeNull();
    expect(Array.isArray(stop.unresolved)).toBe(true);
  });

  it('a suspended run can be continued with a recorded budget extension; a finalized one cannot', async () => {
    const r = await run('C1', 'no_judge', { budget: { maxCalls: 3 }, onLimit: 'suspend' });
    const engine = r.engine!;
    expect(engine.harness.getSession(r.sessionId).status).toBe('suspended');
    const ext = engine.extendBudget({ addCalls: 200, reason: 'pilot continuation', by: 'test' });
    expect(ext.position.round).toBeGreaterThanOrEqual(1);
    engine.resume();
    const s = await engine.run();
    expect(s.outcome).toMatch(/^valid_terminal:/);
    expect(s.limits.maxCalls).toBe(203);
    expect(() => engine.extendBudget({ addCalls: 1, reason: 'again' })).toThrow(/finalized/);
  });
});

describe('the three modes share the interaction framework', () => {
  it.each(['baseline', 'no_judge', 'full'] as Mode[])('%s: steps, items and turns are recorded; the mode keeps its own enforcement', async (mode) => {
    const seen: Partial<Record<CharId, CharacterMeta[]>> = {};
    const r = await run('C1', mode, { llm: mockFactory({}, {}, qaScript(seen)).factory });
    expect(r.stepsByRound['1']).toBeGreaterThanOrEqual(2);
    expect(ledgerOf(r).items.find((i) => i.kind === 'request')?.closure?.reason).toBe('answered');
    expect(seen.shi_jingtang?.[0]?.variant).toBe(mode === 'baseline' ? 'baseline' : 'harness');
    const categories = Object.keys(r.pauses);
    if (mode === 'baseline') expect(categories).not.toContain('dispatch_request');
    else expect(categories).toContain('dispatch_request');
    expect((r.callsByRole.judge ?? 0) > 0).toBe(mode === 'full');
    replayOk(r);
  });
});
