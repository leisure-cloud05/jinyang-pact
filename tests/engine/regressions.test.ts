/** Regression tests for the WP-D review (review 24 in docs/review_log.md, majors 1–9). */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { findCase } from '../../src/content/loader.js';
import {
  CallbackDecisionSource,
  EngineRecords,
  EngineSession,
  PolicyDecisionSource,
  restoreBudgetClient,
  runCase,
  type DecisionContext,
  type PlayerSource,
  type StepName,
} from '../../src/engine/index.js';
import { Harness } from '../../src/harness/index.js';
import type { JudgeMeta } from '../../src/agents/judge.js';
import { BudgetedClient } from '../../src/llm/budget.js';
import { DEFAULT_PRICES } from '../../src/llm/prices.js';
import type { LlmClient, LlmRequest, LlmResult } from '../../src/llm/types.js';
import { content, dbIn, invariantProblems, mockFactory, onCleanup, run, tempDir, testClock } from './helpers.js';

class SimulatedCrash extends Error {}

function crashOnce(step: StepName, round: number) {
  let crashed = false;
  return {
    onStep: (s: StepName, info: { round: number }) => {
      if (!crashed && s === step && info.round === round) {
        crashed = true;
        throw new SimulatedCrash(`crash at ${step} in round ${round}`);
      }
    },
  };
}

function policyOf(caseId: string): PolicyDecisionSource {
  return new PolicyDecisionSource(findCase(content(), caseId).decision_policy);
}

describe('1: a narration backlog never makes recovery skip a round', () => {
  it('round-1 narration fails twice, ADVANCE, crash at round-2 PLAYER, restart: round 2 is fully played', async () => {
    const clean = await run('C1', 'full');
    const dir = tempDir();
    const base = { caseId: 'C1', mode: 'full' as const, rep: 1, dbPath: dbIn(dir), content: content(), clock: testClock() };
    const failingNarrator = mockFactory({}, { httpRetries: 0 }, (m) => m.injectFaults(['http_500', 'http_500', 'http_500', 'http_500'], { role: 'narrator' }));
    await expect(runCase({ ...base, llm: failingNarrator.factory, hooks: crashOnce('player', 2) })).rejects.toThrow(SimulatedCrash);
    const resumed = await runCase({ ...base, llm: mockFactory().factory, keepOpen: true });
    const h = resumed.engine!.harness;
    onCleanup(() => h.close());
    expect(h.repo.listRoundStarts(resumed.sessionId).map((s) => s.round)).toEqual([1, 2, 3]);
    const rounds = h.repo.committedBatches(resumed.sessionId);
    expect([...new Set(rounds.filter((b) => b.kind === 'character').map((b) => b.round))]).toEqual([1, 2]);
    expect(rounds.filter((b) => b.kind === 'system_advance').map((b) => b.round)).toEqual([1, 2]);
    expect(resumed.outcome).toBe(clean.outcome);
    expect(resumed.finalHash).toBe(clean.finalHash);
    // The round-1 backlog was narrated after restart (world untouched).
    expect(rounds.filter((b) => b.kind === 'character' && b.narrationStatus !== 'done')).toEqual([]);
    expect(h.replay(resumed.sessionId, 'rederive').mismatches).toEqual([]);
  });
});

describe('2: PLAYER is crash-safe', () => {
  it('a crash inside the PLAYER step loses neither direct inputs nor queued instructions, and asks the source once', async () => {
    const dir = tempDir();
    const dbPath = dbIn(dir);
    let turns = 0;
    const script = findCase(content(), 'C1').script;
    const players: PlayerSource = {
      turn: (ctx) => {
        turns += 1;
        return {
          script: script.find((s) => s.round === ctx.round)?.inputs ?? [],
          inputs: ctx.round === 1 ? [{ kind: 'dialogue', to: ['sang_weihan'], text: 'DIRECT-INPUT-MARKER' }] : [],
        };
      },
    };
    let armed = false;
    let stages = 0;
    const crashing = Harness.open(dbPath, {
      hooks: {
        onStage: (stage) => {
          if (!armed || stage !== 'before_commit') return;
          stages += 1;
          if (stages === 3) throw new SimulatedCrash('crash while delivering the queued instruction');
        },
      },
    });
    const opts = { content: content(), players, clock: testClock() };
    const engine = EngineSession.create(crashing, { ...opts, llm: mockFactory().factory(crashing.usageSink()), hooks: { onStep: (s: StepName) => void (s === 'player' && (armed = true)) } }, { sessionId: 'P', caseId: 'C1', mode: 'full', rep: 1 });
    await engine.step(); // PREPARE
    engine.interrupt('QUEUED-INSTRUCTION-MARKER'); // no character batch open: queued for the PLAYER step
    await expect(engine.step()).rejects.toThrow(SimulatedCrash);
    // Nothing of the PLAYER step committed (one transaction), but the turn was persisted before execution.
    expect(crashing.repo.listDialogue('P').filter((d) => d.speaker === 'player')).toEqual([]);
    expect(crashing.repo.listInstructions('P')[0]?.status).toBe('queued');
    crashing.close();

    const h = Harness.open(dbPath);
    onCleanup(() => h.close());
    const resumed = EngineSession.open(h, { ...opts, llm: mockFactory().factory(h.usageSink()) }, 'P');
    const summary = await resumed.run();
    expect(summary.outcome).toBe('valid_terminal:pact_concluded');
    const said = h.repo.listDialogue('P').filter((d) => d.speaker === 'player').map((d) => d.text);
    expect(said.filter((t) => t === 'DIRECT-INPUT-MARKER')).toHaveLength(1);
    expect(said.filter((t) => t === 'QUEUED-INSTRUCTION-MARKER')).toHaveLength(1);
    expect(h.repo.listInstructions('P')[0]).toEqual(expect.objectContaining({ status: 'applied', appliedRound: 1 }));
    expect(turns).toBe(summary.rounds - 1); // one turn per played PLAYER step; round 1 was not asked twice
    expect(h.replay('P', 'rederive').mismatches).toEqual([]);
  });
});

describe('3: narration budget refusals reach the limit handling', () => {
  it('C1 no_judge with 9 calls: a call limit stops execution without inventing a world terminal', async () => {
    const r = await run('C1', 'no_judge', { budget: { maxCalls: 9 } });
    expect(r.outcome).toBe('budget_exhausted');
    expect(r.harness.repo.listRequests(r.sessionId).map((q) => q.op)).toContain('suspend');
    const pending = r.harness.repo.committedBatches(r.sessionId).filter((b) => b.kind === 'character' && b.narrationStatus !== 'done');
    // With several interaction steps, nine calls can be spent before a narration is pending.
    for (const b of pending) expect(r.harness.repo.committedBatches(r.sessionId).some((x) => x.kind === 'system_advance' && x.round === b.round)).toBe(false);
    expect(r.terminal).toBeNull();
  });
});

describe('4: the restored budget reserves the worst case with effective pricing', () => {
  const schema = z.object({ ok: z.boolean() });
  const request = (sessionId: string): LlmRequest<{ ok: boolean }> => ({
    role: 'character',
    sessionId,
    messages: [{ role: 'user', content: 'x'.repeat(4000) }],
    schema,
    schemaName: 'probe',
  });
  const pricing = { models: { character: 'deepseek/deepseek-v4-flash' }, maxTokens: { character: 700 }, prices: DEFAULT_PRICES, httpRetries: 2, requirePrice: true };
  const worstCase = (): number =>
    new BudgetedClient({ complete: () => Promise.reject(new Error('unused')) }, { maxCallsPerSession: 100, maxUsdPerSession: 1 }, {
      resolveModel: () => pricing.models.character,
      resolveMaxTokens: () => 700,
      prices: DEFAULT_PRICES,
    }).reservationUsd(request('S') as LlmRequest<unknown>) as number;
  function fake(cost: (reserved: number) => number | null): LlmClient {
    return {
      complete: async <T>(req: LlmRequest<T>): Promise<LlmResult<T>> => {
        await new Promise((r) => setTimeout(r, 5));
        const c = cost(worstCase());
        return { ok: true, value: { ok: true } as T, raw: '{"ok":true}', usage: { inputTokens: 1, outputTokens: 1, costUsd: c, costSource: c === null ? 'none' : 'reported' }, attempts: 1, latencyMs: 5, model: req.model ?? 'deepseek/deepseek-v4-flash' };
      },
    };
  }

  it('prior spend + parallel calls never exceed the USD cap after a restart', async () => {
    const h = Harness.open(dbIn(tempDir()));
    onCleanup(() => h.close());
    const records = new EngineRecords(h.store);
    const r = worstCase();
    expect(r).toBeGreaterThan(0);
    const prior = records.chargeBegin('S', 'character', 0);
    records.chargeEnd(prior, { status: 'done', chargedUsd: 0.5 - 1.5 * r, attempts: 1, unknownCost: false });
    const client = restoreBudgetClient(h, records, 'S', fake((reserved) => reserved), { content: content(), llm: fake(() => 0), budget: { maxUsd: 0.5 }, pricing });
    const results = await Promise.all([1, 2, 3].map(() => client.complete(request('S'))));
    expect(results.filter((x) => x.ok)).toHaveLength(1);
    expect(results.filter((x) => !x.ok && x.error.kind === 'budget')).toHaveLength(2);
    expect(records.usedBudget('S').usd).toBeLessThanOrEqual(0.5 + 1e-12);
  });

  it('unknown-cost and unfinished calls are charged at their worst case; a live client without a price is refused', async () => {
    const h = Harness.open(dbIn(tempDir()));
    onCleanup(() => h.close());
    const records = new EngineRecords(h.store);
    const client = restoreBudgetClient(h, records, 'U', fake(() => null), { content: content(), llm: fake(() => null), pricing });
    await client.complete(request('U'));
    expect(records.usedBudget('U')).toEqual(expect.objectContaining({ calls: 1, unknownCostCalls: 1 }));
    expect(records.usedBudget('U').usd).toBeCloseTo(worstCase(), 12);
    records.chargeBegin('V', 'judge', 0.2); // in flight when the process died
    expect(records.usedBudget('V')).toEqual({ calls: 1, usd: 0.2, unknownCostCalls: 1 });
    const unpriced = restoreBudgetClient(h, records, 'W', fake(() => 0), { content: content(), llm: fake(() => 0), pricing: { models: { character: 'vendor/unknown' } } });
    const refused = await unpriced.complete(request('W'));
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error.kind).toBe('config');
  });
});

describe('5: Judge failures open an error_recovery pause', () => {
  it('a Judge timeout pauses (retry) before submission; the retried Judge assesses', async () => {
    const mocks = mockFactory({}, { httpRetries: 0 }, (m) => m.injectFaults(['timeout'], { role: 'judge' }));
    const r = await run('C2', 'full', { llm: mocks.factory });
    const pause = r.harness.repo.listPauses(r.sessionId).find((p) => p.category === 'error_recovery');
    expect(pause?.meta?.actor).toBe('judge');
    expect(r.harness.repo.listSessionDecisions(r.sessionId).find((d) => d.pauseId === pause?.id)?.option).toBe('retry');
    const judge = r.engine!.records.logs(r.sessionId, 'judge').map((l) => l.data as { attempt: number; status: string });
    expect(judge[0]).toEqual(expect.objectContaining({ attempt: 0, status: 'error' }));
    expect(judge[1]).toEqual(expect.objectContaining({ attempt: 1, status: 'ok' }));
    expect(r.outcome).toBe('valid_terminal:pact_concluded');
    expect(r.harness.replay(r.sessionId, 'rederive').mismatches).toEqual([]);
  });

  it('skip records the unassessed proposals as misses (no bogus proposal), stop ends the run', async () => {
    const policy = policyOf('C2');
    const skip = new CallbackDecisionSource((ctx) => (ctx.pause.category === 'error_recovery' ? { option: 'skip_actor', by: 'user' } : policy.decide(ctx)));
    const skipped = await run('C2', 'full', { decisions: skip, llm: mockFactory({}, { httpRetries: 0 }, (m) => m.injectFaults(['timeout'], { role: 'judge' })).factory });
    const misses = skipped.engine!.records.logs(skipped.sessionId, 'judge_skipped');
    expect(misses).toHaveLength(1);
    expect((misses[0]?.data as { misses: string[] }).misses.length).toBeGreaterThan(0);
    expect(skipped.harness.repo.listSessionProposals(skipped.sessionId).some((p) => (p.actor as string) === 'judge')).toBe(false);
    expect(skipped.harness.replay(skipped.sessionId, 'rederive').mismatches).toEqual([]);
    const stop = new CallbackDecisionSource((ctx) => (ctx.pause.category === 'error_recovery' ? { option: 'stop', by: 'user' } : policy.decide(ctx)));
    const stopped = await run('C2', 'full', { decisions: stop, llm: mockFactory({}, { httpRetries: 0 }, (m) => m.injectFaults(['timeout'], { role: 'judge' })).factory });
    expect(stopped.outcome).toBe('error');
  });
});

describe('6: the wall-clock deadline', () => {
  it('expiring during the step that produces the terminal ⇒ suspended (error), not a valid completion', async () => {
    let now = Date.UTC(2026, 8, 30);
    const clock = (): number => (now += 1000);
    const r = await run('C1', 'full', {
      clock,
      hooks: { onStep: (s: StepName, info: { round: number }) => void (s === 'prepare' && info.round === 3 && (now += 30 * 60 * 1000)) },
    });
    expect(r.terminal?.kind).toBe('pact_concluded');
    expect(r.outcome).toBe('error');
    expect(r.outcomeDetail).toMatch(/wall-clock/);
  });

  it('a watchdog aborts outstanding calls when the deadline passes', async () => {
    let now = Date.UTC(2026, 8, 30);
    const clock = (): number => (now += 10);
    const slow = mockFactory({}, {}, (m) =>
      m.register({ role: 'character', actor: 'li_congke' }, async () => {
        now += 60 * 60 * 1000;
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        return { speech: '', private_rationale: '', actions: [], ask_player: null };
      }),
    );
    const started = Date.now();
    const r = await run('C1', 'no_judge', { clock, llm: slow.factory, deadlinePollMs: 20 });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(r.outcome).toBe('error');
    expect(r.outcomeDetail).toMatch(/wall-clock/);
    expect(r.harness.repo.listSessionProposals(r.sessionId).filter((p) => p.status === 'committed')).toEqual([]);
  });
});

describe('7: an interrupt while a decision is awaited', () => {
  it('discards the superseded answer and restarts at PLAYER (mandatory pause)', async () => {
    const dir = tempDir();
    const h = Harness.open(dbIn(dir));
    onCleanup(() => h.close());
    const policy = policyOf('C1');
    let engine: EngineSession | null = null;
    let interrupted = false;
    const decisions = new CallbackDecisionSource(async (ctx: DecisionContext) => {
      const choice = policy.decide(ctx);
      if (!interrupted && ctx.pause.category === 'dispatch_request') {
        interrupted = true;
        await Promise.resolve();
        engine?.interrupt('WAIT-MARKER');
      }
      return choice;
    });
    engine = EngineSession.create(h, { content: content(), llm: mockFactory().factory(h.usageSink()), decisions, clock: testClock() }, { sessionId: 'I', caseId: 'C1', mode: 'full', rep: 1 });
    const summary = await engine.run();
    expect(summary.outcome).toBe('valid_terminal:pact_concluded');
    expect(engine.records.logs('I', 'decision_discarded')).toHaveLength(1);
    expect(h.repo.listPauses('I').filter((p) => p.category === 'dispatch_request').map((p) => p.status)).toEqual(['obsolete', 'resolved']);
    expect(h.repo.listDialogue('I').some((d) => d.text === 'WAIT-MARKER')).toBe(true);
    expect(invariantProblems(h, 'I')).toEqual([]);
    expect(h.replay('I', 'rederive').mismatches).toEqual([]);
  });

  it('discards a superseded error-recovery answer too', async () => {
    const dir = tempDir();
    const h = Harness.open(dbIn(dir));
    onCleanup(() => h.close());
    const policy = policyOf('C1');
    let engine: EngineSession | null = null;
    const decisions = new CallbackDecisionSource(async (ctx: DecisionContext) => {
      if (ctx.pause.category === 'error_recovery') {
        await Promise.resolve();
        engine?.interrupt('RETRY-LATER');
        return { option: 'retry', by: 'user' };
      }
      return policy.decide(ctx);
    });
    engine = EngineSession.create(
      h,
      { content: content(), llm: mockFactory().factory(h.usageSink()), decisions, clock: testClock(), faults: [{ round: 1, kind: 'llm_timeout', target: 'shi_jingtang' }] },
      { sessionId: 'E', caseId: 'C1', mode: 'no_judge', rep: 1 },
    );
    const summary = await engine.run();
    expect(engine.records.logs('E', 'decision_discarded')).toHaveLength(1);
    expect(h.repo.listPauses('E').find((p) => p.category === 'error_recovery')?.status).toBe('obsolete');
    expect(summary.outcome).toBe('valid_terminal:pact_concluded');
    expect(h.replay('E', 'rederive').mismatches).toEqual([]);
  });
});

describe('9: REVISE keeps full envelopes (never executed) in the audit bundle', () => {
  it('originals and replacements are persisted with stable ids and links, and exported', async () => {
    const r = await run('C2', 'full', { llm: mockFactory({ judge: { reviseGoalConflicts: true } }).factory });
    const revisions = r.engine!.records.revisions(r.sessionId);
    const original = revisions.find((x) => x.kind === 'original' && (x.envelope.action as { type: string }).type === 'revise_document');
    const replacement = revisions.find((x) => x.kind === 'replacement' && x.actor === original?.actor);
    // Every draft of the revised actor is kept (its speech too), each with its full envelope.
    expect(revisions.filter((x) => x.kind === 'original' && x.actor === original?.actor).length).toBeGreaterThan(1);
    expect(original).toBeDefined();
    expect(replacement).toBeDefined();
    expect((original!.envelope.action as { type: string }).type).toBe('revise_document');
    expect(original!.envelope.rationale.length).toBeGreaterThan(0);
    expect(original!.envelope.callTag).toMatch(/^char\./);
    expect(original!.verdict).toEqual(expect.objectContaining({ verdict: 'REVISE', category: 'goal_conflict' }));
    expect(original!.links.replacedBy).toContain(replacement!.revisionId);
    expect(replacement!.links.replaces).toContain(original!.revisionId);
    const proposal = r.harness.repo.listSessionProposals(r.sessionId).find((p) => p.proposalId === replacement!.links.proposalId);
    expect(proposal?.batchId).toBe(original!.batchId);
    // The original was never submitted, hence never executed.
    const batch = r.harness.repo.listProposals(original!.batchId);
    expect(batch.some((p) => p.actor === original!.actor && JSON.stringify(p.action) === JSON.stringify(original!.envelope.action))).toBe(false);
    const dir = tempDir();
    const files = r.engine!.exportAudit(path.join(dir, 'audit'));
    const exported = readFileSync(files.find((f) => f.endsWith('revisions.jsonl'))!, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { revisionId: string });
    expect(exported.map((e) => e.revisionId)).toEqual(revisions.map((x) => x.revisionId));
    expect(r.outcome).toMatch(/^valid_terminal:/);
  });
});

describe('re-review: deadline during the awaited player turn (6)', () => {
  it('a turn awaited past the deadline is not applied; the run suspends (then stops with error)', async () => {
    let now = Date.UTC(2026, 9, 1);
    const clock = (): number => (now += 1000);
    const players: PlayerSource = {
      turn: async () => {
        now += 30 * 60 * 1000; // the player took too long
        await Promise.resolve();
        return { script: [{ action: { type: 'set_dispatch_timing', args: { docId: 'doc:1', mode: 'delay', rounds: 1 } } }] };
      },
    };
    const r = await run('C1', 'full', { clock, players });
    expect(r.outcome).toBe('error');
    expect(r.outcomeDetail).toMatch(/wall-clock/);
    const h = r.harness;
    expect(h.repo.listRequests(r.sessionId).map((q) => q.op)).toContain('suspend');
    expect(h.repo.findRequest(r.sessionId, 'r1.script')).toBeNull();
    expect(h.getState(r.sessionId).documents['doc:1']?.timing.mode).toBe('now');
    expect(h.repo.committedBatches(r.sessionId).map((b) => b.kind)).toEqual(['system_prepare']);
    // The input is kept (persisted turn) for a resume, not lost.
    expect(r.engine!.records.findTurn(r.sessionId, 1)).toEqual(expect.objectContaining({ script: [expect.objectContaining({ action: expect.anything() })] }));
  });
});

describe('re-review: REVISE envelopes survive a stop during re-assessment (9)', () => {
  it('originals and replacements are persisted before the re-assessment and keep their status', async () => {
    const policy = policyOf('C1');
    const stop = new CallbackDecisionSource((ctx) => (ctx.pause.category === 'error_recovery' ? { option: 'stop', by: 'user' } : policy.decide(ctx)));
    // A Judge that sends Shi's dispatch back once (REVISE); the revised output (approval only) is re-assessed, and
    // that re-assessment times out; the user stops the run.
    const mocks = mockFactory({}, { httpRetries: 0 }, (m) => {
      m.register('judge', (req) => {
        const meta = req.meta as unknown as JudgeMeta;
        return {
          items: meta.context.proposals.map((p) => ({
            proposal_id: p.proposal_id,
            verdict: !meta.reassessment && p.type === 'dispatch_document' ? 'REVISE' : 'CONTINUE',
            category: !meta.reassessment && p.type === 'dispatch_document' ? 'goal_conflict' : null,
            reason: 'probe',
            question: null,
          })),
        };
      });
      m.injectFaults(['timeout'], { role: 'judge', callTag: 'rejudge.s1.g0' });
    });
    const r = await run('C1', 'full', { llm: mocks.factory, decisions: stop });
    expect(r.outcome).toBe('error');
    const revisions = r.engine!.records.revisions(r.sessionId);
    const original = revisions.find((x) => x.kind === 'original' && (x.envelope.action as { type: string }).type === 'dispatch_document');
    expect(original?.status).toBe('replaced');
    expect(original?.envelope.rationale.length).toBeGreaterThan(0);
    const replacements = revisions.filter((x) => x.kind === 'replacement' && x.actor === original?.actor);
    expect(replacements.length).toBeGreaterThan(0);
    expect(replacements.every((x) => x.status === 'pending_reassessment' && x.links.replaces?.includes(original!.revisionId))).toBe(true);
    expect(original!.links.replacedBy).toEqual(replacements.map((x) => x.revisionId));
    // Nothing of the batch was submitted or executed.
    expect(r.harness.repo.listProposals(original!.batchId)).toEqual([]);
    // The export of this stopped run (no reopen) links the failed re-assessment's defaulted verdicts.
    const files = r.engine!.exportAudit(path.join(tempDir(), 'audit'));
    const engineJson = JSON.parse(readFileSync(files.find((f) => f.endsWith('engine.json'))!, 'utf8')) as { log: Array<{ kind: string; data: Record<string, unknown> }> };
    const reassessment = engineJson.log.find((l) => l.kind === 'judge' && l.data.reassessment === true && l.data.status === 'error');
    expect(reassessment).toBeDefined();
    const verdicts = reassessment!.data.verdicts as Array<{ proposalId: string; realProposalId?: string | null; revisionId?: string | null; defaulted: boolean }>;
    expect(verdicts.length).toBeGreaterThan(0);
    const revisionIds = new Set(revisions.map((x) => x.revisionId));
    for (const v of verdicts) {
      expect(v).toHaveProperty('realProposalId', null); // replacement never submitted
      expect(revisionIds.has(v.revisionId as string)).toBe(true);
    }
    const refs = reassessment!.data.defaultedRefs as Array<{ judgeId: string; revisionId: string | null }>;
    expect(refs.map((x) => x.judgeId)).toEqual(verdicts.filter((v) => v.defaulted).map((v) => v.proposalId));
    expect(refs.every((x) => x.revisionId !== null && revisionIds.has(x.revisionId))).toBe(true);
  });
});

describe('re-review: reopening a finalized run is idempotent (10)', () => {
  it.each([
    ['C1', 'valid_terminal:pact_concluded', {}],
    ['D1', 'max_rounds', {}],
    ['C1', 'budget_exhausted', { budget: { maxCalls: 3 } }],
  ] as const)('%s → %s keeps its outcome when reopened after its deadline', async (caseId, outcome, extra) => {
    const dir = tempDir();
    const base = { caseId, mode: 'full' as const, rep: 1, dbPath: dbIn(dir), content: content(), ...extra };
    const first = await runCase({ ...base, llm: mockFactory().factory, clock: testClock() });
    expect(first.outcome).toBe(outcome);
    const probe = Harness.open(base.dbPath);
    const requestsBefore = probe.repo.listRequests(first.sessionId).length;
    probe.close();
    let late = Date.UTC(2027, 0, 1);
    const reopened = await runCase({ ...base, llm: mockFactory().factory, clock: () => (late += 1000), keepOpen: true });
    const h = reopened.engine!.harness;
    onCleanup(() => h.close());
    expect(reopened.outcome).toBe(outcome);
    expect(reopened.status).toBe(first.status);
    expect(reopened.finalHash).toBe(first.finalHash);
    expect(h.repo.listRequests(reopened.sessionId)).toHaveLength(requestsBefore);
    const again = await reopened.engine!.run();
    expect(h.repo.listRequests(reopened.sessionId)).toHaveLength(requestsBefore);
    expect(again.outcome).toBe(outcome);
    expect(again.status).toBe(first.status);
    expect(reopened.engine!.records.logs(reopened.sessionId, 'suspended').length).toBe(outcome === 'budget_exhausted' ? 1 : 0);
  });
});

describe('Judge records carry real ids (WP-F follow-up)', () => {
  const reviseDispatch = (m: import('../../src/llm/mock/index.js').MockLlmClient): void => {
    m.register('judge', (req) => {
      const meta = req.meta as unknown as JudgeMeta;
      return {
        items: meta.context.proposals.map((p) => ({
          proposal_id: p.proposal_id,
          verdict: !meta.reassessment && p.type === 'dispatch_document' ? 'REVISE' : 'CONTINUE',
          category: !meta.reassessment && p.type === 'dispatch_document' ? 'goal_conflict' : null,
          reason: 'probe',
          question: null,
        })),
      };
    });
  };

  it.each([
    ['normal + REVISE re-assessment', () => run('C1', 'full', { llm: mockFactory({}, {}, reviseDispatch).factory })],
    ['defaulted/skipped', () => {
      const policy = policyOf('C2');
      const skip = new CallbackDecisionSource((ctx) => (ctx.pause.category === 'error_recovery' ? { option: 'skip_actor', by: 'user' } : policy.decide(ctx)));
      return run('C2', 'full', { decisions: skip, llm: mockFactory({}, { httpRetries: 0 }, (m) => m.injectFaults(['timeout'], { role: 'judge' })).factory });
    }],
  ] as const)('%s: every exported Judge verdict/ref names a proposal or a revision that exists', async (_name, go) => {
    const r = await go();
    const exported = r.engine!.records.exportSession(r.sessionId);
    const proposals = new Set(r.harness.repo.listSessionProposals(r.sessionId).map((p) => p.proposalId));
    const revisions = new Set(exported.revisions.map((x) => x.revisionId));
    const judgeLogs = exported.log.filter((l) => l.kind === 'judge' || l.kind === 'judge_skipped');
    expect(judgeLogs.length).toBeGreaterThan(0);
    const refs: Array<{ realProposalId: string | null; revisionId: string | null }> = [];
    for (const l of judgeLogs) {
      const d = l.data as { verdicts: Array<{ realProposalId: string | null; revisionId: string | null }>; defaultedRefs?: typeof refs; missRefs?: typeof refs };
      refs.push(...d.verdicts, ...(d.defaultedRefs ?? []), ...(d.missRefs ?? []));
    }
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.realProposalId !== null || ref.revisionId !== null).toBe(true);
      if (ref.realProposalId !== null) expect(proposals.has(ref.realProposalId)).toBe(true);
      if (ref.revisionId !== null) expect(revisions.has(ref.revisionId)).toBe(true);
    }
  });
});

describe('Judge links survive a crash (no finally): snapshot at the pause, reopen, finish', () => {
  it('links are persisted with the submission; stripped links are backfilled on recovery; every ref resolves', async () => {
    const dir = tempDir();
    const dbPath = dbIn(dir);
    const copy = path.join(dir, 'snapshot at pause.sqlite');
    const h = Harness.open(dbPath);
    onCleanup(() => h.close());
    let snapped = false;
    const clock = testClock(); // one clock for the run and its restart (the wall-clock limit spans both)
    const engine = EngineSession.create(
      h,
      {
        content: content(),
        llm: mockFactory().factory(h.usageSink()),
        clock,
        hooks: {
          onEvent: (e) => {
            if (!snapped && e.type === 'pause') {
              snapped = true;
              h.exportDatabase(copy); // the process "dies" here: nothing after this point reaches the snapshot
            }
          },
        },
      },
      { sessionId: 'S', caseId: 'C1', mode: 'full', rep: 1 },
    );
    await engine.run();
    expect(snapped).toBe(true);

    const restored = Harness.open(copy);
    onCleanup(() => restored.close());
    const records = new EngineRecords(restored.store);
    const judgeLogs = () => records.logs('S').filter((l) => l.kind === 'judge');
    // Atomic with the submission: the snapshot taken at the pause already carries the real ids.
    const atPause = judgeLogs().flatMap((l) => (l.data as { verdicts: Array<{ realProposalId?: string | null }> }).verdicts);
    expect(atPause.length).toBeGreaterThan(0);
    expect(atPause.every((v) => typeof v.realProposalId === 'string')).toBe(true);
    // Simulate records written before the links existed: strip them; recovery must backfill.
    for (const l of judgeLogs()) {
      const d = l.data as { verdicts: Array<Record<string, unknown>> };
      records.updateLogData(l.id, { ...d, verdicts: d.verdicts.map(({ realProposalId: _r, revisionId: _v, ...rest }) => rest) });
    }
    const resumed = EngineSession.open(restored, { content: content(), llm: mockFactory().factory(restored.usageSink()), clock }, 'S');
    expect(records.logs('S', 'judge_links_backfilled')).toHaveLength(1);
    const summary = await resumed.run();
    expect(summary.outcome).toBe('valid_terminal:pact_concluded');
    const proposals = new Map(restored.repo.listSessionProposals('S').map((p) => [p.proposalId, p]));
    const verdicts = judgeLogs().flatMap((l) => (l.data as { verdicts: Array<{ proposalId: string; realProposalId: string | null; revisionId: string | null }> }).verdicts);
    expect(verdicts.length).toBeGreaterThan(0);
    for (const v of verdicts) {
      expect(v.realProposalId).not.toBeNull();
      expect(proposals.has(v.realProposalId as string)).toBe(true);
    }
    // The verdicts of the paused batch name its committed approve/dispatch proposals.
    const committed = verdicts.map((v) => proposals.get(v.realProposalId as string)).filter((p) => p?.status === 'committed');
    expect(committed.map((p) => (p?.action as { type: string }).type)).toEqual(expect.arrayContaining(['approve_document', 'dispatch_document']));
  });
});
