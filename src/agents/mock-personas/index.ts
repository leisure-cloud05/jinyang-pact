/**
 * Registers the deterministic personas and role mocks on a `MockLlmClient` (PLAN §9.3). Every handler reads only
 * `req.meta` — the structured context the real prompt was built from — and fails loudly when it is missing, so a
 * mock can never peek at world state the model would not see.
 */
import type { MockLlmClient } from '../../llm/mock/index.js';
import type { AnswerMeta } from '../answer.js';
import type { CharacterMeta } from '../character.js';
import type { JudgeMeta } from '../judge.js';
import type { MapperMeta } from '../mapper.js';
import type { NarratorMeta } from '../narrator.js';
import { injectCharacter, injectNarrator, type InjectionRecord, type MisbehaviourKind } from './misbehaviour.js';
import { personaTurn } from './personas.js';
import { answerMock, judgeMock, mapperMock, narratorMock, type JudgeMockOptions } from './roles.js';

export * from './personas.js';
export * from './roles.js';
export * from './misbehaviour.js';
export * from './terms.js';

export interface MockPersonaOptions {
  /** Misbehaviour injection rate per call (default 0). */
  misbehaviourRate?: number;
  misbehaviourKinds?: readonly MisbehaviourKind[];
  judge?: JudgeMockOptions;
}

export interface MockPersonaHandle {
  /** One record per injected misbehaviour. */
  injections: InjectionRecord[];
}

function metaOf<T extends { agent: string }>(meta: Record<string, unknown> | undefined, agent: T['agent']): T {
  if (!meta || meta.agent !== agent) throw new Error(`mock ${agent}: request carries no ${agent} meta (build requests with the agents layer)`);
  return meta as unknown as T;
}

export function registerMockPersonas(mock: MockLlmClient, options: MockPersonaOptions = {}): MockPersonaHandle {
  const injections: InjectionRecord[] = [];
  const mis = {
    rate: options.misbehaviourRate ?? 0,
    ...(options.misbehaviourKinds ? { kinds: options.misbehaviourKinds } : {}),
    log: injections,
  };
  mock.register('character', (req) => {
    const meta = metaOf<CharacterMeta>(req.meta, 'character');
    return injectCharacter(meta, personaTurn(meta), mis);
  });
  mock.register('judge', (req) => judgeMock(metaOf<JudgeMeta>(req.meta, 'judge'), options.judge));
  mock.register('narrator', (req) => {
    const meta = metaOf<NarratorMeta>(req.meta, 'narrator');
    return injectNarrator(meta, narratorMock(meta), mis);
  });
  mock.register('mapper', (req) => mapperMock(metaOf<MapperMeta>(req.meta, 'mapper')));
  mock.register('answer', (req) => answerMock(metaOf<AnswerMeta>(req.meta, 'answer')));
  return { injections };
}
