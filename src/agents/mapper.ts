/**
 * Mapper agent (PLAN §9.1; UI only): the player's free-text command → action | dialogue | clarify | unsupported.
 * The context holds only what the player sees (permissions, accessible drafts, who is present). A mapped action
 * must be in the player's configured permissions and pass the core action parse; anything else becomes a
 * clarification. The mapped action is still validated by the harness like any player input.
 */
import { parseAction, type Action } from '../core/actions.js';
import { compareIds, own } from '../core/ids.js';
import { canAccessDocument, filterTermsFor, presentAt } from '../core/knowledge.js';
import { documentPair } from '../core/negotiation.js';
import type { CharId, CoreConfig, Document, WorldState } from '../core/types.js';
import type { ChatMessage, LlmClient } from '../llm/types.js';
import { DEFAULT_INPUT_CAPS, INPUT_MARGIN, summarizeCall } from './call.js';
import { actorName, buildNames, type AgentNames } from './names.js';
import { MAPPER_SYSTEM, MAPPER_USER, render } from './prompts/index.js';
import { AGENT_SCHEMAS, MapperOutputSchema, type MapperKind } from './schemas.js';
import { agentStatusOf, type AgentContent, type AgentStatus, type CallIdentity, type Lang, type LlmCallSummary } from './types.js';
import { jsonLine, langName, termsView, type TermsView } from './util.js';

export interface MapperContext {
  lang: Lang;
  round: number;
  day: number;
  permissions: string[];
  present: { id: CharId; name: string }[];
  documents: {
    docId: string;
    version: number;
    status: string;
    timing: Document['timing'];
    approvedVersion: number | null;
    terms: TermsView;
    note: string;
  }[];
  authorizations: { id: string; grantee: string; revoked: boolean }[];
}

export interface MapperMeta {
  agent: 'mapper';
  lang: Lang;
  identity: CallIdentity;
  context: MapperContext;
  text: string;
}

export interface MapperOptions {
  client: LlmClient;
  content: AgentContent;
  config: CoreConfig;
  state: WorldState;
  text: string;
  lang: Lang;
  identity: CallIdentity;
  names?: AgentNames;
  signal?: AbortSignal;
  model?: string;
  temperature?: number;
}

export interface MapperResult {
  status: AgentStatus;
  kind: MapperKind | null;
  action: Action | null;
  dialogue: { to: CharId[]; text: string } | null;
  question: string | null;
  reason: string | null;
  /** Why a model interpretation was downgraded to `clarify` (not permitted, malformed). */
  downgraded: string | null;
  llm: LlmCallSummary;
  messages: ChatMessage[];
}

export function buildMapperContext(content: AgentContent, config: CoreConfig, state: WorldState, lang: Lang, names?: AgentNames): MapperContext {
  const n = names ?? buildNames(content);
  return {
    lang,
    round: state.round,
    day: state.day,
    permissions: [...config.player.permissions],
    present: presentAt(state, state.player.location)
      .filter((p): p is CharId => p !== 'player' && p !== 'system')
      .map((id) => ({ id, name: actorName(n, id, lang) })),
    documents: Object.keys(state.documents)
      .sort(compareIds)
      .map((id) => own(state.documents, id) as Document)
      .filter((d) => canAccessDocument(state, 'player', d))
      .map((d) => ({
        docId: d.id,
        version: d.version,
        status: d.status,
        timing: { ...d.timing },
        approvedVersion: d.approval?.version ?? null,
        terms: termsView(filterTermsFor(state, config, 'player', d.terms), config.catalog, documentPair(state, config, d), lang),
        note: d.note,
      })),
    authorizations: Object.values(state.player.authorizations)
      .sort((a, b) => compareIds(a.id, b.id))
      .map((a) => ({ id: a.id, grantee: a.grantee, revoked: a.revoked })),
  };
}

export function serializeMapperContext(ctx: MapperContext): string {
  return [
    jsonLine({ round: ctx.round, day: ctx.day, permissions: ctx.permissions, present: ctx.present }),
    ...ctx.documents.map((d) => jsonLine(d)),
    ...(ctx.authorizations.length > 0 ? [jsonLine({ authorizations: ctx.authorizations })] : []),
  ].join('\n');
}

export function prepareMapperCall(opts: Omit<MapperOptions, 'client' | 'signal' | 'model' | 'temperature'>): {
  messages: ChatMessage[];
  meta: MapperMeta;
} {
  const context = buildMapperContext(opts.content, opts.config, opts.state, opts.lang, opts.names);
  const system = render(MAPPER_SYSTEM, { permissions: context.permissions.join(', '), lang_name: langName(opts.lang) });
  const cap = DEFAULT_INPUT_CAPS.mapper - INPUT_MARGIN;
  let text = opts.text;
  let user = render(MAPPER_USER, { context: serializeMapperContext(context), text });
  if (system.length + user.length > cap) {
    text = text.slice(0, Math.max(0, cap - system.length - (user.length - text.length)));
    user = render(MAPPER_USER, { context: serializeMapperContext(context), text });
  }
  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    meta: { agent: 'mapper', lang: opts.lang, identity: { ...opts.identity }, context, text },
  };
}

export async function runMapper(opts: MapperOptions): Promise<MapperResult> {
  const { messages, meta } = prepareMapperCall(opts);
  const result = await opts.client.complete({
    role: 'mapper',
    actor: 'player',
    round: opts.identity.round,
    ...(opts.identity.sessionId !== undefined ? { sessionId: opts.identity.sessionId } : {}),
    ...(opts.identity.callTag !== undefined ? { callTag: opts.identity.callTag } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    messages,
    schema: MapperOutputSchema,
    schemaName: AGENT_SCHEMAS.mapper.name,
    meta: meta as unknown as Record<string, unknown>,
  });
  const llm = summarizeCall(result);
  const empty = { action: null, dialogue: null, question: null, reason: null, downgraded: null, llm, messages };
  if (!result.ok) return { status: agentStatusOf(result.error.kind), kind: null, ...empty };
  const out = result.value;
  const clarify = (why: string): MapperResult => ({
    status: 'ok',
    kind: 'clarify',
    ...empty,
    question: out.question ?? (opts.lang === 'zh' ? '请再说明你的意思。' : 'Could you say more precisely what you want?'),
    downgraded: why,
  });
  switch (out.kind) {
    case 'action': {
      if (!out.action) return clarify('kind "action" without an action');
      if (!opts.config.player.permissions.includes(out.action.type)) return clarify(`action ${out.action.type} is not a player permission`);
      const parsed = parseAction(out.action);
      if (!parsed.ok) return clarify(`malformed action: ${parsed.error}`);
      return { status: 'ok', kind: 'action', ...empty, action: parsed.value };
    }
    case 'dialogue':
      if (!out.dialogue) return clarify('kind "dialogue" without dialogue');
      return { status: 'ok', kind: 'dialogue', ...empty, dialogue: { to: [...out.dialogue.to], text: out.dialogue.text } };
    case 'clarify':
      return { status: 'ok', kind: 'clarify', ...empty, question: out.question ?? clarify('').question };
    case 'unsupported':
      return { status: 'ok', kind: 'unsupported', ...empty, reason: out.reason ?? (opts.lang === 'zh' ? '书记无权如此行事。' : 'The clerk cannot do that.') };
  }
}
