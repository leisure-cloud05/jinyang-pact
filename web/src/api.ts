/**
 * Client of the play API. Every POST carries a fresh `requestId`; a network failure is retried once with the SAME
 * id, so the server's idempotency returns the first result instead of acting twice.
 */
import type { ApiErrorBody, ViewMode } from '../../src/server/api-types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function newRequestId(prefix: string): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${rnd}`;
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const e = (body ?? {}) as Partial<ApiErrorBody>;
    throw new ApiError(res.status, e.error ?? 'http_error', e.message ?? `${res.status} ${res.statusText}`);
  }
  return body as T;
}

export async function getJson<T>(url: string): Promise<T> {
  return parse<T>(await fetch(url, { headers: { accept: 'application/json' } }));
}

export async function postJson<T>(url: string, body: Record<string, unknown>, prefix = 'ui'): Promise<T> {
  const payload = JSON.stringify({ requestId: newRequestId(prefix), ...body });
  const init: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: payload };
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    // Network hiccup: same payload, same requestId — the server replays instead of acting twice.
    res = await fetch(url, init);
  }
  return parse<T>(res);
}

export function sessionUrl(id: string, path: string, params: Record<string, string | number | undefined> = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  const qs = q.toString();
  return `/api/sessions/${encodeURIComponent(id)}/${path}${qs ? `?${qs}` : ''}`;
}

export function viewParam(view: ViewMode): string | undefined {
  return view === 'director' ? 'director' : undefined;
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return `${err.message}${err.code ? ` (${err.code})` : ''}`;
  return err instanceof Error ? err.message : String(err);
}
