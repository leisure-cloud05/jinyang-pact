/** Helpers for the agents tests: real content, case states, and a tiny round driver over the pure core. */
import { fileURLToPath } from 'node:url';
import {
  caseCoreConfig,
  caseInitialState,
  effectiveCharacter,
  findCase,
  loadContent,
  type ContentBundle,
} from '../../src/content/loader.js';
import type { CharacterConfig } from '../../src/content/schema.js';
import { executeBatch, type BatchDecision, type BatchProposal } from '../../src/core/execute.js';
import { planPauses } from '../../src/core/plan.js';
import { runAdvance, runPrepare } from '../../src/core/system.js';
import { CHAR_IDS, type CharId, type CoreConfig, type NarrationFact, type WorldEvent, type WorldState } from '../../src/core/types.js';
import { MockLlmClient } from '../../src/llm/mock/index.js';
import { MemorySink } from '../../src/llm/usage.js';

export const CONTENT_ROOT = fileURLToPath(new URL('../../content/', import.meta.url));

let bundle: ContentBundle | null = null;
export function content(): ContentBundle {
  bundle ??= loadContent(CONTENT_ROOT, { requireSources: true });
  return bundle;
}

export function cfg(caseId: string): CoreConfig {
  return caseCoreConfig(content(), caseId);
}

export function initialOf(caseId: string): WorldState {
  return caseInitialState(content(), caseId);
}

export function personas(caseId: string): Record<CharId, CharacterConfig> {
  const c = findCase(content(), caseId);
  const out = {} as Record<CharId, CharacterConfig>;
  for (const id of CHAR_IDS) out[id] = effectiveCharacter(content(), c, id);
  return out;
}

export interface Driver {
  state: WorldState;
  config: CoreConfig;
  events: WorldEvent[];
  seq: number;
}

export function driver(caseId: string): Driver {
  const config = cfg(caseId);
  const d: Driver = { state: initialOf(caseId), config, events: [], seq: 0 };
  prepare(d);
  return d;
}

export function prepare(d: Driver): WorldEvent[] {
  const r = runPrepare(d.state, d.config);
  d.state = r.state;
  d.events.push(...r.events);
  return r.events;
}

/** Commits proposals as a character batch in no_judge mode, endorsing every required pause. */
export function commitEndorsed(d: Driver, proposals: { actor: BatchProposal['actor']; action: unknown }[]): { events: WorldEvent[]; outcomes: ReturnType<typeof executeBatch>['outcomes'] } {
  const batch: BatchProposal[] = proposals.map((p) => {
    d.seq += 1;
    return { proposalId: `p${d.seq}`, actor: p.actor, seq: d.seq, action: p.action, askPlayer: null };
  });
  const plan = planPauses(d.state, { kind: 'character', proposals: batch, decisions: [] }, { config: d.config, mode: 'no_judge' });
  const decisions: BatchDecision[] = plan.required.map((r, i) => ({
    decisionId: `d${d.seq}-${i}`,
    category: r.category,
    option: 'endorse',
    proposalIds: r.proposalIds,
    pair: r.pair,
  }));
  const result = executeBatch(d.state, { kind: 'character', proposals: batch, decisions }, { config: d.config, mode: 'no_judge' });
  d.state = result.state;
  d.events.push(...result.events);
  return { events: result.events, outcomes: result.outcomes };
}

export function advance(d: Driver): WorldEvent[] {
  const r = runAdvance(d.state, d.config);
  d.state = r.state;
  d.events.push(...r.events);
  return [...r.events, ...prepare(d)];
}

export function factsOf(events: readonly WorldEvent[], scene?: string): NarrationFact[] {
  return events.flatMap((e) => e.facts).filter((f) => scene === undefined || f.scene === scene);
}

export function newMock(): { mock: MockLlmClient; sink: MemorySink } {
  const sink = new MemorySink();
  return { mock: new MockLlmClient({ sink, maxInputChars: { character: 32_000, judge: 16_000, narrator: 12_000, mapper: 8_000 } }), sink };
}
