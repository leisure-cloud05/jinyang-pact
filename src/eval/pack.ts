/**
 * Pack a run folder for sending back (PLAN §14): a ZIP that never contains `.env` files, keys, credential headers
 * or raw SQLite WAL/SHM files. Databases are exported with `VACUUM INTO` (never a raw copy of a WAL database), their
 * text columns redacted and the copy vacuumed again so no freed page keeps the old text. Every text file passes
 * credential redaction (registered key, `sk-or-…`, `Bearer …`, credential header lines). Any file whose bytes still
 * contain a secret pattern is left out. A manifest of included and excluded files goes into the ZIP.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { redactSecrets } from '../llm/redact.js';
import { buildZip, type ZipEntry } from './zip.js';

export interface PackOptions {
  /** Additional secret values to redact (tests use a synthetic key; the CLI passes the configured key). */
  extraSecrets?: readonly string[];
  now?: () => Date;
}

export interface PackResult {
  zipPath: string;
  included: string[];
  excluded: Array<{ file: string; reason: string }>;
}

const TEXT_EXT = new Set(['.json', '.jsonl', '.md', '.csv', '.txt', '.html', '.htm', '.svg', '.yaml', '.yml', '.log', '.ts', '.js', '.tsv', '.xml']);
const DB_EXT = new Set(['.sqlite', '.sqlite3', '.db']);

export function excludedReason(rel: string): string | null {
  const base = path.basename(rel).toLowerCase();
  if (/^\.env($|\.)/.test(base) && base !== '.env.example') return 'environment file';
  if (/(^|[-_.])(wal|shm|journal)$/.test(base) || base.endsWith('-wal') || base.endsWith('-shm') || base.endsWith('-journal')) return 'raw SQLite WAL/SHM/journal (databases are exported with VACUUM INTO)';
  if (base.endsWith('.lock')) return 'lock file';
  if (/\.(pem|key|p12|pfx)$/.test(base) || /^id_(rsa|ed25519|ecdsa)/.test(base)) return 'key material';
  if (/^(headers?|request[-_]headers?)(\.|$)/.test(base)) return 'request headers';
  return null;
}

const HEADER_LINE = /^(\s*["']?(?:authorization|proxy-authorization|x-api-key|api-key|openrouter-api-key|cookie|set-cookie)["']?\s*[:=]\s*).+$/gim;
const KEY_ASSIGN = /\b(OPENROUTER_API_KEY\s*[=:]\s*)\S+/g;

export function redactText(text: string, extra: readonly string[] = []): string {
  return redactSecrets(text, extra).replace(HEADER_LINE, '$1[REDACTED]').replace(KEY_ASSIGN, '$1[REDACTED]');
}

function containsSecret(bytes: Buffer, extra: readonly string[]): boolean {
  const latin = bytes.toString('latin1');
  if (/sk-or-[A-Za-z0-9_-]{6,}/.test(latin)) return true;
  if (/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/.test(latin)) return true;
  for (const s of extra) if (s.length >= 8 && bytes.includes(Buffer.from(s, 'utf8'))) return true;
  return false;
}

function walk(dir: string, root: string, skip: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (path.resolve(full) === path.resolve(skip)) continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, root, skip, out);
    else out.push(path.relative(root, full));
  }
}

/** VACUUM INTO a temp copy, redact every text column, vacuum again; returns the bytes. */
export function exportDatabase(file: string, extra: readonly string[]): Buffer {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'jinyang pack '));
  const copy = path.join(tmp, 'copy.sqlite');
  try {
    const src = new DatabaseSync(file, { readOnly: true });
    try {
      src.prepare('VACUUM INTO ?').run(copy);
    } finally {
      src.close();
    }
    const db = new DatabaseSync(copy);
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
      for (const { name } of tables) {
        const cols = db.prepare(`PRAGMA table_info("${name.replace(/"/g, '""')}")`).all() as Array<{ name: string }>;
        for (const { name: col } of cols) {
          const q = `"${col.replace(/"/g, '""')}"`;
          const t = `"${name.replace(/"/g, '""')}"`;
          const rows = db.prepare(`SELECT rowid AS rid, ${q} AS v FROM ${t} WHERE typeof(${q}) = 'text'`).all() as Array<{ rid: number; v: string }>;
          const update = db.prepare(`UPDATE ${t} SET ${q} = ? WHERE rowid = ?`);
          for (const r of rows) {
            const red = redactText(r.v, extra);
            if (red !== r.v) update.run(red, r.rid);
          }
        }
      }
      db.exec('VACUUM');
    } finally {
      db.close();
    }
    return readFileSync(copy);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function packDir(dir: string, zipPath: string, opts: PackOptions = {}): PackResult {
  const root = path.resolve(dir);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`not a directory: ${root}`);
  const extra = opts.extraSecrets ?? [];
  const files: string[] = [];
  walk(root, root, zipPath, files);
  const entries: ZipEntry[] = [];
  const included: string[] = [];
  const excluded: PackResult['excluded'] = [];
  const prefix = path.basename(root);
  for (const rel of files) {
    const reason = excludedReason(rel);
    if (reason) {
      excluded.push({ file: rel, reason });
      continue;
    }
    const full = path.join(root, rel);
    const ext = path.extname(rel).toLowerCase();
    let data: Buffer;
    if (DB_EXT.has(ext)) {
      try {
        data = exportDatabase(full, extra);
      } catch (err) {
        excluded.push({ file: rel, reason: `database export failed: ${(err as Error).message}` });
        continue;
      }
    } else if (TEXT_EXT.has(ext) || ext === '') {
      data = Buffer.from(redactText(readFileSync(full, 'utf8'), extra), 'utf8');
    } else {
      data = readFileSync(full);
    }
    if (containsSecret(data, extra)) {
      excluded.push({ file: rel, reason: 'still contains a secret pattern after redaction' });
      continue;
    }
    entries.push({ name: `${prefix}/${rel.replace(/\\/g, '/')}`, data });
    included.push(rel);
  }
  const manifest = { packedAt: (opts.now ?? (() => new Date()))().toISOString(), root: prefix, included, excluded };
  entries.push({ name: `${prefix}/PACK_MANIFEST.json`, data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') });
  writeFileSync(zipPath, buildZip(entries));
  return { zipPath, included, excluded };
}
