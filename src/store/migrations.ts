/**
 * SQLite schema (PLAN §8, §13.3). World state lives in `snapshots` + `events`; everything else is a control or
 * log record (sessions, batches, proposals, pauses, decisions, epochs, requests, round_starts, pending
 * instructions, dialogue, narrations, llm_calls/llm_attempts). JSON columns hold canonical JSON text.
 *
 * `control_seq` (per session, from `sessions.control_seq`) orders control records; `round_starts` records the
 * dialogue/control cut-offs used by branching.
 */
import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('baseline','no_judge','full')),
  case_id TEXT,
  status TEXT NOT NULL,
  suspended_from TEXT,
  phase TEXT NOT NULL,
  round INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  rng_seed INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  rules_hash TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  config_json TEXT NOT NULL,
  base_version INTEGER NOT NULL,
  parent_session_id TEXT REFERENCES sessions(session_id),
  parent_round INTEGER,
  parent_version INTEGER,
  run_outcome TEXT,
  control_seq INTEGER NOT NULL DEFAULT 0,
  dialogue_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE snapshots (
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  version INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  PRIMARY KEY (session_id, version)
);

CREATE TABLE batches (
  batch_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  kind TEXT NOT NULL,
  round INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  base_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  control_seq INTEGER NOT NULL,
  commit_seq INTEGER,
  committed_version INTEGER,
  narration_status TEXT NOT NULL DEFAULT 'none',
  note TEXT
);
CREATE INDEX batches_session ON batches(session_id, control_seq);

CREATE TABLE events (
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  version INTEGER NOT NULL,
  batch_id TEXT,
  round INTEGER NOT NULL,
  day INTEGER NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  proposal_id TEXT,
  decision_id TEXT,
  changes_json TEXT NOT NULL,
  facts_json TEXT NOT NULL,
  rules_json TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  inherited INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, version)
);

CREATE TABLE proposals (
  proposal_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  batch_id TEXT NOT NULL REFERENCES batches(batch_id),
  round INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  base_version INTEGER NOT NULL,
  actor TEXT NOT NULL,
  source TEXT NOT NULL,
  seq INTEGER NOT NULL,
  action_json TEXT NOT NULL,
  rationale TEXT NOT NULL,
  cites_json TEXT NOT NULL,
  ask_player_json TEXT,
  status TEXT NOT NULL,
  rule TEXT,
  reason TEXT,
  feedback TEXT,
  code TEXT,
  category TEXT,
  gate TEXT,
  authorization_id TEXT,
  decision_id TEXT,
  event_versions_json TEXT NOT NULL DEFAULT '[]',
  control_seq INTEGER NOT NULL
);
CREATE INDEX proposals_batch ON proposals(batch_id, control_seq);

CREATE TABLE pauses (
  pause_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  batch_id TEXT REFERENCES batches(batch_id),
  round INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  kind TEXT NOT NULL,
  category TEXT NOT NULL,
  proposal_ids_json TEXT NOT NULL,
  pair TEXT,
  visible_facts_json TEXT NOT NULL,
  question_json TEXT NOT NULL,
  options_json TEXT NOT NULL,
  status TEXT NOT NULL,
  decision_id TEXT,
  control_seq INTEGER NOT NULL
);
CREATE INDEX pauses_session ON pauses(session_id, status);

CREATE TABLE decisions (
  decision_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  pause_id TEXT REFERENCES pauses(pause_id),
  batch_id TEXT NOT NULL,
  category TEXT NOT NULL,
  proposal_ids_json TEXT NOT NULL,
  pair TEXT,
  option TEXT NOT NULL,
  advice TEXT,
  payload_json TEXT NOT NULL,
  by TEXT NOT NULL,
  request_id TEXT,
  round INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  control_seq INTEGER NOT NULL
);
CREATE INDEX decisions_batch ON decisions(batch_id, control_seq);

CREATE TABLE epochs (
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  epoch INTEGER NOT NULL,
  reason TEXT NOT NULL,
  instruction_id TEXT,
  started_at TEXT NOT NULL,
  control_seq INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch)
);

CREATE TABLE requests (
  session_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  op TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  control_seq INTEGER NOT NULL,
  PRIMARY KEY (session_id, request_id)
);

CREATE TABLE round_starts (
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  round INTEGER NOT NULL,
  version INTEGER NOT NULL,
  dialogue_seq_cutoff INTEGER NOT NULL,
  control_seq_cutoff INTEGER NOT NULL,
  PRIMARY KEY (session_id, round)
);

CREATE TABLE pending_instructions (
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  instruction_id TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','applied')),
  interrupted INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  control_seq INTEGER NOT NULL,
  applied_round INTEGER,
  PRIMARY KEY (session_id, instruction_id)
);

CREATE TABLE dialogue (
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  seq INTEGER NOT NULL,
  round INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  world_version INTEGER NOT NULL,
  speaker TEXT NOT NULL,
  listeners_json TEXT NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('speech','advice','question','answer')),
  proposal_id TEXT,
  decision_id TEXT,
  payload_json TEXT,
  inherited INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE narrations (
  narration_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  batch_id TEXT,
  scene TEXT NOT NULL,
  event_versions_json TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok','fallback','failed')),
  raw TEXT,
  header TEXT NOT NULL,
  displayed TEXT NOT NULL,
  check_json TEXT NOT NULL,
  control_seq INTEGER NOT NULL
);

CREATE TABLE llm_calls (
  call_id TEXT PRIMARY KEY,
  session_id TEXT,
  ts TEXT NOT NULL,
  role TEXT NOT NULL,
  actor TEXT,
  round INTEGER,
  call_tag TEXT,
  model TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL,
  cost_source TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  status TEXT NOT NULL,
  record_json TEXT NOT NULL
);

CREATE TABLE llm_attempts (
  call_id TEXT NOT NULL REFERENCES llm_calls(call_id),
  attempt_no INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  generation_id TEXT,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL,
  cost_source TEXT NOT NULL,
  reconciled INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY (call_id, attempt_no)
);
`,
  },
  {
    version: 2,
    name: 'proposals.probe (scripted enforcement probes, PLAN §12.4)',
    sql: `ALTER TABLE proposals ADD COLUMN probe INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    version: 3,
    name: 'intake evidence, pause metadata, persistent id allocation',
    sql: `
ALTER TABLE proposals ADD COLUMN intake TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE proposals ADD COLUMN intake_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE pauses ADD COLUMN meta_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE llm_calls ADD COLUMN client_call_id TEXT;
CREATE TABLE id_counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
`,
  },
  {
    version: 4,
    name: 'dialogue.control_at (control position at emission, for chronological transcripts)',
    sql: `
ALTER TABLE dialogue ADD COLUMN control_at INTEGER;
`,
  },
];

/** Applies pending migrations inside one transaction each; returns the resulting schema version. */
export function migrate(db: DatabaseSync): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null } | undefined;
  let current = row?.v ?? 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(m.version, m.name);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    current = m.version;
  }
  return current;
}
