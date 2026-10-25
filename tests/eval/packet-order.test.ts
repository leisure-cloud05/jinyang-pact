/**
 * Human-evaluation packets keep the chronological order within a round (what the player knew when deciding):
 * dialogue appears where it was written (`controlAt`: committed speech after the decision that let its batch
 * commit; an unlinked player interjection where it happened), and every decision is placed at its own position,
 * so "ask → answer → endorse" reads in that order.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPacket } from '../../src/eval/humaneval.js';
import { loadBundle, type AuditBundle, type BDecision, type BDialogue } from '../../src/eval/oracle/bundle.js';
import { mockFactory, planSpec, runExperiment } from '../../src/eval/runner.js';
import { content, tempDir } from './helpers.js';

async function c3Bundle(): Promise<AuditBundle> {
  const out = path.join(tempDir('jinyang packet order '), 'exp');
  const res = await runExperiment({
    plan: planSpec('main', { cases: ['C3'], modes: ['full'], reps: 1 }),
    outDir: out,
    content: content(),
    llm: mockFactory(0),
    live: false,
    lang: 'zh',
    misbehaviourRate: 0,
  });
  const run = res.runs[0]!;
  expect(run.error).toBeNull();
  return loadBundle(path.join(out, run.runId, 'audit'));
}

function line(text: string, over: Partial<BDialogue>): BDialogue {
  return { seq: 0, round: 1, epoch: 0, worldVersion: 0, speaker: 'shi_jingtang', listeners: ['player'], text, kind: 'speech', proposalId: null, decisionId: null, payload: null, inherited: false, controlAt: null, ...over };
}

/** Flattened lines of one round with their block index. */
function roundLines(bundle: AuditBundle, round: number): string[] {
  const doc = buildPacket('X', bundle, content());
  return doc.rounds.find((r) => r.round === round)!.blocks.flatMap((b) => b.lines);
}
const indexOf = (lines: string[], needle: string): number => lines.findIndex((l) => l.includes(needle));

describe('packet chronology', () => {
  it('real bundles record a control position for every dialogue row', async () => {
    const bundle = await c3Bundle();
    expect(bundle.dialogue.length).toBeGreaterThan(0);
    for (const d of bundle.dialogue) expect(typeof d.controlAt).toBe('number');
  });

  it('committed speech, unlinked interjections and ask/answer/endorse appear in emission order', async () => {
    const real = await c3Bundle();
    const decision = real.decisions.find((d) => d.option === 'urge_stop')!;
    const pause = real.pauses.find((p) => p.pauseId === decision.pauseId)!;
    const regen = real.batches.find((b) => b.round === decision.round && b.controlSeq > decision.controlSeq && real.proposals.some((p) => p.batchId === b.batchId))!;
    const proposal = real.proposals.find((p) => p.batchId === regen.batchId)!;
    const round = decision.round;
    // A dialogue row written at control position X sits right after control record X. The interjection is written
    // after the pause opened (X = the pause); the ask decision follows (fractional: no real record sits there).
    const askAt = pause.controlSeq + 0.7;
    const ask: BDecision = { ...decision, decisionId: `${decision.decisionId}-ask`, option: 'ask', advice: '【问】何以罢议？', controlSeq: askAt };
    const bundle: AuditBundle = {
      ...real,
      decisions: [...real.decisions, ask],
      dialogue: [
        // Written before the pause opened but committed only after the decision (its batch commits later).
        line('【再议之言】', { seq: 0, round, proposalId: proposal.proposalId, controlAt: regen.commitSeq ?? regen.controlSeq }),
        // The answer to the question, written right after the ask decision.
        line('【答】兵力已竭。', { seq: 0, round, kind: 'answer', payload: { decisionId: ask.decisionId }, controlAt: askAt }),
        // A player interjection with no proposal or decision link, after the pause opened.
        line('【插话】诸公且慢。', { seq: 0, round, speaker: 'player', listeners: ['shi_jingtang'], controlAt: pause.controlSeq }),
        ...real.dialogue,
      ],
    };
    const lines = roundLines(bundle, round);
    const opened = indexOf(lines, '【请示 ');
    const interject = indexOf(lines, '【插话】');
    const asked = indexOf(lines, '【问】何以罢议？');
    const answered = indexOf(lines, '【答】兵力已竭。');
    const decided = lines.findIndex((l, i) => i > answered && l.startsWith('书记之决') && !l.includes('【问】'));
    const committed = indexOf(lines, '【再议之言】');
    expect(opened).toBeGreaterThanOrEqual(0);
    expect(interject).toBeGreaterThan(opened);
    expect(asked).toBeGreaterThan(interject);
    expect(answered).toBeGreaterThan(asked);
    expect(decided).toBeGreaterThan(answered);
    expect(committed).toBeGreaterThan(decided);
  });
});
