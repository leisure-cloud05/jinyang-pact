/**
 * Inspector views (PLAN §11): committed events with the rules applied, the state changes (each operation with the
 * value it replaced) and the originating proposal; every proposal with its status, rule id and reason; state diffs
 * between versions; dialogue.
 *
 * Player view: events the clerk witnesses (its own, or with a fact it sees), with changes restricted to what the
 * clerk can know (its faction's resources, the siege, accessible documents, its own knowledge and goal); proposals
 * of the clerk and of player-side characters at headquarters (actor-facing feedback instead of the full reason, no
 * private rationale); the diff of `playerView` between versions. Director view: everything.
 */
import { renderFactLine } from '../../agents/narration/index.js';
import type { Lang } from '../../agents/types.js';
import { displayText } from '../../display-language.js';
import { canAccessDocument, playerView } from '../../core/knowledge.js';
import { own } from '../../core/ids.js';
import type { WorldState } from '../../core/types.js';
import type { ChangeView, DialogueView, DiffView, EventView, EventsView, ProposalView, ProposalsView, ViewMode } from '../api-types.js';
import type { SessionCtx } from '../context.js';
import { sanitizeForPlayer } from '../guard.js';
import { jsonDiff, stateAt, walkEvents } from '../history.js';
import { ApiError } from '../errors.js';
import { Projection } from '../projection.js';
import { RULE_TITLES, actionType, describeAction, nameOf, playerSeesActor, playerSeesFact } from './common.js';

/** Whether the player may see a patch operation at `segments` (evaluated on the states around the event). */
function playerSeesPath(ctx: SessionCtx, segments: readonly string[], before: WorldState, after: WorldState): boolean {
  const [head, key] = segments;
  switch (head) {
    case 'round':
    case 'day':
    case 'siege':
    case 'player':
    case 'terminal':
      return true;
    case 'factions':
      return key === ctx.config.player.faction;
    case 'flags':
      return key === 'assistanceAbandoned' || key === 'mutinyOccurred';
    case 'documents': {
      const doc = own(after.documents, key ?? '') ?? own(before.documents, key ?? '');
      return doc !== undefined && canAccessDocument(after, 'player', doc);
    }
    case 'knowledge': {
      const item = own(after.knowledge, key ?? '') ?? own(before.knowledge, key ?? '');
      return item !== undefined && item.holder === 'player';
    }
    case 'suggestions': {
      const s = own(after.suggestions, key ?? '') ?? own(before.suggestions, key ?? '');
      if (!s || s.target.kind !== 'document') return false;
      const doc = own(after.documents, s.target.id);
      return doc !== undefined && canAccessDocument(after, 'player', doc);
    }
    default:
      return false;
  }
}

export function eventsView(ctx: SessionCtx, viewer: ViewMode, lang: Lang): EventsView {
  const proposals = new Map<string, { actor: string; action: unknown }>();
  for (const p of ctx.harness.repo.listSessionProposals(ctx.sessionId)) proposals.set(p.proposalId, { actor: p.actor, action: p.action });
  const out: EventView[] = [];
  for (const w of walkEvents(ctx.harness, ctx.sessionId)) {
    const e = w.event;
    const facts = viewer === 'director' ? e.facts : e.facts.filter((f) => playerSeesFact(f, ctx.playerLoc));
    if (viewer === 'player' && e.actor !== 'player' && facts.length === 0) continue;
    let hidden = 0;
    const changes: ChangeView[] = [];
    for (const c of w.changes) {
      if (viewer === 'player' && !playerSeesPath(ctx, c.segments, w.before, w.after)) {
        hidden += 1;
        continue;
      }
      const view = { op: c.op, path: c.path, before: c.before, after: c.after };
      changes.push(viewer === 'player' ? sanitizeForPlayer(view, w.after, ctx.config) : view);
    }
    const origin = e.proposalId ? proposals.get(e.proposalId) : undefined;
    const originVisible = origin !== undefined && (viewer === 'director' || playerSeesActor(origin.actor, w.before, ctx.config, ctx.playerLoc));
    out.push({
      index: out.length,
      version: viewer === 'director' ? e.version : null,
      round: e.round,
      day: e.day,
      kind: e.kind,
      actor: e.actor,
      actorName: nameOf(ctx.names, e.actor),
      batchId: e.batchId,
      inherited: e.inherited,
      rulesApplied: [...e.rulesApplied],
      lines: facts.map((f) => displayText(renderFactLine(f, ctx.names, lang), lang)),
      proposal: originVisible && e.proposalId ? { proposalId: e.proposalId, actor: origin.actor, type: actionType(origin.action) } : null,
      decisionId: e.decisionId,
      changes,
      // Player view: only whether something was hidden, never how much (a count would measure offstage activity).
      hiddenChanges: viewer === 'player' ? (hidden > 0 ? 1 : 0) : hidden,
    });
  }
  return { view: viewer, events: out };
}

export function proposalsView(ctx: SessionCtx, viewer: ViewMode): ProposalsView {
  const out: ProposalView[] = [];
  const projection = new Projection(ctx);
  for (const p of ctx.harness.repo.listSessionProposals(ctx.sessionId)) {
    if (viewer === 'player' && !playerSeesActor(p.actor, ctx.state, ctx.config, ctx.playerLoc)) continue;
    // Terms are resolved on the world as it was just before this proposal (projected), and — for the player —
    // only through the player's own assertions and accessible documents (rejected proposals included).
    const before = projection.stateBefore(p.batchId, p.proposalId);
    let action = p.action;
    if (viewer === 'player') {
      action = sanitizeForPlayer(action, before, ctx.config);
      const a = action as { type?: string; args?: { to?: unknown } } | null;
      // Speech the clerk did not hear stays private.
      if (a?.type === 'speak' && Array.isArray(a.args?.to) && !a.args.to.includes('player') && p.actor !== 'player') {
        action = { type: 'speak', args: { to: a.args.to, text: '…' } };
      }
    }
    const { terms, unknown } = projection.termsOf(before, p.actor, p.action, viewer);
    const summary = describeAction(action, ctx.names, terms);
    const ownOrSystem = p.actor === 'player' || p.actor === 'system';
    out.push({
      proposalId: p.proposalId,
      batchId: p.batchId,
      round: p.round,
      epoch: p.epoch,
      actor: p.actor,
      actorName: nameOf(ctx.names, p.actor),
      source: p.source,
      seq: p.seq,
      type: actionType(p.action),
      summary: unknown ? { zh: `${summary.zh}（条款你无从得知）`, en: `${summary.en} (terms unknown to you)` } : summary,
      termsUnknown: unknown,
      args: (action as { args?: unknown } | null)?.args ?? null,
      status: p.status,
      rule: p.rule,
      ruleTitle: p.rule ? (RULE_TITLES[p.rule] ?? null) : null,
      reason: viewer === 'director' ? p.reason : p.status === 'rejected' || p.status === 'unapplied' ? (p.feedback ?? (ownOrSystem ? p.reason : null)) : p.status === 'withheld' ? 'withheld by your decision' : p.status === 'stale_epoch' ? 'stale: superseded by an interrupt or a newer version (H05)' : p.status === 'obsolete' ? 'obsolete: the round was regenerated' : null,
      category: p.category,
      gate: p.gate,
      eventVersions: viewer === 'director' ? [...p.eventVersions] : [],
      rationale: viewer === 'director' || p.actor === 'player' ? p.rationale : null,
      probe: p.probe === true,
    });
  }
  return { view: viewer, proposals: out };
}

/**
 * State diff. Director view: between two world versions. Player view: between two round starts (`to` null = now)
 * of what the clerk knows (`playerView`) — world versions are not exposed to the player.
 */
export function diffView(ctx: SessionCtx, viewer: ViewMode, from: number, to: number | null): DiffView {
  if (viewer === 'director') {
    const a = stateAt(ctx.harness, ctx.sessionId, from);
    const b = stateAt(ctx.harness, ctx.sessionId, to ?? ctx.state.version);
    return { view: viewer, unit: 'version', from, to: to ?? ctx.state.version, entries: jsonDiff(a, b) };
  }
  const startOf = (round: number): WorldState => {
    const s = roundStartVersion(ctx, round);
    if (s === null) throw new ApiError(400, 'unknown_round', `round ${round} has no recorded start in this session or its ancestors`);
    return stateAt(ctx.harness, ctx.sessionId, s);
  };
  const a = startOf(from);
  const b = to === null ? ctx.state : startOf(to);
  const entries = jsonDiff(sanitizeForPlayer(playerView(a, ctx.config), b, ctx.config), sanitizeForPlayer(playerView(b, ctx.config), b, ctx.config));
  return { view: viewer, unit: 'round', from, to, entries };
}

/** World version at the start of `round` (this session, else its ancestors before the branch). */
export function roundStartVersion(ctx: SessionCtx, round: number): number | null {
  let id: string | null = ctx.sessionId;
  for (let i = 0; id && i < 50; i++) {
    const start = ctx.harness.repo.findRoundStart(id, round);
    if (start) return start.version;
    id = ctx.harness.repo.findSession(id)?.parentSessionId ?? null;
  }
  return null;
}
export function dialogueView(ctx: SessionCtx, viewer: ViewMode): DialogueView {
  const rows = ctx.harness.repo
    .listDialogue(ctx.sessionId)
    .filter((r) => viewer === 'director' || r.speaker === 'player' || r.listeners.includes('player'))
    .map((r, i) => ({
      // Dialogue seq counts rows the player did not hear: players get an ordinal.
      seq: viewer === 'director' ? r.seq : i + 1,
      round: r.round,
      speaker: r.speaker,
      speakerName: nameOf(ctx.names, r.speaker),
      listeners: [...r.listeners],
      listenerNames: r.listeners.map((l) => nameOf(ctx.names, l)),
      kind: r.kind,
      text: r.text,
      inherited: r.inherited === true,
      payload: viewer === 'director' ? (r.payload ?? null) : sanitizeForPlayer(r.payload ?? null, ctx.state, ctx.config),
    }));
  return { view: viewer, rows };
}
