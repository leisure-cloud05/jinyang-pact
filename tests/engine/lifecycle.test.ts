/**
 * Engine lifecycle features (offline, mock LLM): D3 interrupt / duplicate request / narration failure and
 * regeneration / user pause; budget exhaustion; wall-clock limit; crash recovery on the same database; branching
 * and named checkpoints; determinism; the misbehaviour injector; error recovery.
 */
import { describe, expect, it } from 'vitest';
import { hashState } from '../../src/core/hash.js';
import { CallbackDecisionSource, EngineSession, PolicyDecisionSource, runCase, type StepName } from '../../src/engine/index.js';
import { findCase } from '../../src/content/loader.js';
import { Harness } from '../../src/harness/index.js';
import { content, dbIn, invariantProblems, isInjected, mockFactory, onCleanup, run, tempDir, testClock } from './helpers.js';

class SimulatedCrash extends Error {}

function eventKinds(h: Harness, sessionId: string): string[] {
  return h.repo.listEvents(sessionId).map((e) => `${e.version}:${e.kind}`);
}

describe('D3: interrupt, duplicate request, narration failure, user pause', () => {
  it.each(['full', 'no_judge'] as const)('%s: all engine-level expectations hold and the world path still reaches pact_concluded', async (mode) => {
    const r = await run('D3', mode, { userPauseRounds: [2] });
    expect(r.outcome).toBe('valid_terminal:pact_concluded');
    const h = r.harness;
    const records = r.engine!.records;
    // Interrupt during GENERATE: accepted, epoch+1 (reason interrupt), the batch stale, its proposals stale_epoch.
    const interrupts = records.logs(r.sessionId, 'interrupt');
    expect(interrupts).toHaveLength(1);
    expect((interrupts[0]?.data as { result: { accepted: boolean } }).result.accepted).toBe(true);
    expect(h.repo.listEpochs(r.sessionId).map((e) => e.reason)).toContain('interrupt');
    const stale = h.repo.listBatches(r.sessionId).filter((b) => b.status === 'stale');
    expect(stale.length).toBeGreaterThan(0);
    const staleProposals = h.repo.listSessionProposals(r.sessionId).filter((p) => stale.some((b) => b.batchId === p.batchId));
    expect(staleProposals.every((p) => p.status === 'stale_epoch')).toBe(true);
    // The instruction was applied at the restarted PLAYER step as player speech.
    const instructions = h.repo.listInstructions(r.sessionId);
    expect(instructions).toEqual([expect.objectContaining({ status: 'applied', interrupted: true, appliedRound: 1 })]);
    expect(h.repo.listDialogue(r.sessionId).some((d) => d.speaker === 'player' && d.text === instructions[0]?.text)).toBe(true);
    // The policy amended the over-limit dispatch: the round regenerated (obsolete batch, epoch reason amend).
    expect(h.repo.listEpochs(r.sessionId).map((e) => e.reason)).toContain('amend');
    expect(h.repo.listBatches(r.sessionId).some((b) => b.status === 'obsolete')).toBe(true);
    // Duplicate request: the stored result was returned, nothing committed twice.
    const dup = records.logs(r.sessionId, 'duplicate_request');
    expect(dup).toHaveLength(1);
    expect(dup[0]?.data).toEqual(expect.objectContaining({ replayed: true, sameDecision: true, versionUnchanged: true, ok: true }));
    // Narration failure at R2/khitan_court: failed row, then regenerated from the stored facts (no new events).
    const narr = h.repo.listNarrations(r.sessionId).filter((n) => n.scene === 'khitan_court');
    const failed = narr.find((n) => n.status === 'failed');
    expect(failed).toBeDefined();
    const regenerated = narr.filter((n) => n.batchId === failed?.batchId && n.narrationId > (failed?.narrationId ?? 0));
    expect(['ok', 'fallback']).toContain(regenerated.at(-1)?.status);
    expect(regenerated.at(-1)?.eventVersions).toEqual(failed?.eventVersions);
    expect(records.logs(r.sessionId, 'narration_regenerated')[0]?.data).toEqual(expect.objectContaining({ versionUnchanged: true }));
    expect(h.repo.getBatch(failed!.batchId!).narrationStatus).toBe('done');
    // user_requested pause at the start of round 2, resolved with resume.
    const userPause = h.repo.listPauses(r.sessionId).find((p) => p.category === 'user_requested');
    expect(userPause?.status).toBe('resolved');
    expect(h.repo.listSessionDecisions(r.sessionId).find((d) => d.pauseId === userPause?.id)?.option).toBe('resume');
    expect(invariantProblems(h, r.sessionId)).toEqual([]);
    expect(h.replay(r.sessionId, 'rederive').mismatches).toEqual([]);
    expect(h.replay(r.sessionId, 'patch').ok).toBe(true);
  });

  it('an interrupt outside a character batch is queued and applied at the next PLAYER step (epoch unchanged)', async () => {
    const dir = tempDir();
    const harness = Harness.open(dbIn(dir));
    onCleanup(() => harness.close());
    const engine = EngineSession.create(harness, { content: content(), llm: mockFactory().factory(harness.usageSink()), clock: testClock() }, { sessionId: 'Q', caseId: 'C1', mode: 'full', rep: 1 });
    await engine.step(); // PREPARE round 1
    const epoch = harness.getSession('Q').epoch;
    const res = engine.interrupt('先别急，听我一言。');
    expect(res).toEqual(expect.objectContaining({ accepted: false, queued: true, epoch }));
    await engine.step(); // PLAYER: script + queued instruction
    expect(harness.repo.listInstructions('Q')[0]).toEqual(expect.objectContaining({ status: 'applied', appliedRound: 1 }));
    expect(harness.repo.listDialogue('Q').some((d) => d.text === '先别急，听我一言。' && d.listeners.includes('shi_jingtang'))).toBe(true);
    const summary = await engine.run();
    expect(summary.outcome).toBe('valid_terminal:pact_concluded');
  });
});

describe('limits', () => {
  it('budget exhaustion suspends the run (batch preserved), then stops it with budget_exhausted', async () => {
    // Three character calls fit; the Judge call of round 1 is refused while the batch is generating.
    const r = await run('C1', 'full', { budget: { maxCalls: 3 } });
    expect(r.outcome).toBe('budget_exhausted');
    expect(r.calls).toBeLessThanOrEqual(3);
    expect(r.refusedCalls).toBeGreaterThan(0);
    const session = r.harness.getSession(r.sessionId);
    expect(session.status).toBe('stopped');
    expect(session.runOutcome).toBe('budget_exhausted');
    const ops = r.harness.repo.listRequests(r.sessionId).map((q) => q.op);
    expect(ops.indexOf('suspend')).toBeGreaterThan(-1);
    expect(ops.indexOf('stop')).toBeGreaterThan(ops.indexOf('suspend'));
    expect(r.engine!.records.logs(r.sessionId, 'suspended')[0]?.data).toEqual(expect.objectContaining({ outcome: 'budget_exhausted' }));
    // The batch in flight is preserved (never committed, never discarded).
    expect(r.harness.repo.openBatches(r.sessionId).map((b) => b.status)).toEqual(['generating']);
    expect(r.harness.replay(r.sessionId, 'rederive').ok).toBe(true);
  });

  it('a resumed run counts the calls already recorded against its budget', async () => {
    const dir = tempDir();
    const dbPath = dbIn(dir);
    const first = await runCase({ caseId: 'C1', mode: 'no_judge', rep: 1, dbPath, content: content(), llm: mockFactory().factory, budget: { maxCalls: 5 }, onLimit: 'suspend', clock: testClock() });
    expect(first.status).toBe('suspended');
    expect(first.outcome).toBeNull();
    const again = await runCase({ caseId: 'C1', mode: 'no_judge', rep: 1, dbPath, content: content(), llm: mockFactory().factory, budget: { maxCalls: 5 }, clock: testClock() });
    expect(again.outcome).toBe('budget_exhausted');
    expect(again.calls).toBeLessThanOrEqual(5);
  });

  it('the wall-clock limit (injectable clock) suspends and stops the run with error', async () => {
    const r = await run('C1', 'full', { clock: testClock(4 * 60 * 1000) });
    expect(r.outcome).toBe('error');
    expect(r.outcomeDetail).toMatch(/wall-clock/);
    expect(r.harness.getSession(r.sessionId).runOutcome).toBe('error');
  });

  it('max_rounds stops a run that reaches no terminal (D1, by design)', async () => {
    const r = await run('D1', 'no_judge');
    expect(r.outcome).toBe('max_rounds');
    expect(r.rounds).toBe(findCase(content(), 'D1').max_rounds);
    expect(r.harness.getSession(r.sessionId).runOutcome).toBe('max_rounds');
  });
});

describe('crash recovery on the same database', () => {
  const crashAt = (step: StepName, round: number) => {
    let crashed = false;
    return {
      onStep: (s: StepName, info: { round: number }) => {
        if (!crashed && s === step && info.round === round) {
          crashed = true;
          throw new SimulatedCrash(`crash at ${step} in round ${round}`);
        }
      },
    };
  };

  it.each([
    ['generate:called', 2],
    ['decide', 1],
    ['narrate', 1],
    ['advance', 2],
  ] as const)('restart after a crash at %s (round %i) continues to the same final state', async (step, round) => {
    const clean = await run('C1', 'full');
    const dir = tempDir();
    const dbPath = dbIn(dir);
    const base = { caseId: 'C1', mode: 'full' as const, rep: 1, dbPath, content: content(), clock: testClock() };
    await expect(runCase({ ...base, llm: mockFactory().factory, hooks: crashAt(step, round) })).rejects.toThrow(SimulatedCrash);
    // "Process restart": a new harness and engine on the same database file.
    const resumed = await runCase({ ...base, llm: mockFactory().factory, keepOpen: true });
    const h = resumed.engine!.harness;
    onCleanup(() => h.close());
    expect(resumed.outcome).toBe(clean.outcome);
    expect(resumed.finalHash).toBe(clean.finalHash);
    expect(invariantProblems(h, resumed.sessionId)).toEqual([]);
    expect(h.replay(resumed.sessionId, 'patch').ok).toBe(true);
    expect(h.replay(resumed.sessionId, 'rederive').mismatches).toEqual([]);
    if (step === 'generate:called') {
      expect(h.repo.listEpochs(resumed.sessionId).map((e) => e.reason)).toContain('recovery');
      expect(h.repo.listBatches(resumed.sessionId).some((b) => b.status === 'stale')).toBe(true);
    }
    const narration = h.repo.committedBatches(resumed.sessionId).filter((b) => b.kind === 'character' && b.narrationStatus !== 'done');
    expect(narration).toEqual([]);
  });
});

describe('branching and checkpoints', () => {
  it('a branch at a round start continues deterministically (same final state as its parent)', async () => {
    const parent = await run('C1', 'full');
    const h = parent.harness;
    const childA = parent.engine!.branch(2, 'C1-branch-a');
    const a = await childA.run();
    const childB = EngineSession.branch(h, { content: content(), llm: mockFactory().factory(h.usageSink()), clock: testClock() }, parent.sessionId, 2, 'C1-branch-b');
    const b = await childB.run();
    expect(a.outcome).toBe(parent.outcome);
    expect(a.finalHash).toBe(parent.finalHash);
    expect(b.finalHash).toBe(parent.finalHash);
    expect(h.getSession('C1-branch-a').parentSessionId).toBe(parent.sessionId);
    expect(childA.records.findRun('C1-branch-a')?.parentSessionId).toBe(parent.sessionId);
    // The child only re-executes from its branch round.
    expect(h.repo.listRoundStarts('C1-branch-a').map((s) => s.round)).toEqual([2, 3]);
    expect(h.replay('C1-branch-a', 'patch').ok).toBe(true);
    expect(h.replay('C1-branch-a', 'rederive').mismatches).toEqual([]);
  });

  it('save/load: a named checkpoint is restored as a new session from its round start', async () => {
    const parent = await run('C2', 'no_judge');
    const cp = parent.engine!.save('late');
    expect(cp.round).toBe(parent.rounds);
    const loaded = EngineSession.load(parent.harness, { content: content(), llm: mockFactory().factory(parent.harness.usageSink()), clock: testClock() }, 'late', 'C2-loaded');
    const s = await loaded.run();
    expect(s.finalHash).toBe(parent.finalHash);
    expect(() => EngineSession.load(parent.harness, { content: content(), llm: mockFactory().factory(parent.harness.usageSink()) }, 'missing', 'x')).toThrow(/no checkpoint/);
  });

  it('refuses to mix baseline and Harness-mode runs in one database (isolated baseline)', async () => {
    const r = await run('C1', 'full');
    expect(() =>
      EngineSession.create(r.harness, { content: content(), llm: mockFactory().factory(r.harness.usageSink()) }, { sessionId: 'B', caseId: 'C1', mode: 'baseline', rep: 1 }),
    ).toThrow(/isolated database/);
  });
});

describe('determinism', () => {
  it.each(['C3', 'D3', 'C5'] as const)('%s: the same (case, rep, mode) gives identical events and final hashes', async (caseId) => {
    const a = await run(caseId, 'full');
    const b = await run(caseId, 'full');
    expect(a.seed).toBe(b.seed);
    expect(a.finalHash).toBe(b.finalHash);
    expect(eventKinds(a.harness, a.sessionId)).toEqual(eventKinds(b.harness, b.sessionId));
    expect(hashState(a.harness.getState(a.sessionId))).toBe(a.finalHash);
    const other = await run(caseId, 'full', { rep: 2 });
    expect(other.seed).not.toBe(a.seed);
  });
});

describe('misbehaviour injector (seeded, nonzero rate)', () => {
  const CASES = ['C1', 'C4', 'C6', 'D2'] as const;

  it('Harness modes reject every injected violation; the permissive baseline commits some', async () => {
    let injectedHarness = 0;
    let committedBaseline = 0;
    for (const caseId of CASES) {
      for (const mode of ['full', 'no_judge', 'baseline'] as const) {
        const mocks = mockFactory({ misbehaviourRate: 0.5 });
        const r = await run(caseId, mode, { llm: mocks.factory });
        const injected = r.harness.repo
          .listSessionProposals(r.sessionId)
          .filter((p) => isInjected(p) && (p.action as { type?: string }).type !== 'wait' && p.status !== 'stale_epoch' && p.status !== 'obsolete');
        if (mode === 'baseline') {
          committedBaseline += injected.filter((p) => p.status === 'committed').length;
        } else {
          injectedHarness += injected.length;
          expect(injected.filter((p) => p.status === 'committed').map((p) => `${caseId}/${mode}: ${JSON.stringify(p.action)}`)).toEqual([]);
          expect(invariantProblems(r.harness, r.sessionId)).toEqual([]);
        }
        expect(r.harness.replay(r.sessionId, 'rederive').mismatches).toEqual([]);
        // Contradicting narrator prose is caught by the checker and replaced by the template (fallback).
        for (const n of r.harness.repo.listNarrations(r.sessionId)) {
          if (n.raw && /已死于军中|援军已至城下|九万九千匹/.test(n.raw)) expect(n.status).toBe('fallback');
        }
      }
    }
    expect(injectedHarness).toBeGreaterThan(0);
    expect(committedBaseline).toBeGreaterThan(0);
  });
});

describe('error recovery', () => {
  it('an llm_timeout opens an error_recovery pause; the policy retries and the run completes', async () => {
    const r = await run('C1', 'no_judge', { faults: [{ round: 1, kind: 'llm_timeout', target: 'shi_jingtang' }] });
    expect(r.outcome).toBe('valid_terminal:pact_concluded');
    const pause = r.harness.repo.listPauses(r.sessionId).find((p) => p.category === 'error_recovery');
    expect(pause?.status).toBe('resolved');
    expect(r.harness.repo.listSessionDecisions(r.sessionId).find((d) => d.pauseId === pause?.id)?.option).toBe('retry');
  });

  it('skip_actor records the failed actor as waiting (format_error) and the round goes on', async () => {
    const policy = new PolicyDecisionSource(findCase(content(), 'C1').decision_policy);
    const decisions = new CallbackDecisionSource((ctx) => (ctx.pause.category === 'error_recovery' ? { option: 'skip_actor', by: 'user' } : policy.decide(ctx)));
    const r = await run('C1', 'no_judge', { decisions, faults: [{ round: 1, kind: 'llm_timeout', target: 'shi_jingtang' }] });
    const skipped = r.harness.repo.listSessionProposals(r.sessionId).filter((p) => p.round === 1 && p.actor === 'shi_jingtang' && p.status === 'format_error');
    expect(skipped).toHaveLength(1);
    expect(r.outcome === 'max_rounds' || r.outcome?.startsWith('valid_terminal')).toBe(true);
    expect(r.harness.replay(r.sessionId, 'rederive').mismatches).toEqual([]);
  });

  it('stop ends the run with run outcome error', async () => {
    const policy = new PolicyDecisionSource(findCase(content(), 'C1').decision_policy);
    const decisions = new CallbackDecisionSource((ctx) => (ctx.pause.category === 'error_recovery' ? { option: 'stop', by: 'user' } : policy.decide(ctx)));
    const r = await run('C1', 'full', { decisions, faults: [{ round: 2, kind: 'llm_timeout', target: 'yelu_deguang' }] });
    expect(r.outcome).toBe('error');
    expect(r.harness.getSession(r.sessionId).status).toBe('stopped');
  });
});
