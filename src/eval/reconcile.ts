/**
 * Cost reconciliation (PLAN §9): looks up every recorded OpenRouter generation id of an experiment's runs
 * (`GET /api/v1/generation?id=…`) and writes `<run>/reconciled_costs.jsonl` (one row per attempt: generation id,
 * reconciled cost in US$, the cost recorded at run time and its source). The report then shows reconciled costs
 * next to reported/estimated ones. User-run only (`--live`); tests inject a fake fetch and never reach the network.
 */
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { redactSecrets } from '../llm/redact.js';
import { readJsonl, toLlmAttempt } from './oracle/bundle.js';
import { findRunDirs } from './report.js';

export type FetchFn = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface ReconcileOptions {
  dir: string;
  apiKey: string;
  fetch: FetchFn;
  baseUrl?: string;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface ReconcileRow {
  callId: string;
  attemptNo: number;
  generationId: string;
  costUsd: number | null;
  recordedCostUsd: number | null;
  recordedSource: string;
  status: 'ok' | 'not_found' | 'error';
  detail: string | null;
}

export async function reconcileDir(opts: ReconcileOptions): Promise<{ runs: number; rows: number; ok: number }> {
  const base = opts.baseUrl ?? 'https://openrouter.ai/api/v1';
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let rows = 0;
  let ok = 0;
  const runs = findRunDirs(opts.dir);
  for (const runDir of runs) {
    const attempts = readJsonl(path.join(runDir, 'audit', 'llm_attempts.jsonl')).map(toLlmAttempt).filter((a) => a.generationId);
    const out: ReconcileRow[] = [];
    for (const a of attempts) {
      const id = a.generationId as string;
      let row: ReconcileRow = { callId: a.callId, attemptNo: a.attemptNo, generationId: id, costUsd: null, recordedCostUsd: a.costUsd, recordedSource: a.costSource, status: 'error', detail: null };
      try {
        const res = await opts.fetch(`${base}/generation?id=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${opts.apiKey}` } });
        if (res.status === 404) row = { ...row, status: 'not_found', detail: 'generation not found' };
        else if (!res.ok) row = { ...row, detail: `HTTP ${res.status}` };
        else {
          const body = (await res.json()) as { data?: { total_cost?: unknown } };
          const cost = typeof body.data?.total_cost === 'number' ? body.data.total_cost : null;
          row = { ...row, costUsd: cost, status: cost === null ? 'error' : 'ok', detail: cost === null ? 'no total_cost in the response' : null };
        }
      } catch (err) {
        row = { ...row, detail: redactSecrets((err as Error).message) };
      }
      if (row.status === 'ok') ok += 1;
      out.push(row);
      await sleep(150);
    }
    if (out.length > 0) {
      writeFileSync(path.join(runDir, 'reconciled_costs.jsonl'), out.map((r) => `${redactSecrets(JSON.stringify(r))}\n`).join(''), 'utf8');
      opts.log?.(`${path.basename(runDir)}: ${out.filter((r) => r.status === 'ok').length}/${out.length} generation(s) reconciled`);
    } else if (!existsSync(path.join(runDir, 'audit', 'llm_attempts.jsonl'))) {
      opts.log?.(`${path.basename(runDir)}: no llm_attempts.jsonl`);
    }
    rows += out.length;
  }
  return { runs: runs.length, rows, ok };
}
