/**
 * SQLite store on `node:sqlite` (PLAN §1): WAL, foreign_keys=ON, busy_timeout=5000, one writer per DB file
 * (lock file), short synchronous transactions (never `await` inside one).
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WriterLock } from './lock.js';
import { migrate } from './migrations.js';

export interface OpenStoreOptions {
  /** Open without the writer lock and without writing (inspection of exports). */
  readOnly?: boolean;
}

export class Store {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly readOnly: boolean;
  private lock: WriterLock | null;
  private depth = 0;
  private closed = false;

  private constructor(db: DatabaseSync, filePath: string, lock: WriterLock | null, readOnly: boolean) {
    this.db = db;
    this.path = filePath;
    this.lock = lock;
    this.readOnly = readOnly;
  }

  static open(filePath: string, opts: OpenStoreOptions = {}): Store {
    const memory = filePath === ':memory:';
    const abs = memory ? filePath : path.resolve(filePath);
    const readOnly = opts.readOnly ?? false;
    if (!memory && !readOnly) mkdirSync(path.dirname(abs), { recursive: true });
    const lock = memory || readOnly ? null : WriterLock.acquire(abs);
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(abs, { enableForeignKeyConstraints: true, timeout: 5000, readOnly });
      db.exec('PRAGMA busy_timeout = 5000');
      if (!readOnly) {
        if (!memory) db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA synchronous = NORMAL');
        migrate(db);
      }
    } catch (err) {
      lock?.release();
      throw err;
    }
    return new Store(db, abs, lock, readOnly);
  }

  get inTransaction(): boolean {
    return this.depth > 0;
  }

  /**
   * Runs `fn` in one `BEGIN IMMEDIATE … COMMIT`. Any exception rolls everything back and is rethrown.
   * Nested calls join the outer transaction. `fn` must be synchronous.
   */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth += 1;
      try {
        return fn();
      } finally {
        this.depth -= 1;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const result = fn();
      if (result instanceof Promise) throw new Error('transactions must be synchronous (never await inside one)');
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.depth = 0;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } finally {
      this.lock?.release();
      this.lock = null;
    }
  }
}
