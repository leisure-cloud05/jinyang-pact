/**
 * Structural secrecy (checker v7, PLAN §9.4): the narrator never receives secret-clause text. For every scene of
 * the C1–C6 reference runs (replayed with the pure core), the narrator's prompt input — both languages — contains no
 * clause text, canary, clause id or key terms of any secret clause. The lexical checker is only a second line.
 */
import { describe, expect, it } from 'vitest';
import { caseCoreConfig, caseInitialState, toTraceSpec } from '../../src/content/loader.js';
import { secretHits } from '../../src/agents/narration/index.js';
import { prepareNarration } from '../../src/agents/narrator.js';
import { simulateTrace } from '../../src/core/simulate.js';
import type { NarrationFact } from '../../src/core/types.js';
import { content } from './helpers.js';

const CASES = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'] as const;
const KEY_TERMS = ['府库', '中分', '平分', 'treasur', 'shared equally', '入洛'];

describe('narrator input never carries secret clauses', () => {
  it.each(CASES)('%s reference run: every scene prompt is free of clause text, canary, id and key terms', (caseId) => {
    const bundle = content();
    const config = caseCoreConfig(bundle, caseId);
    const trace = bundle.traces[caseId];
    expect(trace, caseId).toBeDefined();
    const result = simulateTrace(caseInitialState(bundle, caseId), config, toTraceSpec(trace!), 'no_judge');
    expect(result.mismatches, caseId).toEqual([]);
    const clauses = Object.values(config.catalog.secretClauses).map((c) => ({ id: c.id, canary: c.canary, text: c.text }));
    expect(clauses.length).toBeGreaterThan(0);

    const scenes = new Map<string, NarrationFact[]>();
    for (const e of result.events) {
      for (const f of e.facts) {
        const key = `${e.round}|${f.scene}`;
        scenes.set(key, [...(scenes.get(key) ?? []), f]);
      }
    }
    expect(scenes.size).toBeGreaterThan(0);
    let carriedClause = false;
    for (const [key, facts] of scenes) {
      carriedClause ||= facts.some((f) => JSON.stringify(f.data).includes('secret_clause_ids":["'));
      for (const lang of ['zh', 'en'] as const) {
        const prep = prepareNarration({
          content: bundle,
          config,
          state: result.state,
          scene: facts[0]!.scene,
          facts,
          lang,
          identity: { round: Number(key.split('|')[0]) },
        });
        const input = prep.messages.map((m) => m.content).join('\n');
        expect(secretHits(input, clauses), `${caseId} ${key} ${lang}`).toEqual([]);
        for (const c of clauses) {
          expect(input).not.toContain(c.canary);
          expect(input).not.toContain(c.id);
        }
        for (const term of KEY_TERMS) expect(input.toLowerCase(), `${caseId} ${key} ${lang}: ${term}`).not.toContain(term);
      }
    }
    // C4's facts do carry the clause (by id only): the restriction is exercised, not vacuous.
    if (caseId === 'C4') expect(carriedClause).toBe(true);
  });
});
