/**
 * Pause facts are rendered from the world as each paused proposal would find it (core `stateBeforeProposal`): a
 * batch that revises the draft, approves and dispatches must show the dispatched terms in the stored pause facts —
 * the facts feed the audit bundle and the human-evaluation packets.
 */
import { describe, expect, it } from 'vitest';
import { A, DOC_TERMS, SHI } from '../core/helpers.js';
import { createSession, newHarness, rid } from './helpers.js';

const S = 's';

describe('pause facts use the projected state before the paused proposal', () => {
  it('revise 50,000 → 80,000, approve, dispatch in one batch: the stored dispatch fact shows 80,000', () => {
    const { h } = newHarness();
    createSession(h, S);
    h.runSystemPrepare(S, rid());
    expect(h.getState(S).documents['doc:1']?.terms.immediate_silk).toBe(50_000);
    const { batchId } = h.openCharacterBatch(S, rid());
    h.submitProposals(
      S,
      batchId,
      [
        { actor: SHI, action: A.revise(1, { ...DOC_TERMS, immediate_silk: 80_000 }, 'more silk') },
        { actor: SHI, action: A.approve(2) },
        { actor: SHI, action: A.dispatch(2) },
      ],
      rid(),
    );
    h.assess(S, batchId, rid());
    const pause = h.openPauses(S).find((p) => p.category === 'dispatch_request');
    expect(pause).toBeDefined();
    const facts = JSON.stringify(pause!.visibleFacts);
    expect(facts).toContain('immediate_silk=80000');
    expect(facts).not.toContain('immediate_silk=50000');
    expect(facts).toContain('dispatch doc:1 v2');
    // Endorsing sends exactly what the fact said.
    h.resolvePause(S, pause!.id, { option: 'endorse' }, rid());
    const offer = Object.values(h.getState(S).offers).find((o) => o.from === SHI);
    expect(offer?.terms.immediate_silk).toBe(80_000);
    // The siege line still describes the current world (before the batch).
    expect(pause!.visibleFacts[0]?.en).toMatch(/^Day 0 \(round 1\)/);
  });

  it('a single dispatch (nothing before it in the batch) renders the current state as before', () => {
    const { h } = newHarness();
    createSession(h, S);
    h.runSystemPrepare(S, rid());
    const { batchId } = h.openCharacterBatch(S, rid());
    h.submitProposals(S, batchId, [{ actor: SHI, action: A.approve(1) }, { actor: SHI, action: A.dispatch(1) }], rid());
    h.assess(S, batchId, rid());
    const pause = h.openPauses(S).find((p) => p.category === 'dispatch_request');
    expect(JSON.stringify(pause!.visibleFacts)).toContain('immediate_silk=50000');
  });
});
