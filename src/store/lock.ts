/**
 * Single-writer lock (PLAN §1) held by the operating system: the writer opens a companion SQLite file
 * `<db>.writer-lock` with `PRAGMA locking_mode = EXCLUSIVE` and takes its exclusive lock, keeping that connection
 * open for its whole lifetime. Any other connection — another process, or another store in this process — gets
 * SQLITE_BUSY and refuses to start. The OS releases the lock when the owner closes it or dies (crash, kill), so
 * there is no stale-lock detection or reclamation at all.
 */
import { DatabaseSync } from 'node:sqlite';

export class LockError extends Error {
  readonly lockPath: string;
  /** Always null: the owner of an OS lock cannot be read while it holds the lock. */
  readonly ownerPid: number | null;
  constructor(message: string, lockPath: string) {
    super(message);
    this.name = 'LockError';
    this.lockPath = lockPath;
    this.ownerPid = null;
  }
}

function isBusy(err: unknown): boolean {
  const e = err as { errcode?: number; code?: string; message?: string };
  return e.errcode === 5 || e.errcode === 6 || /locked|busy/i.test(e.message ?? '');
}

export class WriterLock {
  readonly lockPath: string;
  private connection: DatabaseSync | null;

  private constructor(lockPath: string, connection: DatabaseSync) {
    this.lockPath = lockPath;
    this.connection = connection;
  }

  /** Acquires the writer lock of `dbPath` or throws LockError if another writer holds it. */
  static acquire(dbPath: string): WriterLock {
    const lockPath = `${dbPath}.writer-lock`;
    let connection: DatabaseSync;
    try {
      connection = new DatabaseSync(lockPath, { timeout: 0 });
    } catch (err) {
      throw new LockError(`cannot open the writer lock ${lockPath}: ${(err as Error).message}`, lockPath);
    }
    try {
      connection.exec('PRAGMA locking_mode = EXCLUSIVE');
      // The exclusive lock taken by this write transaction is kept after COMMIT until the connection closes.
      connection.exec('BEGIN EXCLUSIVE');
      connection.exec('CREATE TABLE IF NOT EXISTS writer (pid INTEGER NOT NULL, since TEXT NOT NULL)');
      connection.exec('DELETE FROM writer');
      connection.prepare('INSERT INTO writer (pid, since) VALUES (?, ?)').run(process.pid, new Date().toISOString());
      connection.exec('COMMIT');
    } catch (err) {
      try {
        connection.close();
      } catch {
        /* already unusable */
      }
      if (isBusy(err)) {
        throw new LockError(`database ${dbPath} is already open for writing by another connection or process`, lockPath);
      }
      throw new LockError(`cannot take the writer lock ${lockPath}: ${(err as Error).message}`, lockPath);
    }
    return new WriterLock(lockPath, connection);
  }

  get held(): boolean {
    return this.connection !== null;
  }

  /** Releases the lock (closing the connection); the OS does the same if the process dies. */
  release(): void {
    const connection = this.connection;
    this.connection = null;
    connection?.close();
  }
}
