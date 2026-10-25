/** Negative regression tests for Codex review 15 (docs/review_log.md) findings 2–7, 9, 10 and §12.4 amend "$current". */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { caseCoreConfig, caseInitialState, toTraceSpec } from '../../src/content/loader.js';
import { simulateTrace, type TraceSpec } from '../../src/core/simulate.js';
import type { Harness, ProposalInput } from '../../src/harness/harness.js';
import { A, DOC_TERMS, SHI, T, YELU, fixture } from '../core/helpers.js';
import { createSession, newHarness, rid, tempDir } from './helpers.js';

const S = 's';
const KEY = 'sk-or-v1-SYNTHETIC0123456789abcdef';

function charBatch(h: Harness, inputs: ProposalInput[], semantic: Parameters<Harness['assess']>[3] = []) {
  const { batchId } = h.openCharacterBatch(S, rid());
  const { proposalIds } = h.submitProposals(S, batchId, inputs, rid());
  const assess = h.assess(S, batchId, rid(), semantic);
  return { batchId, proposalIds, assess, pauses: h.openPauses(S).filter((p) => p.batchId === batchId) };
}

function started(mode: 'full' | 'no_judge' | 'baseline' = 'full'): Harness {
  const { h } = newHarness();
  createSession(h, S, 'FX1', mode);
  h.runSystemPrepare(S, rid());
  return h;
}

describe('#2 suspended and stopped runs never commit', () => {
  it('commit, assess and decisions are refused while suspended; the batch survives until resume', () => {
    const h = started();
    const { batchId } = charBatch(h, [{ actor: SHI, action: A.approve() }]);
    h.suspend(S, 'budget', rid());
    expect(() => h.commitBatch({ sessionId: S, batchId, requestId: rid() })).toThrow(/suspended/);
    expect(h.repo.getBatch(batchId).status).toBe('assessed');
    expect(h.getSession(S).status).toBe('suspended');
    h.resume(S, rid());
    expect(h.commitBatch({ sessionId: S, batchId, requestId: rid() }).ok).toBe(true);
  });

  it('a stopped run stays stopped', () => {
    const h = started();
    const { batchId, pauses } = charBatch(h, [{ actor: SHI, action: A.approve() }, { actor: SHI, action: A.dispatch() }]);
    h.stop(S, 'budget_exhausted', rid());
    expect(() => h.resolvePause(S, pauses[0]!.id, { option: 'endorse' }, rid())).toThrow(/stopped/);
    expect(() => h.commitBatch({ sessionId: S, batchId, requestId: rid() })).toThrow(/stopped/);
    const other = h.openPauses(S);
    expect(other).toHaveLength(1);
    expect(h.getSession(S)).toMatchObject({ status: 'stopped', runOutcome: 'budget_exhausted' });
  });
});

describe('#3 control pauses have real continuations', () => {
  it('user_requested resume restores the saved status and phase', () => {
    const h = started();
    const before = h.getSession(S);
    const { pauseId } = h.openPause(S, { category: 'user_requested', proposalIds: [] }, rid());
    expect(h.getSession(S).status).toBe('awaiting_decision');
    const res = h.resolvePause(S, pauseId, { option: 'resume' }, rid());
    expect(res.continuation).toEqual({ status: before.status, phase: before.phase });
    expect(h.getSession(S)).toMatchObject({ status: before.status, phase: before.phase });
  });

  it('error_recovery: retry restores, skip_actor records the actor as skipped, stop ends the run', () => {
    const h = started();
    const { batchId } = h.openCharacterBatch(S, rid());
    expect(() => h.openPause(S, { category: 'error_recovery', proposalIds: [], batchId }, rid())).toThrow(/failing actor/);
    const retry = h.openPause(S, { category: 'error_recovery', proposalIds: [], batchId, actor: YELU }, rid());
    expect(h.resolvePause(S, retry.pauseId, { option: 'retry' }, rid()).continuation).toEqual({ status: 'generating', phase: 'generate' });
    expect(h.getSession(S)).toMatchObject({ status: 'generating', phase: 'generate' });
    const skip = h.openPause(S, { category: 'error_recovery', proposalIds: [], batchId, actor: YELU }, rid());
    const skipped = h.resolvePause(S, skip.pauseId, { option: 'skip_actor' }, rid());
    expect(skipped.skippedActor).toBe(YELU);
    expect(h.repo.listProposals(batchId)).toMatchObject([{ actor: YELU, status: 'format_error', intake: 'format_error', code: 'skipped' }]);
    expect(h.repo.getBatch(batchId).status).toBe('generating');
    const stop = h.openPause(S, { category: 'error_recovery', proposalIds: [], batchId, actor: YELU }, rid());
    expect(h.resolvePause(S, stop.pauseId, { option: 'stop' }, rid()).status).toBe('stopped');
    expect(h.getSession(S)).toMatchObject({ status: 'stopped', runOutcome: 'error' });
  });
});

describe('#4 aborts happen only after the transition commits', () => {
  it('a rolled-back interrupt leaves the in-flight signal alive', () => {
    const h = started();
    h.interrupt(S, { instructionId: 'duplicate', text: 'queued' }, rid()); // no open batch: queued
    const { batchId } = h.openCharacterBatch(S, rid());
    const signal = h.signal(S);
    expect(() => h.interrupt(S, { instructionId: 'duplicate', text: 'again' }, rid())).toThrow();
    expect(signal.aborted).toBe(false);
    expect(h.getSession(S).epoch).toBe(0);
    expect(h.repo.getBatch(batchId).status).toBe('generating');
    h.interrupt(S, { text: 'real' }, rid());
    expect(signal.aborted).toBe(true);
    expect(h.signal(S).aborted).toBe(false);
  });
});

describe('#5 narration is complete only when every scene is covered', () => {
  it('one narrated scene of two leaves the batch pending; the latest batch alone moves the phase', () => {
    const h = started();
    const r = charBatch(h, [{ actor: SHI, action: A.approve() }, { actor: YELU, action: A.propose(SHI, T({ vassal: true, aid_cavalry: 20000, aid_arrival_days: 20 })) }]);
    h.commitBatch({ sessionId: S, batchId: r.batchId, requestId: rid() });
    const scenes = h.narrationScenes(S, r.batchId);
    expect(scenes.map((x) => x.scene)).toEqual(['jinyang_hq', 'khitan_court']);
    const narrate = (scene: (typeof scenes)[number]) =>
      h.recordNarration(S, { batchId: r.batchId, scene: scene.scene, eventVersions: scene.eventVersions, status: 'ok', raw: 'p', header: 'h', displayed: 'h p', check: {} }, rid());
    narrate(scenes[0]!);
    expect(h.repo.getBatch(r.batchId).narrationStatus).toBe('pending');
    expect(h.getSession(S).phase).toBe('narrate');
    expect(h.recover(S, rid()).narrationPending).toEqual([r.batchId]);
    narrate(scenes[1]!);
    expect(h.repo.getBatch(r.batchId).narrationStatus).toBe('done');
    expect(h.getSession(S).phase).toBe('advance');

    // A later batch awaiting narration is not advanced by re-narrating the older one.
    h.runSystemAdvance(S, rid());
    h.runSystemPrepare(S, rid());
    const r2 = charBatch(h, [{ actor: SHI, action: A.speak(['player'], 'x') }, { actor: SHI, action: A.timing('hold') }]);
    h.commitBatch({ sessionId: S, batchId: r2.batchId, requestId: rid() });
    expect(h.getSession(S).phase).toBe('narrate');
    narrate(scenes[0]!);
    narrate(scenes[1]!);
    expect(h.getSession(S).phase).toBe('narrate');
  });
});

describe('#6 replay checks snapshot contents, not just hash columns', () => {
  it('a tampered latest snapshot (or base snapshot) fails both replays', () => {
    const h = started();
    const { batchId } = charBatch(h, [{ actor: SHI, action: A.approve() }]);
    h.commitBatch({ sessionId: S, batchId, requestId: rid() });
    expect(h.replay(S, 'patch').ok && h.replay(S, 'rederive').ok).toBe(true);
    const latest = h.getState(S);
    const tampered = JSON.stringify({ ...latest, siege: { ...latest.siege, morale: 999 } });
    h.store.db.prepare('UPDATE snapshots SET state_json = ? WHERE session_id = ? AND version = ?').run(tampered, S, latest.version);
    expect(h.getState(S).siege.morale).toBe(999);
    expect(h.replay(S, 'patch').ok).toBe(false);
    expect(h.replay(S, 'rederive').ok).toBe(false);
    const base = h.repo.getSnapshot(S, 0)!.state;
    h.store.db.prepare('UPDATE snapshots SET state_json = ? WHERE session_id = ? AND version = 0').run(JSON.stringify({ ...base, day: 42 }), S);
    expect(h.replay(S, 'patch').mismatches.some((m) => m.startsWith('snapshot 0'))).toBe(true);
  });
});

describe('#7 rederive does not trust stored classifications or control records', () => {
  function committedRejection() {
    const h = started();
    const r = charBatch(h, [{ actor: SHI, action: A.approve(999) }, { actor: SHI, action: A.approve() }]);
    h.commitBatch({ sessionId: S, batchId: r.batchId, requestId: rid() });
    expect(h.repo.listProposals(r.batchId).map((p) => [p.status, p.rule])).toEqual([['rejected', 'H04'], ['committed', null]]);
    expect(h.replay(S, 'rederive').ok).toBe(true);
    return { h, ...r };
  }

  it('relabelling a rejected proposal as format_error is detected (even with its intake rewritten)', () => {
    const { h, proposalIds } = committedRejection();
    h.store.db.prepare(`UPDATE proposals SET status = 'format_error' WHERE proposal_id = ?`).run(proposalIds[0]!);
    expect(h.replay(S, 'rederive').ok).toBe(false);
    h.store.db.prepare(`UPDATE proposals SET intake = 'format_error' WHERE proposal_id = ?`).run(proposalIds[0]!);
    expect(h.replay(S, 'rederive').mismatches.some((m) => m.includes('submit record'))).toBe(true);
  });

  it('edited actions, batch epoch/base version and event round/day are detected', () => {
    const { h, batchId, proposalIds } = committedRejection();
    const reset = () => {
      const fresh = committedRejection();
      return fresh;
    };
    h.store.db.prepare(`UPDATE proposals SET action_json = ? WHERE proposal_id = ?`).run(JSON.stringify(A.approve(1)), proposalIds[0]!);
    expect(h.replay(S, 'rederive').mismatches.some((m) => m.includes('differs from its intake'))).toBe(true);

    const b = reset();
    b.h.store.db.prepare('UPDATE batches SET epoch = 99, base_version = 999 WHERE batch_id = ?').run(b.batchId);
    const mismatches = b.h.replay(S, 'rederive').mismatches.join('\n');
    expect(mismatches).toMatch(/base version 999/);
    expect(mismatches).toMatch(/epoch 99/);

    const c = reset();
    const event = c.h.repo.listBatchEvents(S, c.batchId)[0]!;
    c.h.store.db.prepare('UPDATE events SET round = 99, day = 999 WHERE session_id = ? AND version = ?').run(S, event.version);
    expect(c.h.replay(S, 'rederive').mismatches.some((m) => m.includes(`event ${event.version} differs`))).toBe(true);
    void batchId;
  });
});

describe('#9 credentials never reach storage or exports', () => {
  it('redacts a synthetic OpenRouter key in dialogue, proposals and world messages; canaries stay', () => {
    const { h } = newHarness();
    createSession(h, S, 'FX3');
    h.runSystemPrepare(S, rid());
    h.applyPlayerAction(S, [{ kind: 'dialogue', to: [SHI], text: `my key is ${KEY}` }], rid());
    const r = charBatch(h, [{ actor: SHI, action: A.letter(YELU, `use ${KEY}`), rationale: `because ${KEY}` }]);
    h.commitBatch({ sessionId: S, batchId: r.batchId, requestId: rid() });
    expect(h.repo.listDialogue(S)[0]?.text).toBe('my key is [REDACTED]');
    const letter = Object.values(h.getState(S).messages).find((m) => m.kind === 'letter');
    expect(JSON.stringify(letter)).toContain('[REDACTED]');
    const dir = path.join(tempDir(), 'audit');
    h.exportAudit(S, dir);
    const all = readdirSync(dir).map((f) => readFileSync(path.join(dir, f), 'utf8')).join('\n');
    expect(all).not.toContain(KEY);
    expect(all).toContain('JYP-CANARY-7F3A'); // game-secret canaries are not credentials
  });
});

describe('#10 semantic pauses: full mode, semantic categories, eligible proposals only', () => {
  it('a Judge pause on an invalid proposal is dropped', () => {
    const h = started();
    const { batchId } = h.openCharacterBatch(S, rid());
    const { proposalIds } = h.submitProposals(S, batchId, [{ actor: SHI, action: A.approve(999) }], rid());
    const res = h.assess(S, batchId, rid(), [{ category: 'goal_conflict', proposalIds }]);
    expect(res).toMatchObject({ status: 'assessed', pauseIds: [] });
  });

  it('is refused in no_judge mode and for non-semantic categories', () => {
    const noJudge = started('no_judge');
    const nb = noJudge.openCharacterBatch(S, rid());
    const np = noJudge.submitProposals(S, nb.batchId, [{ actor: SHI, action: A.approve() }], rid());
    expect(() => noJudge.assess(S, nb.batchId, rid(), [{ category: 'goal_conflict', proposalIds: np.proposalIds }])).toThrow(/full mode/);
    const full = started();
    const fb = full.openCharacterBatch(S, rid());
    const fp = full.submitProposals(S, fb.batchId, [{ actor: SHI, action: A.approve() }], rid());
    expect(() => full.assess(S, fb.batchId, rid(), [{ category: 'dispatch_request', proposalIds: fp.proposalIds }])).toThrow(/not a semantic/);
    expect(full.assess(S, fb.batchId, rid(), [{ category: 'internal_disagreement', proposalIds: fp.proposalIds }]).pauseIds).toHaveLength(1);
  });
});

describe('§12.4 amend payloads accept "$current"', () => {
  it('the harness resolves "$current" to the player-visible version at decision time', () => {
    const h = started();
    const { pauses } = charBatch(h, [{ actor: SHI, action: A.approve() }, { actor: SHI, action: A.dispatch() }]);
    const res = h.resolvePause(S, pauses[0]!.id, { option: 'amend', amend: { docId: 'doc:1', baseDocVersion: '$current', terms: DOC_TERMS, note: 'n' } }, rid());
    expect(res.status).toBe('regenerated');
    expect(h.getState(S).documents['doc:1']?.version).toBe(2);
  });

  it('simulateTrace applies it too', () => {
    const base = toTraceSpec(fixture().traces.FX1!);
    const spec: TraceSpec = {
      ...base,
      rounds: base.rounds.map((r) =>
        r.round === 1
          ? {
              ...r,
              decisions: r.decisions.map((d) =>
                d.ref === 'dispatch' ? { ...d, choose: 'amend' as const, amend: { docId: 'doc:1', baseDocVersion: '$current' as const, terms: DOC_TERMS, note: 'amended' } } : d,
              ),
              regenerations: [
                {
                  proposals: [
                    { ref: 'approve2', actor: SHI, action: A.approve(2) },
                    { ref: 'dispatch2', actor: SHI, action: A.dispatch(2) },
                  ],
                  decisions: [{ ref: 'dispatch2', choose: 'endorse' as const }],
                },
              ],
            }
          : r,
      ),
    };
    const run = simulateTrace(caseInitialState(fixture(), 'FX1'), caseCoreConfig(fixture(), 'FX1'), spec, 'full');
    expect(run.mismatches).toEqual([]);
    expect(run.terminal?.kind).toBe('pact_concluded');
    expect(run.state.documents['doc:1']?.version).toBe(2);
  });
});

describe('review 18', () => {
  it('#2 late narration and interrupts never revive a stopped or suspended run', () => {
    const h = started();
    const r = charBatch(h, [{ actor: SHI, action: A.approve() }]);
    h.commitBatch({ sessionId: S, batchId: r.batchId, requestId: rid() });
    const narrateAll = () => {
      for (const scene of h.narrationScenes(S, r.batchId)) {
        h.recordNarration(S, { batchId: r.batchId, scene: scene.scene, eventVersions: scene.eventVersions, status: 'ok', raw: 'p', header: 'h', displayed: 'h', check: {} }, rid());
      }
    };
    h.suspend(S, 'budget', rid());
    narrateAll();
    expect(h.getSession(S)).toMatchObject({ status: 'suspended', suspendedFrom: 'ready', phase: 'advance' });
    expect(() => h.runSystemAdvance(S, rid())).toThrow(/suspended/);
    h.resume(S, rid());
    expect(h.getSession(S).status).toBe('ready');

    const h2 = started();
    const r2 = h2.openCharacterBatch(S, rid());
    h2.stop(S, 'budget_exhausted', rid());
    expect(() => h2.interrupt(S, { text: 'wake up' }, rid())).toThrow(/stopped/);
    expect(h2.getSession(S)).toMatchObject({ status: 'stopped', runOutcome: 'budget_exhausted' });
    expect(h2.repo.getBatch(r2.batchId).status).toBe('generating');
  });

  it('#3 skip_actor → commit → replay: provenance is control-derived and validated', () => {
    const h = started();
    const { batchId } = h.openCharacterBatch(S, rid());
    const pause = h.openPause(S, { category: 'error_recovery', proposalIds: [], batchId, actor: YELU }, rid());
    h.resolvePause(S, pause.pauseId, { option: 'skip_actor' }, rid());
    h.submitProposals(S, batchId, [{ actor: SHI, action: A.approve() }], rid());
    h.assess(S, batchId, rid());
    expect(h.commitBatch({ sessionId: S, batchId, requestId: rid() }).ok).toBe(true);
    const skipped = h.repo.listProposals(batchId).find((p) => p.actor === YELU);
    expect(skipped).toMatchObject({ source: 'system', status: 'format_error', code: 'skipped' });
    expect(h.replay(S, 'rederive').mismatches).toEqual([]);
    h.store.db.prepare(`UPDATE proposals SET decision_id = 'forged' WHERE proposal_id = ?`).run(skipped!.proposalId);
    expect(h.replay(S, 'rederive').mismatches.some((m) => m.includes('without a matching skip_actor decision'))).toBe(true);
  });

  it('#6 "$current" is resolved against the evolving state, input by input (conditions at the step start)', () => {
    const h = started();
    const revise = (silk: number) => ({ action: { type: 'revise_document', args: { docId: 'doc:1', baseDocVersion: '$current', terms: { ...DOC_TERMS, immediate_silk: silk }, note: String(silk) } } });
    const r = h.applyScriptInputs(S, [revise(40000), revise(30000), { action: A.timing('hold'), when: { doc_status: { docId: 'doc:1', status: 'draft' as const } } }], rid());
    expect(r.outcomes.map((o) => o.status)).toEqual(['committed', 'committed', 'committed']);
    expect(h.getState(S).documents['doc:1']).toMatchObject({ version: 3, terms: { immediate_silk: 30000 } });
    const stored = h.repo.listProposals(r.batchId!).map((p) => (p.action as { args: { baseDocVersion?: number } }).args.baseDocVersion);
    expect(stored).toEqual([1, 2, undefined]); // resolved actions are what is stored and replayed
    expect(h.replay(S, 'rederive').ok).toBe(true);
  });

  it('#7 simulateTrace reports a rejected amendment instead of regenerating', () => {
    const base = toTraceSpec(fixture().traces.FX1!);
    const spec: TraceSpec = {
      ...base,
      rounds: base.rounds.map((r) =>
        r.round === 1
          ? {
              ...r,
              decisions: r.decisions.map((d) => (d.ref === 'dispatch' ? { ...d, choose: 'amend' as const, amend: { docId: 'doc:1', baseDocVersion: 999, terms: DOC_TERMS, note: 'x' } } : d)),
              regenerations: [{ proposals: [{ ref: 'a', actor: SHI, action: A.approve() }, { ref: 'd', actor: SHI, action: A.dispatch() }], decisions: [{ ref: 'd', choose: 'endorse' as const }] }],
            }
          : r,
      ),
    };
    const run = simulateTrace(caseInitialState(fixture(), 'FX1'), caseCoreConfig(fixture(), 'FX1'), spec, 'full');
    expect(run.mismatches.some((m) => m.includes('amend rejected (H04)'))).toBe(true);
    expect(run.terminal).toBeNull();
    expect(run.state.documents['doc:1']?.version).toBe(1);
  });
});
