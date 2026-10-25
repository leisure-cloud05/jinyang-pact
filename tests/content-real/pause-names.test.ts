/**
 * Player-facing pause facts name actors by their localized display names from content (they feed the play UI,
 * the audit bundle and the human-evaluation packets), never by raw character ids.
 */
import { describe, expect, it } from 'vitest';
import { caseInitialState } from '../../src/content/loader.js';
import { describePause } from '../../src/harness/decisions.js';
import type { ProposalRecord } from '../../src/store/repo.js';
import { caseConfig, content } from './helpers.js';

function proposal(actor: string, action: unknown, askPlayer: { question: string } | null = null): ProposalRecord {
  return { actor, action, askPlayer } as unknown as ProposalRecord;
}

describe('pause facts use display names', () => {
  it('renders the actor of a paused proposal and its question with zh/en names, not ids', () => {
    const state = caseInitialState(content(), 'C1');
    const config = caseConfig('C1');
    const dispatch = proposal('shi_jingtang', { type: 'dispatch_document', args: { docId: 'doc:1', docVersion: 1 } }, { question: '可否？' });
    const { visibleFacts } = describePause(state, config, 'dispatch_request', [dispatch]);
    const zh = visibleFacts.map((f) => f.zh).join('\n');
    const en = visibleFacts.map((f) => f.en).join('\n');
    expect(zh).toContain('石敬瑭：dispatch doc:1 v1');
    expect(zh).toContain('石敬瑭问：可否？');
    expect(en).toContain('Shi Jingtang: dispatch doc:1 v1');
    expect(en).toContain('Shi Jingtang asks: 可否？');
    expect(`${zh}\n${en}`).not.toContain('shi_jingtang');
  });

  it('names the player by the scenario role', () => {
    const state = caseInitialState(content(), 'C1');
    const config = caseConfig('C1');
    const { visibleFacts } = describePause(state, config, 'dispatch_request', [
      proposal('player', { type: 'dispatch_document', args: { docId: 'doc:1', docVersion: 1 } }),
    ]);
    expect(visibleFacts.map((f) => f.en).join('\n')).toContain('the headquarters clerk: dispatch doc:1 v1');
    expect(visibleFacts.map((f) => f.zh).join('\n')).toContain('帅府书记：dispatch doc:1 v1');
  });
});
