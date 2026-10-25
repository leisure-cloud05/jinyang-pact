/**
 * Answer agent (PLAN §7 "ask"): while a decision is paused, the player may ask a character a question; that
 * character answers IN CHARACTER in one speech-only call (role `answer`).
 *
 * Structural secrecy (the narrator's rule, PLAN §9.4): the answer context carries NOTHING the asking player does not
 * know. It is built from an ALLOWLIST only: the answerer's public name and title and its curated `public_voice`
 * (manner of speech), the player's view (scene, siege, resources, accessible documents with player-unknown secret
 * clauses removed, the negotiation as the player knows it), the pause's player-visible facts and the dialogue the
 * player heard. Nothing else from the persona (voice, goals, memories, agendas, preferences), sources or knowledge. The question is untrusted data, placed in a delimited block. The lexical leakage scan
 * (canaries, clause ids, clause text) remains a second layer: a hit blocks the speech. Output `{speech}` only.
 * A failed or over-budget call yields a templated "no answer" line. Nothing here writes state.
 */
import type { CharacterConfig } from '../content/schema.js';
import { compareIds, own } from '../core/ids.js';
import { canAccessDocument, filterTermsFor, playerView, presentAt } from '../core/knowledge.js';
import { documentPair } from '../core/negotiation.js';
import type { CharId, CoreConfig, Document, Localized, LocId, WorldState } from '../core/types.js';
import type { ChatMessage, LlmClient } from '../llm/types.js';
import { DEFAULT_INPUT_CAPS, INPUT_MARGIN, summarizeCall } from './call.js';
import { actorName, buildNames, loc, locationName, type AgentNames } from './names.js';
import { secretHits, secretsUnknownTo } from './narration/index.js';
import { ANSWER_SYSTEM, ANSWER_USER, render } from './prompts/index.js';
import { AGENT_SCHEMAS, AnswerOutputSchema } from './schemas.js';
import { agentStatusOf, type AgentContent, type AgentStatus, type CallIdentity, type DialogueRow, type Lang, type LlmCallSummary } from './types.js';
import { jsonLine, langName, termsView } from './util.js';

export const ANSWER_CONTEXT_VERSION = 'ctx.answer.v2';

/** The only sections an answer context has (the allowlist, in order). */
export const ANSWER_SECTIONS = [
  'WHO YOU ARE (public name, title and manner of speech)',
  'THE SCENE (as the clerk sees it)',
  'WHAT THE CLERK CAN SEE',
  'THE PENDING DECISION (as the clerk sees it)',
  'WHAT THE CLERK HAS HEARD (oldest first)',
] as const;
const MAX_DIALOGUE = 20;

/** The player-visible answer context (what the mock answer persona reads, and what the model reads serialized). */
export interface AnswerContext {
  version: string;
  lang: Lang;
  self: { id: CharId; name: string; title: string; publicVoice: string };
  time: { round: number; day: number };
  scene: { location: LocId; locationName: string; present: string[] };
  situation: {
    siege: { grain: number; pressure: number; morale: number };
    resources: Record<string, number>;
    documents: Array<{ docId: string; version: number; status: string; timing: unknown; to: string; note: string; terms: unknown }>;
    negotiation: unknown;
  };
  /** Dialogue the PLAYER heard (oldest first, last 20), lines carrying player-unknown secrets removed. */
  heard: Array<{ speaker: string; to: string[]; kind: string; text: string }>;
  facts: string[];
}

/** What the mock answer persona receives in `req.meta`. */
export interface AnswerMeta {
  agent: 'answer';
  lang: Lang;
  identity: CallIdentity;
  context: AnswerContext;
  question: string;
  facts: string[];
}

export interface AnswerOptions {
  client: LlmClient;
  content: AgentContent;
  config: CoreConfig;
  state: WorldState;
  charId: CharId;
  lang: Lang;
  identity: CallIdentity;
  /** The player's question (already credential-redacted by the caller); untrusted data. */
  question: string;
  /** The pause's player-visible facts (and its question), as the player sees them. */
  facts: readonly Localized[];
  persona?: CharacterConfig;
  /** All dialogue rows of the session (filtered here to what the player heard). */
  dialogue?: readonly DialogueRow[];
  names?: AgentNames;
  maxInputChars?: number;
  signal?: AbortSignal;
  model?: string;
  temperature?: number;
}

export type AnswerOutcome = 'answered' | 'blocked' | 'no_answer';

export interface AnswerResult {
  status: AgentStatus;
  outcome: AnswerOutcome;
  /** Text to record as the character's answer (model speech, or a templated line). */
  text: string;
  /** Secret content the player does not know, found in the model speech (never the excerpt: it is the secret). */
  leakHits: { check: string; detail: string }[];
  llm: LlmCallSummary;
  messages: ChatMessage[];
  context: AnswerContext;
}

/** Templated line when no answer could be obtained (failure, budget). */
export function noAnswerLine(names: AgentNames, charId: CharId, lang: Lang): string {
  const name = loc(names.characters[charId].name, lang);
  return lang === 'zh' ? `${name}沉吟良久，未置一词。` : `${name} hesitates and gives no answer.`;
}

/** Templated line when the answer was blocked by the leakage scan. */
export function blockedAnswerLine(names: AgentNames, charId: CharId, lang: Lang): string {
  const name = loc(names.characters[charId].name, lang);
  return lang === 'zh' ? `${name}摇首道：“此事不便多言。”` : `${name} shakes his head: "That is not for me to say."`;
}

/** The question as a data block: delimiter lookalikes inside it are neutralised. */
export function questionBlock(question: string): string {
  return question.replace(/<{2,}|>{2,}/g, '').replace(/\b(BEGIN|END)_QUESTION\b/g, '$1-QUESTION');
}

/** Builds the player-visible answer context (pure). */
export function buildAnswerContext(opts: Pick<AnswerOptions, 'content' | 'config' | 'state' | 'charId' | 'lang' | 'facts' | 'persona' | 'dialogue' | 'names'>): AnswerContext {
  const { config, state, lang } = opts;
  const persona = opts.persona ?? opts.content.characters[opts.charId];
  const names = opts.names ?? buildNames(opts.content, { [opts.charId]: persona });
  const view = playerView(state, config);
  const location = state.player.location;
  const secrets = secretsUnknownTo(config, state, 'player');
  const documents = Object.keys(state.documents)
    .sort(compareIds)
    .map((id) => own(state.documents, id) as Document)
    .filter((doc) => canAccessDocument(state, 'player', doc))
    .map((doc) => ({
      docId: doc.id,
      version: doc.version,
      status: doc.status,
      timing: doc.timing,
      to: actorName(names, doc.to, lang),
      note: secretHits(doc.note, secrets).length > 0 ? '' : doc.note,
      terms: termsView(filterTermsFor(state, config, 'player', doc.terms), config.catalog, documentPair(state, config, doc), lang),
    }));
  const heard = (opts.dialogue ?? [])
    .filter((r) => r.speaker === 'player' || r.listeners.includes('player'))
    .filter((r) => secretHits(r.text, secrets).length === 0)
    .sort((a, b) => a.seq - b.seq)
    .slice(-MAX_DIALOGUE)
    .map((r) => ({ speaker: actorName(names, r.speaker, lang), to: r.listeners.map((l) => actorName(names, l, lang)), kind: r.kind, text: r.text }));
  return {
    version: ANSWER_CONTEXT_VERSION,
    lang,
    self: {
      id: opts.charId,
      name: loc(persona.name, lang),
      title: loc(persona.title, lang),
      publicVoice: loc(persona.public_voice, lang),
    },
    time: { round: state.round, day: state.day },
    scene: {
      location,
      locationName: locationName(names, location, lang),
      present: presentAt(state, location)
        .filter((p) => p !== 'system')
        .map((p) => actorName(names, p, lang)),
    },
    situation: {
      siege: { grain: view.resources.resources.grain, pressure: view.siege.pressure, morale: view.siege.morale },
      resources: { ...view.resources.resources },
      documents,
      negotiation: view.negotiation,
    },
    heard,
    facts: opts.facts.map((f) => loc(f, lang)).filter((f) => secretHits(f, secrets).length === 0),
  };
}

export function serializeAnswerContext(ctx: AnswerContext): string {
  const section = (title: string, items: readonly unknown[]): string =>
    `=== ${title} ===\n${items.length === 0 ? '(none)' : items.map((i) => (typeof i === 'string' ? i : jsonLine(i))).join('\n')}`;
  return [
    section(ANSWER_SECTIONS[0], [{ name: ctx.self.name, title: ctx.self.title }, `Manner of speech: ${ctx.self.publicVoice}`]),
    section(ANSWER_SECTIONS[1], [{ round: ctx.time.round, day: ctx.time.day, place: ctx.scene.locationName, present: ctx.scene.present }]),
    section(ANSWER_SECTIONS[2], [{ siege: ctx.situation.siege, resources: ctx.situation.resources }, ...ctx.situation.documents, { negotiation: ctx.situation.negotiation }]),
    section(ANSWER_SECTIONS[3], ctx.facts.map((f) => `- ${f}`)),
    section(ANSWER_SECTIONS[4], ctx.heard),
  ].join('\n\n');
}

export function prepareAnswerCall(opts: Omit<AnswerOptions, 'client' | 'signal' | 'model' | 'temperature'>): {
  context: AnswerContext;
  messages: ChatMessage[];
  meta: AnswerMeta;
  names: AgentNames;
} {
  const persona = opts.persona ?? opts.content.characters[opts.charId];
  const names = opts.names ?? buildNames(opts.content, { [opts.charId]: persona });
  const context = buildAnswerContext({ ...opts, names });
  const name = context.self.name;
  const system = render(ANSWER_SYSTEM, { name, title: context.self.title, lang_name: langName(opts.lang) });
  const question = questionBlock(opts.question);
  const user = (ctx: AnswerContext): string =>
    render(ANSWER_USER, { round: opts.state.round, day: opts.state.day, context: serializeAnswerContext(ctx), question, name });
  const cap = opts.maxInputChars ?? DEFAULT_INPUT_CAPS.answer;
  let text = user(context);
  while (system.length + text.length + INPUT_MARGIN > cap && context.heard.length > 0) {
    context.heard.shift();
    text = user(context);
  }
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: text },
  ];
  const meta: AnswerMeta = { agent: 'answer', lang: opts.lang, identity: { ...opts.identity }, context, question: opts.question, facts: context.facts };
  return { context, messages, meta, names };
}

export async function runAnswer(opts: AnswerOptions): Promise<AnswerResult> {
  const { context, messages, meta, names } = prepareAnswerCall(opts);
  const result = await opts.client.complete({
    role: 'answer',
    actor: opts.charId,
    round: opts.identity.round,
    ...(opts.identity.sessionId !== undefined ? { sessionId: opts.identity.sessionId } : {}),
    callTag: opts.identity.callTag ?? 'answer',
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    messages,
    schema: AnswerOutputSchema,
    schemaName: AGENT_SCHEMAS.answer.name,
    meta: meta as unknown as Record<string, unknown>,
  });
  const llm = summarizeCall(result);
  const base = { llm, messages, context };
  if (!result.ok || result.value.speech.trim().length === 0) {
    return { ...base, status: result.ok ? 'ok' : agentStatusOf(result.error.kind), outcome: 'no_answer', text: noAnswerLine(names, opts.charId, opts.lang), leakHits: [] };
  }
  const speech = result.value.speech.trim();
  const hits = secretHits(speech, secretsUnknownTo(opts.config, opts.state, 'player'));
  if (hits.length > 0) {
    return { ...base, status: 'ok', outcome: 'blocked', text: blockedAnswerLine(names, opts.charId, opts.lang), leakHits: hits.map((h) => ({ check: h.check, detail: h.detail })) };
  }
  return { ...base, status: 'ok', outcome: 'answered', text: speech, leakHits: [] };
}
