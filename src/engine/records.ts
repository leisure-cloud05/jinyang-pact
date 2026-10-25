/**
 * Engine sidecar tables in the run database (engine-owned; the harness schema is untouched):
 * - `engine_runs`: run metadata (case, rep, mode, lang, seed, content/rule/prompt hashes, model slugs, engine
 *   version, lineage, start time) and the run outcome;
 * - `engine_activations`: every scheduler decision (SELECT) with tier and reason, including capped candidates;
 * - `engine_log`: Judge verdicts, policy decisions, interrupts, faults, narration regeneration, limits
 *   (a non-null `key` makes an entry idempotent: fired-once markers);
 * - `engine_checkpoints`: named save points (round-start versions).
 * All statements are short and synchronous (never inside an await); free text passes credential redaction.
 */
import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '../core/hash.js';
import type { CharId, Mode } from '../core/types.js';
import { redactSecrets } from '../llm/redact.js';
import type { Store } from '../store/db.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS engine_runs (
  session_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  rep INTEGER NOT NULL,
  mode TEXT NOT NULL,
  lang TEXT NOT NULL,
  seed INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  rules_hash TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  models_json TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  parent_session_id TEXT,
  started_at_ms INTEGER NOT NULL,
  outcome TEXT,
  outcome_detail TEXT,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS engine_activations (
  session_id TEXT NOT NULL,
  select_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  version INTEGER NOT NULL,
  ord INTEGER NOT NULL,
  char_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  reason TEXT NOT NULL,
  agenda_ids_json TEXT NOT NULL,
  skipped INTEGER NOT NULL,
  inherited INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, select_id, char_id)
);
CREATE TABLE IF NOT EXISTS engine_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  kind TEXT NOT NULL,
  key TEXT,
  data_json TEXT NOT NULL,
  UNIQUE (session_id, kind, key)
);
CREATE TABLE IF NOT EXISTS engine_player_turns (
  session_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  turn_json TEXT NOT NULL,
  PRIMARY KEY (session_id, round)
);
CREATE TABLE IF NOT EXISTS engine_player_done (
  session_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  PRIMARY KEY (session_id, round, epoch)
);
CREATE TABLE IF NOT EXISTS engine_charges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_flight','done','refused')),
  reserved_usd REAL NOT NULL,
  charged_usd REAL NOT NULL,
  attempts INTEGER NOT NULL,
  unknown_cost INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS engine_revisions (
  revision_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('original','replacement')),
  idx INTEGER NOT NULL,
  envelope_json TEXT NOT NULL,
  verdict_json TEXT NOT NULL,
  links_json TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS engine_checkpoints (
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  round INTEGER NOT NULL,
  version INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, name)
);
`;

export interface RunRecord {
  sessionId: string;
  caseId: string;
  rep: number;
  mode: Mode;
  lang: 'zh' | 'en';
  seed: number;
  contentHash: string;
  rulesHash: string;
  promptHash: string;
  models: Record<string, string>;
  engineVersion: string;
  parentSessionId: string | null;
  startedAtMs: number;
  outcome: string | null;
  outcomeDetail: string | null;
  updatedAtMs: number;
}

export interface ActivationRecord {
  sessionId: string;
  selectId: string;
  round: number;
  epoch: number;
  version: number;
  ord: number;
  charId: CharId;
  tier: string;
  reason: string;
  agendaIds: string[];
  skipped: boolean;
  inherited: boolean;
}

export interface LogRecord {
  id: number;
  sessionId: string;
  round: number;
  epoch: number;
  kind: string;
  key: string | null;
  data: unknown;
}

export interface CheckpointRecord {
  sessionId: string;
  name: string;
  round: number;
  version: number;
  createdAtMs: number;
}

/**
 * A Judge-REVISE draft (never executed): the full original envelope, or its replacement, with stable ids and links
 * (`replacedBy` on originals; `replaces` and the submitted `proposalId` on replacements).
 */
export interface RevisionRecord {
  revisionId: string;
  sessionId: string;
  batchId: string;
  round: number;
  epoch: number;
  actor: string;
  kind: 'original' | 'replacement';
  index: number;
  envelope: { action: unknown; rationale: string; cites: string[]; askPlayer: { question: string } | null; seq: number; callTag: string };
  verdict: unknown;
  links: { replacedBy?: string[]; replaces?: string[]; proposalId?: string | null };
  /** originals: revising → replaced | revision_failed; replacements: pending_reassessment → final. */
  status: 'revising' | 'replaced' | 'revision_failed' | 'pending_reassessment' | 'final';
}

type Row = Record<string, unknown>;
const str = (v: unknown): string => String(v);
const num = (v: unknown): number => Number(v);
const optStr = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const red = (v: unknown): string => redactSecrets(canonicalJson(v ?? null));

export class EngineRecords {
  private readonly db: DatabaseSync;

  constructor(store: Store) {
    this.db = store.db;
    this.db.exec(SCHEMA);
  }

  // --- runs -----------------------------------------------------------------------------------------------------

  insertRun(r: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO engine_runs (session_id, case_id, rep, mode, lang, seed, content_hash, rules_hash, prompt_hash, models_json,
          engine_version, parent_session_id, started_at_ms, outcome, outcome_detail, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.sessionId,
        r.caseId,
        r.rep,
        r.mode,
        r.lang,
        r.seed,
        r.contentHash,
        r.rulesHash,
        r.promptHash,
        canonicalJson(r.models),
        r.engineVersion,
        r.parentSessionId,
        r.startedAtMs,
        r.outcome,
        r.outcomeDetail,
        r.updatedAtMs,
      );
  }

  findRun(sessionId: string): RunRecord | null {
    const r = this.db.prepare('SELECT * FROM engine_runs WHERE session_id = ?').get(sessionId) as Row | undefined;
    if (!r) return null;
    return {
      sessionId: str(r.session_id),
      caseId: str(r.case_id),
      rep: num(r.rep),
      mode: str(r.mode) as Mode,
      lang: str(r.lang) as 'zh' | 'en',
      seed: num(r.seed),
      contentHash: str(r.content_hash),
      rulesHash: str(r.rules_hash),
      promptHash: str(r.prompt_hash),
      models: JSON.parse(str(r.models_json)) as Record<string, string>,
      engineVersion: str(r.engine_version),
      parentSessionId: optStr(r.parent_session_id),
      startedAtMs: num(r.started_at_ms),
      outcome: optStr(r.outcome),
      outcomeDetail: optStr(r.outcome_detail),
      updatedAtMs: num(r.updated_at_ms),
    };
  }

  setOutcome(sessionId: string, outcome: string | null, detail: string | null, atMs: number): void {
    this.db
      .prepare('UPDATE engine_runs SET outcome = ?, outcome_detail = ?, updated_at_ms = ? WHERE session_id = ?')
      .run(outcome, detail === null ? null : redactSecrets(detail), atMs, sessionId);
  }

  /** Modes of the runs stored in this database (baseline isolation check). */
  modes(): Mode[] {
    return (this.db.prepare('SELECT DISTINCT mode FROM engine_runs').all() as Row[]).map((r) => str(r.mode) as Mode);
  }

  // --- activations ------------------------------------------------------------------------------------------------

  insertActivations(rows: readonly Omit<ActivationRecord, 'inherited'>[], inherited = false): void {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO engine_activations (session_id, select_id, round, epoch, version, ord, char_id, tier, reason,
        agenda_ids_json, skipped, inherited) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const a of rows) {
      stmt.run(
        a.sessionId,
        a.selectId,
        a.round,
        a.epoch,
        a.version,
        a.ord,
        a.charId,
        a.tier,
        redactSecrets(a.reason),
        canonicalJson(a.agendaIds),
        a.skipped ? 1 : 0,
        inherited ? 1 : 0,
      );
    }
  }

  activations(sessionId: string, filter: { selectId?: string; beforeRound?: number; round?: number } = {}): ActivationRecord[] {
    return (this.db.prepare('SELECT * FROM engine_activations WHERE session_id = ? ORDER BY round, epoch, select_id, ord').all(sessionId) as Row[])
      .map((r) => ({
        sessionId: str(r.session_id),
        selectId: str(r.select_id),
        round: num(r.round),
        epoch: num(r.epoch),
        version: num(r.version),
        ord: num(r.ord),
        charId: str(r.char_id) as CharId,
        tier: str(r.tier),
        reason: str(r.reason),
        agendaIds: JSON.parse(str(r.agenda_ids_json)) as string[],
        skipped: num(r.skipped) === 1,
        inherited: num(r.inherited) === 1,
      }))
      .filter(
        (a) =>
          (filter.selectId === undefined || a.selectId === filter.selectId) &&
          (filter.beforeRound === undefined || a.round < filter.beforeRound) &&
          (filter.round === undefined || a.round === filter.round),
      );
  }

  // --- log --------------------------------------------------------------------------------------------------------

  /** Appends a log entry; with a `key`, only the first entry per (kind, key) is kept. Returns false if it existed. */
  log(sessionId: string, round: number, epoch: number, kind: string, data: unknown, key: string | null = null): boolean {
    const info = this.db
      .prepare('INSERT OR IGNORE INTO engine_log (session_id, round, epoch, kind, key, data_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sessionId, round, epoch, kind, key, red(data));
    return Number(info.changes) > 0;
  }

  /** Appends a log entry and returns its row id (for entries completed later, e.g. Judge proposal ids). */
  appendLog(sessionId: string, round: number, epoch: number, kind: string, data: unknown): number {
    const info = this.db
      .prepare('INSERT INTO engine_log (session_id, round, epoch, kind, key, data_json) VALUES (?, ?, ?, ?, NULL, ?)')
      .run(sessionId, round, epoch, kind, red(data));
    return Number(info.lastInsertRowid);
  }

  getLog(id: number): LogRecord | null {
    const r = this.db.prepare('SELECT * FROM engine_log WHERE id = ?').get(id) as Row | undefined;
    if (!r) return null;
    return { id: num(r.id), sessionId: str(r.session_id), round: num(r.round), epoch: num(r.epoch), kind: str(r.kind), key: optStr(r.key), data: JSON.parse(str(r.data_json)) as unknown };
  }

  updateLogData(id: number, data: unknown): void {
    this.db.prepare('UPDATE engine_log SET data_json = ? WHERE id = ?').run(red(data), id);
  }

  hasLog(sessionId: string, kind: string, key: string): boolean {
    return this.db.prepare('SELECT 1 FROM engine_log WHERE session_id = ? AND kind = ? AND key = ?').get(sessionId, kind, key) !== undefined;
  }

  logs(sessionId: string, kind?: string): LogRecord[] {
    const rows = (
      kind === undefined
        ? this.db.prepare('SELECT * FROM engine_log WHERE session_id = ? ORDER BY id').all(sessionId)
        : this.db.prepare('SELECT * FROM engine_log WHERE session_id = ? AND kind = ? ORDER BY id').all(sessionId, kind)
    ) as Row[];
    return rows.map((r) => ({
      id: num(r.id),
      sessionId: str(r.session_id),
      round: num(r.round),
      epoch: num(r.epoch),
      kind: str(r.kind),
      key: optStr(r.key),
      data: JSON.parse(str(r.data_json)) as unknown,
    }));
  }

  // --- checkpoints ------------------------------------------------------------------------------------------------

  saveCheckpoint(c: CheckpointRecord): void {
    this.db
      .prepare('INSERT OR REPLACE INTO engine_checkpoints (session_id, name, round, version, created_at_ms) VALUES (?, ?, ?, ?, ?)')
      .run(c.sessionId, c.name, c.round, c.version, c.createdAtMs);
  }

  checkpoints(sessionId?: string): CheckpointRecord[] {
    const rows = (
      sessionId === undefined
        ? this.db.prepare('SELECT * FROM engine_checkpoints ORDER BY created_at_ms, session_id, name').all()
        : this.db.prepare('SELECT * FROM engine_checkpoints WHERE session_id = ? ORDER BY created_at_ms, name').all(sessionId)
    ) as Row[];
    return rows.map((r) => ({
      sessionId: str(r.session_id),
      name: str(r.name),
      round: num(r.round),
      version: num(r.version),
      createdAtMs: num(r.created_at_ms),
    }));
  }

  findCheckpoint(name: string, sessionId?: string): CheckpointRecord | null {
    return this.checkpoints(sessionId).find((c) => c.name === name) ?? null;
  }

  // --- player turns (PLAYER crash safety) -------------------------------------------------------------------------

  /** The round's player turn, persisted before any of it executes (a restart re-applies the same turn). */
  findTurn(sessionId: string, round: number): unknown {
    const r = this.db.prepare('SELECT turn_json FROM engine_player_turns WHERE session_id = ? AND round = ?').get(sessionId, round) as Row | undefined;
    return r ? (JSON.parse(str(r.turn_json)) as unknown) : null;
  }

  saveTurn(sessionId: string, round: number, turn: unknown): void {
    this.db.prepare('INSERT OR IGNORE INTO engine_player_turns (session_id, round, turn_json) VALUES (?, ?, ?)').run(sessionId, round, red(turn));
  }

  markPlayerDone(sessionId: string, round: number, epoch: number): void {
    this.db.prepare('INSERT OR IGNORE INTO engine_player_done (session_id, round, epoch) VALUES (?, ?, ?)').run(sessionId, round, epoch);
  }

  playerDoneEpochs(sessionId: string, round: number): number[] {
    return (this.db.prepare('SELECT epoch FROM engine_player_done WHERE session_id = ? AND round = ? ORDER BY epoch').all(sessionId, round) as Row[]).map((r) => num(r.epoch));
  }

  // --- budget ledger ------------------------------------------------------------------------------------------------

  /** Records a call about to start with its worst-case reservation (an unfinished row counts at that worst case). */
  chargeBegin(sessionId: string, role: string, reservedUsd: number): number {
    const info = this.db
      .prepare(`INSERT INTO engine_charges (session_id, role, status, reserved_usd, charged_usd, attempts, unknown_cost) VALUES (?, ?, 'in_flight', ?, ?, 0, 0)`)
      .run(sessionId, role, reservedUsd, reservedUsd);
    return Number(info.lastInsertRowid);
  }

  chargeEnd(id: number, c: { status: 'done' | 'refused'; chargedUsd: number; attempts: number; unknownCost: boolean }): void {
    this.db
      .prepare('UPDATE engine_charges SET status = ?, charged_usd = ?, attempts = ?, unknown_cost = ? WHERE id = ?')
      .run(c.status, c.chargedUsd, c.attempts, c.unknownCost ? 1 : 0, id);
  }

  /**
   * Budget already used by a session: calls that sent a request (unfinished calls count as made), and USD charged —
   * reported/estimated costs, the worst-case reservation for unknown-cost calls and for calls still in flight.
   */
  usedBudget(sessionId: string): { calls: number; usd: number; unknownCostCalls: number } {
    const r = this.db
      .prepare(
        `SELECT SUM(CASE WHEN status = 'in_flight' OR (status = 'done' AND attempts > 0) THEN 1 ELSE 0 END) AS calls,
                COALESCE(SUM(CASE WHEN status = 'refused' THEN 0 ELSE charged_usd END), 0) AS usd,
                SUM(CASE WHEN status = 'in_flight' OR unknown_cost = 1 THEN 1 ELSE 0 END) AS unknown
           FROM engine_charges WHERE session_id = ?`,
      )
      .get(sessionId) as Row | undefined;
    return { calls: num(r?.calls ?? 0), usd: num(r?.usd ?? 0), unknownCostCalls: num(r?.unknown ?? 0) };
  }

  // --- Judge REVISE envelopes ---------------------------------------------------------------------------------------

  insertRevision(r: RevisionRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO engine_revisions (revision_id, session_id, batch_id, round, epoch, actor, kind, idx, envelope_json, verdict_json, links_json, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.revisionId, r.sessionId, r.batchId, r.round, r.epoch, r.actor, r.kind, r.index, red(r.envelope), red(r.verdict), red(r.links), r.status);
  }

  revisions(sessionId: string): RevisionRecord[] {
    return (this.db.prepare('SELECT * FROM engine_revisions WHERE session_id = ? ORDER BY round, epoch, batch_id, actor, kind DESC, idx').all(sessionId) as Row[]).map((r) => ({
      revisionId: str(r.revision_id),
      sessionId: str(r.session_id),
      batchId: str(r.batch_id),
      round: num(r.round),
      epoch: num(r.epoch),
      actor: str(r.actor),
      kind: str(r.kind) as RevisionRecord['kind'],
      index: num(r.idx),
      envelope: JSON.parse(str(r.envelope_json)) as RevisionRecord['envelope'],
      verdict: JSON.parse(str(r.verdict_json)) as unknown,
      links: JSON.parse(str(r.links_json)) as RevisionRecord['links'],
      status: str(r.status) as RevisionRecord['status'],
    }));
  }

  /** Engine rows of a session, for the audit bundle (engine.json, revisions.jsonl). */
  exportSession(sessionId: string): {
    run: RunRecord | null;
    activations: ActivationRecord[];
    log: LogRecord[];
    checkpoints: CheckpointRecord[];
    revisions: RevisionRecord[];
    budget: { calls: number; usd: number; unknownCostCalls: number };
  } {
    return {
      run: this.findRun(sessionId),
      activations: this.activations(sessionId),
      log: this.logs(sessionId),
      checkpoints: this.checkpoints(sessionId),
      revisions: this.revisions(sessionId),
      budget: this.usedBudget(sessionId),
    };
  }
}
