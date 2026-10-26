/** Character agent: messages/meta, output → drafts, cite stripping, format_error → wait, personas on C1. */
import { describe, expect, it } from 'vitest';
import { mapCharacterOutput, runCharacterTurn } from '../../src/agents/character.js';
import { buildCharacterContext } from '../../src/agents/context.js';
import { registerMockPersonas } from '../../src/agents/mock-personas/index.js';
import { parseAction } from '../../src/core/actions.js';
import { executeBatch, type BatchProposal } from '../../src/core/execute.js';
import { planPauses } from '../../src/core/plan.js';
import { CHAR_IDS } from '../../src/core/types.js';
import { cfg, content, driver, newMock, personas } from './helpers.js';

const C1_OPENING = [
  {
    seq: 1,
    round: 1,
    epoch: 0,
    worldVersion: 0,
    speaker: 'player' as const,
    listeners: ['shi_jingtang' as const, 'sang_weihan' as const],
    text: '明公，表已誊毕，请即用印遣使。',
    kind: 'speech' as const,
  },
];

describe('character agent', () => {
  it('mock personas produce valid proposals for C1\'s opening situation that the rules accept', async () => {
    const { mock, sink } = newMock();
    registerMockPersonas(mock);
    const d = driver('C1');
    const p = personas('C1');
    const batch: BatchProposal[] = [];
    for (const id of CHAR_IDS) {
      const r = await runCharacterTurn({
        client: mock,
        content: content(),
        config: d.config,
        state: d.state,
        charId: id,
        lang: 'zh',
        variant: 'harness',
        identity: { sessionId: 's', caseId: 'C1', rep: 1, round: 1, epoch: 0 },
        persona: p[id],
        dialogue: C1_OPENING,
      });
      expect(r.status, id).toBe('ok');
      expect(r.citeErrors).toBe(0);
      expect(r.drafts.length).toBeGreaterThan(0);
      for (const draft of r.drafts) {
        expect(parseAction(draft.action).ok).toBe(true);
        batch.push({ proposalId: `${id}-${draft.seq}`, actor: id, seq: draft.seq, action: draft.action, askPlayer: draft.askPlayer });
      }
      // The prompt is exactly what the mock saw; the meta carries no world state.
      const call = sink.records[sink.records.length - 1];
      expect(call?.role).toBe('character');
      expect(call?.actor).toBe(id);
    }
    const types = batch.map((b) => `${b.actor}:${(b.action as { type: string }).type}`);
    expect(types).toContain('shi_jingtang:approve_document');
    expect(types).toContain('shi_jingtang:dispatch_document');
    expect(types).toContain('liu_zhiyuan:suggest_revision');
    const plan = planPauses(d.state, { kind: 'character', proposals: batch, decisions: [] }, { config: d.config, mode: 'no_judge' });
    expect(plan.rejected).toEqual([]);
    expect(plan.required.map((r) => r.category)).toContain('dispatch_request');
    const decisions = plan.required.map((r, i) => ({ decisionId: `d${i}`, category: r.category, option: 'endorse' as const, proposalIds: r.proposalIds, pair: r.pair }));
    const result = executeBatch(d.state, { kind: 'character', proposals: batch, decisions }, { config: d.config, mode: 'no_judge' });
    expect(result.outcomes.filter((o) => o.status !== 'committed')).toEqual([]);
    expect(result.state.documents['doc:1']?.status).toBe('sent');
  });

  it('passes only the structured context in meta (no world state)', async () => {
    const { mock } = newMock();
    let seen: Record<string, unknown> | undefined;
    mock.register('character', (req) => {
      seen = req.meta;
      return { speech: '', private_rationale: 'r', actions: [], ask_player: null };
    });
    const d = driver('C1');
    await runCharacterTurn({ client: mock, content: content(), config: d.config, state: d.state, charId: 'sang_weihan', lang: 'en', variant: 'baseline', identity: { round: 1 } });
    expect(seen?.agent).toBe('character');
    expect(Object.keys(seen ?? {}).sort()).toEqual(['agent', 'citeKeys', 'context', 'identity', 'lang', 'revision', 'variant']);
    const text = JSON.stringify(seen);
    expect(text).not.toContain('"knowledge"');
    expect(text).not.toContain('"reservations"');
    expect(text).not.toContain('"counters"');
  });

  it('maps speech to a speak draft for those present, strips invalid cites and attaches ask_player', () => {
    const d = driver('C1');
    const built = buildCharacterContext({ content: content(), config: cfg('C1'), state: d.state, charId: 'shi_jingtang', lang: 'en', maxChars: 1_000_000 });
    const mapped = mapCharacterOutput(
      'shi_jingtang',
      {
        speech: 'Seal it.',
        private_rationale: 'r',
        actions: [
          { type: 'approve_document', args: { docId: 'doc:1', docVersion: 1 }, rationale: 'a', cites: ['doc:1', 'zztj280-012', 'zztj280-999', 'k:99999', 'doc:1'] },
          { type: 'dispatch_document', args: { docId: 'doc:1', docVersion: 1 }, rationale: 'b', cites: ['zztj280-014'] },
        ],
        ask_player: { question: 'Send now?' },
        interaction: null,
      },
      built.context,
      built.citeKeys,
    );
    expect(mapped.drafts.map((x) => [x.seq, x.action.type])).toEqual([
      [0, 'speak'],
      [1, 'approve_document'],
      [2, 'dispatch_document'],
    ]);
    const speak = mapped.drafts[0]?.action;
    expect(speak?.type === 'speak' && speak.args.to.sort()).toEqual(['liu_zhiyuan', 'player', 'sang_weihan']);
    expect(mapped.drafts[1]?.cites).toEqual(['doc:1', 'zztj280-012']);
    expect(mapped.citeErrors).toBe(3); // two fabricated ids + one never_initial source
    expect(mapped.strippedCites).toEqual(['zztj280-999', 'k:99999', 'zztj280-014']);
    // ask_player goes to the first consequential action (dispatch), not to speech or the approval.
    expect(mapped.drafts.find((x) => x.askPlayer)?.action.type).toBe('dispatch_document');
  });

  it('treats an unusable reply (after the repair retry) as format_error → one wait draft', async () => {
    const { mock } = newMock();
    registerMockPersonas(mock);
    mock.injectFaults(['invalid_json', 'schema_invalid'], { role: 'character' });
    const d = driver('C1');
    const r = await runCharacterTurn({ client: mock, content: content(), config: d.config, state: d.state, charId: 'shi_jingtang', lang: 'zh', variant: 'harness', identity: { round: 1 } });
    expect(r.status).toBe('format_error');
    expect(r.llm.repairUsed).toBe(true);
    expect(r.drafts).toHaveLength(1);
    expect(r.drafts[0]?.action).toEqual({ type: 'wait', args: {} });
  });

  it('recovers with the single repair retry, and reports transport failures as errors without drafts', async () => {
    const { mock } = newMock();
    registerMockPersonas(mock);
    const d = driver('C1');
    mock.injectFaults(['invalid_json'], { role: 'character' });
    const repaired = await runCharacterTurn({ client: mock, content: content(), config: d.config, state: d.state, charId: 'shi_jingtang', lang: 'en', variant: 'harness', identity: { round: 1 } });
    expect(repaired.status).toBe('ok');
    expect(repaired.llm.repairUsed).toBe(true);
    mock.injectFaults(['http_400'], { role: 'character' });
    const failed = await runCharacterTurn({ client: mock, content: content(), config: d.config, state: d.state, charId: 'shi_jingtang', lang: 'en', variant: 'harness', identity: { round: 1 } });
    expect(failed.status).toBe('error');
    expect(failed.drafts).toEqual([]);
    expect(failed.llm.errorKind).toBe('http');
  });

  it('trims every character prompt to about 24,000 characters, well inside the 32,000 input cap', async () => {
    const { mock } = newMock();
    registerMockPersonas(mock);
    const d = driver('C4');
    const longDialogue = Array.from({ length: 200 }, (_v, i) => ({
      seq: i + 1, round: 1, epoch: 0, worldVersion: 0, speaker: 'player' as const, listeners: [...CHAR_IDS], text: '议'.repeat(300), kind: 'speech' as const,
    }));
    for (const id of CHAR_IDS) {
      const r = await runCharacterTurn({ client: mock, content: content(), config: d.config, state: d.state, charId: id, lang: 'zh', variant: 'baseline', identity: { round: 1 }, persona: personas('C4')[id], dialogue: longDialogue });
      expect(r.status, id).toBe('ok');
      const total = r.messages.reduce((n, m) => n + m.content.length, 0);
      expect(total).toBeLessThanOrEqual(24_000);
      expect(r.context.truncation.dialogueDropped).toBeGreaterThan(0);
    }
  });

  it('a revision request makes the persona drop the flagged action', async () => {
    const { mock } = newMock();
    registerMockPersonas(mock);
    const d = driver('C1');
    const r = await runCharacterTurn({
      client: mock, content: content(), config: d.config, state: d.state, charId: 'shi_jingtang', lang: 'en', variant: 'harness', identity: { round: 1 },
      revision: [{ action: { type: 'dispatch_document', args: { docId: 'doc:1', docVersion: 1 } }, reason: 'the council is divided', category: 'internal_disagreement' }],
    });
    expect(r.messages[1]?.content).toContain('REVISION REQUESTED');
    expect(r.drafts.map((x) => x.action.type)).not.toContain('dispatch_document');
    expect(r.promptIds).toContain('character.revision');
  });
});
