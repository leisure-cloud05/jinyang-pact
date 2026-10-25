/** Regression tests for Codex review 15 finding 1 (lock race) and finding 8 (usage ids after restart). */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Store } from '../../src/store/db.js';
import { LockError, WriterLock } from '../../src/store/lock.js';
import { SqliteUsageSink } from '../../src/store/usage.js';
import { REPO_ROOT } from '../core/helpers.js';
import { tempDir } from '../harness/helpers.js';

function runChild(script: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script, ...args], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', () => resolve(out.trim() || `no output: ${err.trim().slice(0, 300)}`));
  });
}

describe('single-writer lock: OS-level, dies with its owner', () => {
  function racerScript(dir: string): string {
    const script = path.join(dir, 'racer.ts');
    const lockModule = pathToFileURL(path.join(REPO_ROOT, 'src', 'store', 'lock.ts')).href;
    writeFileSync(
      script,
      `import { WriterLock, LockError } from ${JSON.stringify(lockModule)};
const [db, startAt, holdMs] = process.argv.slice(2);
while (Date.now() < Number(startAt)) { /* align the start of all racers */ }
try {
  const lock = WriterLock.acquire(db!);
  process.stdout.write('acquired\\n');
  if (Number(holdMs) < 0) setInterval(() => {}, 1000); // hold until killed
  else setTimeout(() => lock.release(), Number(holdMs));
} catch (err) {
  process.stdout.write(err instanceof LockError ? 'refused\\n' : 'error ' + String(err) + '\\n');
}
`,
    );
    return script;
  }

  it('exactly one of several processes racing for the same lock acquires it', async () => {
    const dir = tempDir();
    const db = path.join(dir, 'raced db.sqlite');
    const script = racerScript(dir);
    const startAt = String(Date.now() + 6000);
    const results = await Promise.all(Array.from({ length: 6 }, () => runChild(script, [db, startAt, '4000'])));
    expect(results.filter((r) => r === 'acquired')).toHaveLength(1);
    expect(results.filter((r) => r === 'refused')).toHaveLength(5);
  }, 60_000);

  it('a killed owner releases the lock without any stale-lock handling', async () => {
    const dir = tempDir();
    const db = path.join(dir, 'killed owner.sqlite');
    const script = racerScript(dir);
    const child = spawn(process.execPath, ['--import', 'tsx', script, db, '0', '-1'], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (d: Buffer) => {
        if (d.toString().includes('acquired')) resolve();
      });
      child.on('error', reject);
      child.on('close', () => reject(new Error('owner exited early')));
    });
    expect(() => WriterLock.acquire(db)).toThrow(LockError); // held by the live child
    const exited = new Promise((resolve) => child.on('close', resolve));
    child.kill('SIGKILL');
    await exited;
    const lock = WriterLock.acquire(db); // the OS released it with the dead process
    expect(lock.held).toBe(true);
    lock.release();
  }, 60_000);

  it('refuses a second writer in the same process and re-acquires after release', () => {
    const db = path.join(tempDir(), 'same process.sqlite');
    const first = WriterLock.acquire(db);
    expect(() => WriterLock.acquire(db)).toThrow(/already open for writing/);
    first.release();
    expect(first.held).toBe(false);
    const second = WriterLock.acquire(db);
    second.release();
  });

  it('an unrelated file at the lock path is not taken over', () => {
    const db = path.join(tempDir(), 'garbage.sqlite');
    writeFileSync(`${db}.writer-lock`, 'this is not a database');
    expect(() => WriterLock.acquire(db)).toThrow(LockError);
    expect(readFileSync(`${db}.writer-lock`, 'utf8')).toBe('this is not a database');
  });
});

describe('usage records survive client restarts', () => {
  it('allocates database-unique call ids across restarts and never drops a record', () => {
    const db = path.join(tempDir(), 'usage restart.sqlite');
    const call = {
      callId: 'call-000001', // the client's per-process counter restarts here
      ts: 't',
      role: 'character' as const,
      model: 'mock',
      promptHash: 'p',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: null,
      costSource: 'none' as const,
      latencyMs: 1,
      attempts: 1,
      status: 'ok' as const,
    };
    const attempt = { callId: 'call-000001', attemptNo: 1, kind: 'first' as const, status: 'ok' as const, latencyMs: 1, generationId: 'g', inputTokens: 1, outputTokens: 1, costUsd: null, costSource: 'none' as const, reconciled: false };
    const first = Store.open(db);
    const id1 = new SqliteUsageSink(first, 's').record(call, [attempt]);
    first.close();
    const second = Store.open(db); // process restart
    const sink = new SqliteUsageSink(second, 's');
    const id2 = sink.record(call, [attempt]);
    const id3 = sink.record(call, [attempt]); // even a repeated record is kept
    expect([id1, id2, id3]).toEqual(['llm-000001', 'llm-000002', 'llm-000003']);
    const listed = sink.list('s');
    expect(listed.map((r) => [r.call.callId, (r.call as { clientCallId?: string }).clientCallId, r.attempts.map((a) => a.callId)])).toEqual([
      ['llm-000001', 'call-000001', ['llm-000001']],
      ['llm-000002', 'call-000001', ['llm-000002']],
      ['llm-000003', 'call-000001', ['llm-000003']],
    ]);
    second.close();
  });
});
