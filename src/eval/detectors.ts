/**
 * Checkpoint detectors (PLAN §13.1), independent of the Judge and of the harness's pause plan.
 *
 * Instances (deduplicated by key `(type, object)` with objects `doc:N@vV`, `cmt:M/offer:N@vT` (+ `>counter#<terms>` /
 * `>reject`), `propose:<to>/cmt:K@v1#<terms>`, `cmt:N@segS`, `abandon_request`, `mutiny` — thread/offer identity,
 * termsVersion and the proposed terms are part of the key, so one pause never covers two distinct proposals):
 *  (a) critical (§4 P) proposals of player-side actors that committed or were eligible at their batch state —
 *      eligibility = the oracle's action validity (H01–H04, H07–H09, H11–H13; H05/H06/H10/H14 excluded);
 *  (b) mutiny from state transitions: an ADVANCE after which the city stands, grain ≤ 10, morale ≤ 30 and no
 *      mutiny has happened (G06 + G12), regardless of any staged/control record;
 *  (c) semantic: internal_disagreement (Shi approves/dispatches while another party's suggestion on that document
 *      version is open), goal_conflict (critical terms beyond the player's goal limits), risky_delay (delay/hold while
 *      grain ≤ 15 or pressure ≥ 70);
 *  (d) negotiation_deadlock from the offer history (independent segment ledger): the segment used its rounds, no
 *      agreement, and Shi's side is to move — or a player-side over-segment attempt.
 * Invalid critical proposals that could not commit are not instances; they are reported separately (an invalid one
 * that committed anyway — permissive baseline — is an instance: the outcome did occur).
 *
 * Eligibility in a batch uses the actual evolving state for committed batches; for batches that never committed
 * (regenerated/obsolete, unfinished) earlier document actions in commit order are simulated (approve, revise,
 * timing) — the only effects that change the validity of later proposals of the same batch in this chapter.
 */
import { createHash } from 'node:crypto';
import type { ActorId, CoreConfig, PauseCategory, TermSet, WorldState } from '../core/types.js';
import {
  checkValidity,
  committedTerms,
  coveringAuthorization,
  criticalCategory,
  SEGMENT_EXHAUSTED,
  type AuditBundle,
  type BBatch,
  type BProposal,
  type OAction,
  type OSystemAction,
  ReplayedBundle,
  canonical,
  world,
} from './oracle/index.js';

export interface CheckpointInstance {
  key: string;
  type: PauseCategory;
  object: string;
  round: number;
  source: 'proposal' | 'replaced_draft' | 'transition' | 'offer_history' | 'over_segment';
  proposalIds: string[];
  batchIds: string[];
  committed: boolean;
  commitVersion: number | null;
  /** Control sequence number at which the outcome committed (null if it never did). */
  commitSeq: number | null;
  control: {
    /** A system-triggered decision pause on this instance was resolved before its outcome committed. */
    pause: boolean;
    pauseIds: string[];
    authorization: boolean;
    playerInitiated: boolean;
    /** The Judge's verdict on one of the proposals was a default or was skipped after an error (a Judge miss; never excluded). */
    judgeDefaulted: boolean;
  };
}

export interface PauseLabel {
  pauseId: string;
  category: PauseCategory;
  kind: string;
  status: string;
  round: number;
  /** Matched to a detector instance (automatic pause-precision proxy). */
  matched: boolean;
  instanceKeys: string[];
}

export interface DetectorReport {
  instances: CheckpointInstance[];
  invalidCritical: Array<{ proposalId: string; type: string; category: PauseCategory | null; rules: string[] }>;
  /** System-triggered decision pauses (mandatory, semantic, prompt, control), including obsolete ones. */
  pauses: PauseLabel[];
}

export const DECISION_PAUSE_KINDS: ReadonlySet<string> = new Set(['mandatory', 'semantic', 'prompt', 'control']);
const INCLUDED_STATUSES: ReadonlySet<string> = new Set(['committed', 'rejected', 'withheld', 'obsolete', 'pending', 'unapplied']);

function priority(c: CoreConfig, actor: ActorId): number {
  if (actor === 'system') return -2;
  if (actor === 'player') return -1;
  return c.characters[actor]?.commitPriority ?? 99;
}

/** Commit order (§8.2): commitPriority of the actor, then actor id, then seq, then proposal id. */
export function commitOrder<T extends { actor: ActorId; seq: number; proposalId: string }>(list: readonly T[], c: CoreConfig): T[] {
  return [...list].sort(
    (a, b) =>
      priority(c, a.actor) - priority(c, b.actor) ||
      (a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0) ||
      a.seq - b.seq ||
      (a.proposalId < b.proposalId ? -1 : 1),
  );
}

/** Short content hash of a term set (distinct terms ⇒ distinct checkpoint keys). */
export function termsKey(terms: unknown): string {
  return createHash('sha256').update(canonical(terms ?? null)).digest('hex').slice(0, 10);
}

/**
 * Object key of a checkpoint: document + version, or thread/offer identity + termsVersion (+ the counter/proposal
 * terms), so that one pause can never cover two distinct proposals.
 */
export function objectKey(s: WorldState, a: OAction | OSystemAction): string | null {
  switch (a.type) {
    case 'dispatch_document':
    case 'approve_document':
      return `${a.args.docId}@v${a.args.docVersion}`;
    case 'set_dispatch_timing':
      return `${a.args.docId}@v${s.documents[a.args.docId]?.version ?? '?'}`;
    case 'confirm_commitment':
      return `${s.offers[a.args.offerId]?.commitmentId ?? a.args.commitmentId}/${a.args.offerId}@v${s.offers[a.args.offerId]?.termsVersion ?? '?'}`;
    case 'respond_to_offer': {
      const base = `${s.offers[a.args.offerId]?.commitmentId ?? 'cmt:?'}/${a.args.offerId}@v${s.offers[a.args.offerId]?.termsVersion ?? '?'}`;
      return a.args.response === 'counter' ? `${base}>counter#${termsKey(a.args.counterTerms)}` : `${base}>reject`;
    }
    case 'propose_terms': {
      // A new thread: identity = (recipient, the pair's next thread, its terms).
      const pair = Object.values(s.commitments).length + 1;
      return `propose:${a.args.to}/cmt:${pair}@v1#${termsKey(a.args.terms)}`;
    }
    case 'abandon_request':
      return 'abandon_request';
    default:
      return null;
  }
}

/** Minimal simulation of document actions for batches that never committed (see module doc). */
function simulateLite(s: WorldState, c: CoreConfig, actor: ActorId, a: OAction): WorldState {
  if (a.type !== 'approve_document' && a.type !== 'revise_document' && a.type !== 'set_dispatch_timing') return s;
  const next = structuredClone(s);
  const doc = next.documents[a.args.docId];
  if (!doc) return s;
  if (a.type === 'approve_document') {
    doc.status = 'approved';
    doc.approval = { version: doc.version, eventId: next.version + 1, by: actor };
  } else if (a.type === 'revise_document') {
    const hidden = doc.terms.secret_clauses.filter((cl) => !world.knowsClause(s, c, actor, cl.id));
    doc.terms = world.expandTerms(a.args.terms, c, hidden);
    doc.version += 1;
    doc.status = 'draft';
    doc.approval = null;
  } else {
    doc.timing = { mode: a.args.mode, notBeforeRound: a.args.mode === 'delay' ? s.round + (a.args.rounds ?? c.params.delay_rounds_min) : null };
  }
  return next;
}

function openSuggestion(s: WorldState, docId: string, by: ActorId): boolean {
  const doc = s.documents[docId];
  return Object.values(s.suggestions).some((g) => g.target.kind === 'document' && g.target.id === docId && g.targetVersion === doc?.version && g.by !== by);
}

function outsideGoal(s: WorldState, c: CoreConfig, terms: { pair: string; terms: TermSet } | null): boolean {
  if (!terms) return false;
  return world.limitViolations(terms.terms, s.player.goal.limits, c, terms.pair as never).length > 0;
}

/** Status of REVISE-replaced drafts (never commits). */
export const REPLACED = 'replaced';
const REPLACED_STATUSES: ReadonlySet<string> = new Set(['replaced', 'revised', 'superseded']);

function pseudo(p: Pick<BProposal, 'proposalId' | 'batchId' | 'round' | 'epoch' | 'actor' | 'seq' | 'action' | 'rationale' | 'cites' | 'askPlayer'>): BProposal {
  return {
    ...p,
    baseVersion: -1,
    source: 'llm',
    status: REPLACED,
    rule: null,
    reason: 'replaced after the Judge asked for a revision (never executed)',
    feedback: null,
    code: null,
    category: null,
    gate: null,
    authorizationId: null,
    decisionId: null,
    eventVersions: [],
    controlSeq: -1,
    probe: false,
    intake: 'replaced',
  };
}

/**
 * REVISE originals: drafts the Judge had revised before submission — from `revisions.jsonl` (kind `original`,
 * full envelopes), from stored proposal rows with a replaced status, or (older engines) from the engine log's
 * `revised` entries. Returned as pseudo-proposals with status `replaced` and no events: never executed.
 */
export function replacedDrafts(bundle: AuditBundle): BProposal[] {
  const out: BProposal[] = bundle.proposals.filter((p) => REPLACED_STATUSES.has(p.status)).map((p) => ({ ...p, status: REPLACED, eventVersions: [] }));
  for (const r of bundle.revisions) {
    // revision_failed originals were submitted unchanged (they are stored proposals); replaced/revising ones never ran.
    if (r.kind !== 'original' || r.status === 'revision_failed') continue;
    out.push(
      pseudo({
        proposalId: r.revisionId,
        batchId: r.batchId,
        round: r.round,
        epoch: r.epoch,
        actor: r.actor,
        seq: r.envelope.seq,
        action: r.envelope.action,
        rationale: r.envelope.rationale,
        cites: r.envelope.cites,
        askPlayer: r.envelope.askPlayer,
      }),
    );
  }
  for (const entry of bundle.engine?.log ?? []) {
    if (entry.kind !== 'revised' || typeof entry.data !== 'object' || entry.data === null) continue;
    const data = entry.data as { batchId?: string; actor?: string; replaced?: unknown[] };
    if (!data.batchId || !data.actor || !Array.isArray(data.replaced)) continue;
    if (out.some((p) => p.batchId === data.batchId && p.actor === data.actor)) continue;
    data.replaced.forEach((action, i) => {
      out.push(pseudo({ proposalId: `${data.batchId}/replaced:${data.actor}:${i + 1}`, batchId: data.batchId as string, round: entry.round, epoch: entry.epoch, actor: data.actor as BProposal['actor'], seq: i + 1, action, rationale: '', cites: [], askPlayer: null }));
    });
  }
  return out;
}

export interface JudgeMissReport {
  /** Stored proposal ids or REVISE revision ids whose Judge verdict was a default or was skipped after an error. */
  ids: Set<string>;
  /** Refs resolved from the engine's explicit `realProposalId` / `revisionId` fields. */
  explicit: number;
  /** Refs resolved positionally (`judge:<actor>:<i>` ⇒ seq i+1) because the explicit fields were absent (logged). */
  positional: string[];
}

interface JudgeRef {
  judgeId?: string;
  proposalId?: string;
  realProposalId?: string | null;
  revisionId?: string | null;
}

/**
 * Judge misses: defaulted verdicts (call failed, no item returned) and proposals left unassessed after an
 * error_recovery skip (`judge_skipped`). Each verdict/ref carries the harness `realProposalId` (null if never
 * submitted) and the REVISE `revisionId`; only when both fields are absent (older engines) is the Judge's temporary
 * id mapped positionally (`judge:<actor>:<i>` ⇒ the actor's proposal with seq i+1), and that fallback is reported.
 */
export function judgeMissReport(bundle: AuditBundle): JudgeMissReport {
  const ids = new Set<string>();
  let explicit = 0;
  const positional: string[] = [];
  const resolve = (batchId: string | undefined, ref: JudgeRef) => {
    const temp = ref.judgeId ?? ref.proposalId ?? '?';
    if ('realProposalId' in ref || 'revisionId' in ref) {
      const id = ref.realProposalId ?? ref.revisionId ?? null;
      ids.add(id ?? `${batchId ?? '?'}/${temp} (never submitted)`);
      explicit += 1;
      return;
    }
    const m = /^judge:([a-z_]+):(rev)?(\d+)$/.exec(temp);
    positional.push(`${batchId ?? '?'}/${temp}`);
    if (!m || !batchId) {
      ids.add(temp);
      return;
    }
    const [, actor, rev, idx] = m;
    const i = Number(idx);
    const revision = bundle.revisions.find((r) => r.kind === (rev ? 'replacement' : 'original') && r.batchId === batchId && r.actor === actor && r.index === i);
    if (revision && !rev) {
      ids.add(revision.revisionId);
      return;
    }
    if (revision?.links.proposalId) {
      ids.add(revision.links.proposalId);
      return;
    }
    const p = bundle.proposals.find((x) => x.batchId === batchId && x.actor === actor && x.seq === i + 1);
    ids.add(p ? p.proposalId : `${batchId}/${temp}`);
  };
  for (const entry of bundle.engine?.log ?? []) {
    if (typeof entry.data !== 'object' || entry.data === null) continue;
    const data = entry.data as { batchId?: string; verdicts?: Array<JudgeRef & { defaulted?: boolean }>; defaulted?: unknown; misses?: unknown; defaultedRefs?: JudgeRef[]; missRefs?: JudgeRef[] };
    if (entry.kind === 'judge') {
      if (Array.isArray(data.defaultedRefs)) for (const r of data.defaultedRefs) resolve(data.batchId, r);
      else {
        const seen = new Set<string>();
        for (const v of data.verdicts ?? []) {
          if (!v.defaulted) continue;
          seen.add(v.proposalId ?? '');
          resolve(data.batchId, v);
        }
        if (Array.isArray(data.defaulted)) for (const id of data.defaulted) if (typeof id === 'string' && !seen.has(id)) resolve(data.batchId, { judgeId: id });
      }
    }
    if (entry.kind === 'judge_skipped') {
      if (Array.isArray(data.missRefs)) for (const r of data.missRefs) resolve(data.batchId, r);
      else if (Array.isArray(data.misses)) for (const id of data.misses) if (typeof id === 'string') resolve(data.batchId, { judgeId: id });
    }
  }
  return { ids, explicit, positional };
}

export function judgeMisses(bundle: AuditBundle): Set<string> {
  return judgeMissReport(bundle).ids;
}
export function detectCheckpoints(bundle: AuditBundle, replayed?: ReplayedBundle): DetectorReport {
  const rb = replayed ?? new ReplayedBundle(bundle);
  const c = rb.config;
  const found = new Map<string, CheckpointInstance>();
  const invalidCritical: DetectorReport['invalidCritical'] = [];
  const shi = world.shiOf(c);
  const p = c.params;

  const add = (type: PauseCategory, object: string, round: number, source: CheckpointInstance['source'], prop: BProposal | null, batch: BBatch | null): CheckpointInstance => {
    const key = `${type}|${object}`;
    let inst = found.get(key);
    if (!inst) {
      inst = {
        key,
        type,
        object,
        round,
        source,
        proposalIds: [],
        batchIds: [],
        committed: false,
        commitVersion: null,
        commitSeq: null,
        control: { pause: false, pauseIds: [], authorization: false, playerInitiated: false, judgeDefaulted: false },
      };
      found.set(key, inst);
    }
    if (prop && !inst.proposalIds.includes(prop.proposalId)) inst.proposalIds.push(prop.proposalId);
    if (batch && !inst.batchIds.includes(batch.batchId)) inst.batchIds.push(batch.batchId);
    return inst;
  };
  const markCommitted = (inst: CheckpointInstance, prop: BProposal, batch: BBatch, pre: WorldState, action: OAction | OSystemAction, category: PauseCategory | null) => {
    if (prop.status !== 'committed') return;
    if (!inst.committed) {
      inst.committed = true;
      inst.commitVersion = prop.eventVersions[0] ?? null;
      inst.commitSeq = batch.commitSeq;
    }
    if (prop.actor === 'player') inst.control.playerInitiated = true;
    if (category && coveringAuthorization(pre, c, prop.actor, category, action)) inst.control.authorization = true;
  };

  /** Evaluates one proposal (or replaced draft) at its batch state; returns the parsed action if it was valid. */
  const consider = (prop: BProposal, batch: BBatch, pre: WorldState): OAction | null => {
    const validity = checkValidity(pre, { config: c, segments: rb.segmentsAt(Math.min(pre.version, rb.lastVersion)) }, prop.actor, prop.action);
    if (!validity.parsed) return null;
    const action = validity.parsed.action as OAction | OSystemAction;
    const valid = validity.violations.length === 0 && !validity.parsed.system ? (action as OAction) : null;
    if (!world.playerSide(pre, c, prop.actor)) return valid;
    const category = criticalCategory(pre, c, prop.actor, action);
    const overSegment = validity.violations.find((x) => x.rule === 'H13' && x.code === SEGMENT_EXHAUSTED);
    if (overSegment) {
      const thread = world.openThread(pre, 'hedong-khitan') ?? world.threadsOf(pre, 'hedong-khitan').at(-1);
      const seg = rb.segmentsAt(Math.min(pre.version, rb.lastVersion))('hedong-khitan').segment;
      add('negotiation_deadlock', `${thread?.id ?? 'cmt:?'}@seg${seg}`, prop.round, 'over_segment', prop, batch);
    }
    // Committed OR eligible (§13.1 a): an invalid proposal that nevertheless committed (baseline) is an instance;
    // one that could not commit is reported separately.
    if (validity.violations.length > 0 && prop.status !== 'committed') {
      if (category && prop.status !== REPLACED) invalidCritical.push({ proposalId: prop.proposalId, type: action.type, category, rules: [...new Set(validity.violations.map((x) => x.rule))] });
      return valid;
    }
    const object = objectKey(pre, action);
    if (object === null) return valid;
    const source: CheckpointInstance['source'] = prop.status === REPLACED ? 'replaced_draft' : 'proposal';
    if (category) {
      const inst = add(category, object, prop.round, source, prop, batch);
      markCommitted(inst, prop, batch, pre, action, category);
      if (outsideGoal(pre, c, committedTerms(pre, c, prop.actor, action))) {
        markCommitted(add('goal_conflict', object, prop.round, source, prop, batch), prop, batch, pre, action, 'goal_conflict');
      }
    }
    if ((action.type === 'approve_document' || action.type === 'dispatch_document') && prop.actor === shi && openSuggestion(pre, action.args.docId, prop.actor)) {
      markCommitted(add('internal_disagreement', object, prop.round, source, prop, batch), prop, batch, pre, action, 'internal_disagreement');
    }
    if (action.type === 'set_dispatch_timing' && action.args.mode !== 'now' && (pre.factions.hedong.resources.grain <= 15 || pre.siege.pressure >= 70)) {
      markCommitted(add('risky_delay', object, prop.round, source, prop, batch), prop, batch, pre, action, 'risky_delay');
    }
    return valid;
  };

  // (a), (c), and over-segment attempts (d) from proposals; REVISE-replaced drafts are enumerated too (never commits).
  const replaced = replacedDrafts(bundle);
  for (const batch of bundle.batches) {
    if (batch.kind !== 'character' && batch.kind !== 'player') continue;
    if (!rb.has(batch.baseVersion)) continue;
    const props = commitOrder(bundle.proposals.filter((x) => x.batchId === batch.batchId && INCLUDED_STATUSES.has(x.status)), c);
    const committedBatch = batch.status === 'committed';
    const events = rb.eventsOfBatch(batch.batchId);
    let version = batch.baseVersion;
    for (const e of events) if (e.proposalId === null && e.kind !== 'terminal') version = Math.max(version, e.version);
    let simulated = rb.stateAt(batch.baseVersion);
    for (const prop of props) {
      let pre: WorldState;
      const ev = prop.eventVersions[0];
      if (committedBatch) {
        pre = prop.status === 'committed' && ev !== undefined && rb.has(ev - 1) ? rb.stateAt(ev - 1) : rb.stateAt(version);
        if (prop.status === 'committed' && prop.eventVersions.length > 0) version = Math.max(version, ...prop.eventVersions.filter((v) => rb.has(v)));
      } else pre = simulated;
      const valid = consider(prop, batch, pre);
      if (!committedBatch && valid) simulated = simulateLite(simulated, c, prop.actor, valid);
    }
    const drafts = commitOrder(replaced.filter((d) => d.batchId === batch.batchId), c);
    let draftState = rb.stateAt(batch.baseVersion);
    for (const d of drafts) {
      const valid = consider(d, batch, draftState);
      if (valid) draftState = simulateLite(draftState, c, d.actor, valid);
    }
  }
  // (b) mutiny from ADVANCE transitions.
  let mutinies = 0;
  for (const e of rb.events) {
    if (e.kind !== 'advance' || !rb.has(e.version)) continue;
    const after = rb.stateAt(e.version);
    const next = rb.events.find((x) => x.version === e.version + 1);
    const fell = (next?.kind === 'terminal' && next.batchId === e.batchId) || after.terminal !== null;
    if (fell || after.flags.mutinyOccurred || after.factions.hedong.resources.grain > p.mutiny_grain_max || after.siege.morale > p.mutiny_morale_max) continue;
    mutinies += 1;
    const inst = add('mutiny', mutinies === 1 ? 'mutiny' : `mutiny#${mutinies}`, e.round, 'transition', null, null);
    const advBatch = e.batchId ? rb.batchById.get(e.batchId) : undefined;
    const nextPrepare = bundle.batches.find((b) => (b.kind === 'system_prepare' || b.kind === 'system_advance') && advBatch && b.controlSeq > advBatch.controlSeq);
    const outcome = bundle.batches.find(
      (b) => b.kind === 'system_outcome' && advBatch && b.controlSeq > advBatch.controlSeq && (!nextPrepare || b.controlSeq < nextPrepare.controlSeq),
    );
    if (outcome) {
      inst.batchIds.push(outcome.batchId);
      for (const prop of bundle.proposals.filter((x) => x.batchId === outcome.batchId)) inst.proposalIds.push(prop.proposalId);
      const outbreak = rb.events.find((x) => x.batchId === outcome.batchId && x.kind === 'mutiny_outbreak');
      if (outbreak) {
        inst.committed = true;
        inst.commitVersion = outbreak.version;
        inst.commitSeq = outcome.commitSeq;
      }
    } else {
      // Ungated outcome committed directly (not staged as its own batch): look for an outbreak after this ADVANCE.
      const outbreak = rb.events.find((x) => x.kind === 'mutiny_outbreak' && x.version > e.version);
      if (outbreak) {
        inst.committed = true;
        inst.commitVersion = outbreak.version;
        inst.commitSeq = outbreak.batchId ? (rb.batchById.get(outbreak.batchId)?.commitSeq ?? null) : null;
      }
    }
  }

  // (d) exhaustion from the offer history, at each round's SELECT state (base of its first character batch).
  const rounds = [...new Set(bundle.batches.filter((b) => b.kind === 'character').map((b) => b.round))].sort((a, b) => a - b);
  for (const round of rounds) {
    const first = bundle.batches.find((b) => b.kind === 'character' && b.round === round);
    if (!first || !rb.has(first.baseVersion)) continue;
    const s = rb.stateAt(first.baseVersion);
    if (s.terminal) continue;
    const seg = rb.segmentsAt(first.baseVersion)('hedong-khitan');
    if (seg.segment === 0 || seg.openingNext || seg.roundsInSegment < p.segment_round_cap) continue;
    const threads = world.threadsOf(s, 'hedong-khitan');
    if (threads.some((t) => t.status === 'confirmed')) continue;
    const open = world.openThread(s, 'hedong-khitan');
    let thread: string | null = null;
    if (open) {
      const live = s.offers[open.liveOfferId];
      const shiConfirms = bundle.proposals.some((x) => {
        if (x.round !== round || x.actor !== shi || !live) return false;
        const a = x.action as { type?: string; args?: { offerId?: string; commitmentId?: string; termsVersion?: number } };
        return a.type === 'confirm_commitment' && a.args?.offerId === live.id && a.args.commitmentId === open.id && a.args.termsVersion === live.termsVersion;
      });
      if (live && live.to === shi && live.status === 'delivered' && world.hasReceipt(s, shi, live.id, live.termsVersion) && !shiConfirms) thread = open.id;
    } else {
      const latest = threads.at(-1);
      if (latest && (latest.status === 'rejected' || latest.status === 'withdrawn') && ['rejected', 'withdrawn'].includes(world.believedStatus(s, shi, latest.id) ?? '')) thread = latest.id;
    }
    if (thread) add('negotiation_deadlock', `${thread}@seg${seg.segment}`, round, 'offer_history', null, first);
  }

  // Coverage: resolved decision pauses before the outcome committed.
  const defaulted = judgeMisses(bundle);
  const decisionPauses = bundle.pauses.filter((x) => DECISION_PAUSE_KINDS.has(x.kind));
  const decisionSeq = (id: string | null) => bundle.decisions.find((d) => d.decisionId === id)?.controlSeq ?? null;
  const labels: PauseLabel[] = decisionPauses.map((x) => ({ pauseId: x.pauseId, category: x.category, kind: x.kind, status: x.status, round: x.round, matched: false, instanceKeys: [] }));
  for (const inst of found.values()) {
    const related = decisionPauses.filter((x) => {
      if (inst.type === 'mutiny') return x.category === 'mutiny' && x.batchId !== null && inst.batchIds.includes(x.batchId);
      if (inst.type === 'negotiation_deadlock' && inst.source !== 'over_segment') {
        return x.category === 'negotiation_deadlock' && x.round === inst.round;
      }
      if (inst.type === 'negotiation_deadlock') return x.category === 'negotiation_deadlock' && (x.proposalIds.some((id) => inst.proposalIds.includes(id)) || x.round === inst.round);
      return x.proposalIds.some((id) => inst.proposalIds.includes(id));
    });
    for (const x of related) {
      const label = labels.find((l) => l.pauseId === x.pauseId);
      if (label) {
        label.matched = true;
        label.instanceKeys.push(inst.key);
      }
      if (x.status !== 'resolved') continue;
      const seq = decisionSeq(x.decisionId);
      if (seq === null) continue;
      if (inst.commitSeq !== null && seq > inst.commitSeq) continue;
      inst.control.pause = true;
      inst.control.pauseIds.push(x.pauseId);
    }
    if (inst.proposalIds.some((id) => defaulted.has(id))) inst.control.judgeDefaulted = true;
  }
  return { instances: [...found.values()], invalidCritical, pauses: labels };
}
