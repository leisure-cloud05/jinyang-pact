/**
 * Idempotent POSTs (H06 at the API boundary). Every POST carries a client `requestId`; the payload hash covers
 * everything except `requestId` and `wait`.
 *
 * Write-ahead intent: a handler validates its preconditions, then calls `intend(target)` immediately BEFORE its
 * effect. `intend` durably records the request as `pending` together with its target (for `advance`: the turn it
 * ends). Only after the effect is the receipt (`done` + response) stored. So:
 * - a retry of a `done` request returns the stored response (`x-idempotent-replay: true`), executing nothing;
 * - a retry of a `pending` request (the process crashed, or the receipt could not be written, after the intent)
 *   first asks the route's `recover(target)` whether the effect already happened — e.g. the turn it ended has been
 *   taken (the engine persisted it) — and then returns a recovered response instead of acting again; only an
 *   effect that provably did not happen is executed again;
 * - a request that failed before `intend` leaves no record (nothing happened) and can simply be retried;
 * - the same id with a different payload is refused (409); concurrent duplicates share one execution.
 */
import { hashValue } from '../core/hash.js';
import { ApiError } from './errors.js';
import type { ServerStore } from './store.js';

export interface ApiResponse {
  status: number;
  body: unknown;
}

export interface IdempotentResult extends ApiResponse {
  replayed: boolean;
}

export interface IdempotentHandler {
  /** Runs the request; must call `intend(target)` right before its first durable effect. */
  exec: (intend: (target: unknown) => void) => Promise<ApiResponse>;
  /** For a pending request: the response if its effect already happened (then nothing is executed), else null. */
  recover?: (target: unknown) => Promise<ApiResponse | null> | ApiResponse | null;
}

export interface IdempotencyFaults {
  /** Test hook: called after the effect and before the receipt is stored; throwing simulates a crash there. */
  beforeReceipt?: (route: string, scope: string) => void;
}

export class Idempotency {
  private readonly store: ServerStore;
  private readonly clock: () => string;
  private readonly faults: IdempotencyFaults;
  private readonly inflight = new Map<string, { hash: string; promise: Promise<ApiResponse> }>();

  constructor(store: ServerStore, clock: () => string, faults: IdempotencyFaults = {}) {
    this.store = store;
    this.clock = clock;
    this.faults = faults;
  }

  static payloadHash(route: string, body: Record<string, unknown>): string {
    const { requestId: _r, wait: _w, ...payload } = body;
    return hashValue({ route, payload: JSON.parse(JSON.stringify(payload)) as unknown });
  }

  async run(scope: string, route: string, body: Record<string, unknown> & { requestId: string }, handler: IdempotentHandler): Promise<IdempotentResult> {
    const hash = Idempotency.payloadHash(route, body);
    const key = `${scope}\u0000${body.requestId}`;
    const running = this.inflight.get(key);
    if (running) {
      if (running.hash !== hash) throw new ApiError(409, 'request_id_reused', `request ${body.requestId} is in progress with a different payload`);
      return { ...(await running.promise), replayed: true };
    }
    const stored = this.store.findRequest(scope, body.requestId);
    if (stored) {
      if (stored.payloadHash !== hash || stored.route !== route) {
        throw new ApiError(409, 'request_id_reused', `request ${body.requestId} was already used with a different payload`);
      }
      if (stored.status === 'done') return { status: stored.statusCode, body: stored.response, replayed: true };
      const recovered = handler.recover ? await handler.recover(stored.target) : null;
      if (recovered) {
        this.receipt(scope, body.requestId, route, hash, recovered);
        return { ...recovered, replayed: true };
      }
    }
    const promise = this.execute(scope, route, body.requestId, hash, handler);
    this.inflight.set(key, { hash, promise });
    try {
      return { ...(await promise), replayed: false };
    } finally {
      this.inflight.delete(key);
    }
  }

  private async execute(scope: string, route: string, requestId: string, hash: string, handler: IdempotentHandler): Promise<ApiResponse> {
    let intended = false;
    const intend = (target: unknown): void => {
      this.store.recordIntent({ scope, requestId, route, payloadHash: hash, target }, this.clock());
      intended = true;
    };
    let res: ApiResponse;
    try {
      res = await handler.exec(intend);
    } catch (err) {
      // Failed before any effect: forget it. After the intent: keep it pending (a retry recovers or re-executes).
      if (!intended) this.store.deletePending(scope, requestId);
      throw err;
    }
    this.faults.beforeReceipt?.(route, scope);
    if (res.status >= 200 && res.status < 300) this.receipt(scope, requestId, route, hash, res);
    else if (!intended) this.store.deletePending(scope, requestId);
    return res;
  }

  private receipt(scope: string, requestId: string, route: string, hash: string, res: ApiResponse): void {
    this.store.recordDone({ scope, requestId, route, payloadHash: hash, statusCode: res.status, response: res.body }, this.clock());
  }
}
