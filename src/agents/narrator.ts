/**
 * Narrator agent (PLAN §9.1, §9.4, H15/H16). Displayed narration = deterministic fact header + model prose.
 * The prose is checked on its rendered text (names/status, unit-bound quantities, outcome claims, undisclosed
 * secrets); any hit, or a format error, displays the template fallback prose instead. A call failure (timeout,
 * HTTP, budget …) returns status `failed` with the fallback shown, so the engine can mark the scene
 * `narration_pending` and regenerate it later. Nothing here touches world state (H15).
 * The raw prose, header, displayed text and check results are all returned for storage.
 */
import type { CharacterStatus, CharId, CoreConfig, LocId, NarrationFact, WorldState } from '../core/types.js';
import { CHAR_IDS } from '../core/types.js';
import type { ChatMessage, LlmClient } from '../llm/types.js';
import { DEFAULT_INPUT_CAPS, INPUT_MARGIN, summarizeCall } from './call.js';
import { actorName, buildNames, locationName, type AgentNames } from './names.js';
import {
  checkProse,
  fallbackProse,
  HEADER_VERSION,
  FALLBACK_VERSION,
  renderFactHeader,
  renderFactLine,
  undisclosedSecrets,
  type CheckResult,
} from './narration/index.js';
import { NARRATOR_STYLE, NARRATOR_SYSTEM, NARRATOR_USER, render } from './prompts/index.js';
import { AGENT_SCHEMAS, NarratorOutputSchema } from './schemas.js';
import { agentStatusOf, type AgentContent, type CallIdentity, type Lang, type LlmCallSummary } from './types.js';

export type NarrationStatus = 'ok' | 'fallback' | 'failed';
export type FallbackReason = 'checker' | 'format_error' | 'error' | null;

/** Stored with the narration row (`check` column). */
export interface NarrationCheckRecord {
  checker: CheckResult | null;
  fallbackReason: FallbackReason;
  headerVersion: string;
  fallbackVersion: string;
  mentionedFacts: number[];
}

export interface NarrationResult {
  status: NarrationStatus;
  /** Raw model output (null when no reply). */
  raw: string | null;
  header: string;
  /** Model prose as returned (null when unusable). */
  prose: string | null;
  /** Prose actually displayed (model prose, or the template fallback). */
  displayedProse: string;
  /** Header + displayed prose. */
  displayed: string;
  check: NarrationCheckRecord;
  llm: LlmCallSummary;
  messages: ChatMessage[];
}

export interface NarratorMeta {
  agent: 'narrator';
  lang: Lang;
  identity: CallIdentity;
  scene: string;
  day: number;
  header: string;
  facts: NarrationFact[];
  characters: { id: CharId; name: string; status: CharacterStatus }[];
  /** Deterministic template prose for these facts (what a template narrator writes). */
  templateProse: string;
}

export interface NarrateSceneOptions {
  client: LlmClient;
  content: AgentContent;
  config: CoreConfig;
  /** Committed state after the scene's events (names/status/quantities are checked against it). */
  state: WorldState;
  scene: LocId | string;
  facts: readonly NarrationFact[];
  lang: Lang;
  identity: CallIdentity;
  day?: number;
  names?: AgentNames;
  maxInputChars?: number;
  signal?: AbortSignal;
  model?: string;
  temperature?: number;
}

function involvedCharacters(facts: readonly NarrationFact[], state: WorldState): CharId[] {
  const ids = new Set<CharId>();
  const add = (v: unknown): void => {
    if (typeof v === 'string' && (CHAR_IDS as readonly string[]).includes(v)) ids.add(v as CharId);
  };
  for (const f of facts) {
    add(f.actor);
    for (const a of f.audience) add(a);
    for (const key of ['by', 'to', 'from', 'charId', 'grantee']) add(f.data[key]);
  }
  return CHAR_IDS.filter((id) => ids.has(id) && state.characters[id] !== undefined);
}

export function prepareNarration(opts: Omit<NarrateSceneOptions, 'client' | 'signal' | 'model' | 'temperature'>): {
  header: string;
  messages: ChatMessage[];
  meta: NarratorMeta;
  names: AgentNames;
} {
  const names = opts.names ?? buildNames(opts.content);
  const day = opts.day ?? opts.state.day;
  const header = renderFactHeader(opts.facts, names, opts.lang, { scene: opts.scene, day });
  const characters = involvedCharacters(opts.facts, opts.state).map((id) => ({
    id,
    name: actorName(names, id, opts.lang),
    status: opts.state.characters[id].status,
  }));
  const system = render(NARRATOR_SYSTEM, { style: NARRATOR_STYLE[opts.lang] });
  const cap = opts.maxInputChars ?? DEFAULT_INPUT_CAPS.narrator;
  const factLines = opts.facts.map((f, i) => `${i}: ${renderFactLine(f, names, opts.lang)}`);
  const build = (lines: string[]): string =>
    render(NARRATOR_USER, {
      scene: locationName(names, opts.scene, opts.lang),
      day,
      header,
      characters: characters.map((c) => `${c.id}: ${c.name} (${c.status})`).join('\n') || '(none)',
      facts: lines.join('\n'),
    });
  let lines = factLines;
  let user = build(lines);
  while (system.length + user.length + INPUT_MARGIN > cap && lines.length > 1) {
    lines = lines.slice(0, -1);
    user = build([...lines, `… (${factLines.length - lines.length} more facts in the header)`]);
  }
  const meta: NarratorMeta = {
    agent: 'narrator',
    lang: opts.lang,
    identity: { ...opts.identity },
    scene: opts.scene,
    day,
    header,
    facts: opts.facts.map((f) => structuredClone(f)),
    characters,
    templateProse: fallbackProse(opts.facts, names, opts.lang, opts.scene),
  };
  return {
    header,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    meta,
    names,
  };
}

/** Checks prose for a scene against its facts and the committed state. */
export function checkSceneProse(
  prose: string,
  opts: Pick<NarrateSceneOptions, 'config' | 'state' | 'facts'> & { names: AgentNames; day?: number },
): CheckResult {
  return checkProse({
    prose,
    facts: opts.facts,
    names: opts.names,
    secrets: undisclosedSecrets(opts.config, opts.state, opts.facts),
  });
}

function joinDisplayed(header: string, prose: string): string {
  return `${header}\n\n${prose}`;
}

export async function narrateScene(opts: NarrateSceneOptions): Promise<NarrationResult> {
  const { header, messages, meta, names } = prepareNarration(opts);
  const fallback = meta.templateProse;
  const result = await opts.client.complete({
    role: 'narrator',
    actor: 'narrator',
    round: opts.identity.round,
    ...(opts.identity.sessionId !== undefined ? { sessionId: opts.identity.sessionId } : {}),
    callTag: opts.identity.callTag ?? `scene:${opts.scene}`,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    messages,
    schema: NarratorOutputSchema,
    schemaName: AGENT_SCHEMAS.narrator.name,
    meta: meta as unknown as Record<string, unknown>,
  });
  const llm = summarizeCall(result);
  const base = { headerVersion: HEADER_VERSION, fallbackVersion: FALLBACK_VERSION };
  if (!result.ok) {
    const status = agentStatusOf(result.error.kind);
    return {
      status: status === 'format_error' ? 'fallback' : 'failed',
      raw: result.raw ?? null,
      header,
      prose: null,
      displayedProse: fallback,
      displayed: joinDisplayed(header, fallback),
      check: { ...base, checker: null, fallbackReason: status === 'format_error' ? 'format_error' : 'error', mentionedFacts: [] },
      llm,
      messages,
    };
  }
  const prose = result.value.prose.trim();
  const checker = checkSceneProse(prose, { config: opts.config, state: opts.state, facts: opts.facts, names, day: meta.day });
  const mentionedFacts = result.value.mentioned_facts.filter((i) => i >= 0 && i < opts.facts.length);
  const ok = checker.ok && prose.length > 0;
  return {
    status: ok ? 'ok' : 'fallback',
    raw: result.raw,
    header,
    prose,
    displayedProse: ok ? prose : fallback,
    displayed: joinDisplayed(header, ok ? prose : fallback),
    check: { ...base, checker, fallbackReason: ok ? null : 'checker', mentionedFacts },
    llm,
    messages,
  };
}

/** Harness-compatible narrate function (`NarrateFn`: `{scene, eventVersions, facts}` → stored narration row). */
export function createNarrateFn(opts: Omit<NarrateSceneOptions, 'scene' | 'facts' | 'state' | 'identity'> & {
  getState: () => WorldState;
  identity: () => CallIdentity;
}): (req: { scene: string; eventVersions: number[]; facts: NarrationFact[] }) => Promise<{
  status: NarrationStatus;
  raw: string | null;
  header: string;
  displayed: string;
  check: NarrationCheckRecord;
}> {
  return async (req) => {
    const r = await narrateScene({
      ...opts,
      state: opts.getState(),
      scene: req.scene,
      facts: req.facts,
      identity: { ...opts.identity(), callTag: `scene:${req.scene}:${req.eventVersions.join(',')}` },
    });
    return { status: r.status, raw: r.raw, header: r.header, displayed: r.displayed, check: r.check };
  };
}
