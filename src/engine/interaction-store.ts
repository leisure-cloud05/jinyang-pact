/**
 * Interaction ledger persistence (PLAN §10.4, §8.5):
 * - `buildHappenings`: the ledger's inputs from persisted records only — committed batches (PREPARE deliveries,
 *   character steps with their recorded turns and proposal outcomes, ADVANCE), the player's dialogue — in control
 *   order;
 * - `syncInteraction`: derives the ledger (from the session's base ledger, inherited at a branch) and materializes
 *   it (`engine_ledger` + `engine_items`). Idempotent: called in the same transaction as every engine commit and at
 *   the start of every engine step, so "commit → follow-up items → processing progress" can neither lose nor
 *   duplicate work across a crash (items have natural keys; the derivation reads committed facts only);
 * - `replayInteraction`: re-parses every committed turn's recorded raw output and compares it with the stored
 *   metadata, re-derives the ledger from scratch and compares it with the materialized one, and checks the step
 *   records. No LLM is called.
 */
import { CharacterOutputSchema } from '../agents/schemas.js';
import { canonicalJson, sha256Hex } from '../core/hash.js';
import type { ActorId, CoreConfig, WorldState } from '../core/types.js';
import type { Harness } from '../harness/index.js';
import { parseJsonContent, validateOutput } from '../llm/parse.js';
import { redactSecrets } from '../llm/redact.js';
import type { DialogueRecord, ProposalRecord } from '../store/repo.js';
import { deriveLedger, type Happening, type Ledger, type ProposalFact, type TurnInput } from './interaction.js';
import type { EngineRecords, TurnRecord } from './records.js';

export interface InteractionEnv {
  harness: Harness;
  records: EngineRecords;
  sessionId: string;
  config: CoreConfig;
  maxRounds: number;
  lang: 'zh' | 'en';
  /** Committed snapshots are immutable: an optional cache shared across syncs. */
  snapshots?: Map<number, WorldState>;
}

function actionOf(p: ProposalRecord): { type: string; args: Record<string, unknown> | null } {
  const a = p.action as { type?: unknown; args?: unknown } | null;
  const type = a && typeof a.type === 'string' ? a.type : 'unknown';
  const args = a && typeof a.args === 'object' && a.args !== null && !Array.isArray(a.args) ? (a.args as Record<string, unknown>) : null;
  return { type, args };
}

function stateLoader(env: InteractionEnv): (version: number) => WorldState {
  const cache = env.snapshots ?? new Map<number, WorldState>();
  const repo = env.harness.repo;
  return (version: number) => {
    const hit = cache.get(version);
    if (hit) return hit;
    let snap = repo.getSnapshot(env.sessionId, version)?.state ?? null;
    if (!snap) {
      const lower = repo.listSnapshotVersions(env.sessionId).filter((v) => v <= version).at(-1);
      snap = lower !== undefined ? (repo.getSnapshot(env.sessionId, lower)?.state ?? null) : null;
    }
    if (!snap) snap = repo.latestSnapshot(env.sessionId).state;
    cache.set(version, snap);
    return snap;
  };
}

const ORDER: Record<Happening['kind'], number> = { prepare: 0, step: 0, advance: 0, dialogue: 1 };

/** The ledger's inputs, from committed records, in control order. */
export function buildHappenings(env: InteractionEnv): Happening[] {
  const { harness, records, sessionId } = env;
  const repo = harness.repo;
  const dialogue = repo.listDialogue(sessionId);
  const decisions = new Map(repo.listSessionDecisions(sessionId).map((d) => [d.decisionId, d]));
  const adviceOf = new Map<string, DialogueRecord>();
  for (const d of dialogue) if (d.kind === 'advice' && d.decisionId) adviceOf.set(d.decisionId, d);
  const turnsByBatch = new Map<string, TurnRecord[]>();
  for (const t of records.turns(sessionId)) {
    const list = turnsByBatch.get(t.batchId) ?? [];
    list.push(t);
    turnsByBatch.set(t.batchId, list);
  }
  const out: Array<Happening & { tie: number }> = [];
  for (const b of repo.committedBatches(sessionId)) {
    if (b.commitSeq === null || b.committedVersion === null) continue;
    if (b.kind === 'system_prepare') out.push({ kind: 'prepare', pos: b.commitSeq, round: b.round, version: b.committedVersion, tie: 0 });
    else if (b.kind === 'system_advance') out.push({ kind: 'advance', pos: b.commitSeq, round: b.round, version: b.committedVersion, tie: 0 });
    else if (b.kind === 'character') {
      const facts: ProposalFact[] = repo.listProposals(b.batchId).map((p) => {
        const { type, args } = actionOf(p);
        const advice = p.status === 'withheld' && p.decisionId ? (adviceOf.get(p.decisionId) ?? null) : null;
        return {
          proposalId: p.proposalId,
          actor: p.actor,
          seq: p.seq,
          type,
          args,
          status: p.status,
          feedback: p.feedback,
          code: p.code,
          adviceText: advice?.text ?? null,
          adviceSeq: advice?.seq ?? null,
        };
      });
      const turns: TurnInput[] = (turnsByBatch.get(b.batchId) ?? []).map((t) => {
        const speechRow = dialogue.find((d) => d.kind === 'speech' && d.speaker === t.actor && d.proposalId !== null && t.proposalIds.includes(d.proposalId));
        return {
          turnId: t.turnId,
          batchId: t.batchId,
          actor: t.actor,
          status: t.status,
          supplied: t.supplied,
          interaction: (t.interaction ?? null) as TurnInput['interaction'],
          speech: t.speech,
          speechSeq: speechRow?.seq ?? null,
          proposals: facts.filter((p) => t.proposalIds.includes(p.proposalId)),
        };
      });
      out.push({ kind: 'step', pos: b.commitSeq, round: b.round, batchId: b.batchId, baseVersion: b.baseVersion, version: b.committedVersion, turns, proposals: facts, tie: 0 });
    }
  }
  for (const d of dialogue) {
    if (d.inherited || d.speaker !== 'player' || (d.kind !== 'speech' && d.kind !== 'advice')) continue;
    const decision = d.decisionId ? decisions.get(d.decisionId) : undefined;
    const folded = d.kind === 'advice' && decision !== undefined && (decision.option === 'withhold' || decision.option === 'counter_draft');
    out.push({
      kind: 'dialogue',
      pos: d.controlAt ?? 0,
      round: d.round,
      seq: d.seq,
      dialogueKind: d.kind,
      text: d.text,
      listeners: d.listeners as ActorId[],
      folded,
      tie: d.seq,
    });
  }
  out.sort((a, b) => a.pos - b.pos || ORDER[a.kind] - ORDER[b.kind] || a.tie - b.tie);
  return out.map(({ tie: _t, ...h }) => h as Happening);
}

export function baseLedger(env: InteractionEnv): Ledger | null {
  return env.records.ledger(env.sessionId, 'base') as Ledger | null;
}

/**
 * Derives the ledger from the session's records (no writes); with `upTo`, only from happenings at control positions
 * ≤ `upTo` (the ledger as it stood when the engine used it).
 */
export function deriveInteraction(env: InteractionEnv, upTo: number | null = null, happenings: Happening[] | null = null): Ledger {
  const all = happenings ?? buildHappenings(env);
  return deriveLedger(baseLedger(env), {
    config: env.config,
    maxRounds: env.maxRounds,
    lang: env.lang,
    happenings: upTo === null ? all : all.filter((h) => h.pos <= upTo),
    stateAt: stateLoader(env),
  });
}

export function ledgerHashOf(ledger: Ledger): string {
  return sha256Hex(ledgerDocument(ledger));
}

/** Canonical stored form of a ledger (what `engine_ledger` holds). */
export function ledgerDocument(ledger: Ledger): string {
  return redactSecrets(canonicalJson(ledger as unknown));
}

/** Derives and materializes the ledger (in one transaction; joins the caller's). Returns the ledger. */
export function syncInteraction(env: InteractionEnv): Ledger {
  const ledger = deriveInteraction(env);
  const doc = ledgerDocument(ledger);
  if (env.records.ledgerJson(env.sessionId, 'current') !== doc) {
    env.harness.store.transaction(() => env.records.saveLedger(env.sessionId, 'current', ledger));
  }
  return ledger;
}

export interface InteractionReplayReport {
  ok: boolean;
  checkedTurns: number;
  checkedItems: number;
  /** Logged ledger uses (selections, contexts) re-derived and compared. */
  checkedUses: number;
  mismatches: string[];
}

function normalized(v: unknown): string {
  return redactSecrets(canonicalJson((v ?? null) as unknown));
}

/**
 * Replay of the interaction state from recorded outputs (PLAN §8.5): every committed turn's raw output re-parses to
 * its stored speech and metadata; the ledger re-derived from scratch equals the materialized one; every committed
 * character batch has a step record at its derived (round, step).
 */
export function replayInteraction(env: InteractionEnv): InteractionReplayReport {
  const mismatches: string[] = [];
  const repo = env.harness.repo;
  const committed = repo.committedBatches(env.sessionId).filter((b) => b.kind === 'character');
  const committedIds = new Set(committed.map((b) => b.batchId));
  let checkedTurns = 0;
  for (const t of env.records.turns(env.sessionId)) {
    if (!committedIds.has(t.batchId)) continue;
    checkedTurns += 1;
    if (t.status !== 'ok') {
      if (t.interaction !== null) mismatches.push(`${t.turnId}: ${t.status} turn carries interaction metadata`);
      continue;
    }
    if (t.raw === null) {
      mismatches.push(`${t.turnId}: readable turn without a recorded output`);
      continue;
    }
    const parsed = parseJsonContent(t.raw);
    const valid = parsed.ok ? validateOutput(CharacterOutputSchema, parsed.value) : null;
    if (!valid || !valid.ok) {
      mismatches.push(`${t.turnId}: the recorded output does not re-parse`);
      continue;
    }
    if (normalized(valid.value.interaction) !== normalized(t.interaction)) mismatches.push(`${t.turnId}: stored interaction metadata differs from the recorded output`);
    if (redactSecrets(valid.value.speech) !== t.speech) mismatches.push(`${t.turnId}: stored speech differs from the recorded output`);
  }
  // Step records: the k-th committed character batch of a round is its step k.
  const steps = new Map(env.records.steps(env.sessionId).map((s) => [s.batchId, s]));
  const perRound = new Map<number, number>();
  for (const b of committed) {
    const k = (perRound.get(b.round) ?? 0) + 1;
    perRound.set(b.round, k);
    const s = steps.get(b.batchId);
    if (!s) mismatches.push(`${b.batchId}: no step record`);
    else if (s.round !== b.round || s.step !== k) mismatches.push(`${b.batchId}: step record r${s.round}.s${s.step}, derived r${b.round}.s${k}`);
  }
  const happenings = buildHappenings(env);
  // Every ledger the engine used for a selection or a context re-derives from the records before that point.
  let checkedUses = 0;
  for (const entry of env.records.logs(env.sessionId, 'ledger_used')) {
    const u = entry.data as { use?: string; selectId?: string; controlSeq?: number; hash?: string };
    if (typeof u.controlSeq !== 'number' || typeof u.hash !== 'string') continue;
    checkedUses += 1;
    if (ledgerHashOf(deriveInteraction(env, u.controlSeq, happenings)) !== u.hash) mismatches.push(`ledger used for ${u.use ?? '?'} ${u.selectId ?? entry.key ?? '?'} differs from its re-derivation`);
  }
  const derived = deriveInteraction(env, null, happenings);
  const stored = env.records.ledgerJson(env.sessionId, 'current');
  if (stored === null) {
    if (derived.items.length > 0) mismatches.push('no materialized ledger, but the records derive items');
  } else if (stored !== ledgerDocument(derived)) {
    const storedItems = new Map(((JSON.parse(stored) as Ledger).items ?? []).map((i) => [i.itemId, normalized(i)]));
    for (const it of derived.items) {
      const s = storedItems.get(it.itemId);
      if (s === undefined) mismatches.push(`item ${it.itemId} (${it.kind}) derived but not stored`);
      else if (s !== normalized(it)) mismatches.push(`item ${it.itemId} (${it.kind}) differs from its re-derivation`);
      storedItems.delete(it.itemId);
    }
    for (const id of storedItems.keys()) mismatches.push(`item ${id} stored but not derived`);
    if (mismatches.length === 0) mismatches.push('ledger document differs from its re-derivation');
  }
  return { ok: mismatches.length === 0, checkedTurns, checkedItems: derived.items.length, checkedUses, mismatches };
}
