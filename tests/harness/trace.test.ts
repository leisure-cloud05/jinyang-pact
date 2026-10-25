import { describe, expect, it } from 'vitest';
import { caseCoreConfig, caseInitialState } from '../../src/content/loader.js';
import { hashState } from '../../src/core/hash.js';
import { simulateTrace } from '../../src/core/simulate.js';
import { fixture } from '../core/helpers.js';
import { createSession, newHarness, playTrace, traceOf } from './helpers.js';

describe('reference traces through the harness', () => {
  for (const caseId of ['FX1', 'FX3']) {
    for (const mode of ['full', 'no_judge'] as const) {
      it(`${caseId} (${mode}): same terminal and final world hash as the pure core, replays reproduce it`, () => {
        const { h } = newHarness();
        createSession(h, 's1', caseId, mode);
        playTrace(h, 's1', traceOf(caseId));
        const core = simulateTrace(caseInitialState(fixture(), caseId), caseCoreConfig(fixture(), caseId), traceOf(caseId), mode);
        const state = h.getState('s1');
        expect(state.terminal).toEqual(core.terminal);
        // World state carries no control ids: harness and pure simulator agree exactly.
        expect(hashState(state)).toBe(hashState(core.state));
        const openedBy = state.negotiation['hedong-khitan'].segmentOpenedBy;
        if (openedBy !== null && openedBy !== 'first_offer') {
          const reset = h.repo.listEvents('s1').find((e) => `event:${e.version}` === openedBy);
          expect(reset?.kind).toBe('deadlock_resolved');
          const decision = h.repo.listSessionDecisions('s1').find((d) => d.decisionId === reset?.decisionId);
          expect(decision).toMatchObject({ category: 'negotiation_deadlock', option: 'urge_stop' });
        }
        expect(h.getSession('s1').status).toBe('finished');
        const patch = h.replay('s1', 'patch');
        const rederive = h.replay('s1', 'rederive');
        expect(patch.mismatches).toEqual([]);
        expect(rederive.mismatches).toEqual([]);
        expect(patch.ok && rederive.ok).toBe(true);
        expect(rederive.checkedEvents).toBe(core.events.length);
      });
    }
  }

  it('FX3 runs the deadlock regenerating transition: epoch 1, obsolete batch, new segment', () => {
    const { h } = newHarness();
    createSession(h, 's3', 'FX3');
    playTrace(h, 's3', traceOf('FX3'));
    expect(h.getSession('s3').epoch).toBe(1);
    expect(h.repo.listEpochs('s3').map((e) => e.reason)).toEqual(['start', 'deadlock:urge_stop']);
    const obsolete = h.repo.listBatches('s3').filter((b) => b.status === 'obsolete');
    expect(obsolete).toHaveLength(1);
    expect(h.getState('s3').negotiation['hedong-khitan'].segment).toBe(2);
    const advice = h.repo.listDialogue('s3').filter((d) => d.kind === 'advice');
    expect(advice.map((d) => d.listeners)).toContainEqual(['shi_jingtang']);
  });

  it('baseline mode: the permissive path commits and re-derives', () => {
    const { h } = newHarness();
    createSession(h, 'b1', 'FX1', 'baseline');
    playTrace(h, 'b1', traceOf('FX1'));
    expect(h.getState('b1').terminal?.kind).toBe('pact_concluded');
    expect(h.replay('b1', 'rederive').mismatches).toEqual([]);
    expect(h.replay('b1', 'patch').ok).toBe(true);
    // The critical dispatch committed without a pause in baseline.
    const dispatch = h.repo.listSessionProposals('b1').find((p) => (p.action as { type?: string }).type === 'dispatch_document');
    expect(dispatch).toMatchObject({ status: 'committed', gate: 'ungated' });
  });
});
