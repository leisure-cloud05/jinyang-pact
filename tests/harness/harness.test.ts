import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { caseInitialState } from '../../src/content/loader.js';
import { hashState } from '../../src/core/hash.js';
import type { WorldState } from '../../src/core/types.js';
import type { DecisionInput } from '../../src/harness/decisions.js';
import { HarnessError } from '../../src/harness/context.js';
import type { Harness, ProposalInput } from '../../src/harness/harness.js';
import { SessionMutex } from '../../src/harness/mutex.js';
import { replayPatch } from '../../src/harness/replay.js';
import { Store } from '../../src/store/db.js';
import { LockError } from '../../src/store/lock.js';
import { Repo } from '../../src/store/repo.js';
import { A, DOC_TERMS, LIU, SANG, SHI, T, YELU, fixture, mutate } from '../core/helpers.js';
import { createSession, newHarness, openHarness, rid, tempDir } from './helpers.js';

const S = 's';

function charBatch(h: Harness, inputs: ProposalInput[]) {
  const { batchId } = h.openCharacterBatch(S, rid());
  const { proposalIds } = h.submitProposals(S, batchId, inputs, rid());
  const assess = h.assess(S, batchId, rid());
  return { batchId, proposalIds, assess, pauses: h.openPauses(S).filter((p) => p.batchId === batchId) };
}

/** Plays one round: PREPARE, a character batch (every pause resolved with `decide` or endorse), commit, ADVANCE. */
function round(h: Harness, inputs: ProposalInput[], decide: (category: string) => DecisionInput = () => ({ option: 'endorse' })): void {
  h.runSystemPrepare(S, rid());
  const { batchId } = charBatch(h, inputs);
  for (let i = 0; i < 10; i++) {
    const pause = h.openPauses(S).find((p) => p.batchId === batchId);
    if (!pause) break;
    h.resolvePause(S, pause.id, decide(pause.category), rid());
  }
  if (h.repo.getBatch(batchId).status !== 'committed') h.commitBatch({ sessionId: S, batchId, requestId: rid() });
  if (!h.getState(S).terminal) h.runSystemAdvance(S, rid());
}

const eventCount = (h: Harness, sessionId = S) => h.repo.listEvents(sessionId).length;

describe('commitBatch atomicity', () => {
  it('an exception inside the commit transaction writes nothing; the retry commits', () => {
    const { h } = newHarness();
    createSession(h, S);
    h.runSystemPrepare(S, rid());
    const { batchId, assess } = charBatch(h, [{ actor: SHI, action: A.approve() }]);
    expect(assess.status).toBe('assessed');
    const before = { events: eventCount(h), hash: hashState(h.getState(S)) };
    h.hooks.onStage = (stage) => {
      if (stage === 'events_written') throw new Error('injected fault');
    };
    expect(() => h.commitBatch({ sessionId: S, batchId, requestId: 'commit-1' })).toThrow('injected fault');
    expect(eventCount(h)).toBe(before.events);
    expect(hashState(h.getState(S))).toBe(before.hash);
    expect(h.repo.getBatch(batchId).status).toBe('assessed');
    expect(h.repo.findRequest(S, 'commit-1')).toBeNull();
    expect(h.repo.listProposals(batchId)[0]?.status).toBe('pending');
    h.hooks.onStage = undefined;
    const ok = h.commitBatch({ sessionId: S, batchId, requestId: 'commit-1' });
    expect(ok).toMatchObject({ ok: true, replayed: false });
    expect(h.getState(S).documents['doc:1']?.status).toBe('approved');
  });
});

describe('idempotency (H06)', () => {
  it('returns the stored result for a repeated request and rejects a changed payload', () => {
    const { h } = newHarness();
    createSession(h, S);
    h.runSystemPrepare(S, rid());
    const input = [{ kind: 'dialogue' as const, to: [SHI], text: '请速决。' }, { kind: 'action' as const, action: A.timing('delay', 1) }];
    const first = h.applyPlayerAction(S, input, 'player-1');
    const again = h.applyPlayerAction(S, input, 'player-1');
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect({ ...again, replayed: false }).toEqual(first);
    expect(h.repo.listDialogue(S)).toHaveLength(1);
    expect(h.repo.listBatches(S).filter((b) => b.kind === 'player')).toHaveLength(1);
    let error: unknown;
    try {
      h.applyPlayerAction(S, [{ kind: 'dialogue', to: [SHI], text: 'something else' }], 'player-1');
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(HarnessError);
    expect((error as HarnessError).code).toBe('H06');
  });
});

describe('batch entry check (H05)', () => {
  it('a batch made stale by an interrupt can never commit, and late proposals are stale_epoch', () => {
    const { h } = newHarness();
    createSession(h, S);
    h.runSystemPrepare(S, rid());
    const { batchId } = charBatch(h, [{ actor: SHI, action: A.approve() }]);
    const interrupt = h.interrupt(S, { text: '先议条款。' }, rid());
    expect(interrupt).toMatchObject({ accepted: true, queued: false, epoch: 1, staleBatchId: batchId });
    const commit = h.commitBatch({ sessionId: S, batchId, requestId: rid() });
    expect(commit).toMatchObject({ ok: false, rule: 'H05' });
    const late = h.submitProposals(S, batchId, [{ actor: SANG, action: A.wait() }], rid());
    expect(late.accepted).toBe(false);
    expect(h.repo.listProposals(batchId).map((p) => p.status)).toEqual(['stale_epoch', 'stale_epoch']);
    expect(h.getSession(S)).toMatchObject({ epoch: 1, phase: 'player' });
    expect(h.takeInstructions(S, rid()).instructions.map((i) => [i.text, i.interrupted])).toEqual([['先议条款。', true]]);
  });

  it('a batch whose base version is no longer current is rejected at entry', () => {
    const { h } = newHarness();
    createSession(h, S);
    h.runSystemPrepare(S, rid());
    const { batchId } = charBatch(h, [{ actor: SHI, action: A.approve() }]);
    const state = h.getState(S);
    h.repo.putSnapshot(S, { ...state, version: state.version + 1 }); // an external world write
    const commit = h.commitBatch({ sessionId: S, batchId, requestId: rid() });
    expect(commit).toMatchObject({ ok: false, rule: 'H05' });
    expect(commit.reason).toContain('stale base version');
    expect(h.repo.getBatch(batchId).status).toBe('stale');
  });
});

describe('decisions', () => {
  it('amend is a regenerating decision: revision committed, batch and its open pauses obsolete, epoch+1', () => {
    const { h } = newHarness();
    createSession(h, S);
    h.runSystemPrepare(S, rid());
    const { batchId, pauses } = charBatch(h, [
      { actor: SHI, action: A.approve() },
      { actor: SHI, action: A.dispatch() },
      { actor: SANG, action: A.suggest('document', 'doc:1', { annual_silk: 100000 }), askPlayer: { question: 'Add silk?' } },
    ]);
    expect(pauses.map((p) => p.category).sort()).toEqual(['dispatch_request', 'prompt_request']);
    const dispatchPause = pauses.find((p) => p.category === 'dispatch_request');
    if (!dispatchPause) throw new Error('no dispatch pause');
    expect(dispatchPause.options).toEqual(['endorse', 'withhold', 'amend', 'delegate', 'ask']);
    expect(JSON.stringify(dispatchPause.visibleFacts)).toContain('dispatch doc:1 v1');
    const res = h.resolvePause(S, dispatchPause.id, {
      option: 'amend',
      amend: { docId: 'doc:1', baseDocVersion: 1, terms: { ...DOC_TERMS, immediate_silk: 40000 }, note: 'amended' },
    }, rid());
    expect(res).toMatchObject({ status: 'regenerated', epoch: 1 });
    expect(res.commit?.events.map((e) => e.kind)).toEqual(['revise_document']);
    expect(h.getState(S).documents['doc:1']).toMatchObject({ version: 2, status: 'draft' });
    expect(h.repo.getBatch(batchId).status).toBe('obsolete');
    expect(h.repo.listProposals(batchId).every((p) => p.status === 'obsolete')).toBe(true);
    const after = h.repo.listPauses(S, { batchId });
    expect(after.map((p) => [p.category, p.status]).sort()).toEqual([['dispatch_request', 'resolved'], ['prompt_request', 'obsolete']]);
    expect(h.repo.listEpochs(S).map((e) => e.reason)).toEqual(['start', 'amend']);
    expect(h.getSession(S)).toMatchObject({ epoch: 1, phase: 'generate' });
    const next = h.openCharacterBatch(S, rid());
    expect(next).toMatchObject({ epoch: 1, generation: 1 });
  });

  it('a rejected amend rolls the whole transition back', () => {
    const { h } = newHarness();
    createSession(h, S);
    h.runSystemPrepare(S, rid());
    const { batchId, pauses } = charBatch(h, [{ actor: SHI, action: A.approve() }, { actor: SHI, action: A.dispatch() }]);
    const pause = pauses[0];
    if (!pause) throw new Error('no pause');
    expect(() =>
      h.resolvePause(S, pause.id, { option: 'amend', amend: { docId: 'doc:1', baseDocVersion: 7, terms: DOC_TERMS, note: '' } }, rid()),
    ).toThrow(/amend rejected/);
    expect(h.repo.getBatch(batchId).status).toBe('paused');
    expect(h.getSession(S).epoch).toBe(0);
    expect(h.repo.listSessionDecisions(S)).toEqual([]);
  });

  it('decision world-effects are applied inside the commit transaction (delegate ⇒ authorization first)', () => {
    const { h } = newHarness();
    createSession(h, S);
    h.runSystemPrepare(S, rid());
    const approve = charBatch(h, [{ actor: SHI, action: A.approve() }]);
    h.commitBatch({ sessionId: S, batchId: approve.batchId, requestId: rid() });
    const { pauses } = charBatch(h, [{ actor: SHI, action: A.dispatch() }]);
    const pause = pauses[0];
    if (!pause) throw new Error('no pause');
    const decision: DecisionInput = {
      option: 'delegate',
      authorization: { grantee: SHI, categories: ['dispatch_request', 'major_commitment'], limits: h.getState(S).player.goal.limits, expiresRound: null },
    };
    h.hooks.onStage = (stage) => {
      if (stage === 'events_written') throw new Error('fault during commit');
    };
    expect(() => h.resolvePause(S, pause.id, decision, 'resolve-1')).toThrow('fault during commit');
    expect(h.repo.findPause(pause.id)?.status).toBe('open');
    expect(h.repo.listSessionDecisions(S)).toEqual([]);
    expect(h.getState(S).player.authorizations).toEqual({});
    h.hooks.onStage = undefined;
    const res = h.resolvePause(S, pause.id, decision, 'resolve-1');
    expect(res.status).toBe('committed');
    expect(res.commit?.events.map((e) => e.kind).slice(0, 2)).toEqual(['authorization_granted', 'dispatch_document']);
    expect(h.getState(S).player.authorizations['auth:1']).toMatchObject({ grantee: SHI, revoked: false });
    const stored = h.repo.listProposals(res.commit?.batchId ?? '')[0];
    expect(stored).toMatchObject({ status: 'committed', gate: 'decision' });
  });

  it('the pause plan is recomputed after each decision: withholding makes a later proposal need a pause', () => {
    const { h } = newHarness();
    createSession(h, S);
    h.runSystemPrepare(S, rid());
    const approve = charBatch(h, [{ actor: SHI, action: A.approve() }]);
    h.commitBatch({ sessionId: S, batchId: approve.batchId, requestId: rid() });
    const { batchId, proposalIds, pauses } = charBatch(h, [
      { actor: SHI, action: A.dispatch() },
      { actor: SHI, action: A.propose(YELU, DOC_TERMS) },
    ]);
    expect(pauses.map((p) => [p.category, p.proposalIds])).toEqual([['dispatch_request', [proposalIds[0]]]]);
    const first = h.resolvePause(S, pauses[0]!.id, { option: 'withhold', advice: 'Not yet.' }, rid());
    expect(first.status).toBe('resolved');
    expect(first.newPauseIds).toHaveLength(1);
    const second = h.repo.findPause(first.newPauseIds[0]!);
    expect(second).toMatchObject({ category: 'major_commitment', proposalIds: [proposalIds[1]] });
    const done = h.resolvePause(S, second!.id, { option: 'endorse' }, rid());
    expect(done.status).toBe('committed');
    expect(done.commit?.outcomes.map((o) => o.status)).toEqual(['withheld', 'committed']);
    expect(h.repo.getBatch(batchId).status).toBe('committed');
    expect(h.repo.listDialogue(S).find((d) => d.kind === 'advice')).toMatchObject({ speaker: 'player', listeners: [SHI], text: 'Not yet.' });
  });

  it('options outside the pause options are refused', () => {
    const { h } = newHarness();
    createSession(h, S);
    h.runSystemPrepare(S, rid());
    const { pauses } = charBatch(h, [{ actor: SHI, action: A.approve() }, { actor: SHI, action: A.dispatch() }]);
    expect(() => h.resolvePause(S, pauses[0]!.id, { option: 'let_it_happen' }, rid())).toThrow(/not an option/);
  });
});

describe('negotiation deadlock regenerating transition', () => {
  const t = (extra: Partial<Parameters<typeof T>[0]> = {}) => T({ vassal: true, immediate_silk: 50000, aid_cavalry: 30000, aid_arrival_days: 20, ...extra });

  function toDeadlock(h: Harness) {
    createSession(h, S);
    round(h, [{ actor: YELU, action: A.propose(SHI, t({ filial: true })) }]);
    round(h, [{ actor: SHI, action: A.counter('offer:1', t()) }]);
    round(h, [{ actor: YELU, action: A.counter('offer:2', t({ cession: 'yanmen_north' })) }]);
    h.runSystemPrepare(S, rid());
    return charBatch(h, [{ actor: SHI, action: A.wait() }]);
  }

  it('is atomic: a fault leaves everything as before; otherwise decision, player batch, new segment, obsolete batch and epoch+1 happen together', () => {
    const { h } = newHarness();
    const { batchId, pauses } = toDeadlock(h);
    expect(pauses.map((p) => [p.kind, p.category, p.pair])).toEqual([['control', 'negotiation_deadlock', 'hedong-khitan']]);
    const pause = pauses[0]!;
    const goalLimits = { ...h.getState(S).player.goal.limits, burden_max: 200 };
    const before = { batches: h.repo.listBatches(S).length, hash: hashState(h.getState(S)) };
    h.hooks.onStage = (stage) => {
      if (stage === 'regenerate') throw new Error('fault in transition');
    };
    expect(() => h.resolvePause(S, pause.id, { option: 'adjust_goal', goalLimits }, 'deadlock-1')).toThrow('fault in transition');
    expect(h.repo.findPause(pause.id)?.status).toBe('open');
    expect(h.repo.listBatches(S)).toHaveLength(before.batches);
    expect(hashState(h.getState(S))).toBe(before.hash);
    expect(h.getSession(S).epoch).toBe(0);
    expect(h.repo.listSessionDecisions(S).filter((d) => d.category === 'negotiation_deadlock')).toEqual([]);

    h.hooks.onStage = undefined;
    const res = h.resolvePause(S, pause.id, { option: 'adjust_goal', goalLimits, advice: 'You may give more.' }, 'deadlock-1');
    expect(res).toMatchObject({ status: 'regenerated', epoch: 1 });
    expect(res.commit?.events.map((e) => e.kind)).toEqual(['goal_adjusted', 'deadlock_resolved']);
    const state = h.getState(S);
    expect(state.player.goal.limits.burden_max).toBe(200);
    const reset = h.repo.listEvents(S).find((e) => e.kind === 'deadlock_resolved');
    expect(reset?.decisionId).toBe(res.decisionId);
    expect(state.negotiation['hedong-khitan']).toMatchObject({ segment: 2, segmentOpenedBy: `event:${reset?.version}`, deadlockPending: false });
    expect(h.repo.getBatch(batchId).status).toBe('obsolete');
    expect(h.repo.listDialogue(S).at(-1)).toMatchObject({ kind: 'advice', listeners: [SHI], payload: { goalLimits } });
    // The regenerated batch no longer needs the control pause; Shi may now counter (opening offer of segment 2).
    const next = charBatch(h, [{ actor: SHI, action: A.counter('offer:3', t({ annual_silk: 100000 })) }]);
    expect(next.pauses.map((p) => p.category)).toEqual(['major_commitment']);
  });
});

describe('ADVANCE, mutiny staging and interrupts', () => {
  function lowSupplies(): WorldState {
    return mutate(caseInitialState(fixture(), 'FX1'), (x) => {
      x.factions.hedong.resources.grain = 15;
      x.siege.morale = 32;
    });
  }

  it('stages the mutiny with a pause; interrupts are queued meanwhile; H14 blocks ADVANCE', () => {
    const { h } = newHarness();
    createSession(h, S, 'FX1', 'full', lowSupplies());
    h.runSystemPrepare(S, rid());
    const { batchId } = charBatch(h, []);
    h.commitBatch({ sessionId: S, batchId, requestId: rid() });
    const adv = h.runSystemAdvance(S, rid());
    expect(adv.ok).toBe(true);
    expect(adv.staged?.pauseId).toBeTruthy();
    const pauseId = adv.staged!.pauseId!;
    expect(h.repo.findPause(pauseId)).toMatchObject({ category: 'mutiny', options: ['let_it_happen', 'urge_payment', 'ask'] });

    const intr = h.interrupt(S, { text: 'Pay the troops!' }, rid());
    expect(intr).toMatchObject({ accepted: false, queued: true, epoch: 0, staleBatchId: null });
    expect(h.repo.findPause(pauseId)?.status).toBe('open');
    expect(h.runSystemAdvance(S, rid())).toMatchObject({ ok: false, rule: 'H14' });
    expect(() => h.applyPlayerAction(S, [{ kind: 'action', action: A.timing('now') }], rid())).toThrow(/open/);

    const res = h.resolvePause(S, pauseId, { option: 'let_it_happen' }, rid());
    expect(res.status).toBe('committed');
    expect(h.getState(S).siege.morale).toBe(0);
    expect(h.getSession(S).phase).toBe('prepare');
    h.runSystemPrepare(S, rid());
    expect(h.takeInstructions(S, rid()).instructions.map((i) => [i.text, i.interrupted, i.appliedRound])).toEqual([['Pay the troops!', false, 2]]);
  });

  it('baseline commits the staged outcome without a pause', () => {
    const { h } = newHarness();
    createSession(h, S, 'FX1', 'baseline', lowSupplies());
    h.runSystemPrepare(S, rid());
    const { batchId } = charBatch(h, []);
    h.commitBatch({ sessionId: S, batchId, requestId: rid() });
    const adv = h.runSystemAdvance(S, rid());
    expect(adv.staged).toMatchObject({ pauseId: null });
    expect(adv.events.map((e) => e.kind)).toEqual(['advance', 'mutiny_outbreak']);
    expect(h.openPauses(S)).toEqual([]);
  });
});

describe('recovery', () => {
  it('after a crash mid-round, a generating batch is marked stale and the round regenerates', () => {
    const { h, dbPath } = newHarness();
    createSession(h, S);
    h.runSystemPrepare(S, rid());
    const { batchId } = h.openCharacterBatch(S, rid());
    h.submitProposals(S, batchId, [{ actor: SHI, action: A.approve() }], rid());
    h.close(); // crash before ASSESS/COMMIT
    const h2 = openHarness(dbPath);
    const report = h2.recover(S, rid());
    expect(report).toMatchObject({ staleBatches: [batchId], epoch: 1, status: 'ready', phase: 'generate' });
    expect(h2.repo.getBatch(batchId).status).toBe('stale');
    expect(h2.repo.listEpochs(S).map((e) => e.reason)).toEqual(['start', 'recovery']);
    expect(h2.commitBatch({ sessionId: S, batchId, requestId: rid() })).toMatchObject({ ok: false, rule: 'H05' });
    const again = h2.openCharacterBatch(S, rid());
    expect(again.epoch).toBe(1);
    h2.submitProposals(S, again.batchId, [{ actor: SHI, action: A.approve() }], rid());
    h2.assess(S, again.batchId, rid());
    expect(h2.commitBatch({ sessionId: S, batchId: again.batchId, requestId: rid() }).ok).toBe(true);
  });

  it('pauses survive a crash during the commit that would have resolved them', () => {
    const { h, dbPath } = newHarness();
    createSession(h, S);
    h.runSystemPrepare(S, rid());
    const { pauses } = charBatch(h, [{ actor: SHI, action: A.approve() }, { actor: SHI, action: A.dispatch() }]);
    h.hooks.onStage = (stage) => {
      if (stage === 'proposals_written') throw new Error('crash');
    };
    expect(() => h.resolvePause(S, pauses[0]!.id, { option: 'endorse' }, rid())).toThrow('crash');
    h.close();
    const h2 = openHarness(dbPath);
    const report = h2.recover(S, rid());
    expect(report).toMatchObject({ restoredPauses: [pauses[0]!.id], status: 'awaiting_decision', phase: 'decide' });
    expect(h2.resolvePause(S, pauses[0]!.id, { option: 'endorse' }, rid()).status).toBe('committed');
  });
});

describe('narration', () => {
  it('regeneration re-narrates stored facts without touching events or state; failures are narration_pending', async () => {
    const { h } = newHarness();
    createSession(h, S);
    h.runSystemPrepare(S, rid());
    const { batchId } = charBatch(h, [{ actor: SHI, action: A.approve() }, { actor: LIU, action: A.speak([SHI], '慎之。') }]);
    const commit = h.commitBatch({ sessionId: S, batchId, requestId: rid() });
    const versions = commit.events.map((e) => e.version);
    h.recordNarration(S, { batchId, scene: 'jinyang_hq', eventVersions: versions, status: 'failed', raw: null, header: 'h', displayed: '', check: { error: 'timeout' } }, rid());
    expect(h.repo.getBatch(batchId).narrationStatus).toBe('failed');
    expect(h.recover(S, rid()).narrationPending).toEqual([batchId]);
    const before = { events: JSON.stringify(h.repo.listEvents(S)), hash: hashState(h.getState(S)) };
    const seen: string[] = [];
    const ids = await h.regenerateNarration(S, versions, (req) => {
      seen.push(...req.facts.map((f) => f.kind));
      return { status: 'ok', raw: '石公批之。', header: 'Shi approved doc:1 v1.', displayed: 'Shi approved doc:1 v1.\n石公批之。', check: { hits: [] } };
    });
    expect(ids).toHaveLength(1);
    expect(seen).toEqual(['document_approved']);
    expect(JSON.stringify(h.repo.listEvents(S))).toBe(before.events);
    expect(hashState(h.getState(S))).toBe(before.hash);
    const rows = h.repo.listNarrations(S);
    expect(rows.map((r) => [r.attempt, r.status])).toEqual([[1, 'failed'], [2, 'ok']]);
    expect(h.repo.getBatch(batchId).narrationStatus).toBe('done');
    expect(h.replay(S, 'rederive').ok).toBe(true);
  });
});

describe('branching at round starts', () => {
  it('copies snapshot, events and dialogue up to the round start; the child continues independently', () => {
    const { h } = newHarness();
    createSession(h, S);
    h.runSystemPrepare(S, rid());
    h.applyPlayerAction(S, [{ kind: 'dialogue', to: [SHI], text: 'R1 speech' }], rid());
    const r1 = charBatch(h, [{ actor: SHI, action: A.approve() }, { actor: SHI, action: A.dispatch() }, { actor: LIU, action: A.speak([SHI], 'R1 Liu') }]);
    h.resolvePause(S, r1.pauses[0]!.id, { option: 'endorse' }, rid());
    h.runSystemAdvance(S, rid());
    h.runSystemPrepare(S, rid()); // records round_starts(2)
    h.applyPlayerAction(S, [{ kind: 'dialogue', to: [SHI], text: 'R2 speech (after the round start)' }], rid());
    const start = h.repo.findRoundStart(S, 2)!;
    expect(start.dialogueSeqCutoff).toBe(2);

    const b = h.branch(S, 2, 'child', rid());
    expect(b).toMatchObject({ newSessionId: 'child', round: 2, version: start.version });
    const child = h.getSession('child');
    expect(child).toMatchObject({ parentSessionId: S, parentRound: 2, parentVersion: start.version, epoch: 0, phase: 'prepare', baseVersion: start.version });
    expect(hashState(h.getState('child'))).toBe(h.repo.getSnapshot(S, start.version)!.hash);
    expect(h.repo.listDialogue('child').map((d) => [d.text, d.inherited])).toEqual([['R1 speech', true], ['R1 Liu', true]]);
    expect(h.repo.listEvents('child').every((e) => e.inherited && e.version <= start.version)).toBe(true);
    expect(() => h.branch(S, 5, 'nope', rid())).toThrow(/no recorded round start/);

    // The child resumes at PREPARE of round 2 and diverges: Yelü confirms; the parent's Yelü rejects.
    h.runSystemPrepare('child', rid());
    const cb = h.openCharacterBatch('child', rid());
    h.submitProposals('child', cb.batchId, [{ actor: YELU, action: A.confirm('cmt:1', 'offer:1', 1) }], rid());
    h.assess('child', cb.batchId, rid());
    h.commitBatch({ sessionId: 'child', batchId: cb.batchId, requestId: rid() });
    h.runSystemAdvance('child', rid());
    h.runSystemPrepare('child', rid());
    expect(h.getState('child').terminal?.kind).toBe('pact_concluded');

    const pb = charBatch(h, [{ actor: YELU, action: A.reject('offer:1') }]);
    h.commitBatch({ sessionId: S, batchId: pb.batchId, requestId: rid() });
    h.runSystemAdvance(S, rid());
    h.runSystemPrepare(S, rid());
    expect(h.getState(S).terminal).toBeNull();
    for (const id of [S, 'child']) {
      expect(h.replay(id, 'patch').mismatches).toEqual([]);
      expect(h.replay(id, 'rederive').mismatches).toEqual([]);
    }
  });
});

describe('exports, lock and mutex', () => {
  it('VACUUM INTO produces a copy (path with spaces) that reopens and replays', () => {
    const { h, dir } = newHarness();
    createSession(h, S);
    round(h, [{ actor: SHI, action: A.approve() }, { actor: SHI, action: A.dispatch() }]);
    const target = path.join(dir, 'export dir', 'jinyang copy.sqlite');
    h.exportDatabase(target);
    const copy = Store.open(target, { readOnly: true });
    try {
      const repo = new Repo(copy);
      expect(repo.listEvents(S)).toHaveLength(eventCount(h));
      expect(replayPatch(repo, S).ok).toBe(true);
    } finally {
      copy.close();
    }
  });

  it('exports the audit bundle as JSONL, with usage records and lineage', () => {
    const { h } = newHarness();
    createSession(h, S);
    round(h, [{ actor: SHI, action: A.approve() }, { actor: SHI, action: A.dispatch() }]);
    h.usageSink(S).record(
      { callId: 'c-1', ts: 't', role: 'character', model: 'mock', promptHash: 'p', inputTokens: 1, outputTokens: 1, costUsd: null, costSource: 'none', latencyMs: 1, attempts: 1, status: 'ok' },
      [{ callId: 'c-1', attemptNo: 1, kind: 'first', status: 'ok', latencyMs: 1, generationId: null, inputTokens: 1, outputTokens: 1, costUsd: null, costSource: 'none', reconciled: false }],
    );
    const dir = path.join(tempDir(), 'audit bundle');
    const files = h.exportAudit(S, dir);
    for (const f of files) expect(existsSync(f)).toBe(true);
    const lines = (name: string) => readFileSync(path.join(dir, name), 'utf8').trim().split('\n').filter(Boolean);
    expect(lines('events.jsonl')).toHaveLength(eventCount(h));
    expect(lines('llm_calls.jsonl')).toHaveLength(1);
    expect(lines('llm_attempts.jsonl')).toHaveLength(1);
    expect(JSON.parse(lines('decisions.jsonl')[0]!)).toMatchObject({ option: 'endorse', category: 'dispatch_request' });
    const session = JSON.parse(readFileSync(path.join(dir, 'session.json'), 'utf8')) as { lineage: unknown; mode: string };
    expect(session).toMatchObject({ lineage: null, mode: 'full' });
  });

  it('a second harness on the same database is refused', () => {
    const { dbPath } = newHarness();
    expect(() => openHarness(dbPath)).toThrow(LockError);
  });

  it('the session mutex serialises async work per session', async () => {
    const mutex = new SessionMutex();
    const log: string[] = [];
    const task = (name: string, ms: number) =>
      mutex.run('s', async () => {
        log.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, ms));
        log.push(`${name}:end`);
      });
    await Promise.all([task('a', 20), task('b', 1), mutex.run('other', () => log.push('other'))]);
    expect(log.indexOf('a:end')).toBeLessThan(log.indexOf('b:start'));
    expect(mutex.isLocked('s')).toBe(false);
  });
});


describe('scripted PLAYER step (PLAN §12.4)', () => {
  it('applies inputs whose conditions hold, resolves "$current", logs skipped inputs and records probes', () => {
    const { h } = newHarness();
    createSession(h, S);
    h.runSystemPrepare(S, rid());
    const inputs = [
      { dialogue: { to: [SHI], text: '请速决。' } },
      { action: A.timing('now'), when: { doc_status: { docId: 'doc:1', status: 'draft' as const } } },
      {
        action: { type: 'revise_document', args: { docId: 'doc:1', baseDocVersion: '$current', terms: { ...DOC_TERMS, immediate_silk: 200000 }, note: 'probe' } },
        probe: true,
      },
      { action: A.wait(), when: { player_received: { kind: 'response' as const, from: YELU } } },
    ];
    const r = h.applyScriptInputs(S, inputs, 'script-1');
    expect(r.applied.map((a) => [a.index, a.kind, a.probe])).toEqual([[0, 'dialogue', false], [1, 'action', false], [2, 'action', true]]);
    expect(r.skipped.map((x) => x.index)).toEqual([3]);
    expect(r.outcomes.map((o) => o.status)).toEqual(['committed', 'committed']);
    expect(h.getState(S).documents['doc:1']?.version).toBe(2); // "$current" resolved to v1
    const proposals = h.repo.listProposals(r.batchId!);
    expect(proposals.map((p) => p.probe)).toEqual([false, true]);
    expect(h.repo.findRequest(S, 'script-1')?.result).toMatchObject({ skipped: [{ index: 3 }] });
    expect(h.applyScriptInputs(S, inputs, 'script-1').replayed).toBe(true);
  });
});
