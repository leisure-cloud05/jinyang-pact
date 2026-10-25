/**
 * Shared harness plumbing: errors, the context passed between harness modules, deterministic control ids and the
 * idempotent request wrapper (H06): every mutating operation runs in one `BEGIN IMMEDIATE` transaction keyed by
 * `(sessionId, requestId)`; a repeat with the same payload hash returns the stored result, a different payload
 * under a used id is rejected, and any exception rolls everything back (nothing is recorded).
 */
import { hashValue } from '../core/hash.js';
import { redactSecrets } from '../llm/redact.js';
import type { RuleId } from '../core/types.js';
import type { Store } from '../store/db.js';
import type { Repo } from '../store/repo.js';

export type HarnessErrorCode = RuleId | 'not_found' | 'invalid_state' | 'invalid_decision' | 'terminal';

export class HarnessError extends Error {
  readonly code: HarnessErrorCode;
  constructor(code: HarnessErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'HarnessError';
    this.code = code;
  }
}

/** Points inside a commit transaction where tests can inject faults. */
export type CommitStage = 'executed' | 'events_written' | 'proposals_written' | 'before_commit' | 'regenerate';

export interface HarnessHooks {
  /** Called inside the transaction; throwing aborts and rolls back the whole operation. */
  onStage?(stage: CommitStage, info: { sessionId: string; batchId: string | null }): void;
}

export interface HarnessContext {
  store: Store;
  repo: Repo;
  clock: () => string;
  hooks: HarnessHooks;
  /** Abort controller of the current epoch's in-flight calls, per session. */
  aborts: Map<string, AbortController>;
  /** Side effects queued by the running request; executed only after its transaction commits. */
  afterCommit: Array<() => void> | null;
}

/** Runs `effect` after the current request commits (immediately when no request is running). */
export function onCommitted(ctx: HarnessContext, effect: () => void): void {
  if (ctx.afterCommit) ctx.afterCommit.push(effect);
  else effect();
}

/**
 * Credential redaction at intake (PLAN §0/§1): free text entering the harness (model output, player input,
 * advice, narration) passes `redactSecrets` before it is executed, hashed or stored, so world state, logs and
 * exports never hold an API key. Game-secret canaries are not credentials and are left intact.
 */
export function redactDeep<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(redactSecrets(JSON.stringify(value))) as T;
}

export function stage(ctx: HarnessContext, name: CommitStage, sessionId: string, batchId: string | null): void {
  ctx.hooks.onStage?.(name, { sessionId, batchId });
}

/** Deterministic control ids: `<sessionId>/<prefix><control seq>`. */
export function controlId(ctx: HarnessContext, sessionId: string, prefix: string): { id: string; seq: number } {
  const seq = ctx.repo.nextControlSeq(sessionId);
  return { id: `${sessionId}/${prefix}${seq}`, seq };
}

export interface Replayable {
  replayed: boolean;
}

/**
 * Runs `fn` as one idempotent request. The stored result is what `fn` returned (JSON); a replay returns it with
 * `replayed: true`.
 */
export function withRequest<T extends Replayable>(
  ctx: HarnessContext,
  sessionId: string,
  requestId: string,
  op: string,
  payload: unknown,
  fn: () => T,
): T {
  const queued: Array<() => void> = [];
  const outer = ctx.afterCommit;
  ctx.afterCommit = outer ?? queued;
  try {
    const result = ctx.store.transaction(() => {
      const payloadHash = hashValue({ op, payload: payload === undefined ? null : redactDeep(payload) });
      const existing = ctx.repo.findRequest(sessionId, requestId);
      if (existing) {
        if (existing.payloadHash !== payloadHash || existing.op !== op) {
          throw new HarnessError('H06', `request ${requestId} was already used with a different payload`);
        }
        return { ...(existing.result as T), replayed: true };
      }
      const fresh = fn();
      stage(ctx, 'before_commit', sessionId, null);
      ctx.repo.insertRequest({
        sessionId,
        requestId,
        op,
        payloadHash,
        result: JSON.parse(JSON.stringify({ ...fresh, replayed: false })),
        controlSeq: ctx.repo.nextControlSeq(sessionId),
      });
      return { ...fresh, replayed: false };
    });
    // Committed: now (and only now) run side effects such as aborting superseded in-flight calls.
    if (outer === null) for (const effect of queued) effect();
    return result;
  } finally {
    ctx.afterCommit = outer;
  }
}
