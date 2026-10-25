/**
 * `UsageSink` (src/llm) persisting one `llm_calls` row per logical call and one `llm_attempts` row per attempt
 * (PLAN §9 cost record contract). Records are redacted before they are written. Each record is its own short
 * transaction (or joins the caller's), so usage is never lost with a rolled-back world transaction.
 *
 * Call ids: the client's ids restart with the process, so every record gets a database-unique id from a
 * persistent allocator (`llm-000001`, …) used for the call and all its attempts; the client's id is kept as
 * `client_call_id`. Every record is stored — a repeated client id is never silently dropped.
 */
import { redactSecrets } from '../llm/redact.js';
import type { LlmAttemptRecord, LlmCallRecord, UsageSink } from '../llm/types.js';
import type { Store } from './db.js';
import { Repo } from './repo.js';

function redacted<T>(value: T): T {
  return JSON.parse(redactSecrets(JSON.stringify(value))) as T;
}

export class SqliteUsageSink implements UsageSink {
  private readonly store: Store;
  /** Session attributed to calls whose record carries none. */
  private readonly defaultSessionId: string | null;

  constructor(store: Store, defaultSessionId: string | null = null) {
    this.store = store;
    this.defaultSessionId = defaultSessionId;
  }

  /** Stores the records; returns the database-unique call id used for the call and its attempts. */
  record(callIn: LlmCallRecord, attemptsIn: readonly LlmAttemptRecord[]): string {
    const db = this.store.db;
    return this.store.transaction(() => {
      const id = `llm-${String(new Repo(this.store).nextCounter('llm_call')).padStart(6, '0')}`;
      const call = { ...redacted(callIn), callId: id, clientCallId: callIn.callId };
      const attempts = attemptsIn.map((a) => ({ ...redacted(a), callId: id }));
      db.prepare(
        `INSERT INTO llm_calls (call_id, session_id, ts, role, actor, round, call_tag, model, prompt_hash, input_tokens,
          output_tokens, cost_usd, cost_source, latency_ms, attempts, status, record_json, client_call_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        call.callId,
        call.sessionId ?? this.defaultSessionId,
        call.ts,
        call.role,
        call.actor ?? null,
        call.round ?? null,
        call.callTag ?? null,
        call.model,
        call.promptHash,
        call.inputTokens,
        call.outputTokens,
        call.costUsd,
        call.costSource,
        call.latencyMs,
        call.attempts,
        call.status,
        JSON.stringify(call),
        redacted(callIn.callId),
      );
      const insert = db.prepare(
        `INSERT INTO llm_attempts (call_id, attempt_no, kind, status, latency_ms, generation_id, input_tokens, output_tokens,
          cost_usd, cost_source, reconciled, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const a of attempts) {
        insert.run(
          a.callId,
          a.attemptNo,
          a.kind,
          a.status,
          a.latencyMs,
          a.generationId,
          a.inputTokens,
          a.outputTokens,
          a.costUsd,
          a.costSource,
          a.reconciled ? 1 : 0,
          JSON.stringify(a),
        );
      }
      return id;
    });
  }

  /** Stored call records (optionally for one session), with their attempts. */
  list(sessionId?: string): Array<{ call: LlmCallRecord; attempts: LlmAttemptRecord[] }> {
    const db = this.store.db;
    const calls = (
      sessionId === undefined
        ? db.prepare('SELECT record_json FROM llm_calls ORDER BY rowid').all()
        : db.prepare('SELECT record_json FROM llm_calls WHERE session_id = ? ORDER BY rowid').all(sessionId)
    ) as Array<{ record_json: string }>;
    const attemptsOf = db.prepare('SELECT record_json FROM llm_attempts WHERE call_id = ? ORDER BY attempt_no');
    return calls.map((row) => {
      const call = JSON.parse(row.record_json) as LlmCallRecord;
      const attempts = (attemptsOf.all(call.callId) as Array<{ record_json: string }>).map(
        (a) => JSON.parse(a.record_json) as LlmAttemptRecord,
      );
      return { call, attempts };
    });
  }
}
