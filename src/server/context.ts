/**
 * Everything a view builder needs about one session, read fresh per request (the harness is the source of truth).
 */
import { buildNames, type AgentNames } from '../agents/names.js';
import type { Lang } from '../agents/types.js';
import { effectiveCharacter, findCase, type ContentBundle } from '../content/loader.js';
import type { CharacterConfig } from '../content/schema.js';
import { CHAR_IDS, type CharId, type CoreConfig, type LocId, type WorldState } from '../core/types.js';
import { EngineRecords, type CaseLikeConfig, type RunRecord } from '../engine/index.js';
import type { Harness } from '../harness/index.js';
import type { SessionRecord } from '../store/repo.js';
import type { SessionMeta } from './store.js';

export interface SessionCtx {
  sessionId: string;
  harness: Harness;
  records: EngineRecords;
  meta: SessionMeta;
  run: RunRecord;
  session: SessionRecord;
  config: CoreConfig;
  caseConfig: CaseLikeConfig;
  content: ContentBundle;
  names: AgentNames;
  lang: Lang;
  state: WorldState;
  playerLoc: LocId;
}

const namesCache = new WeakMap<ContentBundle, Map<string, AgentNames>>();

export function namesFor(content: ContentBundle, caseConfig: CaseLikeConfig): AgentNames {
  let perCase = namesCache.get(content);
  if (!perCase) {
    perCase = new Map();
    namesCache.set(content, perCase);
  }
  let names = perCase.get(caseConfig.id);
  if (!names) {
    const personas = {} as Record<CharId, CharacterConfig>;
    for (const id of CHAR_IDS) personas[id] = effectiveCharacter(content, caseConfig, id);
    names = buildNames(content, personas);
    perCase.set(caseConfig.id, names);
  }
  return names;
}

export function buildCtx(harness: Harness, records: EngineRecords, content: ContentBundle, meta: SessionMeta, run: RunRecord): SessionCtx {
  const session = harness.getSession(meta.sessionId);
  const caseConfig = findCase(content, run.caseId);
  const state = harness.getState(meta.sessionId);
  return {
    sessionId: meta.sessionId,
    harness,
    records,
    meta,
    run,
    session,
    config: session.config,
    caseConfig,
    content,
    names: namesFor(content, caseConfig),
    lang: run.lang,
    state,
    playerLoc: state.player.location,
  };
}

export function recordsOf(harness: Harness): EngineRecords {
  return new EngineRecords(harness.store);
}
