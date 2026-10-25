/**
 * Analysis of reference-trace replays for the real-content tests (WP-B2): versioned world states by patch replay,
 * the §10.3 scene scheduler (all tiers, with the conventions of content/README.md §5), independent derivation of
 * §13.1 checkpoint instances, and first-match decision policies. Pure; no network, no LLM.
 */
import { caseInitialState, effectiveCharacter, toTraceSpec } from '../../src/content/loader.js';
import type { CaseConfig, TraceConfig } from '../../src/content/schema.js';
import { parseAction, type Action } from '../../src/core/actions.js';
import { executeBatch, orderProposals, type BatchProposal } from '../../src/core/execute.js';
import { believedThreadStatus, hasReceiptEvidence, isPlayerSide } from '../../src/core/knowledge.js';
import { mandatoryCategory, proposalTerms } from '../../src/core/pauses.js';
import { H13_SEGMENT_EXHAUSTED, checkAction } from '../../src/core/rules.js';
import { replayEvents } from '../../src/core/reducer.js';
import { simulateTrace, type SimulationResult, type TraceSpec } from '../../src/core/simulate.js';
import { withinLimits } from '../../src/core/terms.js';
import { CHAR_IDS, type CharId, type CoreConfig, type Mode, type PauseCategory, type WorldState } from '../../src/core/types.js';
import { caseConfig, configOf, content } from './helpers.js';

export const MAX_ACTIVE = 4;
const PREPARE_KINDS = new Set(['message_delivered', 'withdrawal_effective', 'withdrawal_late']);
const OUTCOME_KINDS = new Set(['mutiny_outbreak', 'mutiny_averted_for_now']);
const REGENERATION_KINDS = new Set(['deadlock_resolved', 'goal_adjusted']);

export interface Replay {
  id: string;
  spec: TraceSpec;
  config: CaseConfig;
  cfg: CoreConfig;
  initial: WorldState;
  run: SimulationResult;
  stateAt: (version: number) => WorldState;
}

const cache = new Map<string, Replay>();

/** Replays a case's reference trace (or a variant `spec`) through the pure core with the case's rules config. */
export function replay(id: string, spec?: TraceSpec, mode: Mode = 'full'): Replay {
  const key = `${id}:${mode}`;
  const cached = spec ? undefined : cache.get(key);
  if (cached) return cached;
  const s = spec ?? toTraceSpec(content().traces[id] as TraceConfig);
  const cfg = caseConfig(id);
  const initial = caseInitialState(content(), id);
  const run = simulateTrace(initial, cfg, s, mode);
  const states = replayEvents(initial, run.events);
  const stateAt = (version: number): WorldState => {
    if (version === 0) return initial;
    const state = states[version - 1];
    if (!state || state.version !== version) throw new Error(`no state at version ${version}`);
    return state;
  };
  const r: Replay = { id, spec: s, config: configOf(id), cfg, initial, run, stateAt };
  if (!spec) cache.set(key, r);
  return r;
}

// ---------------------------------------------------------------------------------------------------------------
// Versions of phase boundaries
// ---------------------------------------------------------------------------------------------------------------

/** World version after PREPARE of `round` (before the player batch). */
export function prepareVersion(r: Replay, round: number): number {
  let version = 0;
  for (const e of r.run.events) {
    // A terminal committed at PREPARE, ADVANCE or after a staged outcome precedes the round's PLAYER step.
    const systemTerminal = e.kind === 'terminal' && e.facts.some((f) => f.data.phase !== undefined && f.data.phase !== 'action');
    if (e.round < round || (e.round === round && (PREPARE_KINDS.has(e.kind) || OUTCOME_KINDS.has(e.kind) || systemTerminal))) {
      version = Math.max(version, e.version);
    }
  }
  return version;
}

/** World version at SELECT of `round`: after PREPARE and the round's first player batch. */
export function selectVersion(r: Replay, round: number): number {
  // The round's own player inputs (trace data, not control logs): each committed non-dialogue action is one event
  // directly after PREPARE.
  const spec = r.spec.rounds.find((x) => x.round === round);
  const committed = (spec?.player ?? []).filter((p) => {
    const type = (p.action as { type?: string }).type;
    return type !== 'speak' && type !== 'wait' && (p.expect?.status ?? 'committed') === 'committed';
  }).length;
  const version = prepareVersion(r, round) + committed;
  return Math.min(version, r.run.events.length);
}

/** Base version of generation `g` of `round`'s character batch (after any regenerating player batch). */
export function generationVersion(r: Replay, round: number, generation: number): number {
  const selected = selectVersion(r, round);
  if (generation === 0) return selected;
  let version = selected;
  for (const e of r.run.events) {
    if (e.round !== round || e.version <= selected) continue;
    if (REGENERATION_KINDS.has(e.kind) || (e.actor === 'player' && e.kind === 'revise_document')) version = Math.max(version, e.version);
  }
  return version;
}

/** Proposals of generation `g` of a round, with the ids and seqs simulateTrace gives them. */
export function generationProposals(r: Replay, round: number, generation: number): BatchProposal[] {
  const spec = r.spec.rounds.find((x) => x.round === round);
  const gen = generation === 0 ? spec : spec?.regenerations[generation - 1];
  return (gen?.proposals ?? []).map((p, i, all) => ({
    proposalId: `r${round}-g${generation}-${i + 1}`,
    actor: p.actor,
    seq: all.slice(0, i).filter((q) => q.actor === p.actor).length + 1,
    action: p.action,
    askPlayer: p.ask_player ?? null,
  }));
}

/** World state just before `target` is validated inside its batch (dry run of the proposals committed before it). */
export function stateBefore(r: Replay, round: number, generation: number, target: BatchProposal): WorldState {
  const base = r.stateAt(generationVersion(r, round, generation));
  const ordered = orderProposals(generationProposals(r, round, generation), r.cfg);
  const before = ordered.slice(0, ordered.findIndex((p) => p.proposalId === target.proposalId));
  return executeBatch(base, { kind: 'character', proposals: before, decisions: [] }, { config: r.cfg, mode: 'full', dryRun: true }).state;
}

// ---------------------------------------------------------------------------------------------------------------
// Scheduler (§10.3) — all tiers
// ---------------------------------------------------------------------------------------------------------------

export interface Scheduled {
  selected: CharId[];
  tiers: { t1: CharId[]; t1b: CharId[]; t2: CharId[]; t3: CharId[]; t4: CharId[] };
}

function roundOfDay(day: number, roundDays: number): number {
  return Math.ceil(day / roundDays) + 1;
}

function deliveryRound(m: WorldState['messages'][string], roundDays: number): number {
  return m.arrivalDay === m.sentDay ? roundOfDay(m.sentDay, roundDays) + 1 : roundOfDay(m.arrivalDay, roundDays);
}

function isChar(id: string): id is CharId {
  return (CHAR_IDS as readonly string[]).includes(id);
}

/**
 * The scene scheduler for every traced round. Tiers 1/1b/2 follow §10.3 exactly; tier 3 (agendas at the player's
 * scene) and tier 4 (periodic) follow the conventions of content/README.md §5. Tiers fill in order up to 4
 * (tier 1 always included); recipients skipped by the cap carry forward.
 */
export function schedule(r: Replay): Map<number, Scheduled> {
  const days = r.cfg.params.round_days;
  const activatedRounds = new Map<CharId, number[]>();
  const out = new Map<number, Scheduled>();
  const lastRound = r.run.terminal?.round ?? r.spec.max_rounds;
  for (let round = 1; round <= Math.min(lastRound, r.spec.max_rounds); round++) {
    const spec = r.spec.rounds.find((x) => x.round === round);
    const v = selectVersion(r, round);
    const s = r.stateAt(v);
    if (s.terminal) break;
    const last = (c: CharId) => {
      const rounds = activatedRounds.get(c) ?? [];
      return rounds.length > 0 ? (rounds[rounds.length - 1] as number) : 0;
    };

    // Tier 1: holders of a delivered live offer awaiting their answer.
    const t1set = new Set<CharId>();
    for (const thread of Object.values(s.commitments)) {
      if (thread.status !== 'negotiating') continue;
      const offer = s.offers[thread.liveOfferId];
      if (offer && offer.status === 'delivered' && hasReceiptEvidence(s, offer.to, offer.id, offer.termsVersion)) t1set.add(offer.to);
    }
    const t1 = CHAR_IDS.filter((c) => t1set.has(c));

    // Tier 1b: other delivery recipients not yet activated since the delivery (carry-forward).
    const pending = new Map<CharId, number>();
    for (const m of Object.values(s.messages)) {
      if (m.status !== 'delivered' || m.kind === 'offer' || !isChar(m.to)) continue;
      const from = deliveryRound(m, days);
      if (from > round || last(m.to) >= from) continue;
      pending.set(m.to, Math.min(pending.get(m.to) ?? Infinity, from));
    }
    const t1b = [...pending.entries()].sort((a, b) => a[1] - b[1] || CHAR_IDS.indexOf(a[0]) - CHAR_IDS.indexOf(b[0])).map(([c]) => c);

    // Tier 2: characters the player addresses this round.
    const addressed = new Set<CharId>();
    for (const p of spec?.player ?? []) {
      const a = p.action as { type?: string; args?: { to?: string[] } };
      if (a.type === 'speak') for (const to of a.args?.to ?? []) if (isChar(to)) addressed.add(to);
    }
    const t2 = CHAR_IDS.filter((c) => addressed.has(c));

    // Tier 3: agenda owners at the player's scene whose trigger fires.
    const t3 = CHAR_IDS.filter((c) => {
      if (s.characters[c].status !== 'alive' || s.characters[c].location !== s.player.location) return false;
      const since = last(c);
      const sinceVersion = since > 0 ? selectVersion(r, since) : 0;
      const eventSince = (kind: string) => r.run.events.some((e) => e.kind === kind && e.version > sinceVersion && e.version <= v);
      const deliveredSince = (kind: string) =>
        Object.values(s.messages).some((m) => m.status === 'delivered' && m.to === c && m.kind === kind && deliveryRound(m, days) > since && deliveryRound(m, days) <= round);
      return effectiveCharacter(content(), r.config, c).agendaTriggers.some((t) => {
        switch (t.on) {
          case 'round_start': return true;
          case 'document_revised': return eventSince('revise_document');
          case 'document_approved': return eventSince('approve_document');
          case 'suggestion_made': return eventSince('suggest_revision');
          case 'offer_delivered': return deliveredSince('offer');
          case 'response_delivered': return deliveredSince('response');
          case 'letter_delivered': return deliveredSince('letter');
          case 'intel_delivered': return deliveredSince('intel');
          case 'grain_below': return s.factions.hedong.resources.grain < (t.threshold ?? -Infinity);
          case 'morale_below': return s.siege.morale < (t.threshold ?? -Infinity);
          case 'pressure_above': return s.siege.pressure > (t.threshold ?? Infinity);
        }
      });
    });

    // Tier 4: periodic activation, active in rounds r with (r − 1 − offset) mod every_rounds = 0.
    const t4 = CHAR_IDS.filter((c) => {
      const p = effectiveCharacter(content(), r.config, c).periodicActivation;
      return p !== null && s.characters[c].status === 'alive' && (round - 1 - p.offset) % p.every_rounds === 0;
    });

    const selected: CharId[] = [...t1];
    for (const c of [...t1b, ...t2, ...t3, ...t4]) if (!selected.includes(c) && selected.length < MAX_ACTIVE) selected.push(c);
    const actors = new Set<CharId>();
    for (const gen of [{ proposals: spec?.proposals ?? [] }, ...(spec?.regenerations ?? [])]) {
      for (const p of gen.proposals) if (isChar(p.actor)) actors.add(p.actor);
    }
    for (const c of new Set([...selected, ...actors])) activatedRounds.set(c, [...(activatedRounds.get(c) ?? []), round]);
    out.set(round, { selected, tiers: { t1, t1b, t2, t3, t4 } });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Checkpoint instances (§13.1), derived from the run independently of the case annotations
// ---------------------------------------------------------------------------------------------------------------

export interface Instance {
  type: PauseCategory;
  round: number;
  object: string;
}

/** Object key of a proposal: doc:<n>@v<version> · offer:<n>@v<termsVersion> · propose:<to> · abandon_request. */
export function objectKey(state: WorldState, action: Action): string | null {
  switch (action.type) {
    case 'dispatch_document':
    case 'approve_document':
      return `${action.args.docId}@v${action.args.docVersion}`;
    case 'set_dispatch_timing':
      return `${action.args.docId}@v${state.documents[action.args.docId]?.version ?? '?'}`;
    case 'respond_to_offer':
    case 'confirm_commitment':
      return `${action.args.offerId}@v${state.offers[action.args.offerId]?.termsVersion ?? '?'}`;
    case 'propose_terms':
      return `propose:${action.args.to}`;
    case 'abandon_request':
      return 'abandon_request';
    default:
      return null;
  }
}

/** True if `round` got past PREPARE (derived from world events only). */
export function roundReached(r: Replay, round: number): boolean {
  const s = r.stateAt(prepareVersion(r, round));
  return s.round === round && s.terminal === null;
}

/** Generations of `round` that ran: the first, plus one per regenerating player batch (world events only). */
function generationsReached(r: Replay, round: number): number[] {
  const spec = r.spec.rounds.find((x) => x.round === round);
  const out = [0];
  for (let g = 1; g <= (spec?.regenerations.length ?? 0); g++) {
    if (generationVersion(r, round, g) > generationVersion(r, round, g - 1)) out.push(g);
  }
  return out;
}

/**
 * Checkpoint instances of the reference run (§13.1), derived ONLY from world events/states and the trace's proposals
 * — never from batch logs, pauses, decisions or system_outcome records, so removing control records cannot remove
 * an instance:
 *  (a) critical-type proposals of player-side actors that are valid at their batch state (H01–H04, H07–H09, H11–H13;
 *      H05/H06/H10/H14 excluded), including batches a regenerating decision later obsoleted;
 *  (b) mutiny: every ADVANCE after which, without a fall, grain ≤ 10, morale ≤ 30 and no mutiny has happened (G06/G12);
 *  (c) semantic goal_conflict / internal_disagreement / risky_delay on player-side proposals;
 *  (d) negotiation_deadlock from the offer history: a segment whose last round is used, no agreement, and Shi's side
 *      to move (he holds the delivered live offer and does not confirm it, or has learned the thread closed), or a
 *      player-side over-segment attempt.
 * Deduplicated by (type, object). Caveat: proposals after a withheld one are evaluated as if it had committed.
 */
export function deriveCheckpoints(r: Replay): Instance[] {
  const found = new Map<string, Instance>();
  const add = (i: Instance) => {
    const key = `${i.type}|${i.object}`;
    if (!found.has(key)) found.set(key, i);
  };
  const p = r.cfg.params;
  const shi = r.cfg.factions.hedong.principal;

  // (b) mutiny from G06 transitions after ADVANCE (a fall at that ADVANCE takes precedence, G12).
  let mutinies = 0;
  for (const e of r.run.events) {
    if (e.kind !== 'advance') continue;
    const after = r.stateAt(e.version);
    const next = r.run.events.find((x) => x.version === e.version + 1);
    const fell = next?.kind === 'terminal' || after.terminal !== null;
    const g = after.factions.hedong.resources.grain;
    if (!fell && !after.flags.mutinyOccurred && g <= p.mutiny_grain_max && after.siege.morale <= p.mutiny_morale_max) {
      mutinies += 1;
      add({ type: 'mutiny', round: e.round, object: mutinies === 1 ? 'mutiny' : `mutiny#${mutinies}` });
    }
  }

  for (let round = 1; round <= r.spec.max_rounds; round++) {
    if (!roundReached(r, round)) continue;
    const spec = r.spec.rounds.find((x) => x.round === round);

    // (d) deadlock from the offer history, on the SELECT state.
    const s = r.stateAt(selectVersion(r, round));
    const pairOffers = Object.values(s.offers).filter((o) => s.commitments[o.commitmentId]?.pair === 'hedong-khitan');
    const threads = Object.values(s.commitments).filter((t) => t.pair === 'hedong-khitan').sort((a, b) => Number(a.id.split(':')[1]) - Number(b.id.split(':')[1]));
    const agreed = threads.some((t) => t.status === 'confirmed');
    const shiConfirms = (offerId: string) =>
      [spec?.proposals ?? [], ...(spec?.regenerations ?? []).map((g) => g.proposals)].flat().some((x) => {
        const a = x.action as { type?: string; args?: { offerId?: string } };
        return x.actor === shi && a.type === 'confirm_commitment' && a.args?.offerId === offerId;
      });
    for (const o of pairOffers.filter((x) => x.segmentRound >= p.segment_round_cap)) {
      if (agreed || pairOffers.some((x) => x.segment > o.segment)) continue;
      const thread = s.commitments[o.commitmentId];
      const live = thread?.status === 'negotiating' ? s.offers[thread.liveOfferId] : undefined;
      const latest = threads[threads.length - 1];
      const shiToMove =
        (live !== undefined && live.to === shi && live.status === 'delivered' && hasReceiptEvidence(s, shi, live.id, live.termsVersion) && !shiConfirms(live.id)) ||
        (latest !== undefined && (latest.status === 'rejected' || latest.status === 'withdrawn') && ['rejected', 'withdrawn'].includes(believedThreadStatus(s, shi, latest.id) ?? ''));
      if (shiToMove) add({ type: 'negotiation_deadlock', round, object: `${o.commitmentId}@seg${o.segment}` });
    }

    for (const g of generationsReached(r, round)) {
      for (const prop of generationProposals(r, round, g)) {
        const parsed = parseAction(prop.action);
        if (!parsed.ok || !isPlayerSide(r.initial, r.cfg, prop.actor)) continue;
        const state = stateBefore(r, round, g, prop);
        const failure = checkAction(state, r.cfg, prop.actor, parsed.value);
        if (failure?.rule === 'H13' && failure.code === H13_SEGMENT_EXHAUSTED) {
          const open = Object.values(state.commitments).find((t) => t.pair === 'hedong-khitan' && t.status === 'negotiating');
          add({ type: 'negotiation_deadlock', round, object: `${open?.id ?? 'cmt:?'}@seg${state.negotiation['hedong-khitan'].segment}` });
        }
        if (failure) continue; // (a) only valid (eligible) proposals are instances
        const object = objectKey(state, parsed.value);
        if (object === null) continue;
        const category = mandatoryCategory(state, r.cfg, prop.actor, parsed.value);
        if (category) add({ type: category, round, object });
        const terms = category ? proposalTerms(state, r.cfg, prop.actor, parsed.value) : null;
        if (terms && !withinLimits(terms.terms, state.player.goal.limits, r.cfg.catalog, terms.pair).ok) {
          add({ type: 'goal_conflict', round, object });
        }
        const a = parsed.value;
        if ((a.type === 'approve_document' || a.type === 'dispatch_document') && prop.actor === shi) {
          const doc = state.documents[a.args.docId];
          const open = Object.values(state.suggestions).some(
            (sug) => sug.target.kind === 'document' && sug.target.id === a.args.docId && sug.targetVersion === doc?.version && sug.by !== prop.actor,
          );
          if (open) add({ type: 'internal_disagreement', round, object });
        }
        if (a.type === 'set_dispatch_timing' && a.args.mode !== 'now') {
          if (state.factions.hedong.resources.grain <= 15 || state.siege.pressure >= 70) add({ type: 'risky_delay', round, object });
        }
      }
    }
  }
  return [...found.values()];
}

// ---------------------------------------------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------------------------------------------

/** First matching rule's option (match keys omitted = any). */
export function policyChoice(c: CaseConfig, category: PauseCategory, facts: { actor?: string; type?: string; within?: boolean }): string | null {
  const rule = c.decision_policy.find(
    (p) =>
      p.match.category === category &&
      (p.match.actor === undefined || p.match.actor === facts.actor) &&
      (p.match.action_type === undefined || p.match.action_type === facts.type) &&
      (p.match.within_limits === undefined || (facts.within !== undefined && p.match.within_limits === facts.within)),
  );
  return rule?.choose ?? null;
}

/** Whether a paused proposal's terms are within the player's goal on the state just before it would commit. */
export function withinGoal(r: Replay, round: number, generation: number, target: BatchProposal): boolean | undefined {
  const state = stateBefore(r, round, generation, target);
  const parsed = parseAction(target.action);
  if (!parsed.ok) return undefined;
  const terms = proposalTerms(state, r.cfg, target.actor, parsed.value);
  return terms ? withinLimits(terms.terms, state.player.goal.limits, r.cfg.catalog, terms.pair).ok : undefined;
}

/** Problems where a trace decision differs from the case policy's first-match choice. */
export function checkPolicy(r: Replay): string[] {
  const problems: string[] = [];
  for (const spec of r.spec.rounds) {
    const generations = [{ decisions: spec.decisions }, ...spec.regenerations];
    generations.forEach((gen, g) => {
      const proposals = generationProposals(r, spec.round, g);
      const specProposals = g === 0 ? spec.proposals : (spec.regenerations[g - 1]?.proposals ?? []);
      const log = r.run.batches.find((b) => b.round === spec.round && b.kind === 'character' && b.generation === g);
      for (const d of gen.decisions) {
        const where = `${r.id} R${spec.round} g${g} ${d.ref ?? d.category}`;
        if (!d.category) problems.push(`${where}: decision without an explicit category`);
        if (d.category === 'negotiation_deadlock') {
          const want = policyChoice(r.config, 'negotiation_deadlock', {});
          if (want !== d.choose) problems.push(`${where}: policy chooses ${want}, trace ${d.choose}`);
          continue;
        }
        const target = proposals[specProposals.findIndex((p) => p.ref === d.ref)];
        if (!target) {
          problems.push(`${where}: unknown ref`);
          continue;
        }
        const pause = log?.pauses.find((p) => p.proposalIds.includes(target.proposalId));
        if (!pause) problems.push(`${where}: no pause was raised for this decision`);
        else if (pause.category !== d.category) problems.push(`${where}: pause is ${pause.category}, decision says ${d.category}`);
        const category = pause?.category ?? d.category;
        if (!category) continue;
        const type = (target.action as { type?: string }).type;
        const want = policyChoice(r.config, category, { actor: target.actor, type, within: withinGoal(r, spec.round, g, target) });
        if (want !== d.choose) problems.push(`${where}: policy chooses ${want}, trace ${d.choose}`);
      }
    });
    if (r.run.batches.some((b) => b.round === spec.round && b.kind === 'system_outcome')) {
      const want = policyChoice(r.config, 'mutiny', {});
      if (want !== (spec.mutiny ?? 'let_it_happen')) problems.push(`${r.id} R${spec.round}: mutiny policy ${want}, trace ${spec.mutiny}`);
    }
  }
  return problems;
}
