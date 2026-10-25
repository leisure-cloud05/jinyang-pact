/**
 * Character agent (PLAN §9.1): authorized context → messages → `LlmClient.complete` with the strict output
 * schema → proposal drafts.
 * - `format_error` (no valid output after the client's single repair retry) ⇒ one `wait` draft;
 * - other failures (timeout, HTTP, budget, abort) ⇒ `error` with no drafts (the engine decides);
 * - `speech` becomes a `speak` draft (seq 0) to everyone present; actions follow in order (seq 1..3);
 * - invalid cites are stripped and counted (never a rejection, PLAN §5);
 * - `ask_player` is attached to the first consequential action (else the first draft).
 * The structured context is passed in `meta` so mock personas see exactly what the prompt was built from.
 */
import type { CharacterConfig } from '../content/schema.js';
import { parseAction, type Action } from '../core/actions.js';
import type { ActionType, CharId, CoreConfig, WorldState } from '../core/types.js';
import type { ChatMessage, LlmClient } from '../llm/types.js';
import { CHARACTER_PROMPT_TARGET, DEFAULT_INPUT_CAPS, INPUT_MARGIN, summarizeCall } from './call.js';
import { buildCharacterContext, type BuiltCharacterContext, type CharacterContext } from './context.js';
import type { AgentNames } from './names.js';
import {
  CHARACTER_REVISION,
  CHARACTER_SYSTEM_BASELINE,
  CHARACTER_SYSTEM_HARNESS,
  CHARACTER_USER,
  render,
  renderCharacterSystem,
  type CharacterVariant,
} from './prompts/index.js';
import { AGENT_SCHEMAS, CharacterOutputSchema, type CharacterOutput } from './schemas.js';
import { agentStatusOf, type AgentContent, type AgentStatus, type CallIdentity, type DialogueRow, type FeedbackRow, type Lang, type LlmCallSummary, type ProposalDraft } from './types.js';
import { langName } from './util.js';

/** An earlier proposal the Judge sent back (REVISE), with its reason. */
export interface RevisionItem {
  action: unknown;
  reason: string;
  category: string | null;
}

/** What mock personas receive in `req.meta` (and nothing else). */
export interface CharacterMeta {
  agent: 'character';
  variant: CharacterVariant;
  lang: Lang;
  identity: CallIdentity;
  context: CharacterContext;
  citeKeys: string[];
  revision: RevisionItem[] | null;
}

export interface CharacterTurnOptions {
  client: LlmClient;
  content: AgentContent;
  config: CoreConfig;
  state: WorldState;
  charId: CharId;
  lang: Lang;
  variant: CharacterVariant;
  identity: CallIdentity;
  persona?: CharacterConfig;
  dialogue?: readonly DialogueRow[];
  feedback?: readonly FeedbackRow[];
  activeAgendaIds?: readonly string[] | null;
  names?: AgentNames;
  revision?: readonly RevisionItem[] | null;
  /** Input cap over all messages (PLAN §9: 32,000; prompts are trimmed to about 24,000). */
  maxInputChars?: number;
  signal?: AbortSignal;
  model?: string;
  temperature?: number;
}

export interface CharacterTurnResult {
  actor: CharId;
  status: AgentStatus;
  drafts: ProposalDraft[];
  speech: string;
  privateRationale: string;
  askPlayer: { question: string } | null;
  /** Cites removed because they were not in the context (PLAN §5 `cite_error`). */
  citeErrors: number;
  strippedCites: string[];
  /** Action items that failed the core action parse (defensive; the output schema already enforces it). */
  invalidActions: { index: number; error: string }[];
  output: CharacterOutput | null;
  context: BuiltCharacterContext;
  messages: ChatMessage[];
  promptIds: string[];
  llm: LlmCallSummary;
}

/** Critical types of PLAN §4 (column P) first, then other consequential ones: ask_player attaches to the first match. */
const CRITICAL: readonly ActionType[] = ['dispatch_document', 'propose_terms', 'respond_to_offer', 'confirm_commitment', 'abandon_request'];
const CONSEQUENTIAL: readonly ActionType[] = ['withdraw_offer', 'allocate_resources', 'approve_document', 'revise_document', 'set_dispatch_timing'];

function systemPromptFor(opts: Pick<CharacterTurnOptions, 'variant' | 'lang' | 'config' | 'charId'>, persona: CharacterConfig): string {
  return renderCharacterSystem(opts.variant, {
    name: opts.lang === 'zh' ? persona.name.zh : persona.name.en,
    title: opts.lang === 'zh' ? persona.title.zh : persona.title.en,
    permissions: opts.config.characters[opts.charId].permissions,
    roundDays: opts.config.params.round_days,
    segmentRoundCap: opts.config.params.segment_round_cap,
    pairOfferCap: opts.config.params.pair_offer_cap,
    langName: langName(opts.lang),
  });
}

function summarizeAction(action: unknown): string {
  try {
    return JSON.stringify(action);
  } catch {
    return String(action);
  }
}

export function renderRevision(items: readonly RevisionItem[] | null | undefined): string {
  if (!items || items.length === 0) return '';
  const lines = items.map((i) => `- ${summarizeAction(i.action)}${i.category ? ` [${i.category}]` : ''}: ${i.reason}`);
  return render(CHARACTER_REVISION, { items: lines.join('\n') });
}

function userMessage(round: number, day: number, contextText: string, name: string, revision: string): string {
  return render(CHARACTER_USER, { round, day, context: contextText, revision, name });
}

/** Builds the context within the input cap and the two messages (system + user). */
export function prepareCharacterCall(opts: Omit<CharacterTurnOptions, 'client' | 'signal' | 'model' | 'temperature'>): {
  built: BuiltCharacterContext;
  messages: ChatMessage[];
  meta: CharacterMeta;
} {
  const persona = opts.persona ?? opts.content.characters[opts.charId];
  const name = opts.lang === 'zh' ? persona.name.zh : persona.name.en;
  const system = systemPromptFor(opts, persona);
  const revision = renderRevision(opts.revision);
  const cap = opts.maxInputChars ?? DEFAULT_INPUT_CAPS.character;
  const overhead = userMessage(opts.state.round, opts.state.day, '', name, revision).length;
  const budget = Math.max(1_000, Math.min(cap, CHARACTER_PROMPT_TARGET) - system.length - overhead - INPUT_MARGIN);
  const built = buildCharacterContext({
    content: opts.content,
    config: opts.config,
    state: opts.state,
    charId: opts.charId,
    lang: opts.lang,
    persona,
    maxChars: budget,
    ...(opts.dialogue ? { dialogue: opts.dialogue } : {}),
    ...(opts.feedback ? { feedback: opts.feedback } : {}),
    ...(opts.activeAgendaIds !== undefined ? { activeAgendaIds: opts.activeAgendaIds } : {}),
    ...(opts.names ? { names: opts.names } : {}),
  });
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: userMessage(opts.state.round, opts.state.day, built.text, name, revision) },
  ];
  const meta: CharacterMeta = {
    agent: 'character',
    variant: opts.variant,
    lang: opts.lang,
    identity: { ...opts.identity },
    context: built.context,
    citeKeys: built.citeKeys,
    revision: opts.revision ? opts.revision.map((r) => ({ ...r })) : null,
  };
  return { built, messages, meta };
}

export interface MappedOutput {
  drafts: ProposalDraft[];
  citeErrors: number;
  strippedCites: string[];
  invalidActions: { index: number; error: string }[];
}

/** Maps a validated character output onto proposal drafts (pure; exported for tests and the engine). */
export function mapCharacterOutput(actor: CharId, output: CharacterOutput, context: CharacterContext, citeKeys: readonly string[]): MappedOutput {
  const valid = new Set(citeKeys);
  const drafts: ProposalDraft[] = [];
  const stripped: string[] = [];
  const invalidActions: { index: number; error: string }[] = [];
  const speech = output.speech.trim();
  const listeners = context.scene.present.map((p) => p.id).filter((id) => id !== 'system' && id !== actor);
  if (speech.length > 0 && listeners.length > 0) {
    drafts.push({
      actor,
      source: 'llm',
      seq: 0,
      action: { type: 'speak', args: { to: listeners as Array<CharId | 'player'>, text: speech } },
      rationale: 'speech',
      cites: [],
      askPlayer: null,
    });
  }
  output.actions.forEach((item, index) => {
    const parsed = parseAction({ type: item.type, args: item.args });
    if (!parsed.ok) {
      invalidActions.push({ index, error: parsed.error });
      return;
    }
    const cites: string[] = [];
    for (const c of item.cites) {
      const key = c.trim();
      if (valid.has(key)) {
        if (!cites.includes(key)) cites.push(key);
      } else {
        stripped.push(c);
      }
    }
    drafts.push({ actor, source: 'llm', seq: index + 1, action: parsed.value, rationale: item.rationale, cites, askPlayer: null });
  });
  if (output.ask_player) {
    const target =
      drafts.find((d) => CRITICAL.includes(d.action.type)) ??
      drafts.find((d) => CONSEQUENTIAL.includes(d.action.type)) ??
      drafts.find((d) => d.action.type !== 'speak') ??
      drafts[0];
    if (target) {
      target.askPlayer = { question: output.ask_player.question };
    } else {
      drafts.push({
        actor,
        source: 'llm',
        seq: output.actions.length + 1,
        action: { type: 'wait', args: {} } as Action,
        rationale: 'question for the player',
        cites: [],
        askPlayer: { question: output.ask_player.question },
      });
    }
  }
  return { drafts, citeErrors: stripped.length, strippedCites: stripped, invalidActions };
}

export function waitDraft(actor: CharId, rationale: string): ProposalDraft {
  return { actor, source: 'llm', seq: 0, action: { type: 'wait', args: {} }, rationale, cites: [], askPlayer: null };
}

export async function runCharacterTurn(opts: CharacterTurnOptions): Promise<CharacterTurnResult> {
  const { built, messages, meta } = prepareCharacterCall(opts);
  const result = await opts.client.complete({
    role: 'character',
    actor: opts.charId,
    round: opts.identity.round,
    ...(opts.identity.sessionId !== undefined ? { sessionId: opts.identity.sessionId } : {}),
    ...(opts.identity.callTag !== undefined ? { callTag: opts.identity.callTag } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    messages,
    schema: CharacterOutputSchema,
    schemaName: AGENT_SCHEMAS.character.name,
    meta: meta as unknown as Record<string, unknown>,
  });
  const promptIds = [opts.variant === 'baseline' ? CHARACTER_SYSTEM_BASELINE.id : CHARACTER_SYSTEM_HARNESS.id, CHARACTER_USER.id];
  if (opts.revision && opts.revision.length > 0) promptIds.push(CHARACTER_REVISION.id);
  const llm = summarizeCall(result);
  const base = {
    actor: opts.charId,
    context: built,
    messages,
    promptIds,
    llm,
  };
  if (!result.ok) {
    const status = agentStatusOf(result.error.kind);
    return {
      ...base,
      status,
      drafts: status === 'format_error' ? [waitDraft(opts.charId, `format_error: ${result.error.kind}`)] : [],
      speech: '',
      privateRationale: '',
      askPlayer: null,
      citeErrors: 0,
      strippedCites: [],
      invalidActions: [],
      output: null,
    };
  }
  const mapped = mapCharacterOutput(opts.charId, result.value, built.context, built.citeKeys);
  return {
    ...base,
    status: 'ok',
    drafts: mapped.drafts,
    speech: result.value.speech,
    privateRationale: result.value.private_rationale,
    askPlayer: result.value.ask_player,
    citeErrors: mapped.citeErrors,
    strippedCites: mapped.strippedCites,
    invalidActions: mapped.invalidActions,
    output: result.value,
  };
}
