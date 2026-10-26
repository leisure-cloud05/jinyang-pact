/**
 * State, draft, catalog and pause views. The player view is built from `playerView` (core) plus data the clerk
 * witnesses at headquarters; the director view adds the full world state.
 */
import { playerView, canAccessDocument } from '../../core/knowledge.js';
import { compareIds, own } from '../../core/ids.js';
import { documentPair } from '../../core/negotiation.js';
import { siegeNumbers } from '../../core/siege.js';
import { TERM_SEMANTICS, limitBurden, payerFor, withinLimits } from '../../core/terms.js';
import { TermLimitsSchema } from '../../content/schema.js';
import { CESSION_VALUES, CHAR_IDS, SCALAR_TERM_KEYS, type CharId, type Document, type PairId, type TermSet } from '../../core/types.js';
import type { DecisionContext } from '../../engine/index.js';
import type { PauseRecord } from '../../store/repo.js';
import type {
  AskThreadEntry,
  CatalogView,
  CharacterView,
  DraftView,
  PauseView,
  PolicySuggestion,
  ProposalBrief,
  StateView,
  TermLimitsView,
  ViewMode,
  WorldView,
} from '../api-types.js';
import type { SessionCtx } from '../context.js';
import { sanitizeForPlayer } from '../guard.js';
import { Projection } from '../projection.js';
import { actionType, describeAction, nameOf, placeOf, playerSeesActor, termsFor } from './common.js';
import { negotiationTrack } from './negotiation-track.js';
import { siegeWatch } from './siege-watch.js';

export const LIMIT_KEYS = Object.keys(TermLimitsSchema.shape);

export const DELEGABLE_CATEGORIES = [
  'dispatch_request',
  'major_commitment',
  'strategic_turn',
  'internal_disagreement',
  'goal_conflict',
  'risky_delay',
  'ambiguity',
  'prompt_request',
];

function limitsView(limits: unknown): TermLimitsView {
  const out: TermLimitsView = {};
  const l = (limits ?? {}) as Record<string, unknown>;
  for (const k of LIMIT_KEYS) {
    const v = l[k];
    out[k] = typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string' ? v : null;
  }
  return out;
}

export function catalogView(ctx: SessionCtx, pair: PairId): CatalogView {
  const catalog = ctx.config.catalog;
  return {
    pair,
    burdenPayer: payerFor('vassal', pair),
    terms: SCALAR_TERM_KEYS.map((key) => {
      const e = catalog.terms[key];
      const type = TERM_SEMANTICS[key].type;
      return {
        key,
        label: { ...e.label },
        type,
        min: e.min,
        max: e.max,
        step: e.step,
        values: type === 'enum' ? CESSION_VALUES.map((v) => ({ value: v, label: { ...ctx.names.cession[v] } })) : [],
        applicable: e.applicable_pairs.includes(pair),
        burdenWeight: e.burden_weight,
        burdenUnit: e.burden_unit,
        burdenByValue: e.burden_by_value ? { ...e.burden_by_value } : null,
        payer: TERM_SEMANTICS[key].trigger === 'parameter' ? null : payerFor(key, pair),
      };
    }),
    limitKeys: [...LIMIT_KEYS],
    delegableCategories: [...DELEGABLE_CATEGORIES],
  };
}

function playerDocument(ctx: SessionCtx): Document | null {
  const docs = Object.keys(ctx.state.documents)
    .sort(compareIds)
    .map((id) => own(ctx.state.documents, id) as Document)
    .filter((d) => canAccessDocument(ctx.state, 'player', d));
  return docs.find((d) => d.status === 'draft' || d.status === 'approved') ?? docs.at(-1) ?? null;
}

export function draftView(ctx: SessionCtx, doc: Document, viewer: ViewMode): DraftView {
  const { state, config, names } = ctx;
  const pair = documentPair(state, config, doc) ?? 'hedong-khitan';
  const terms = termsFor(doc.terms, state, config, viewer === 'director' ? 'director' : 'player') as NonNullable<ReturnType<typeof termsFor>>;
  const visibleSet: TermSet = { ...doc.terms, secret_clauses: doc.terms.secret_clauses.filter((c) => terms.secret_clauses.some((v) => v.id === c.id)) };
  const within = withinLimits(visibleSet, state.player.goal.limits, config.catalog, pair);
  const approvedCurrent = (doc.status === 'approved' || doc.status === 'sent') && doc.approval !== null && doc.approval.version === doc.version;
  let transmit: DraftView['transmit'] = { ok: true, reason: null };
  if (doc.status === 'sent') transmit = { ok: false, reason: 'already sent' };
  else if (doc.status === 'withdrawn') transmit = { ok: false, reason: 'withdrawn' };
  else if (!approvedCurrent) transmit = { ok: false, reason: 'the current version is not approved by Shi Jingtang' };
  else if (doc.timing.mode === 'hold') transmit = { ok: false, reason: 'timing is set to hold' };
  else if (doc.timing.notBeforeRound !== null && state.round < doc.timing.notBeforeRound) transmit = { ok: false, reason: `delayed until round ${doc.timing.notBeforeRound}` };
  const suggestions = Object.values(state.suggestions)
    .filter((s) => s.target.kind === 'document' && s.target.id === doc.id)
    .sort((a, b) => compareIds(a.id, b.id))
    .map((s) => ({
      id: s.id,
      by: s.by,
      byName: nameOf(names, s.by),
      targetVersion: s.targetVersion,
      terms: (viewer === 'director' ? s.terms : sanitizeForPlayer(s.terms, state, config)) as unknown as Record<string, unknown>,
      reason: s.reason,
      round: s.round,
      day: s.day,
    }));
  return {
    docId: doc.id,
    version: doc.version,
    status: doc.status,
    to: doc.to,
    toName: nameOf(names, doc.to),
    holder: doc.holder,
    note: doc.note,
    timing: { mode: doc.timing.mode, notBeforeRound: doc.timing.notBeforeRound },
    approval: doc.approval ? { version: doc.approval.version, by: doc.approval.by } : null,
    approvedCurrent,
    terms,
    pair,
    burden: limitBurden(visibleSet, config.catalog, pair),
    withinGoal: within,
    history: doc.history.map((h) => ({ version: h.version, by: h.by, byName: nameOf(names, h.by), round: h.round })),
    transmit,
    suggestions,
  };
}

function characters(ctx: SessionCtx): CharacterView[] {
  const { state, names } = ctx;
  return CHAR_IDS.map((id) => {
    const c = state.characters[id];
    return {
      id,
      name: { ...names.characters[id].name },
      title: { ...names.characters[id].title },
      status: c.status,
      faction: c.faction,
      location: c.location,
      locationName: placeOf(names, c.location),
      present: c.location === ctx.playerLoc && c.status === 'alive',
    };
  });
}

function worldView(ctx: SessionCtx, viewer: ViewMode): WorldView {
  const { state, config, names } = ctx;
  const pv = playerView(state, config);
  return {
    version: viewer === 'director' ? state.version : null,
    round: state.round,
    day: state.day,
    location: pv.location,
    locationName: placeOf(names, pv.location),
    siege: { ...pv.siege },
    resources: { ...pv.resources.resources },
    reserved: { ...pv.resources.reserved },
    goal: { text: { ...pv.goal.text }, limits: limitsView(pv.goal.limits) },
    authorizations: Object.values(pv.authorizations)
      .sort((a, b) => compareIds(a.id, b.id))
      .map((a) => ({
        id: a.id,
        grantee: a.grantee,
        granteeName: nameOf(names, a.grantee),
        categories: [...a.categories],
        limits: limitsView(a.limits),
        grantedRound: a.grantedRound,
        expiresRound: a.expiresRound,
        revoked: a.revoked,
      })),
    assistanceAbandoned: pv.assistanceAbandoned,
    terminal: pv.terminal ? { kind: pv.terminal.kind, round: pv.terminal.round, day: pv.terminal.day, detail: { ...pv.terminal.detail } } : null,
    negotiation: {
      segment: pv.negotiation.segment,
      roundsUsed: pv.negotiation.roundsUsed,
      offers: pv.negotiation.offers.map((o) => ({ ...o, fromName: nameOf(names, o.from), toName: nameOf(names, o.to) })),
    },
    beliefs: pv.beliefs.map((b) => ({
      id: b.id,
      subject: b.subject,
      predicate: b.predicate,
      value: sanitizeForPlayer(b.value, state, config),
      asOfDay: b.asOfDay,
      evidence: { kind: b.evidence.kind, ref: b.evidence.ref },
      credibility: b.credibility,
    })),
  };
}

/** A proposal as of the moment it would commit (projected state), with terms the viewer can know. */
export function proposalBrief(
  ctx: SessionCtx,
  p: { proposalId: string; batchId: string; actor: string; action: unknown; status: string },
  viewer: ViewMode,
  projection: Projection,
): ProposalBrief {
  const before = projection.stateBefore(p.batchId, p.proposalId);
  const action = viewer === 'director' ? p.action : sanitizeForPlayer(p.action, before, ctx.config);
  const { terms, unknown } = projection.termsOf(before, p.actor, p.action, viewer);
  const summary = describeAction(action, ctx.names, terms);
  return {
    proposalId: p.proposalId,
    actor: p.actor,
    actorName: nameOf(ctx.names, p.actor),
    type: actionType(p.action),
    summary: unknown ? { zh: `${summary.zh}（条款你无从得知）`, en: `${summary.en} (terms unknown to you)` } : summary,
    terms,
    termsUnknown: unknown,
    status: p.status,
  };
}

export function pauseView(
  ctx: SessionCtx,
  pause: PauseRecord,
  viewer: ViewMode,
  pending: { pauseId: string; ctx: DecisionContext } | null,
  suggestion: PolicySuggestion | null,
  projection: Projection = new Projection(ctx),
): PauseView {
  const all = pause.batchId ? ctx.harness.repo.listProposals(pause.batchId).filter((p) => pause.proposalIds.includes(p.proposalId)) : [];
  const decision = pause.decisionId ? ctx.harness.repo.listSessionDecisions(ctx.sessionId).find((d) => d.decisionId === pause.decisionId) : undefined;
  const isPending = pending !== null && pending.pauseId === pause.id;
  const asks = ctx.harness.repo.listSessionDecisions(ctx.sessionId).filter((d) => d.pauseId === pause.id && d.option === 'ask');
  const asked = asks.length;
  const briefs = all
    .filter((p) => viewer === 'director' || playerSeesActor(p.actor, ctx.state, ctx.config, ctx.playerLoc))
    .map((p) => proposalBrief(ctx, p, viewer, projection));
  return {
    id: pause.id,
    round: pause.round,
    epoch: pause.epoch,
    kind: pause.kind,
    category: pause.category,
    status: pause.status,
    question: { ...pause.question },
    // Rendered by the harness from the projected state of each paused proposal, player knowledge only.
    visibleFacts: pause.visibleFacts.map((f) => ({ ...f })),
    options: [...pause.options],
    proposals: briefs,
    decision: decision ? { option: decision.option, advice: decision.advice, by: decision.by } : null,
    withinLimits: isPending && pending.ctx.withinLimits !== undefined ? pending.ctx.withinLimits : null,
    suggestion: isPending ? suggestion : null,
    asked,
    askable: isPending ? pending.ctx.askable.map((id) => ({ id, name: charName(ctx, id) })) : [],
    thread: askThread(ctx, asks),
    pending: isPending,
  };
}

function charName(ctx: SessionCtx, id: string): { zh: string; en: string } {
  const c = Object.hasOwn(ctx.config.characters, id) ? ctx.config.characters[id as CharId] : undefined;
  return c?.name ? { ...c.name } : { zh: id, en: id };
}

/**
 * The pause's questions with the answers, from dialogue the player heard: the player asked every question and is a
 * listener of every answer (PLAN §7), so nothing here is offstage.
 */
function askThread(ctx: SessionCtx, asks: readonly { decisionId: string; advice: string | null }[]): AskThreadEntry[] {
  if (asks.length === 0) return [];
  const answers = new Map<string, { speaker: string; text: string; outcome: string | null }>();
  for (const d of ctx.harness.repo.listDialogue(ctx.sessionId)) {
    if (d.kind !== 'answer' || !d.listeners.includes('player')) continue;
    const p = (d.payload ?? null) as { decisionId?: string; outcome?: string } | null;
    if (p?.decisionId) answers.set(p.decisionId, { speaker: d.speaker, text: d.text, outcome: p.outcome ?? null });
  }
  return asks.map((a) => {
    const ans = answers.get(a.decisionId);
    return {
      question: a.advice ?? '',
      answeredBy: ans ? charName(ctx, ans.speaker) : null,
      answer: ans?.text ?? null,
      outcome: ans?.outcome ?? null,
    };
  });
}
export function stateView(
  ctx: SessionCtx,
  viewer: ViewMode,
  base: Pick<StateView, 'session' | 'control'>,
  pending: { pauseId: string; ctx: DecisionContext } | null,
  suggestion: PolicySuggestion | null,
): StateView {
  const doc = playerDocument(ctx);
  const pair = doc ? (documentPair(ctx.state, ctx.config, doc) ?? 'hedong-khitan') : 'hedong-khitan';
  const pause = pending ? ctx.harness.repo.findPause(pending.pauseId) : null;
  const world = worldView(ctx, viewer);
  const view: StateView = {
    view: viewer,
    session: base.session,
    control: base.control,
    world,
    // Hedong's own grain and the siege are what the clerk sees at headquarters (the same numbers as `world`).
    siegeWatch: siegeWatch(siegeNumbers(ctx.state), ctx.config.params, { maxRounds: ctx.caseConfig.max_rounds, ended: base.session.ended }),
    // In both views: what the clerk knows of the negotiation (the director sees the rest in the inspector).
    negotiationTrack: negotiationTrack(ctx, world.negotiation.offers),
    characters: characters(ctx),
    player: {
      name: { ...ctx.names.player.name },
      title: { ...ctx.names.player.title },
      permissions: [...ctx.config.player.permissions],
    },
    document: doc ? draftView(ctx, doc, viewer) : null,
    catalog: catalogView(ctx, pair),
    pendingPause: pause ? pauseView(ctx, pause, viewer, pending, suggestion) : null,
  };
  if (viewer === 'director') view.full = ctx.state;
  return view;
}
