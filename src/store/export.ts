/**
 * Exports (PLAN §1, §13.3): a consistent copy of the database via `VACUUM INTO` (never a raw copy of a WAL
 * database), and the per-session audit bundle as JSONL files.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { redactSecrets } from '../llm/redact.js';
import type { Store } from './db.js';
import type { Repo } from './repo.js';

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

/** Writes a self-contained copy of the database to `destPath` (must not exist). */
export function vacuumInto(store: Store, destPath: string): string {
  const dest = path.resolve(destPath);
  if (existsSync(dest)) throw new ExportError(`export target exists: ${dest}`);
  if (store.inTransaction) throw new ExportError('cannot export inside a transaction');
  mkdirSync(path.dirname(dest), { recursive: true });
  store.db.prepare('VACUUM INTO ?').run(dest);
  return dest;
}

type Row = Record<string, unknown>;

/** JSON columns are decoded so the bundle is plain JSON (column name suffix `_json` is dropped). */
function decodeRow(row: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.endsWith('_json') && typeof value === 'string') out[key.slice(0, -5)] = JSON.parse(value);
    else out[key] = value;
  }
  return out;
}

/** Every exported line passes credential redaction (a safety net behind redaction at intake). */
function writeJsonl(file: string, rows: Row[]): void {
  writeFileSync(file, rows.map((r) => `${redactSecrets(JSON.stringify(decodeRow(r)))}\n`).join(''), 'utf8');
}

export const AUDIT_FILES = [
  'session.json',
  'snapshots.jsonl',
  'events.jsonl',
  'batches.jsonl',
  'proposals.jsonl',
  'epochs.jsonl',
  'requests.jsonl',
  'pauses.jsonl',
  'decisions.jsonl',
  'dialogue.jsonl',
  'narrations.jsonl',
  'round_starts.jsonl',
  'pending_instructions.jsonl',
  'llm_calls.jsonl',
  'llm_attempts.jsonl',
] as const;

/**
 * Audit bundle of one session. A branch child's bundle references its parent's prefix through the lineage in
 * `session.json` (control records stay in the parent).
 */
export function exportAudit(repo: Repo, sessionId: string, dir: string): string[] {
  const session = repo.getSession(sessionId);
  mkdirSync(dir, { recursive: true });
  const lineage =
    session.parentSessionId === null
      ? null
      : { parentSessionId: session.parentSessionId, parentRound: session.parentRound, parentVersion: session.parentVersion };
  writeFileSync(
    path.join(dir, 'session.json'),
    `${redactSecrets(JSON.stringify({ ...session, lineage, auditFormat: 1 }, null, 2))}\n`,
    'utf8',
  );
  writeJsonl(path.join(dir, 'snapshots.jsonl'), repo.rawRows('snapshots', sessionId, 'version'));
  writeJsonl(path.join(dir, 'events.jsonl'), repo.rawRows('events', sessionId, 'version'));
  writeJsonl(path.join(dir, 'batches.jsonl'), repo.rawRows('batches', sessionId, 'control_seq'));
  writeJsonl(path.join(dir, 'proposals.jsonl'), repo.rawRows('proposals', sessionId, 'control_seq'));
  writeJsonl(path.join(dir, 'epochs.jsonl'), repo.rawRows('epochs', sessionId, 'epoch'));
  writeJsonl(path.join(dir, 'requests.jsonl'), repo.rawRows('requests', sessionId, 'control_seq'));
  writeJsonl(path.join(dir, 'pauses.jsonl'), repo.rawRows('pauses', sessionId, 'control_seq'));
  writeJsonl(path.join(dir, 'decisions.jsonl'), repo.rawRows('decisions', sessionId, 'control_seq'));
  writeJsonl(path.join(dir, 'dialogue.jsonl'), repo.rawRows('dialogue', sessionId, 'seq'));
  writeJsonl(path.join(dir, 'narrations.jsonl'), repo.rawRows('narrations', sessionId, 'narration_id'));
  writeJsonl(path.join(dir, 'round_starts.jsonl'), repo.rawRows('round_starts', sessionId, 'round'));
  writeJsonl(path.join(dir, 'pending_instructions.jsonl'), repo.rawRows('pending_instructions', sessionId, 'control_seq'));
  writeJsonl(path.join(dir, 'llm_calls.jsonl'), repo.rawRows('llm_calls', sessionId, 'rowid'));
  writeJsonl(path.join(dir, 'llm_attempts.jsonl'), repo.attemptRowsForSession(sessionId));
  return AUDIT_FILES.map((f) => path.join(dir, f));
}
