/**
 * Pauses and decisions (PLAN §7): ASSESS opens the pauses of the pause plan (mandatory, prompt, control) plus
 * semantic pauses supplied by the Judge; resolving a pause stores the decision, recomputes the plan over the
 * remaining proposals (opening newly required pauses) and commits the batch when no pause is left open.
 * Regenerating decisions (`amend`; deadlock `adjust_goal`/`urge_accept`/`urge_stop`) run as one atomic transition:
 * decision → `player` batch with its world effects → advice → paused batch and its pauses obsolete → epoch+1.
 * Pause facts and questions are built from the player's knowledge only.
 */
import { SCALAR_TERM_KEYS, BESIEGED_FACTION, SEMANTIC_CATEGORIES, type ActorId, type DecisionOption, type Localized, type PairId, type PauseCategory, type TermLimits, type WorldState, type AuthorizationGrant, type CoreConfig, type DecisionPayload } from '../core/types.js';
import { DEFAULT_TERMS } from '../core/terms.js';
import { knowsClause, playerView } from '../core/knowledge.js';
import { QUALIFYING_DEADLOCK_OPTIONS, optionsForPause, pauseKindOf } from '../core/pauses.js';
import { planPauses, type PauseRequest } from '../core/plan.js';
import { resolvePlaceholders } from '../core/script.js';
import { stateBeforeProposal } from '../core/before.js';
import type { BatchRecord, DialogueKind, PauseMeta, PauseRecord, ProposalRecord, SessionRecord } from '../store/repo.js';
import { commitProposalBatch, currentState, executableProposals, markStale, newBatch, stalenessCheck, toBatchDecision, type CommitResult } from './commit.js';
import { HarnessError, controlId, onCommitted, stage, type HarnessContext, type Replayable } from './context.js';

/** Commit, assessment and decisions are refused while a run is suspended or stopped (batch kept until resume). */
export function assertRunning(ctx: HarnessContext, sessionId: string): void {
  const status = ctx.repo.getSession(sessionId).status;
  if (status === 'suspended' || status === 'stopped') {
    throw new HarnessError('invalid_state', `session ${sessionId} is ${status}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Pause texts (player knowledge only)
// ---------------------------------------------------------------------------------------------------------------

const QUESTIONS: Record<PauseCategory, Localized> = {
  dispatch_request: { zh: '是否同意发出求援书？', en: 'Should the request for assistance be dispatched?' },
  major_commitment: { zh: '是否同意这项重大承诺？', en: 'Should this major commitment go ahead?' },
  strategic_turn: { zh: '是否同意这一战略转折？', en: 'Should this strategic turn go ahead?' },
  mutiny: { zh: '军中将变：任其发生，还是敦促发饷？', en: 'A mutiny is about to break out: let it happen, or urge payment?' },
  negotiation_deadlock: {
    zh: '本段谈判轮数已尽：调整目标、敦促接受，还是敦促罢议？',
    en: 'This negotiation segment is exhausted: adjust the goal, urge acceptance, or urge stopping?',
  },
  death: { zh: '是否允许此人物之死？', en: 'Should this death take place?' },
  allegiance: { zh: '是否允许此人物改换阵营？', en: 'Should this change of allegiance take place?' },
  internal_disagreement: { zh: '幕僚意见不一，是否继续？', en: 'The council disagrees. Proceed?' },
  goal_conflict: { zh: '此举超出你的目标限度，是否继续？', en: 'This goes beyond your goal limits. Proceed?' },
  risky_delay: { zh: '在危急时刻拖延，是否继续？', en: 'This delays at a critical moment. Proceed?' },
  ambiguity: { zh: '意图不明，是否继续？', en: 'The intent is ambiguous. Proceed?' },
  prompt_request: { zh: '人物向你请示。', en: 'A character asks for your view.' },
  user_requested: { zh: '已暂停。', en: 'Paused at your request.' },
  error_recovery: { zh: '出现错误：重试、跳过该人物，还是停止？', en: 'An error occurred: retry, skip the actor, or stop?' },
};

function termsText(state: WorldState, config: CoreConfig, terms: Record<string, unknown> | null | undefined): string {
  if (!terms) return '';
  const parts: string[] = [];
  for (const key of SCALAR_TERM_KEYS) {
    const value = terms[key];
    if (value === undefined || value === null || value === DEFAULT_TERMS[key]) continue;
    parts.push(value === true ? key : `${key}=${String(value)}`);
  }
  const clauses = Array.isArray(terms.secret_clauses) ? terms.secret_clauses : [];
  for (const c of clauses) {
    const id = typeof c === 'string' ? c : typeof c === 'object' && c !== null ? String((c as { id?: unknown }).id) : '';
    if (id && knowsClause(state, config, 'player', id)) parts.push(`secret:${id}`);
  }
  return parts.join(', ');
}

function actionText(state: WorldState, config: CoreConfig, action: unknown): string {
  if (typeof action !== 'object' || action === null) return 'an unreadable proposal';
  const a = action as { type?: string; args?: Record<string, unknown> };
  const args = a.args ?? {};
  switch (a.type) {
    case 'dispatch_document': {
      const doc = Object.hasOwn(state.documents, String(args.docId)) ? state.documents[String(args.docId)] : undefined;
      const visible = doc && playerView(state, config).documents.some((d) => d.docId === doc.id);
      return `dispatch ${String(args.docId)} v${String(args.docVersion)}${visible && doc ? ` (${termsText(state, config, doc.terms as unknown as Record<string, unknown>)})` : ''}`;
    }
    case 'propose_terms':
      return `propose to ${String(args.to)}: ${termsText(state, config, args.terms as Record<string, unknown>)}`;
    case 'respond_to_offer':
      return args.response === 'counter'
        ? `counter ${String(args.offerId)}: ${termsText(state, config, args.counterTerms as Record<string, unknown>)}`
        : `reject ${String(args.offerId)}`;
    case 'confirm_commitment':
      return `confirm ${String(args.offerId)} (terms v${String(args.termsVersion)})`;
    case 'abandon_request':
      return 'abandon the request for assistance';
    case 'mutiny_outbreak':
      return 'mutiny';
    default:
      return String(a.type);
  }
}

/** Localized display name of an actor for player-facing pause text; the raw id when the config carries no names. */
function actorLabel(config: CoreConfig, actor: string): Localized {
  if (actor === 'player') return config.player.name ?? { zh: actor, en: actor };
  const c = Object.hasOwn(config.characters, actor) ? config.characters[actor as keyof CoreConfig['characters']] : undefined;
  return c?.name ?? { zh: actor, en: actor };
}

export function describePause(
  state: WorldState,
  config: CoreConfig,
  category: PauseCategory,
  proposals: readonly ProposalRecord[],
  extra: {
    reason?: string | null;
    question?: Localized | null;
    facts?: Localized[];
    /** The world as each paused proposal would find it (projected within its batch); default `state`. */
    stateFor?: ((p: ProposalRecord) => WorldState) | undefined;
  } = {},
): { visibleFacts: Localized[]; question: Localized } {
  const grain = state.factions[config.player.faction].resources.grain;
  const facts: Localized[] = [
    {
      zh: `第${state.day}日（第${state.round}轮）：存粮${grain}，围城压力${state.siege.pressure}，士气${state.siege.morale}。`,
      en: `Day ${state.day} (round ${state.round}): grain ${grain}, pressure ${state.siege.pressure}, morale ${state.siege.morale}.`,
    },
  ];
  for (const p of proposals) {
    const text = actionText(extra.stateFor?.(p) ?? state, config, p.action);
    const who = actorLabel(config, p.actor);
    facts.push({ zh: `${who.zh}：${text}`, en: `${who.en}: ${text}` });
    if (p.askPlayer) facts.push({ zh: `${who.zh}问：${p.askPlayer.question}`, en: `${who.en} asks: ${p.askPlayer.question}` });
  }
  if (category === 'negotiation_deadlock') {
    const n = playerView(state, config).negotiation;
    facts.push({
      zh: `谈判第${n.segment}段已用${n.roundsUsed}轮（${extra.reason ?? ''}）。`,
      en: `Negotiation segment ${n.segment}: ${n.roundsUsed} round(s) used (${extra.reason ?? ''}).`,
    });
  }
  facts.push(...(extra.facts ?? []));
  const question =
    extra.question ??
    (category === 'prompt_request' && proposals[0]?.askPlayer
      ? { zh: proposals[0].askPlayer.question, en: proposals[0].askPlayer.question }
      : QUESTIONS[category]);
  return { visibleFacts: facts, question };
}

// ---------------------------------------------------------------------------------------------------------------
// Opening pauses
// ---------------------------------------------------------------------------------------------------------------

function sameProposals(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');
}

export interface PauseSpec {
  kind?: PauseRecord['kind'];
  category: PauseCategory;
  proposalIds: string[];
  pair?: PairId | null;
  reason?: string | null;
  question?: Localized | null;
  facts?: Localized[];
  /** error_recovery: the actor whose call failed (for `skip_actor`). */
  actor?: ActorId | null;
}

/**
 * Each paused proposal's fact is rendered from the world as that proposal would find it: the batch base (`state`,
 * the current state while the batch is open) plus a dry run of the batch's earlier proposals and decisions (core
 * `stateBeforeProposal`). Rendering stays player-knowledge-only (`actionText`).
 */
function projectedFor(ctx: HarnessContext, session: SessionRecord, batch: BatchRecord, state: WorldState): (p: ProposalRecord) => WorldState {
  const input = {
    kind: batch.kind,
    proposals: executableProposals(ctx.repo.listProposals(batch.batchId)),
    decisions: ctx.repo.listDecisions(batch.batchId).filter((d) => d.option !== 'ask').map(toBatchDecision),
  };
  const cache = new Map<string, WorldState>();
  return (p) => {
    let s = cache.get(p.proposalId);
    if (!s) {
      s = stateBeforeProposal(state, input, p.proposalId, { config: session.config, mode: session.mode });
      cache.set(p.proposalId, s);
    }
    return s;
  };
}

function insertPause(
  ctx: HarnessContext,
  session: SessionRecord,
  batch: BatchRecord | null,
  state: WorldState,
  spec: PauseSpec,
  meta: PauseMeta = {},
): PauseRecord {
  const proposals = batch ? ctx.repo.listProposals(batch.batchId).filter((p) => spec.proposalIds.includes(p.proposalId)) : [];
  const text = describePause(state, session.config, spec.category, proposals, { ...spec, stateFor: batch ? projectedFor(ctx, session, batch, state) : undefined });
  const { id, seq } = controlId(ctx, session.sessionId, 'pause');
  const pause: PauseRecord = {
    id,
    sessionId: session.sessionId,
    batchId: batch?.batchId ?? null,
    round: state.round,
    epoch: session.epoch,
    kind: spec.kind ?? pauseKindOf(spec.category),
    category: spec.category,
    proposalIds: [...spec.proposalIds],
    pair: spec.pair ?? null,
    visibleFacts: text.visibleFacts,
    question: text.question,
    options: optionsForPause(state, session.config, spec.category, spec.pair ?? null, proposals.map((p) => p.action)),
    status: 'open',
    decisionId: null,
    controlSeq: seq,
    meta,
  };
  ctx.repo.insertPause(pause);
  return pause;
}

/** Opens the pauses a batch still needs (deduplicated against its existing open/resolved pauses). */
export function openRequiredPauses(ctx: HarnessContext, session: SessionRecord, batch: BatchRecord, specs: readonly PauseSpec[]): PauseRecord[] {
  const state = currentState(ctx, session.sessionId);
  const existing = ctx.repo.listPauses(session.sessionId, { batchId: batch.batchId }).filter((p) => p.status !== 'obsolete');
  const opened: PauseRecord[] = [];
  for (const spec of specs) {
    const dup = [...existing, ...opened].some((p) => p.category === spec.category && sameProposals(p.proposalIds, spec.proposalIds));
    if (dup) continue;
    opened.push(insertPause(ctx, session, batch, state, spec));
  }
  return opened;
}

export function planForBatch(ctx: HarnessContext, session: SessionRecord, batch: BatchRecord) {
  const state = currentState(ctx, session.sessionId);
  return planPauses(
    state,
    {
      kind: batch.kind,
      proposals: executableProposals(ctx.repo.listProposals(batch.batchId)),
      decisions: ctx.repo.listDecisions(batch.batchId).filter((d) => d.option !== 'ask').map(toBatchDecision),
    },
    { config: session.config, mode: session.mode },
  );
}

function specFromRequest(r: PauseRequest): PauseSpec {
  return { kind: r.kind, category: r.category, proposalIds: r.proposalIds, pair: r.pair, reason: r.checkpoint?.reason ?? null };
}

export interface SemanticPauseInput {
  category: PauseCategory;
  proposalIds: string[];
  question?: Localized | null;
  facts?: Localized[];
}

export interface AssessResult extends Replayable {
  status: 'assessed' | 'paused' | 'stale';
  pauseIds: string[];
  reason: string | null;
}

/** ASSESS: pause plan (+ Judge pauses) for a generated character batch. Runs inside the caller's transaction. */
export function assessBatch(ctx: HarnessContext, sessionId: string, batchId: string, semantic: readonly SemanticPauseInput[]): AssessResult {
  const session = ctx.repo.getSession(sessionId);
  const batch = ctx.repo.getBatch(batchId);
  if (batch.sessionId !== sessionId) throw new HarnessError('not_found', `${batchId} is not a batch of ${sessionId}`);
  if (batch.status !== 'generating') throw new HarnessError('invalid_state', `${batchId} is ${batch.status}, not generating`);
  const state = currentState(ctx, sessionId);
  const entry = stalenessCheck(session, batch, state);
  if (entry) {
    markStale(ctx, batch, 'stale', 'stale_epoch');
    return { replayed: false, status: 'stale', pauseIds: [], reason: entry.reason };
  }
  const plan = planForBatch(ctx, session, batch);
  const specs: PauseSpec[] = plan.required.map(specFromRequest);
  // Judge pauses: full mode only, semantic categories only, and only for proposals that would commit.
  if (semantic.length > 0 && session.mode !== 'full') {
    throw new HarnessError('invalid_state', `semantic (Judge) pauses exist only in full mode, not ${session.mode}`);
  }
  const wouldCommit = new Set(plan.wouldCommit);
  for (const s of semantic) {
    if (!SEMANTIC_CATEGORIES.includes(s.category)) {
      throw new HarnessError('invalid_state', `${s.category} is not a semantic pause category`);
    }
    const eligible = s.proposalIds.filter((id) => wouldCommit.has(id));
    if (eligible.length === 0) continue; // invalid proposals never produce decision pauses
    specs.push({ kind: 'semantic', category: s.category, proposalIds: eligible, question: s.question ?? null, facts: s.facts ?? [] });
  }
  const opened = openRequiredPauses(ctx, session, batch, specs);
  const status = opened.length > 0 ? 'paused' : 'assessed';
  ctx.repo.updateBatch(batchId, { status });
  ctx.repo.updateSession(sessionId, {
    status: status === 'paused' ? 'awaiting_decision' : 'committing',
    phase: status === 'paused' ? 'decide' : 'commit',
  });
  return { replayed: false, status, pauseIds: opened.map((p) => p.id), reason: null };
}

// ---------------------------------------------------------------------------------------------------------------
// Resolving pauses
// ---------------------------------------------------------------------------------------------------------------

export interface DecisionInput {
  option: DecisionOption;
  advice?: string | null;
  authorization?: AuthorizationGrant | null;
  goalLimits?: TermLimits | null;
  /** `baseDocVersion` may be "$current" (the version the player can see at decision time). */
  amend?: { docId: string; baseDocVersion: number | '$current'; terms: unknown; note: string } | null;
  counterTerms?: unknown | null;
  by?: 'user' | 'policy';
}

export interface ResolveResult extends Replayable {
  status: 'open' | 'resolved' | 'committed' | 'regenerated' | 'stopped';
  decisionId: string;
  newPauseIds: string[];
  commit: CommitResult | null;
  epoch: number;
  /** user_requested / error_recovery: the restored continuation, and the actor skipped by `skip_actor`. */
  continuation?: PauseMeta['continuation'];
  skippedActor?: string | null;
}

function payloadOf(input: DecisionInput): DecisionPayload {
  return {
    authorization: input.authorization ?? null,
    goalLimits: input.goalLimits ?? null,
    amend: input.amend ?? null,
    counterTerms: input.counterTerms ?? null,
  };
}

function insertDecision(
  ctx: HarnessContext,
  session: SessionRecord,
  pause: PauseRecord,
  batchId: string,
  input: DecisionInput,
  requestId: string,
): string {
  const { id, seq } = controlId(ctx, session.sessionId, 'd');
  ctx.repo.insertDecision({
    decisionId: id,
    sessionId: session.sessionId,
    pauseId: pause.id,
    batchId,
    category: pause.category,
    proposalIds: pause.proposalIds,
    pair: pause.pair,
    option: input.option,
    advice: input.advice ?? null,
    payload: payloadOf(input),
    by: input.by ?? 'user',
    requestId,
    round: pause.round,
    epoch: session.epoch,
    controlSeq: seq,
  });
  return id;
}

export function addDialogue(
  ctx: HarnessContext,
  sessionId: string,
  row: { speaker: ActorId; listeners: ActorId[]; text: string; kind: DialogueKind; proposalId?: string | null; decisionId?: string | null; payload?: unknown },
): number {
  const session = ctx.repo.getSession(sessionId);
  const state = currentState(ctx, sessionId);
  const seq = ctx.repo.nextDialogueSeq(sessionId);
  ctx.repo.insertDialogue({
    sessionId,
    seq,
    round: state.round,
    epoch: session.epoch,
    worldVersion: state.version,
    speaker: row.speaker,
    listeners: row.listeners,
    text: row.text,
    kind: row.kind,
    proposalId: row.proposalId ?? null,
    decisionId: row.decisionId ?? null,
    payload: row.payload ?? null,
  });
  return seq;
}

const DEFAULT_ADVICE: Partial<Record<DecisionOption, string>> = {
  withhold: 'The player objects to this proposal.',
  counter_draft: 'The player suggests these counter-terms (non-binding).',
  urge_payment: 'Pay the troops before they mutiny.',
  urge_accept: 'The player urges you to accept the terms on the table.',
  urge_stop: 'The player urges you to stop negotiating.',
  adjust_goal: 'The player has adjusted the goal.',
};

function adviceRecipients(ctx: HarnessContext, session: SessionRecord, pause: PauseRecord, option: DecisionOption): ActorId[] {
  if (option === 'urge_payment' || QUALIFYING_DEADLOCK_OPTIONS.includes(option)) {
    return [session.config.factions[BESIEGED_FACTION].principal];
  }
  const actors = pause.batchId
    ? ctx.repo.listProposals(pause.batchId).filter((p) => pause.proposalIds.includes(p.proposalId)).map((p) => p.actor)
    : [];
  return [...new Set(actors.filter((a) => a !== 'system' && a !== 'player'))];
}

function recordAdvice(ctx: HarnessContext, session: SessionRecord, pause: PauseRecord, decisionId: string, input: DecisionInput): void {
  if (!(input.option in DEFAULT_ADVICE)) return;
  const listeners = adviceRecipients(ctx, session, pause, input.option);
  if (listeners.length === 0) return;
  addDialogue(ctx, session.sessionId, {
    speaker: 'player',
    listeners,
    text: input.advice ?? DEFAULT_ADVICE[input.option] ?? '',
    kind: 'advice',
    decisionId,
    payload: input.option === 'counter_draft' ? { counterTerms: input.counterTerms ?? null } : input.option === 'adjust_goal' ? { goalLimits: input.goalLimits ?? null } : null,
  });
}

function isRegenerating(pause: PauseRecord, option: DecisionOption): boolean {
  return option === 'amend' || (pause.category === 'negotiation_deadlock' && QUALIFYING_DEADLOCK_OPTIONS.includes(option));
}

/** Epoch+1, abort the current epoch's in-flight calls. */
export function bumpEpoch(ctx: HarnessContext, session: SessionRecord, reason: string, instructionId: string | null): number {
  const epoch = session.epoch + 1;
  ctx.repo.insertEpoch({
    sessionId: session.sessionId,
    epoch,
    reason,
    instructionId,
    startedAt: ctx.clock(),
    controlSeq: ctx.repo.nextControlSeq(session.sessionId),
  });
  ctx.repo.updateSession(session.sessionId, { epoch });
  // In-flight calls of the superseded epoch are aborted only once the transition has committed.
  onCommitted(ctx, () => {
    ctx.aborts.get(session.sessionId)?.abort(new Error(`epoch ${session.epoch} superseded: ${reason}`));
    ctx.aborts.set(session.sessionId, new AbortController());
  });
  return epoch;
}

/** The atomic regenerating transition (§7). Runs inside the caller's transaction. */
function regenerate(ctx: HarnessContext, session: SessionRecord, pause: PauseRecord, input: DecisionInput, requestId: string): ResolveResult {
  const paused = pause.batchId ? ctx.repo.getBatch(pause.batchId) : null;
  if (!paused) throw new HarnessError('invalid_decision', `${input.option} needs a paused batch`);
  if (input.option === 'amend' && !input.amend) throw new HarnessError('invalid_decision', 'amend needs the revised document');
  const state = currentState(ctx, session.sessionId);
  // 1. the player batch carrying the decision's world effects
  const playerBatch = newBatch(ctx, session, 'player', state, { status: 'assessed', note: `${input.option} for ${pause.id}` });
  const decisionId = insertDecision(ctx, session, pause, playerBatch.batchId, input, requestId);
  ctx.repo.updatePause(pause.id, { status: 'resolved', decisionId });
  if (input.option === 'amend' && input.amend) {
    const resolved = resolvePlaceholders(state, { type: 'revise_document', args: input.amend });
    if (!resolved.ok) throw new HarnessError('invalid_decision', `amend: ${resolved.reason}`);
    const { seq } = controlId(ctx, session.sessionId, 'p');
    ctx.repo.insertProposal({
      proposalId: `${playerBatch.batchId}/p1`,
      sessionId: session.sessionId,
      batchId: playerBatch.batchId,
      round: playerBatch.round,
      epoch: playerBatch.epoch,
      baseVersion: playerBatch.baseVersion,
      actor: 'player',
      source: 'player',
      seq: 1,
      action: resolved.action,
      rationale: `amend decision ${decisionId}`,
      cites: [],
      askPlayer: null,
      status: 'pending',
      rule: null,
      reason: null,
      feedback: null,
      code: null,
      category: null,
      gate: null,
      authorizationId: null,
      decisionId,
      eventVersions: [],
      controlSeq: seq,
    });
  }
  const commit = commitProposalBatch(ctx, session.sessionId, playerBatch.batchId);
  if (!commit.ok) throw new HarnessError('invalid_state', `regenerating batch did not commit: ${commit.reason ?? ''}`);
  const amendOutcome = commit.outcomes[0];
  if (input.option === 'amend' && amendOutcome && amendOutcome.status !== 'committed') {
    throw new HarnessError('invalid_decision', `amend rejected (${amendOutcome.rule ?? ''}): ${amendOutcome.reason ?? ''}`);
  }
  // 2. advice (urges / goal change)
  recordAdvice(ctx, session, pause, decisionId, input);
  stage(ctx, 'regenerate', session.sessionId, paused.batchId);
  // 3. the paused character batch and all its open pauses become obsolete; 4. epoch + 1
  markStale(ctx, paused, 'obsolete', 'obsolete');
  const epoch = bumpEpoch(ctx, session, input.option === 'amend' ? 'amend' : `deadlock:${input.option}`, null);
  const terminal = currentState(ctx, session.sessionId).terminal;
  ctx.repo.updateSession(session.sessionId, terminal ? { status: 'finished', phase: 'finished' } : { status: 'ready', phase: 'generate' });
  return { replayed: false, status: 'regenerated', decisionId, newPauseIds: [], commit, epoch };
}

/** Resolves one pause (inside the caller's transaction). */
export function resolvePauseTx(
  ctx: HarnessContext,
  sessionId: string,
  pauseId: string,
  input: DecisionInput,
  requestId: string,
  opts: { autoCommit?: boolean } = {},
): ResolveResult {
  const session = ctx.repo.getSession(sessionId);
  const pause = ctx.repo.findPause(pauseId);
  if (!pause || pause.sessionId !== sessionId) throw new HarnessError('not_found', `unknown pause ${pauseId}`);
  if (pause.status !== 'open') throw new HarnessError('invalid_state', `${pauseId} is ${pause.status}`);
  if (session.status === 'stopped' || (session.status === 'suspended' && pause.kind !== 'user' && pause.kind !== 'error')) {
    throw new HarnessError('invalid_state', `session ${sessionId} is ${session.status}`);
  }
  if (!pause.options.includes(input.option)) {
    throw new HarnessError('invalid_decision', `${input.option} is not an option of ${pauseId} (${pause.options.join(', ')})`);
  }
  if (input.option === 'delegate' && input.authorization && pause.batchId) {
    const actors = ctx.repo.listProposals(pause.batchId).filter((p) => pause.proposalIds.includes(p.proposalId)).map((p) => p.actor);
    if (!actors.includes(input.authorization.grantee)) {
      throw new HarnessError('invalid_decision', `delegate grantee ${input.authorization.grantee} is not the paused actor`);
    }
  }
  if (input.option === 'adjust_goal' && !input.goalLimits) throw new HarnessError('invalid_decision', 'adjust_goal needs goalLimits');

  if (input.option === 'ask') {
    const decisionId = insertDecision(ctx, session, pause, pause.batchId ?? '', input, requestId);
    addDialogue(ctx, sessionId, {
      speaker: 'player',
      listeners: adviceRecipients(ctx, session, pause, 'withhold'),
      text: input.advice ?? '',
      kind: 'question',
      decisionId,
    });
    return { replayed: false, status: 'open', decisionId, newPauseIds: [], commit: null, epoch: session.epoch };
  }
  if (isRegenerating(pause, input.option)) return regenerate(ctx, session, pause, input, requestId);

  if (pause.category === 'user_requested' || pause.category === 'error_recovery') {
    return resolveControlPause(ctx, session, pause, input, requestId);
  }
  const decisionId = insertDecision(ctx, session, pause, pause.batchId ?? '', input, requestId);
  ctx.repo.updatePause(pause.id, { status: 'resolved', decisionId });
  recordAdvice(ctx, session, pause, decisionId, input);
  if (!pause.batchId) {
    return { replayed: false, status: 'resolved', decisionId, newPauseIds: [], commit: null, epoch: session.epoch };
  }
  const batch = ctx.repo.getBatch(pause.batchId);
  // Recompute the pause plan over the remaining proposals (§7) and open newly required pauses.
  const plan = planForBatch(ctx, session, batch);
  const opened = openRequiredPauses(ctx, session, batch, plan.required.map(specFromRequest));
  const stillOpen = ctx.repo.listPauses(sessionId, { batchId: batch.batchId, status: 'open' });
  if (stillOpen.length > 0) {
    ctx.repo.updateSession(sessionId, { status: 'awaiting_decision', phase: batch.kind === 'system_outcome' ? 'outcome' : 'decide' });
    return { replayed: false, status: 'resolved', decisionId, newPauseIds: opened.map((p) => p.id), commit: null, epoch: session.epoch };
  }
  ctx.repo.updateBatch(batch.batchId, { status: 'assessed' });
  if (opts.autoCommit === false) {
    ctx.repo.updateSession(sessionId, { status: 'committing', phase: 'commit' });
    return { replayed: false, status: 'resolved', decisionId, newPauseIds: [], commit: null, epoch: session.epoch };
  }
  const commit = commitProposalBatch(ctx, sessionId, batch.batchId);
  return { replayed: false, status: 'committed', decisionId, newPauseIds: [], commit, epoch: session.epoch };
}

/**
 * Opens a pause. user_requested / error_recovery pauses save the continuation (status/phase to restore on
 * resume/retry) and, for errors, the failing actor; they never change a batch's status.
 */
export function openPauseTx(ctx: HarnessContext, sessionId: string, spec: PauseSpec & { batchId?: string | null }): PauseRecord {
  const session = ctx.repo.getSession(sessionId);
  const batch = spec.batchId ? ctx.repo.getBatch(spec.batchId) : null;
  const state = currentState(ctx, sessionId);
  const control = spec.category === 'user_requested' || spec.category === 'error_recovery';
  if (spec.category === 'error_recovery' && !spec.actor) {
    throw new HarnessError('invalid_state', 'error_recovery pauses name the failing actor');
  }
  const meta: PauseMeta = control
    ? {
        continuation: {
          status: session.status === 'awaiting_decision' || session.status === 'suspended' ? 'ready' : session.status,
          phase: session.phase,
        },
        actor: spec.actor ?? null,
      }
    : {};
  const pause = insertPause(ctx, session, batch, state, spec, meta);
  if (!control && batch && batch.status !== 'committed') ctx.repo.updateBatch(batch.batchId, { status: 'paused' });
  if (session.status !== 'suspended' && session.status !== 'stopped') ctx.repo.updateSession(sessionId, { status: 'awaiting_decision' });
  return pause;
}

/**
 * user_requested (`resume`) and error_recovery (`retry` / `skip_actor` / `stop`) transitions, atomically:
 * resume/retry restore the saved continuation; skip_actor restores it and records the failing actor's turn as
 * skipped (a `format_error` proposal treated as wait when a generating batch is attached); stop ends the run with
 * run outcome `error`.
 */
function resolveControlPause(
  ctx: HarnessContext,
  session: SessionRecord,
  pause: PauseRecord,
  input: DecisionInput,
  requestId: string,
): ResolveResult {
  const decisionId = insertDecision(ctx, session, pause, pause.batchId ?? '', input, requestId);
  ctx.repo.updatePause(pause.id, { status: 'resolved', decisionId });
  const continuation = pause.meta?.continuation ?? { status: 'ready' as const, phase: session.phase };
  const base = { replayed: false, decisionId, newPauseIds: [], commit: null, epoch: session.epoch };
  if (input.option === 'stop') {
    ctx.repo.updateSession(session.sessionId, { status: 'stopped', runOutcome: 'error' });
    return { ...base, status: 'stopped', continuation: null, skippedActor: null };
  }
  let skippedActor: string | null = null;
  if (input.option === 'skip_actor') {
    skippedActor = pause.meta?.actor ?? null;
    if (!skippedActor) throw new HarnessError('invalid_decision', `${pause.id} names no actor to skip`);
    const batch = pause.batchId ? ctx.repo.findBatch(pause.batchId) : null;
    if (batch && batch.status === 'generating' && batch.epoch === session.epoch) {
      const { seq } = controlId(ctx, session.sessionId, 'p');
      const existing = ctx.repo.listProposals(batch.batchId);
      ctx.repo.insertProposal({
        proposalId: `${batch.batchId}/p${existing.length + 1}`,
        sessionId: session.sessionId,
        batchId: batch.batchId,
        round: batch.round,
        epoch: batch.epoch,
        baseVersion: batch.baseVersion,
        actor: skippedActor as ActorId,
        // Control-derived provenance: the turn was skipped by this decision, not produced by a model.
        source: 'system',
        seq: existing.filter((p) => p.actor === skippedActor).length + 1,
        action: null,
        rationale: `skipped after error_recovery (${decisionId})`,
        cites: [],
        askPlayer: null,
        status: 'format_error',
        rule: null,
        reason: 'actor skipped by the player after an error',
        feedback: null,
        code: 'skipped',
        category: null,
        gate: null,
        authorizationId: null,
        decisionId,
        eventVersions: [],
        controlSeq: seq,
      });
    }
  }
  const stillOpen = ctx.repo.listPauses(session.sessionId, { status: 'open' });
  if (session.status !== 'suspended') {
    ctx.repo.updateSession(session.sessionId, {
      status: stillOpen.length > 0 ? 'awaiting_decision' : continuation.status,
      phase: continuation.phase,
    });
  }
  return { ...base, status: 'resolved', continuation, skippedActor };
}
