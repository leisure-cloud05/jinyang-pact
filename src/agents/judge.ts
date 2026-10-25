/**
 * Judge agent (PLAN §9.1, §7). Input is built from the PLAYER's knowledge only: the player's goal and active
 * authorizations, player-visible facts (core `playerView`), open disagreements (suggestions on documents the
 * player can see) and the dialogue the player heard, plus the player-side proposals rendered as the player could
 * see them (secret clauses the player does not know are removed from terms; free text the player could not have
 * observed is withheld; secret text is scrubbed). Precomputed checks (goal limits on player-visible terms, open
 * objections, risky delay) are included as hints.
 * Output: CONTINUE | PAUSE | REVISE with a semantic category. Questions and reasons are scanned for secret
 * content unknown to the player and replaced by a generic question on a hit.
 * `judgeWithRevision` implements the REVISE loop: one revision call per character, one re-assessment; a second
 * REVISE (or a failed revision) becomes PAUSE `ambiguity`.
 */
import { parseAction, type Action } from '../core/actions.js';
import { compareIds, own } from '../core/ids.js';
import { canAccessDocument, clauseLookupFor, coLocated, filterTermsFor, isPlayerSide, knowsClause, playerView } from '../core/knowledge.js';
import { documentPair } from '../core/negotiation.js';
import { isAuthorizationActive, mandatoryCategory, proposalTerms } from '../core/pauses.js';
import { expandTermArgs, withinLimits } from '../core/terms.js';
import type { ActorId, CoreConfig, Document, JsonValue, TermLimits, TermSet, WorldState } from '../core/types.js';
import type { ChatMessage, LlmClient } from '../llm/types.js';
import { DEFAULT_INPUT_CAPS, INPUT_MARGIN, summarizeCall } from './call.js';
import { believedResources } from './ledger.js';
import { actorName, buildNames, loc, type AgentNames } from './names.js';
import { secretHits, secretsUnknownTo, type SecretSpec } from './narration/index.js';
import { JUDGE_REASSESSMENT_NOTE, JUDGE_SYSTEM, JUDGE_USER, render } from './prompts/index.js';
import { AGENT_SCHEMAS, JUDGE_CATEGORIES, JudgeOutputSchema, type JudgeVerdictKind, type SemanticCategory } from './schemas.js';
import { agentStatusOf, type AgentContent, type AgentStatus, type CallIdentity, type DialogueRow, type Lang, type LlmCallSummary } from './types.js';
import { jsonLine, langName, sanitizeJson, sha256Hex, termsView, type TermsView } from './util.js';

export const JUDGE_CONTEXT_VERSION = 'ctx.judge.v1';

export interface JudgeProposalInput {
  proposalId: string;
  actor: ActorId;
  action: unknown;
  askPlayer?: { question: string } | null;
}

export interface JudgeProposalView {
  proposal_id: string;
  actor: ActorId;
  actorName: string;
  type: string;
  args: JsonValue;
  terms: TermsView | null;
  goalCheck: { withinGoal: boolean; violations: string[] } | null;
  mandatoryCategory: string | null;
  askPlayer: string | null;
  hints: { openObjection: boolean; riskyDelay: boolean };
}

export interface JudgeContext {
  version: string;
  lang: Lang;
  player: {
    goal: { text: string; limits: Partial<TermLimits> };
    authorizations: { id: string; grantee: string; categories: string[]; limits: Partial<TermLimits>; expiresRound: number | null }[];
  };
  facts: {
    round: number;
    day: number;
    location: string;
    siege: { grain: number; pressure: number; morale: number };
    resources: { available: Record<string, number>; reserved: Record<string, number> };
    documents: JsonValue[];
    negotiation: JsonValue;
    beliefs: JsonValue[];
  };
  disagreements: JsonValue[];
  dialogue: JsonValue[];
  proposals: JudgeProposalView[];
}

export interface BuiltJudgeContext {
  context: JudgeContext;
  text: string;
  hash: string;
}

export interface JudgeContextInput {
  content: AgentContent;
  config: CoreConfig;
  state: WorldState;
  proposals: readonly JudgeProposalInput[];
  lang: Lang;
  dialogue?: readonly DialogueRow[];
  maxDialogue?: number;
  names?: AgentNames;
  /** Budget for the serialized context (default: judge cap minus prompt). */
  maxChars?: number;
}

const WITHHELD = '(not visible to the player)';
const SCRUBBED = '(sealed content withheld)';

function limitsView(limits: TermLimits): Partial<TermLimits> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(limits)) if (v !== null && v !== undefined) out[k] = v;
  return out as Partial<TermLimits>;
}

function scrub(text: string, secrets: readonly SecretSpec[]): string {
  return secretHits(text, secrets).length > 0 ? SCRUBBED : text;
}

function playerTermsArgs(args: unknown, state: WorldState, config: CoreConfig): unknown {
  if (typeof args !== 'object' || args === null) return args;
  const t = args as Record<string, unknown>;
  if (!Array.isArray(t.secret_clauses)) return args;
  return { ...t, secret_clauses: t.secret_clauses.filter((id) => typeof id === 'string' && knowsClause(state, config, 'player', id)) };
}

/** The proposal's arguments as the player could know them. */
function playerArgs(action: Action, actor: ActorId, state: WorldState, config: CoreConfig, secrets: readonly SecretSpec[]): JsonValue {
  const observable = coLocated(state, actor, 'player');
  const text = (s: string, visible: boolean): string => (visible ? scrub(s, secrets) : WITHHELD);
  const a = action;
  switch (a.type) {
    case 'speak':
      return { to: a.args.to, text: text(a.args.text, a.args.to.includes('player')) };
    case 'send_letter':
      return { to: a.args.to, text: text(a.args.text, observable) };
    case 'revise_document':
      return {
        docId: a.args.docId,
        baseDocVersion: a.args.baseDocVersion,
        terms: playerTermsArgs(a.args.terms, state, config) as JsonValue,
        note: text(a.args.note, observable),
      };
    case 'suggest_revision':
      return { target: a.args.target, terms: playerTermsArgs(a.args.terms, state, config) as JsonValue, reason: text(a.args.reason, observable) };
    case 'propose_terms':
      return { to: a.args.to, terms: playerTermsArgs(a.args.terms, state, config) as JsonValue, note: a.args.note === null ? null : text(a.args.note, observable) };
    case 'respond_to_offer':
      return {
        offerId: a.args.offerId,
        response: a.args.response,
        counterTerms: a.args.counterTerms === null ? null : (playerTermsArgs(a.args.counterTerms, state, config) as JsonValue),
        reason: text(a.args.reason, observable),
      };
    case 'abandon_request':
      return { reason: text(a.args.reason, observable) };
    default:
      return sanitizeJson(a.args, 'en');
  }
}

function openObjection(action: Action, actor: ActorId, state: WorldState): boolean {
  let target: { kind: 'document' | 'offer'; id: string; version: number } | null = null;
  if (action.type === 'approve_document' || action.type === 'dispatch_document') {
    const doc = own(state.documents, action.args.docId);
    if (doc) target = { kind: 'document', id: doc.id, version: doc.version };
  } else if (action.type === 'confirm_commitment' || action.type === 'respond_to_offer') {
    const offer = own(state.offers, action.args.offerId);
    if (offer) target = { kind: 'offer', id: offer.id, version: offer.termsVersion };
  }
  if (!target) return false;
  return Object.values(state.suggestions).some(
    (s) => s.by !== actor && s.target.kind === target.kind && s.target.id === target.id && s.targetVersion === target.version,
  );
}

function riskyDelay(action: Action, state: WorldState): boolean {
  if (action.type !== 'set_dispatch_timing' || action.args.mode === 'now') return false;
  return state.factions.hedong.resources.grain <= 15 || state.siege.pressure >= 70;
}

function proposalView(
  p: JudgeProposalInput,
  state: WorldState,
  config: CoreConfig,
  names: AgentNames,
  lang: Lang,
  secrets: readonly SecretSpec[],
): JudgeProposalView {
  const parsed = parseAction(p.action);
  const type = typeof p.action === 'object' && p.action !== null ? String((p.action as { type?: unknown }).type ?? 'unknown') : 'unknown';
  if (!parsed.ok) {
    return {
      proposal_id: p.proposalId,
      actor: p.actor,
      actorName: actorName(names, p.actor, lang),
      type,
      args: 'malformed action',
      terms: null,
      goalCheck: null,
      mandatoryCategory: null,
      askPlayer: p.askPlayer ? scrub(p.askPlayer.question, secrets) : null,
      hints: { openObjection: false, riskyDelay: false },
    };
  }
  const action = parsed.value;
  let terms: TermsView | null = null;
  let goalCheck: JudgeProposalView['goalCheck'] = null;
  const pt = proposalTerms(state, config, p.actor, action);
  if (pt) {
    const visible: TermSet = filterTermsFor(state, config, 'player', pt.terms);
    terms = termsView(visible, config.catalog, pt.pair, lang);
    const check = withinLimits(visible, state.player.goal.limits, config.catalog, pt.pair);
    goalCheck = { withinGoal: check.ok, violations: check.violations };
  } else if (action.type === 'revise_document') {
    const doc = own(state.documents, action.args.docId);
    const pair = doc ? documentPair(state, config, doc) : null;
    if (pair) {
      const known = action.args.terms.secret_clauses.filter((id) => knowsClause(state, config, 'player', id));
      const expanded = expandTermArgs({ ...action.args.terms, secret_clauses: known }, clauseLookupFor(state, config, 'player'));
      if (expanded.ok) {
        terms = termsView(expanded.terms, config.catalog, pair, lang);
        const check = withinLimits(expanded.terms, state.player.goal.limits, config.catalog, pair);
        goalCheck = { withinGoal: check.ok, violations: check.violations };
      }
    }
  }
  return {
    proposal_id: p.proposalId,
    actor: p.actor,
    actorName: actorName(names, p.actor, lang),
    type: action.type,
    args: playerArgs(action, p.actor, state, config, secrets),
    terms,
    goalCheck,
    mandatoryCategory: mandatoryCategory(state, config, p.actor, action),
    askPlayer: p.askPlayer ? scrub(p.askPlayer.question, secrets) : null,
    hints: { openObjection: openObjection(action, p.actor, state), riskyDelay: riskyDelay(action, state) },
  };
}

function section(title: string, items: readonly unknown[]): string {
  return `=== ${title} ===\n${items.length === 0 ? '(none)' : items.map((i) => jsonLine(i)).join('\n')}`;
}

export function serializeJudgeContext(ctx: JudgeContext): string {
  return [
    section("PLAYER'S GOAL AND AUTHORIZATIONS", [ctx.player.goal, ...ctx.player.authorizations]),
    section('PLAYER-VISIBLE FACTS', [
      { round: ctx.facts.round, day: ctx.facts.day, location: ctx.facts.location, siege: ctx.facts.siege, resources: ctx.facts.resources },
      ...ctx.facts.documents,
      ctx.facts.negotiation,
    ]),
    section('WHAT THE PLAYER KNOWS', ctx.facts.beliefs),
    section('OPEN DISAGREEMENTS (advisers\' suggestions on what the player can see)', ctx.disagreements),
    section('DIALOGUE THE PLAYER HEARD (oldest first)', ctx.dialogue),
    section('PROPOSALS TO ASSESS', ctx.proposals),
  ].join('\n\n');
}

export function buildJudgeContext(input: JudgeContextInput): BuiltJudgeContext {
  const { content, config, state, lang } = input;
  const names = input.names ?? buildNames(content);
  const view = playerView(state, config);
  const ledger = believedResources(state, 'player', config.player.faction);
  const secrets = secretsUnknownTo(config, state, 'player');
  const docs = Object.keys(state.documents)
    .sort(compareIds)
    .map((id) => own(state.documents, id) as Document)
    .filter((d) => canAccessDocument(state, 'player', d))
    .map((d) => ({
      docId: d.id,
      version: d.version,
      status: d.status,
      approvedVersion: d.approval?.version ?? null,
      timing: d.timing,
      to: d.to,
      terms: termsView(filterTermsFor(state, config, 'player', d.terms), config.catalog, documentPair(state, config, d), lang),
      note: scrub(d.note, secrets),
    })) as unknown as JsonValue[];
  const beliefs = view.beliefs
    .filter((k) => !/^(?:offer:\d+(?:\/withdrawal)?|cmt:\d+|doc:\d+)$/.test(k.subject))
    .map((k) => ({ ref: k.id, subject: k.subject, value: sanitizeJson(k.value, lang), asOfDay: k.asOfDay, credibility: k.credibility }));
  const disagreements = Object.keys(state.suggestions)
    .sort(compareIds)
    .map((id) => own(state.suggestions, id))
    .filter((s): s is NonNullable<typeof s> => s !== undefined)
    .filter((s) => {
      if (!isPlayerSide(state, config, s.by)) return false;
      if (s.target.kind === 'document') {
        const doc = own(state.documents, s.target.id);
        return doc !== undefined && canAccessDocument(state, 'player', doc) && doc.version === s.targetVersion;
      }
      return view.negotiation.offers.some((o) => o.offerId === s.target.id);
    })
    .map((s) => ({
      suggestionId: s.id,
      by: s.by,
      byName: actorName(names, s.by, lang),
      target: s.target,
      targetVersion: s.targetVersion,
      changes: sanitizeJson(
        Object.fromEntries(Object.entries(s.terms).filter(([k, v]) => v !== null && k !== 'secret_clauses')),
        lang,
      ),
      reason: scrub(s.reason, secrets),
      round: s.round,
    })) as unknown as JsonValue[];
  const dialogue = (input.dialogue ?? [])
    .filter((r) => r.speaker === 'player' || r.listeners.includes('player'))
    .sort((a, b) => a.seq - b.seq)
    .slice(-(input.maxDialogue ?? 20))
    .map((r) => ({
      ref: `dialogue:${r.seq}`,
      round: r.round,
      speaker: actorName(names, r.speaker, lang),
      kind: r.kind,
      text: scrub(r.text, secrets),
    })) as unknown as JsonValue[];
  const context: JudgeContext = {
    version: JUDGE_CONTEXT_VERSION,
    lang,
    player: {
      goal: { text: loc(state.player.goal.text, lang), limits: limitsView(state.player.goal.limits) },
      authorizations: Object.values(state.player.authorizations)
        .filter((a) => isAuthorizationActive(a, state.round))
        .sort((a, b) => compareIds(a.id, b.id))
        .map((a) => ({ id: a.id, grantee: a.grantee, categories: [...a.categories], limits: limitsView(a.limits), expiresRound: a.expiresRound })),
    },
    facts: {
      round: view.round,
      day: view.day,
      location: view.location,
      siege: { grain: ledger.available.grain, pressure: view.siege.pressure, morale: view.siege.morale },
      // Believed ledger of the player: remote debits/releases only once the player holds evidence of them.
      resources: { available: { ...ledger.available }, reserved: { ...ledger.reserved } },
      documents: docs,
      negotiation: sanitizeJson(view.negotiation, lang),
      beliefs: beliefs as unknown as JsonValue[],
    },
    disagreements,
    dialogue,
    proposals: input.proposals.map((p) => proposalView(p, state, config, names, lang, secrets)),
  };
  let text = serializeJudgeContext(context);
  const budget = input.maxChars ?? DEFAULT_INPUT_CAPS.judge - JUDGE_SYSTEM.text.length - INPUT_MARGIN - 300;
  while (text.length > budget && context.dialogue.length > 0) {
    context.dialogue.shift();
    text = serializeJudgeContext(context);
  }
  while (text.length > budget && context.facts.beliefs.length > 0) {
    context.facts.beliefs.shift();
    text = serializeJudgeContext(context);
  }
  return { context, text, hash: sha256Hex(text) };
}

// ---------------------------------------------------------------------------------------------------------------
// Call
// ---------------------------------------------------------------------------------------------------------------

export interface JudgeVerdict {
  proposalId: string;
  verdict: JudgeVerdictKind;
  category: SemanticCategory | null;
  reason: string;
  question: string | null;
  /** Question/reason replaced because they carried content the player may not see. */
  sanitized: boolean;
  /** No valid item for this proposal (or the call failed): CONTINUE by default. */
  defaulted: boolean;
}

export interface JudgeMeta {
  agent: 'judge';
  lang: Lang;
  identity: CallIdentity;
  context: JudgeContext;
  reassessment: boolean;
}

export interface JudgeResult {
  status: AgentStatus;
  verdicts: JudgeVerdict[];
  /** Items naming proposal ids that were not assessed (ignored). */
  unknownIds: string[];
  /**
   * True when at least one verdict is a default rather than a judgement (the call failed, or the model returned
   * no item for a proposal). Defaulted verdicts are CONTINUE: the engine must honour `status` (error ⇒
   * error_recovery / suspend), and recall reporting must count defaulted eligible instances as MISSES — never
   * exclude them or count them as judged.
   */
  defaulted: boolean;
  /** Proposal ids whose verdict was defaulted. */
  defaultedIds: string[];
  context: BuiltJudgeContext;
  messages: ChatMessage[];
  llm: LlmCallSummary;
}

export interface JudgeOptions {
  client: LlmClient;
  content: AgentContent;
  config: CoreConfig;
  state: WorldState;
  proposals: readonly JudgeProposalInput[];
  lang: Lang;
  identity: CallIdentity;
  dialogue?: readonly DialogueRow[];
  names?: AgentNames;
  /** Second assessment after REVISE: a REVISE verdict becomes PAUSE ambiguity. */
  reassessment?: boolean;
  signal?: AbortSignal;
  model?: string;
  temperature?: number;
}

const GENERIC_QUESTION: Record<SemanticCategory, { zh: string; en: string }> = {
  internal_disagreement: { zh: '幕中意见不一，是否仍照此行事？', en: 'The council is divided. Proceed with this anyway?' },
  goal_conflict: { zh: '此举似超出你所定之限，是否照行？', en: 'This seems to go beyond your limits. Proceed?' },
  risky_delay: { zh: '城中危急，仍要延缓吗？', en: 'The city is in danger. Delay anyway?' },
  ambiguity: { zh: '此举用意未明，是否照行？', en: 'The intent of this proposal is unclear. Proceed?' },
};

export function prepareJudgeCall(opts: Omit<JudgeOptions, 'client' | 'signal' | 'model' | 'temperature'>): {
  built: BuiltJudgeContext;
  messages: ChatMessage[];
  meta: JudgeMeta;
} {
  const built = buildJudgeContext({
    content: opts.content,
    config: opts.config,
    state: opts.state,
    proposals: opts.proposals,
    lang: opts.lang,
    ...(opts.dialogue ? { dialogue: opts.dialogue } : {}),
    ...(opts.names ? { names: opts.names } : {}),
  });
  const messages: ChatMessage[] = [
    { role: 'system', content: render(JUDGE_SYSTEM, { lang_name: langName(opts.lang) }) },
    { role: 'user', content: render(JUDGE_USER, { context: built.text, reassessment: opts.reassessment ? JUDGE_REASSESSMENT_NOTE : '' }) },
  ];
  const meta: JudgeMeta = { agent: 'judge', lang: opts.lang, identity: { ...opts.identity }, context: built.context, reassessment: opts.reassessment === true };
  return { built, messages, meta };
}

/** Normalizes raw items onto one verdict per proposal (pure; exported for tests). */
export function normalizeVerdicts(
  items: readonly { proposal_id: string; verdict: JudgeVerdictKind; category: SemanticCategory | null; reason: string; question: string | null }[],
  proposals: readonly JudgeProposalInput[],
  opts: { lang: Lang; secrets: readonly SecretSpec[]; reassessment: boolean },
): { verdicts: JudgeVerdict[]; unknownIds: string[] } {
  const ids = new Set(proposals.map((p) => p.proposalId));
  const unknownIds = items.filter((i) => !ids.has(i.proposal_id)).map((i) => i.proposal_id);
  const verdicts = proposals.map((p): JudgeVerdict => {
    const item = items.find((i) => i.proposal_id === p.proposalId);
    if (!item) {
      return { proposalId: p.proposalId, verdict: 'CONTINUE', category: null, reason: 'no verdict returned', question: null, sanitized: false, defaulted: true };
    }
    let verdict: JudgeVerdictKind = item.verdict;
    let category: SemanticCategory | null = item.category;
    if (verdict === 'REVISE' && opts.reassessment) {
      verdict = 'PAUSE';
      category = 'ambiguity';
    }
    if (verdict === 'CONTINUE') category = null;
    else if (category === null || !(JUDGE_CATEGORIES as readonly string[]).includes(category)) category = 'ambiguity';
    let question = verdict === 'PAUSE' ? (item.question?.trim() || null) : null;
    let reason = item.reason;
    let sanitized = false;
    if (secretHits(`${question ?? ''}\n${reason}`, opts.secrets).length > 0) {
      sanitized = true;
      reason = 'reason withheld (it referred to content the player may not see)';
      if (question !== null && category) question = GENERIC_QUESTION[category][opts.lang];
    }
    if (verdict === 'PAUSE' && question === null && category) question = GENERIC_QUESTION[category][opts.lang];
    return { proposalId: p.proposalId, verdict, category, reason, question, sanitized, defaulted: false };
  });
  return { verdicts, unknownIds };
}

export async function runJudge(opts: JudgeOptions): Promise<JudgeResult> {
  const { built, messages, meta } = prepareJudgeCall(opts);
  const result = await opts.client.complete({
    role: 'judge',
    actor: 'judge',
    round: opts.identity.round,
    ...(opts.identity.sessionId !== undefined ? { sessionId: opts.identity.sessionId } : {}),
    callTag: opts.identity.callTag ?? (opts.reassessment ? 'reassess' : 'assess'),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    messages,
    schema: JudgeOutputSchema,
    schemaName: AGENT_SCHEMAS.judge.name,
    meta: meta as unknown as Record<string, unknown>,
  });
  const llm = summarizeCall(result);
  if (!result.ok) {
    return {
      status: agentStatusOf(result.error.kind),
      verdicts: opts.proposals.map((p) => ({
        proposalId: p.proposalId,
        verdict: 'CONTINUE',
        category: null,
        reason: `judge unavailable (${result.error.kind})`,
        question: null,
        sanitized: false,
        defaulted: true,
      })),
      unknownIds: [],
      defaulted: true,
      defaultedIds: opts.proposals.map((p) => p.proposalId),
      context: built,
      messages,
      llm,
    };
  }
  const { verdicts, unknownIds } = normalizeVerdicts(result.value.items, opts.proposals, {
    lang: opts.lang,
    secrets: secretsUnknownTo(opts.config, opts.state, 'player'),
    reassessment: opts.reassessment === true,
  });
  const defaultedIds = verdicts.filter((v) => v.defaulted).map((v) => v.proposalId);
  return { status: 'ok', verdicts, unknownIds, defaulted: defaultedIds.length > 0, defaultedIds, context: built, messages, llm };
}

// ---------------------------------------------------------------------------------------------------------------
// REVISE flow (PLAN §7)
// ---------------------------------------------------------------------------------------------------------------

export interface RevisionFlowResult {
  /** Final proposal set: unrevised originals plus the revised replacements. */
  proposals: JudgeProposalInput[];
  /** One verdict per final proposal (no REVISE remains). */
  verdicts: JudgeVerdict[];
  /** Original proposal ids replaced by a revision. */
  replaced: string[];
  revisedActors: ActorId[];
  /** Final proposals whose verdict is a default, not a judgement (count as misses in recall reporting). */
  defaultedIds: string[];
  judgeCalls: number;
  revisionCalls: number;
}

export interface RevisionFlowOptions {
  proposals: readonly JudgeProposalInput[];
  /** One Judge assessment (`reassessment` is true for the single re-assessment). */
  assess: (proposals: readonly JudgeProposalInput[], reassessment: boolean) => Promise<JudgeVerdict[]>;
  /**
   * One revision call for a character: returns its replacement proposals (fresh ids), or null if the revision
   * failed (the REVISE verdicts then become PAUSE ambiguity on the originals).
   */
  revise: (actor: ActorId, items: { proposal: JudgeProposalInput; verdict: JudgeVerdict }[]) => Promise<JudgeProposalInput[] | null>;
}

function toPause(v: JudgeVerdict, reason: string): JudgeVerdict {
  return { ...v, verdict: 'PAUSE', category: 'ambiguity', reason, question: v.question ?? null };
}

export async function judgeWithRevision(opts: RevisionFlowOptions): Promise<RevisionFlowResult> {
  let judgeCalls = 1;
  let revisionCalls = 0;
  const first = await opts.assess(opts.proposals, false);
  const byId = new Map(first.map((v) => [v.proposalId, v]));
  const reviseActors: ActorId[] = [];
  for (const p of opts.proposals) {
    if (byId.get(p.proposalId)?.verdict === 'REVISE' && !reviseActors.includes(p.actor)) reviseActors.push(p.actor);
  }
  if (reviseActors.length === 0) {
    return {
      proposals: [...opts.proposals],
      verdicts: first,
      replaced: [],
      revisedActors: [],
      defaultedIds: first.filter((v) => v.defaulted).map((v) => v.proposalId),
      judgeCalls,
      revisionCalls,
    };
  }
  const finalProposals: JudgeProposalInput[] = [];
  const finalVerdicts: JudgeVerdict[] = [];
  const replaced: string[] = [];
  const revisedActors: ActorId[] = [];
  const revisedAll: JudgeProposalInput[] = [];
  const revisedFor = new Map<ActorId, JudgeProposalInput[] | null>();
  for (const actor of reviseActors) {
    const own = opts.proposals.filter((p) => p.actor === actor);
    const items = own
      .map((p) => ({ proposal: p, verdict: byId.get(p.proposalId) as JudgeVerdict }))
      .filter((i) => i.verdict?.verdict === 'REVISE');
    revisionCalls += 1;
    const revised = await opts.revise(actor, items);
    revisedFor.set(actor, revised);
    if (revised) {
      revisedActors.push(actor);
      replaced.push(...own.map((p) => p.proposalId));
      revisedAll.push(...revised);
    }
  }
  for (const p of opts.proposals) {
    const v = byId.get(p.proposalId) as JudgeVerdict;
    const revised = revisedFor.get(p.actor);
    if (revised) continue; // replaced below
    finalProposals.push(p);
    finalVerdicts.push(v.verdict === 'REVISE' ? toPause(v, `revision unavailable: ${v.reason}`) : v);
  }
  if (revisedAll.length > 0) {
    judgeCalls += 1;
    const second = await opts.assess(revisedAll, true);
    const secondById = new Map(second.map((v) => [v.proposalId, v]));
    for (const p of revisedAll) {
      const v =
        secondById.get(p.proposalId) ??
        ({ proposalId: p.proposalId, verdict: 'CONTINUE', category: null, reason: 'no verdict returned', question: null, sanitized: false, defaulted: true } as JudgeVerdict);
      finalProposals.push(p);
      finalVerdicts.push(v.verdict === 'REVISE' ? toPause(v, `second REVISE: ${v.reason}`) : v);
    }
  }
  return {
    proposals: finalProposals,
    verdicts: finalVerdicts,
    replaced,
    revisedActors,
    defaultedIds: finalVerdicts.filter((v) => v.defaulted).map((v) => v.proposalId),
    judgeCalls,
    revisionCalls,
  };
}
