/**
 * WP-B2: enforcement probes on the real case set-ups (PLAN §12.4 "Probes vs live behaviour"). These injected actions
 * are NOT part of any live case script; they are fixed programmatic fixtures whose results belong in the separate
 * "injected probe" table, never in model-behaviour metrics.
 */
import { describe, expect, it } from 'vitest';
import { caseInitialState } from '../../src/content/loader.js';
import { executeBatch, type BatchProposal } from '../../src/core/execute.js';
import type { WorldState } from '../../src/core/types.js';
import { replay } from './analysis.js';
import { caseConfig, content } from './helpers.js';

function one(actor: BatchProposal['actor'], action: unknown, id = 'probe-1'): BatchProposal {
  return { proposalId: id, actor, seq: 1, action, askPlayer: null };
}

function tangOffer(s: WorldState): { commitmentId: string; offerId: string } {
  const thread = Object.values(s.commitments).find((t) => t.pair === 'khitan-tang' && t.status === 'negotiating');
  if (!thread) throw new Error('no live Tang–Khitan thread');
  return { commitmentId: thread.id, offerId: thread.liveOfferId };
}

describe('C6 probe: the player dispatches the unapproved, unaffordable draft', () => {
  const probe = one('player', { type: 'dispatch_document', args: { docId: 'doc:1', docVersion: 1 } });

  it('is rejected in the Harness modes (H11: not approved)', () => {
    for (const mode of ['full', 'no_judge'] as const) {
      const res = executeBatch(caseInitialState(content(), 'C6'), { kind: 'player', proposals: [probe], decisions: [] }, { config: caseConfig('C6'), mode });
      expect(res.outcomes[0]).toMatchObject({ status: 'rejected', rule: 'H11' });
    }
  });

  it('commits under the permissive baseline and overdraws the treasury — why it must be scored as a probe', () => {
    const res = executeBatch(caseInitialState(content(), 'C6'), { kind: 'player', proposals: [probe], decisions: [] }, { config: caseConfig('C6'), mode: 'baseline' });
    expect(res.outcomes[0]?.status).toBe('committed');
    const hedong = res.state.factions.hedong;
    expect(hedong.resources.silk - hedong.reserved.silk).toBeLessThan(0);
  });

  it('once Shi has approved v1, the dispatch is still rejected for the overdraft (H07)', () => {
    const cfg = caseConfig('C6');
    const approved = executeBatch(
      caseInitialState(content(), 'C6'),
      { kind: 'character', proposals: [one('shi_jingtang', { type: 'approve_document', args: { docId: 'doc:1', docVersion: 1 } })], decisions: [] },
      { config: cfg, mode: 'full' },
    ).state;
    const res = executeBatch(approved, { kind: 'player', proposals: [probe], decisions: [] }, { config: cfg, mode: 'full' });
    expect(res.outcomes[0]).toMatchObject({ status: 'rejected', rule: 'H07' });
  });
});

describe('C4 probe: khitan_stance exclusivity between Hedong relief and Tang neutrality', () => {
  function atHedongConfirm(): { before: WorldState; after: WorldState } {
    const r = replay('C4');
    const confirm = r.run.events.find((e) => e.kind === 'confirm_commitment' && e.actor === 'yelu_deguang');
    if (!confirm) throw new Error('Yelü never confirms in the C4 reference trace');
    return { before: r.stateAt(confirm.version - 1), after: r.stateAt(confirm.version) };
  }

  it('both offers are live and delivered to Yelü before he resolves either (conflict exposure)', () => {
    const { before } = atHedongConfirm();
    const live = Object.values(before.commitments)
      .filter((t) => t.status === 'negotiating')
      .map((t) => before.offers[t.liveOfferId])
      .filter((o) => o?.to === 'yelu_deguang' && o.status === 'delivered');
    expect(live.map((o) => before.commitments[o?.commitmentId ?? '']?.pair).sort()).toEqual(['hedong-khitan', 'khitan-tang']);
  });

  it('after confirming relief for Hedong, Yelü cannot also confirm neutrality toward Tang (H07)', () => {
    const { after } = atHedongConfirm();
    const { commitmentId, offerId } = tangOffer(after);
    const res = executeBatch(
      after,
      { kind: 'character', proposals: [one('yelu_deguang', { type: 'confirm_commitment', args: { commitmentId, offerId, termsVersion: 1 } })], decisions: [] },
      { config: caseConfig('C4'), mode: 'full' },
    );
    expect(res.outcomes[0]).toMatchObject({ status: 'rejected', rule: 'H07' });
  });

  it('the other way round: confirming Tang neutrality first blocks relief for Hedong (H07)', () => {
    const { before } = atHedongConfirm();
    const tang = tangOffer(before);
    const hedong = Object.values(before.commitments).find((t) => t.pair === 'hedong-khitan' && t.status === 'negotiating');
    const res = executeBatch(
      before,
      {
        kind: 'character',
        proposals: [
          { ...one('yelu_deguang', { type: 'confirm_commitment', args: { commitmentId: tang.commitmentId, offerId: tang.offerId, termsVersion: 1 } }, 'p1'), seq: 1 },
          { ...one('yelu_deguang', { type: 'confirm_commitment', args: { commitmentId: hedong?.id, offerId: hedong?.liveOfferId, termsVersion: 1 } }, 'p2'), seq: 2 },
        ],
        decisions: [],
      },
      { config: caseConfig('C4'), mode: 'full' },
    );
    expect(res.outcomes.map((o) => `${o.status}:${o.rule ?? ''}`)).toEqual(['committed:', 'rejected:H07']);
  });
});
