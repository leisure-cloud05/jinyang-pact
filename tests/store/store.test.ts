import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LlmAttemptRecord, LlmCallRecord } from '../../src/llm/types.js';
import { Store } from '../../src/store/db.js';
import { ExportError, vacuumInto } from '../../src/store/export.js';
import { LockError } from '../../src/store/lock.js';
import { MIGRATIONS } from '../../src/store/migrations.js';
import { Repo } from '../../src/store/repo.js';
import { SqliteUsageSink } from '../../src/store/usage.js';
import { tempDir } from '../harness/helpers.js';

function open(dbPath: string): Store {
  return Store.open(dbPath);
}

describe('store: connection and schema', () => {
  it('uses WAL, foreign keys and a 5 s busy timeout, and applies migrations once', () => {
    const dir = tempDir();
    const db = path.join(dir, 'a b.sqlite');
    const s = open(db);
    try {
      expect(s.db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
      expect(s.db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
      expect(s.db.prepare('PRAGMA busy_timeout').get()).toMatchObject({ timeout: 5000 });
      expect(s.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toMatchObject({ v: MIGRATIONS.length });
    } finally {
      s.close();
    }
    const again = open(db);
    expect(again.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toMatchObject({ n: MIGRATIONS.length });
    again.close();
  });

  it('rolls back every write of a failed transaction', () => {
    const s = open(path.join(tempDir(), 'tx.sqlite'));
    try {
      const count = () => (s.db.prepare('SELECT COUNT(*) AS n FROM llm_calls').get() as { n: number }).n;
      expect(() =>
        s.transaction(() => {
          s.db.prepare(`INSERT INTO llm_calls (call_id, ts, role, model, prompt_hash, input_tokens, output_tokens, cost_source,
            latency_ms, attempts, status, record_json) VALUES ('c1', 't', 'character', 'm', 'h', 1, 1, 'none', 1, 1, 'ok', '{}')`).run();
          throw new Error('boom');
        }),
      ).toThrow('boom');
      expect(count()).toBe(0);
      expect(s.inTransaction).toBe(false);
      expect(() => s.transaction(() => Promise.resolve(1) as unknown as number)).toThrow('synchronous');
    } finally {
      s.close();
    }
  });
});

describe('store: single-writer lock', () => {
  it('refuses a second writer on the same file until the first closes', () => {
    const db = path.join(tempDir(), 'locked db.sqlite');
    const first = open(db);
    expect(() => open(db)).toThrow(LockError);
    first.close();
    const second = open(db);
    second.close();
  });

  it('read-only opens take no lock', () => {
    const db = path.join(tempDir(), 'ro.sqlite');
    const writer = open(db);
    const reader = Store.open(db, { readOnly: true });
    expect(reader.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toMatchObject({ n: 0 });
    reader.close();
    writer.close();
  });
});

describe('store: VACUUM INTO export', () => {
  it('writes a consistent copy to a path with spaces that can be reopened', () => {
    const dir = tempDir();
    const s = open(path.join(dir, 'live.sqlite'));
    const sink = new SqliteUsageSink(s, 'sess');
    sink.record(
      {
        callId: 'call-1',
        ts: '2026-09-28T00:00:00Z',
        role: 'character',
        model: 'mock',
        promptHash: 'h',
        inputTokens: 10,
        outputTokens: 5,
        costUsd: null,
        costSource: 'none',
        latencyMs: 3,
        attempts: 1,
        status: 'ok',
      },
      [],
    );
    const target = path.join(dir, 'exports with spaces', 'copy of db.sqlite');
    expect(vacuumInto(s, target)).toBe(target);
    expect(() => vacuumInto(s, target)).toThrow(ExportError);
    s.close();
    const copy = Store.open(target, { readOnly: true });
    expect(copy.db.prepare('SELECT call_id, client_call_id FROM llm_calls').all()).toEqual([{ call_id: 'llm-000001', client_call_id: 'call-1' }]);
    copy.close();
  });
});

describe('store: SqliteUsageSink', () => {
  it('records one llm_calls row per call and one llm_attempts row per attempt, redacted', () => {
    const s = open(path.join(tempDir(), 'usage.sqlite'));
    try {
      const sink = new SqliteUsageSink(s);
      const secret = 'sk-or-v1-0123456789abcdefSYNTHETIC';
      const call: LlmCallRecord = {
        callId: 'call-7',
        ts: '2026-09-28T00:00:00Z',
        role: 'judge',
        actor: 'shi_jingtang',
        sessionId: 'sess-1',
        round: 2,
        callTag: 'judge',
        model: 'deepseek/deepseek-v4-flash',
        promptHash: 'abc',
        inputTokens: 120,
        outputTokens: 30,
        costUsd: 0.0001,
        costSource: 'reported',
        latencyMs: 800,
        attempts: 2,
        status: 'ok',
        error: `upstream said ${secret}`,
      };
      const attempts: LlmAttemptRecord[] = [
        { callId: 'call-7', attemptNo: 1, kind: 'first', status: 'parse', latencyMs: 400, generationId: 'gen-a', inputTokens: 60, outputTokens: 15, costUsd: 0.00005, costSource: 'reported', reconciled: false },
        { callId: 'call-7', attemptNo: 2, kind: 'repair', status: 'ok', latencyMs: 400, generationId: 'gen-b', inputTokens: 60, outputTokens: 15, costUsd: 0.00005, costSource: 'reported', reconciled: false },
      ];
      sink.record(call, attempts);
      const listed = sink.list('sess-1');
      expect(listed).toHaveLength(1);
      expect(listed[0]?.attempts.map((a) => [a.kind, a.generationId])).toEqual([['first', 'gen-a'], ['repair', 'gen-b']]);
      expect(JSON.stringify(listed)).not.toContain(secret);
      expect(JSON.stringify(listed)).toContain('[REDACTED]');
      const repo = new Repo(s);
      expect(repo.attemptRowsForSession('sess-1')).toHaveLength(2);
    } finally {
      s.close();
    }
  });
});
