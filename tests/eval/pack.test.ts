/**
 * Pack (PLAN §14): no `.env`, no keys, no credential headers, no raw WAL/SHM; databases via VACUUM INTO with their
 * text redacted. Tested with a synthetic key and paths containing spaces. Never touches the real `.env`.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { excludedReason, packDir } from '../../src/eval/pack.js';
import { buildZip, readZip } from '../../src/eval/zip.js';
import { tempDir } from './helpers.js';

const SYNTHETIC_KEY = 'sk-or-v1-synthetic0123456789abcdefABCDEF0123456789';
const OTHER_SECRET = 'plain-secret-value-9f8e7d6c5b4a';

describe('zip writer/reader', () => {
  it('round-trips UTF-8 names and binary data', () => {
    const entries = [
      { name: 'dir with space/说明.md', data: Buffer.from('你好, 世界\n', 'utf8') },
      { name: 'bin.dat', data: Buffer.from([0, 1, 2, 255, 254]) },
    ];
    const back = readZip(buildZip(entries));
    expect(back.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    expect(back.map((e) => Buffer.from(e.data).toString('base64'))).toEqual(entries.map((e) => e.data.toString('base64')));
  });
});

describe('pack', () => {
  it('excludes env files, WAL/SHM, key material and header dumps', () => {
    expect(excludedReason('.env')).not.toBeNull();
    expect(excludedReason('sub/.env.local')).not.toBeNull();
    expect(excludedReason('.env.example')).toBeNull();
    expect(excludedReason('run.sqlite-wal')).not.toBeNull();
    expect(excludedReason('run.sqlite-shm')).not.toBeNull();
    expect(excludedReason('id_rsa')).not.toBeNull();
    expect(excludedReason('server.pem')).not.toBeNull();
    expect(excludedReason('headers.txt')).not.toBeNull();
    expect(excludedReason('audit/events.jsonl')).toBeNull();
  });

  it('packs a run folder (path with spaces) without the synthetic key anywhere, with a vacuumed redacted database', () => {
    const root = tempDir('jinyang pack test ');
    const runDir = path.join(root, 'my runs', 'exp 1');
    mkdirSync(path.join(runDir, 'C1 full r1', 'audit'), { recursive: true });
    writeFileSync(path.join(runDir, '.env'), `OPENROUTER_API_KEY=${SYNTHETIC_KEY}\n`);
    writeFileSync(path.join(runDir, 'headers.txt'), `Authorization: Bearer ${SYNTHETIC_KEY}\n`);
    writeFileSync(path.join(runDir, 'C1 full r1', 'audit', 'llm_calls.jsonl'), `${JSON.stringify({ call_id: 'c1', error: `401 with key ${SYNTHETIC_KEY}`, other: OTHER_SECRET })}\n`);
    writeFileSync(path.join(runDir, 'notes.md'), `debug:\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz\nx-api-key: ${OTHER_SECRET}\nOPENROUTER_API_KEY=${OTHER_SECRET}\n`);
    // A live WAL database with the key in a text column.
    const dbFile = path.join(runDir, 'C1 full r1', 'run.sqlite');
    const db = new DatabaseSync(dbFile);
    db.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT); ');
    db.prepare('INSERT INTO t (note) VALUES (?)').run(`leaked ${SYNTHETIC_KEY} in a log`);
    db.prepare('INSERT INTO t (note) VALUES (?)').run('harmless');
    expect(existsSync(`${dbFile}-wal`)).toBe(true);
    const zip = path.join(root, 'my runs', 'exp 1.zip');
    let result: ReturnType<typeof packDir>;
    try {
      result = packDir(runDir, zip, { extraSecrets: [SYNTHETIC_KEY, OTHER_SECRET] });
    } finally {
      db.close();
    }
    const raw = readFileSync(zip);
    const entries = readZip(raw);
    const names = entries.map((e) => e.name);
    expect(names.some((n) => n.endsWith('/.env'))).toBe(false);
    expect(names.some((n) => /-(wal|shm)$/.test(n))).toBe(false);
    expect(names.some((n) => n.endsWith('headers.txt'))).toBe(false);
    expect(names).toContain('exp 1/C1 full r1/run.sqlite');
    expect(names).toContain('exp 1/PACK_MANIFEST.json');
    const excluded = result.excluded.map((e) => path.basename(e.file));
    for (const f of ['.env', 'headers.txt', 'run.sqlite-wal']) expect(excluded).toContain(f);
    for (const e of entries) {
      const text = Buffer.from(e.data).toString('latin1');
      expect(text.includes(SYNTHETIC_KEY)).toBe(false);
      expect(Buffer.from(e.data).includes(Buffer.from(OTHER_SECRET))).toBe(false);
      expect(/Bearer [A-Za-z0-9]{12,}/.test(text)).toBe(false);
    }
    const notes = Buffer.from(entries.find((e) => e.name.endsWith('notes.md'))?.data ?? []).toString('utf8');
    expect(notes).toContain('Authorization: [REDACTED]');
    // The packed database is a proper SQLite file (VACUUM INTO), its text redacted, the harmless row intact.
    const dbEntry = entries.find((e) => e.name.endsWith('run.sqlite'));
    expect(Buffer.from(dbEntry?.data ?? []).subarray(0, 15).toString('latin1')).toBe('SQLite format 3');
    const out = path.join(root, 'extracted.sqlite');
    writeFileSync(out, Buffer.from(dbEntry?.data ?? []));
    const check = new DatabaseSync(out);
    try {
      const rows = check.prepare('SELECT note FROM t ORDER BY id').all() as Array<{ note: string }>;
      expect(rows.map((r) => r.note)).toEqual(['leaked [REDACTED] in a log', 'harmless']);
    } finally {
      check.close();
    }
  });
});
