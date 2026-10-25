/**
 * Fixed sample calls for the live smoke gate (PLAN §14 step 2): one per role, built with the real prompts, real
 * output schemas and real authorized contexts from the content. They use dev config D1 (internal deliberation),
 * never a frozen evaluation case: live exposure before the freeze is limited to D1–D3/P1–P3 (PLAN §0).
 * `mockOutput` is what the deterministic mock (persona / role mock) answers for the same `meta`.
 */
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import { caseCoreConfig, caseInitialState, effectiveCharacter, findCase, loadContent, type ContentBundle } from '../content/loader.js';
import { executeBatch, type BatchProposal } from '../core/execute.js';
import { runPrepare } from '../core/system.js';
import type { NarrationFact } from '../core/types.js';
import type { ChatMessage } from '../llm/types.js';
import { prepareCharacterCall } from './character.js';
import { prepareJudgeCall, type JudgeProposalInput } from './judge.js';
import { prepareMapperCall } from './mapper.js';
import { personaTurn } from './mock-personas/personas.js';
import { judgeMock, mapperMock, narratorMock } from './mock-personas/roles.js';
import { prepareNarration } from './narrator.js';
import { AGENT_SCHEMAS } from './schemas.js';
import type { DialogueRow, Lang } from './types.js';

export const SAMPLE_CASE = 'D1';
export const SAMPLE_ROLES = ['character', 'judge', 'narrator', 'mapper'] as const;
export type SampleRole = (typeof SAMPLE_ROLES)[number];

export interface AgentSample {
  role: SampleRole;
  actor: string;
  schemaName: string;
  schema: z.ZodType<unknown>;
  messages: ChatMessage[];
  meta: Record<string, unknown>;
  mockOutput: unknown;
}

export const DEFAULT_CONTENT_ROOT = fileURLToPath(new URL('../../content/', import.meta.url));

const cache = new Map<string, Record<SampleRole, AgentSample>>();
let bundleCache: { root: string; bundle: ContentBundle } | null = null;

function bundleAt(root: string): ContentBundle {
  if (!bundleCache || bundleCache.root !== root) bundleCache = { root, bundle: loadContent(root, { requireSources: true }) };
  return bundleCache.bundle;
}

export function buildAgentSamples(lang: Lang, contentRoot: string = DEFAULT_CONTENT_ROOT): Record<SampleRole, AgentSample> {
  const key = `${contentRoot}|${lang}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const content = bundleAt(contentRoot);
  const caseConfig = findCase(content, SAMPLE_CASE);
  const config = caseCoreConfig(content, SAMPLE_CASE);
  const state = runPrepare(caseInitialState(content, SAMPLE_CASE), config).state;
  const identity = { sessionId: 'smoke', caseId: SAMPLE_CASE, rep: 1, round: 1, epoch: 0 };

  // The clerk's opening words to Sang and Liu (the D1 script, round 1).
  const opening = caseConfig.script.find((s) => s.round === 1)?.inputs.find((i) => 'dialogue' in i);
  const openingText =
    opening && 'dialogue' in opening
      ? typeof opening.dialogue.text === 'string'
        ? opening.dialogue.text
        : lang === 'zh'
          ? opening.dialogue.text.zh
          : opening.dialogue.text.en
      : '';
  const dialogue: DialogueRow[] = openingText
    ? [{ seq: 1, round: 1, epoch: 0, worldVersion: state.version, speaker: 'player', listeners: ['sang_weihan', 'liu_zhiyuan'], text: openingText, kind: 'speech' }]
    : [];

  const character = prepareCharacterCall({
    content,
    config,
    state,
    charId: 'sang_weihan',
    lang,
    variant: 'harness',
    identity,
    persona: effectiveCharacter(content, caseConfig, 'sang_weihan'),
    dialogue,
  });
  const sangOut = personaTurn(character.meta);

  const proposals: JudgeProposalInput[] = [
    { proposalId: 'p1', actor: 'shi_jingtang', action: { type: 'approve_document', args: { docId: 'doc:1', docVersion: 1 } } },
    { proposalId: 'p2', actor: 'shi_jingtang', action: { type: 'dispatch_document', args: { docId: 'doc:1', docVersion: 1 } } },
    {
      proposalId: 'p3',
      actor: 'liu_zhiyuan',
      action: { type: 'speak', args: { to: ['shi_jingtang', 'player'], text: lang === 'zh' ? '父礼、割地，后患无穷。' : 'Filial rites and land will bring endless harm.' } },
    },
  ];
  const judge = prepareJudgeCall({ content, config, state, proposals, lang, identity: { ...identity, callTag: 'assess' }, dialogue });

  // Facts of a committed deliberation step: Sang's revision (as his persona drafts it) and Liu's suggestion.
  const revise = sangOut.actions.find((a) => a.type === 'revise_document');
  const batch: BatchProposal[] = [];
  if (revise) batch.push({ proposalId: 'n1', actor: 'sang_weihan', seq: 1, action: { type: revise.type, args: revise.args }, askPlayer: null });
  batch.push({
    proposalId: 'n2',
    actor: 'liu_zhiyuan',
    seq: 2,
    action: {
      type: 'suggest_revision',
      args: {
        target: { kind: 'document', id: 'doc:1' },
        terms: { vassal: null, filial: false, cession: 'none', annual_silk: null, immediate_silk: 150000, aid_cavalry: null, aid_arrival_days: null, neutrality: null, marriage_alliance: null, secret_clauses: null },
        reason: lang === 'zh' ? '宁厚赂金帛，不必许以土田。' : 'Pay in silk rather than promise land.',
      },
    },
    askPlayer: null,
  });
  const executed = executeBatch(state, { kind: 'character', proposals: batch, decisions: [] }, { config, mode: 'no_judge' });
  const facts: NarrationFact[] = executed.events.flatMap((e) => e.facts).filter((f) => f.scene === 'jinyang_hq');
  const narration = prepareNarration({ content, config, state: executed.state, scene: 'jinyang_hq', facts, lang, identity: { ...identity, callTag: 'scene:jinyang_hq' } });

  const mapper = prepareMapperCall({
    content,
    config,
    state,
    text: lang === 'zh' ? '把即付之帛改为十万匹。' : 'Change the immediate silk gift to 100,000 bolts.',
    lang,
    identity,
  });

  const samples: Record<SampleRole, AgentSample> = {
    character: {
      role: 'character',
      actor: 'sang_weihan',
      schemaName: AGENT_SCHEMAS.character.name,
      schema: AGENT_SCHEMAS.character.schema,
      messages: character.messages,
      meta: character.meta as unknown as Record<string, unknown>,
      mockOutput: sangOut,
    },
    judge: {
      role: 'judge',
      actor: 'judge',
      schemaName: AGENT_SCHEMAS.judge.name,
      schema: AGENT_SCHEMAS.judge.schema,
      messages: judge.messages,
      meta: judge.meta as unknown as Record<string, unknown>,
      mockOutput: judgeMock(judge.meta),
    },
    narrator: {
      role: 'narrator',
      actor: 'narrator',
      schemaName: AGENT_SCHEMAS.narrator.name,
      schema: AGENT_SCHEMAS.narrator.schema,
      messages: narration.messages,
      meta: narration.meta as unknown as Record<string, unknown>,
      mockOutput: narratorMock(narration.meta),
    },
    mapper: {
      role: 'mapper',
      actor: 'player',
      schemaName: AGENT_SCHEMAS.mapper.name,
      schema: AGENT_SCHEMAS.mapper.schema,
      messages: mapper.messages,
      meta: mapper.meta as unknown as Record<string, unknown>,
      mockOutput: mapperMock(mapper.meta),
    },
  };
  cache.set(key, samples);
  return samples;
}
