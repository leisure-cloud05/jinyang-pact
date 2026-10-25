/**
 * Server sidecar tables in the play database (WP-E; the harness and engine schemas are untouched):
 * - `server_sessions`: how a play session was created (database, LLM, scripted player lines, director unlock);
 * - `server_requests`: idempotency records of successful POSTs `(scope, requestId)` with the payload hash and the
 *   stored response, so a retried request returns the first result and a reused id with another payload is refused.
 * Statements are short and synchronous; free text passes credential redaction before it is stored.
 */
import type { DatabaseSync } from 'node:sqlite';
import { redactSecrets } from '../llm/redact.js';
import type { Store } from '../store/db.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS server_sessions (
  session_id TEXT PRIMARY KEY,
  db TEXT NOT NULL,
  llm TEXT NOT NULL,
  script INTEGER NOT NULL,
  director_unlocked_round INTEGER,
  created_at TEXT NOT NULL,
  origin TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS server_requests (
  scope TEXT NOT NULL,
  request_id TEXT NOT NULL,
  route TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'done',
  target_json TEXT,
  status_code INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, request_id)
);
`;

export type DbName = 'main' | 'baseline';

export interface SessionMeta {
  sessionId: string;
  db: DbName;
  llm: 'mock' | 'live';
  script: boolean;
  directorUnlockedRound: number | null;
  createdAt: string;
  /** `create`, `branch:<parent>`, `load:<checkpoint>` or `external` (found in the database, not created here). */
  origin: string;
}

export interface StoredRequest {
  scope: string;
  requestId: string;
  route: string;
  payloadHash: string;
  /** `pending`: the intent (and its target) is recorded and the effect may or may not have happened; `done`: receipt stored. */
  status: 'pending' | 'done';
  target: unknown;
  statusCode: number;
  response: unknown;
}

type Row = Record<string, unknown>;

export class ServerStore {
  private readonly db: DatabaseSync;

  constructor(store: Store) {
    this.db = store.db;
    this.db.exec(SCHEMA);
    // Tables created by an earlier version lack the intent columns.
    const cols = new Set((this.db.prepare('PRAGMA table_info(server_requests)').all() as Row[]).map((r) => String(r.name)));
    if (!cols.has('status')) this.db.exec(`ALTER TABLE server_requests ADD COLUMN status TEXT NOT NULL DEFAULT 'done'`);
    if (!cols.has('target_json')) this.db.exec('ALTER TABLE server_requests ADD COLUMN target_json TEXT');
  }

  insertSession(m: SessionMeta): void {
    this.db
      .prepare(
        `INSERT INTO server_sessions (session_id, db, llm, script, director_unlocked_round, created_at, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(m.sessionId, m.db, m.llm, m.script ? 1 : 0, m.directorUnlockedRound, m.createdAt, redactSecrets(m.origin));
  }

  findSession(sessionId: string): SessionMeta | null {
    const r = this.db.prepare('SELECT * FROM server_sessions WHERE session_id = ?').get(sessionId) as Row | undefined;
    return r ? this.toMeta(r) : null;
  }

  listSessions(): SessionMeta[] {
    return (this.db.prepare('SELECT * FROM server_sessions ORDER BY created_at, session_id').all() as Row[]).map((r) => this.toMeta(r));
  }

  unlockDirector(sessionId: string, round: number): void {
    this.db
      .prepare('UPDATE server_sessions SET director_unlocked_round = ? WHERE session_id = ? AND director_unlocked_round IS NULL')
      .run(round, sessionId);
  }

  findRequest(scope: string, requestId: string): StoredRequest | null {
    const r = this.db.prepare('SELECT * FROM server_requests WHERE scope = ? AND request_id = ?').get(scope, requestId) as Row | undefined;
    if (!r) return null;
    return {
      scope: String(r.scope),
      requestId: String(r.request_id),
      route: String(r.route),
      payloadHash: String(r.payload_hash),
      status: String(r.status) === 'pending' ? 'pending' : 'done',
      target: r.target_json === null || r.target_json === undefined ? null : (JSON.parse(String(r.target_json)) as unknown),
      statusCode: Number(r.status_code),
      response: JSON.parse(String(r.response_json)) as unknown,
    };
  }

  /** Records a request's intent and target before its effect (a crash after this point is recoverable). */
  recordIntent(r: { scope: string; requestId: string; route: string; payloadHash: string; target: unknown }, createdAt: string): void {
    this.db
      .prepare(
        `INSERT INTO server_requests (scope, request_id, route, payload_hash, status, target_json, status_code, response_json, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?, 0, 'null', ?)
         ON CONFLICT (scope, request_id) DO UPDATE SET status = 'pending', target_json = excluded.target_json WHERE server_requests.status = 'pending'`,
      )
      .run(r.scope, r.requestId, r.route, r.payloadHash, redactSecrets(JSON.stringify(r.target ?? null)), createdAt);
  }

  /** Stores the receipt (the response a retry returns). */
  recordDone(r: { scope: string; requestId: string; route: string; payloadHash: string; statusCode: number; response: unknown }, createdAt: string): void {
    this.db
      .prepare(
        `INSERT INTO server_requests (scope, request_id, route, payload_hash, status, target_json, status_code, response_json, created_at)
         VALUES (?, ?, ?, ?, 'done', NULL, ?, ?, ?)
         ON CONFLICT (scope, request_id) DO UPDATE SET status = 'done', status_code = excluded.status_code, response_json = excluded.response_json`,
      )
      .run(r.scope, r.requestId, r.route, r.payloadHash, r.statusCode, redactSecrets(JSON.stringify(r.response ?? null)), createdAt);
  }

  /** Forgets a request that failed before recording any intent (nothing happened). */
  deletePending(scope: string, requestId: string): void {
    this.db.prepare(`DELETE FROM server_requests WHERE scope = ? AND request_id = ? AND status = 'pending'`).run(scope, requestId);
  }
  private toMeta(r: Row): SessionMeta {
    return {
      sessionId: String(r.session_id),
      db: String(r.db) === 'baseline' ? 'baseline' : 'main',
      llm: String(r.llm) === 'live' ? 'live' : 'mock',
      script: Number(r.script) === 1,
      directorUnlockedRound: r.director_unlocked_round === null || r.director_unlocked_round === undefined ? null : Number(r.director_unlocked_round),
      createdAt: String(r.created_at),
      origin: String(r.origin),
    };
  }
}
