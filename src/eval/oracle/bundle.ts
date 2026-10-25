/**
 * Audit bundle (PLAN §13.3) as typed, camelCase records. Reads the JSONL export written by `exportAudit`
 * (`runs/<id>/<run>/audit/`) plus the engine sidecar (`engine.json`) when present. Tolerant: a missing file is an
 * empty table, so partial bundles (failed runs) are still evaluated.
 *
 * Independence (PLAN §13.3): this module imports only domain TYPES; it never uses harness or core logic.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  ActorId,
  BatchKind,
  BatchStatus,
  CoreConfig,
  Localized,
  Mode,
  NarrationFact,
  PairId,
  PatchOp,
  PauseCategory,
  PauseKind,
  WorldState,
} from '../../core/types.js';

type Row = Record<string, unknown>;

export interface BundleSession {
  sessionId: string;
  mode: Mode;
  caseId: string | null;
  status: string;
  phase: string;
  round: number;
  epoch: number;
  rngSeed: number;
  contentHash: string;
  rulesHash: string;
  promptHash: string;
  config: CoreConfig;
  baseVersion: number;
  parentSessionId: string | null;
  runOutcome: string | null;
}

export interface BSnapshot {
  version: number;
  state: WorldState;
  stateHash: string;
}

export interface BEvent {
  version: number;
  batchId: string | null;
  round: number;
  day: number;
  kind: string;
  actor: ActorId;
  proposalId: string | null;
  decisionId: string | null;
  changes: PatchOp[];
  facts: NarrationFact[];
  rules: string[];
  stateHash: string;
  inherited: boolean;
}

export interface BBatch {
  batchId: string;
  kind: BatchKind;
  round: number;
  epoch: number;
  baseVersion: number;
  status: BatchStatus;
  generation: number;
  controlSeq: number;
  commitSeq: number | null;
  committedVersion: number | null;
  narrationStatus: string;
  note: string | null;
}

export interface BProposal {
  proposalId: string;
  batchId: string;
  round: number;
  epoch: number;
  baseVersion: number;
  actor: ActorId;
  source: string;
  seq: number;
  action: unknown;
  rationale: string;
  cites: string[];
  askPlayer: { question: string } | null;
  status: string;
  rule: string | null;
  reason: string | null;
  feedback: string | null;
  code: string | null;
  category: string | null;
  gate: string | null;
  authorizationId: string | null;
  decisionId: string | null;
  eventVersions: number[];
  controlSeq: number;
  probe: boolean;
  intake: string;
}

export interface BPause {
  pauseId: string;
  batchId: string | null;
  round: number;
  epoch: number;
  kind: PauseKind;
  category: PauseCategory;
  proposalIds: string[];
  pair: PairId | null;
  visibleFacts: Localized[];
  question: Localized;
  options: string[];
  status: 'open' | 'resolved' | 'obsolete';
  decisionId: string | null;
  controlSeq: number;
}

export interface BDecision {
  decisionId: string;
  pauseId: string | null;
  batchId: string;
  category: PauseCategory;
  proposalIds: string[];
  pair: PairId | null;
  option: string;
  advice: string | null;
  payload: Record<string, unknown>;
  by: string;
  requestId: string | null;
  round: number;
  epoch: number;
  controlSeq: number;
}

export interface BEpoch {
  epoch: number;
  reason: string;
  instructionId: string | null;
  controlSeq: number;
}

export interface BRequest {
  requestId: string;
  op: string;
  payloadHash: string;
  result: unknown;
  controlSeq: number;
}

export interface BDialogue {
  seq: number;
  round: number;
  epoch: number;
  worldVersion: number;
  speaker: ActorId;
  listeners: ActorId[];
  text: string;
  kind: 'speech' | 'advice' | 'question' | 'answer';
  proposalId: string | null;
  decisionId: string | null;
  payload: unknown;
  inherited: boolean;
  /** Session control sequence at emission (schema v4+); null in older bundles. */
  controlAt: number | null;
}

export interface BNarration {
  narrationId: number;
  batchId: string | null;
  scene: string;
  eventVersions: number[];
  attempt: number;
  status: 'ok' | 'fallback' | 'failed';
  raw: string | null;
  header: string;
  displayed: string;
  check: unknown;
  controlSeq: number;
}

export interface BRoundStart {
  round: number;
  version: number;
  dialogueSeqCutoff: number;
  controlSeqCutoff: number;
}

export interface BLlmCall {
  callId: string;
  ts: string;
  role: string;
  actor: string | null;
  round: number | null;
  callTag: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  costSource: string;
  latencyMs: number;
  attempts: number;
  status: string;
  record: Record<string, unknown>;
}

export interface BLlmAttempt {
  callId: string;
  attemptNo: number;
  kind: string;
  status: string;
  latencyMs: number;
  generationId: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  costSource: string;
  reconciled: boolean;
}

/**
 * A Judge-REVISE draft (WP-D `revisions.jsonl`): the full original envelope (never executed) or its replacement,
 * with stable ids and links (`replacedBy` on originals; `replaces` and the submitted `proposalId` on replacements).
 */
export interface BRevision {
  revisionId: string;
  batchId: string;
  round: number;
  epoch: number;
  actor: ActorId;
  kind: 'original' | 'replacement';
  index: number;
  envelope: { action: unknown; rationale: string; cites: string[]; askPlayer: { question: string } | null; seq: number; callTag: string };
  verdict: unknown;
  links: { replacedBy?: string[]; replaces?: string[]; proposalId?: string | null };
  /** originals: revising → replaced | revision_failed; replacements: pending_reassessment → final (null: older engines). */
  status: string | null;
}

/** Engine sidecar (WP-D `engine.json`): run metadata, scheduler activations and the engine log. */
export interface EngineExport {
  run: Record<string, unknown> | null;
  activations: Array<{ round: number; epoch: number; charId: string; tier: string; reason: string; skipped: boolean }>;
  log: Array<{ round: number; epoch: number; kind: string; key: string | null; data: unknown }>;
}

export interface AuditBundle {
  dir: string | null;
  session: BundleSession;
  snapshots: BSnapshot[];
  events: BEvent[];
  batches: BBatch[];
  proposals: BProposal[];
  epochs: BEpoch[];
  requests: BRequest[];
  pauses: BPause[];
  decisions: BDecision[];
  dialogue: BDialogue[];
  narrations: BNarration[];
  roundStarts: BRoundStart[];
  llmCalls: BLlmCall[];
  llmAttempts: BLlmAttempt[];
  /** REVISE originals and replacements (empty when the engine recorded none). */
  revisions: BRevision[];
  engine: EngineExport | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Field readers
// ---------------------------------------------------------------------------------------------------------------

const num = (v: unknown, fallback = 0): number => (v === null || v === undefined || v === '' ? fallback : Number(v));
const optNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown, fallback = ''): string => (v === null || v === undefined ? fallback : String(v));
const optStr = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const bool = (v: unknown): boolean => v === true || v === 1 || v === '1';
function json<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
}
/** Exported rows drop the `_json` suffix; hand-written fixtures may keep it. */
function field(row: Row, name: string): unknown {
  return name in row ? row[name] : row[`${name}_json`];
}

export function toSession(raw: Row): BundleSession {
  return {
    sessionId: str(raw.sessionId ?? raw.session_id),
    mode: str(raw.mode) as Mode,
    caseId: optStr(raw.caseId ?? raw.case_id),
    status: str(raw.status),
    phase: str(raw.phase),
    round: num(raw.round, 1),
    epoch: num(raw.epoch),
    rngSeed: num(raw.rngSeed ?? raw.rng_seed),
    contentHash: str(raw.contentHash ?? raw.content_hash),
    rulesHash: str(raw.rulesHash ?? raw.rules_hash),
    promptHash: str(raw.promptHash ?? raw.prompt_hash),
    config: json<CoreConfig>(raw.config ?? raw.config_json, {} as CoreConfig),
    baseVersion: num(raw.baseVersion ?? raw.base_version),
    parentSessionId: optStr(raw.parentSessionId ?? raw.parent_session_id),
    runOutcome: optStr(raw.runOutcome ?? raw.run_outcome),
  };
}

export const toSnapshot = (r: Row): BSnapshot => ({
  version: num(r.version),
  state: json<WorldState>(field(r, 'state'), {} as WorldState),
  stateHash: str(r.state_hash),
});

export const toEvent = (r: Row): BEvent => ({
  version: num(r.version),
  batchId: optStr(r.batch_id),
  round: num(r.round),
  day: num(r.day),
  kind: str(r.kind),
  actor: str(r.actor) as ActorId,
  proposalId: optStr(r.proposal_id),
  decisionId: optStr(r.decision_id),
  changes: json<PatchOp[]>(field(r, 'changes'), []),
  facts: json<NarrationFact[]>(field(r, 'facts'), []),
  rules: json<string[]>(field(r, 'rules'), []),
  stateHash: str(r.state_hash),
  inherited: bool(r.inherited),
});

export const toBatch = (r: Row): BBatch => ({
  batchId: str(r.batch_id),
  kind: str(r.kind) as BatchKind,
  round: num(r.round),
  epoch: num(r.epoch),
  baseVersion: num(r.base_version),
  status: str(r.status) as BatchStatus,
  generation: num(r.generation),
  controlSeq: num(r.control_seq),
  commitSeq: optNum(r.commit_seq),
  committedVersion: optNum(r.committed_version),
  narrationStatus: str(r.narration_status, 'none'),
  note: optStr(r.note),
});

export const toProposal = (r: Row): BProposal => ({
  proposalId: str(r.proposal_id),
  batchId: str(r.batch_id),
  round: num(r.round),
  epoch: num(r.epoch),
  baseVersion: num(r.base_version),
  actor: str(r.actor) as ActorId,
  source: str(r.source),
  seq: num(r.seq),
  action: json<unknown>(field(r, 'action'), null),
  rationale: str(r.rationale),
  cites: json<string[]>(field(r, 'cites'), []),
  askPlayer: json<{ question: string } | null>(field(r, 'ask_player'), null),
  status: str(r.status),
  rule: optStr(r.rule),
  reason: optStr(r.reason),
  feedback: optStr(r.feedback),
  code: optStr(r.code),
  category: optStr(r.category),
  gate: optStr(r.gate),
  authorizationId: optStr(r.authorization_id),
  decisionId: optStr(r.decision_id),
  eventVersions: json<number[]>(field(r, 'event_versions'), []),
  controlSeq: num(r.control_seq),
  probe: bool(r.probe),
  intake: str(r.intake, 'pending'),
});

export const toPause = (r: Row): BPause => ({
  pauseId: str(r.pause_id),
  batchId: optStr(r.batch_id),
  round: num(r.round),
  epoch: num(r.epoch),
  kind: str(r.kind) as PauseKind,
  category: str(r.category) as PauseCategory,
  proposalIds: json<string[]>(field(r, 'proposal_ids'), []),
  pair: optStr(r.pair) as PairId | null,
  visibleFacts: json<Localized[]>(field(r, 'visible_facts'), []),
  question: json<Localized>(field(r, 'question'), { zh: '', en: '' }),
  options: json<string[]>(field(r, 'options'), []),
  status: str(r.status) as BPause['status'],
  decisionId: optStr(r.decision_id),
  controlSeq: num(r.control_seq),
});

export const toDecision = (r: Row): BDecision => ({
  decisionId: str(r.decision_id),
  pauseId: optStr(r.pause_id),
  batchId: str(r.batch_id),
  category: str(r.category) as PauseCategory,
  proposalIds: json<string[]>(field(r, 'proposal_ids'), []),
  pair: optStr(r.pair) as PairId | null,
  option: str(r.option),
  advice: optStr(r.advice),
  payload: json<Record<string, unknown>>(field(r, 'payload'), {}),
  by: str(r.by),
  requestId: optStr(r.request_id),
  round: num(r.round),
  epoch: num(r.epoch),
  controlSeq: num(r.control_seq),
});

export const toEpoch = (r: Row): BEpoch => ({
  epoch: num(r.epoch),
  reason: str(r.reason),
  instructionId: optStr(r.instruction_id),
  controlSeq: num(r.control_seq),
});

export const toRequest = (r: Row): BRequest => ({
  requestId: str(r.request_id),
  op: str(r.op),
  payloadHash: str(r.payload_hash),
  result: json<unknown>(field(r, 'result'), null),
  controlSeq: num(r.control_seq),
});

export const toDialogue = (r: Row): BDialogue => ({
  seq: num(r.seq),
  round: num(r.round),
  epoch: num(r.epoch),
  worldVersion: num(r.world_version),
  speaker: str(r.speaker) as ActorId,
  listeners: json<ActorId[]>(field(r, 'listeners'), []),
  text: str(r.text),
  kind: str(r.kind) as BDialogue['kind'],
  proposalId: optStr(r.proposal_id),
  decisionId: optStr(r.decision_id),
  payload: json<unknown>(field(r, 'payload'), null),
  inherited: bool(r.inherited),
  controlAt: r.control_at === null || r.control_at === undefined ? null : num(r.control_at),
});

export const toNarration = (r: Row): BNarration => ({
  narrationId: num(r.narration_id),
  batchId: optStr(r.batch_id),
  scene: str(r.scene),
  eventVersions: json<number[]>(field(r, 'event_versions'), []),
  attempt: num(r.attempt, 1),
  status: str(r.status) as BNarration['status'],
  raw: optStr(r.raw),
  header: str(r.header),
  displayed: str(r.displayed),
  check: json<unknown>(field(r, 'check'), null),
  controlSeq: num(r.control_seq),
});

export const toRoundStart = (r: Row): BRoundStart => ({
  round: num(r.round),
  version: num(r.version),
  dialogueSeqCutoff: num(r.dialogue_seq_cutoff),
  controlSeqCutoff: num(r.control_seq_cutoff),
});

export const toLlmCall = (r: Row): BLlmCall => ({
  callId: str(r.call_id),
  ts: str(r.ts),
  role: str(r.role),
  actor: optStr(r.actor),
  round: optNum(r.round),
  callTag: optStr(r.call_tag),
  model: str(r.model),
  inputTokens: num(r.input_tokens),
  outputTokens: num(r.output_tokens),
  costUsd: optNum(r.cost_usd),
  costSource: str(r.cost_source, 'none'),
  latencyMs: num(r.latency_ms),
  attempts: num(r.attempts),
  status: str(r.status),
  record: json<Record<string, unknown>>(field(r, 'record'), {}),
});

export const toLlmAttempt = (r: Row): BLlmAttempt => ({
  callId: str(r.call_id),
  attemptNo: num(r.attempt_no),
  kind: str(r.kind),
  status: str(r.status),
  latencyMs: num(r.latency_ms),
  generationId: optStr(r.generation_id),
  inputTokens: num(r.input_tokens),
  outputTokens: num(r.output_tokens),
  costUsd: optNum(r.cost_usd),
  costSource: str(r.cost_source, 'none'),
  reconciled: bool(r.reconciled),
});

export const toRevision = (r: Row): BRevision => {
  const env = json<Record<string, unknown>>(r.envelope ?? r.envelope_json, {});
  return {
    revisionId: str(r.revisionId ?? r.revision_id),
    batchId: str(r.batchId ?? r.batch_id),
    round: num(r.round),
    epoch: num(r.epoch),
    actor: str(r.actor) as ActorId,
    kind: str(r.kind) as BRevision['kind'],
    index: num(r.index ?? r.idx),
    envelope: {
      action: env.action ?? null,
      rationale: str(env.rationale),
      cites: Array.isArray(env.cites) ? (env.cites as string[]) : [],
      askPlayer: (env.askPlayer as { question: string } | null | undefined) ?? null,
      seq: num(env.seq, 1),
      callTag: str(env.callTag),
    },
    verdict: json<unknown>(r.verdict ?? r.verdict_json, null),
    links: json<BRevision['links']>(r.links ?? r.links_json, {}),
    status: r.status === undefined || r.status === null ? null : String(r.status),
  };
};

function toEngine(raw: unknown): EngineExport | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Row;
  const activations = Array.isArray(r.activations) ? (r.activations as Row[]) : [];
  const log = Array.isArray(r.log) ? (r.log as Row[]) : [];
  return {
    run: typeof r.run === 'object' && r.run !== null ? (r.run as Record<string, unknown>) : null,
    activations: activations.map((a) => ({
      round: num(a.round),
      epoch: num(a.epoch),
      charId: str(a.charId ?? a.char_id),
      tier: str(a.tier),
      reason: str(a.reason),
      skipped: bool(a.skipped),
    })),
    log: log.map((l) => ({ round: num(l.round), epoch: num(l.epoch), kind: str(l.kind), key: optStr(l.key), data: l.data ?? null })),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------------------------

export function readJsonl(file: string): Row[] {
  if (!existsSync(file)) return [];
  const out: Row[] = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    out.push(JSON.parse(line) as Row);
  }
  return out;
}

/** Raw tables of a bundle (file name without extension → rows). */
export interface RawBundle {
  session: Row;
  tables: Record<string, Row[]>;
  engine: unknown;
}

export const BUNDLE_TABLES = [
  'snapshots',
  'events',
  'batches',
  'proposals',
  'epochs',
  'requests',
  'pauses',
  'decisions',
  'dialogue',
  'narrations',
  'round_starts',
  'llm_calls',
  'llm_attempts',
  'revisions',
] as const;

export function readRawBundle(dir: string): RawBundle {
  const sessionFile = path.join(dir, 'session.json');
  if (!existsSync(sessionFile)) throw new Error(`not an audit bundle (no session.json): ${dir}`);
  const tables: Record<string, Row[]> = {};
  for (const t of BUNDLE_TABLES) tables[t] = readJsonl(path.join(dir, `${t}.jsonl`));
  const engineFile = [path.join(dir, 'engine.json'), path.join(dir, '..', 'engine.json')].find((f) => existsSync(f));
  return {
    session: JSON.parse(readFileSync(sessionFile, 'utf8')) as Row,
    tables,
    engine: engineFile ? (JSON.parse(readFileSync(engineFile, 'utf8')) as unknown) : null,
  };
}

export function fromRaw(raw: RawBundle, dir: string | null = null): AuditBundle {
  const t = (name: string): Row[] => raw.tables[name] ?? [];
  return {
    dir,
    session: toSession(raw.session),
    snapshots: t('snapshots').map(toSnapshot).sort((a, b) => a.version - b.version),
    events: t('events').map(toEvent).sort((a, b) => a.version - b.version),
    batches: t('batches').map(toBatch).sort((a, b) => a.controlSeq - b.controlSeq),
    proposals: t('proposals').map(toProposal).sort((a, b) => a.controlSeq - b.controlSeq),
    epochs: t('epochs').map(toEpoch).sort((a, b) => a.controlSeq - b.controlSeq),
    requests: t('requests').map(toRequest).sort((a, b) => a.controlSeq - b.controlSeq),
    pauses: t('pauses').map(toPause).sort((a, b) => a.controlSeq - b.controlSeq),
    decisions: t('decisions').map(toDecision).sort((a, b) => a.controlSeq - b.controlSeq),
    dialogue: t('dialogue').map(toDialogue).sort((a, b) => a.seq - b.seq),
    narrations: t('narrations').map(toNarration).sort((a, b) => a.narrationId - b.narrationId),
    roundStarts: t('round_starts').map(toRoundStart).sort((a, b) => a.round - b.round),
    llmCalls: t('llm_calls').map(toLlmCall),
    llmAttempts: t('llm_attempts').map(toLlmAttempt),
    revisions: t('revisions').map(toRevision),
    engine: toEngine(raw.engine),
  };
}

/** Loads the audit bundle in `dir` (the `audit/` folder of a run). */
export function loadBundle(dir: string): AuditBundle {
  return fromRaw(readRawBundle(dir), dir);
}
