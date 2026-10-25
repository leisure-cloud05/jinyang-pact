/**
 * LLM smoke test (PLAN §14 gate): one fixed request per role (character, judge, narrator, mapper) built with the
 * real agent prompts, output schemas and authorized contexts from the content (dev config D1), N calls per role
 * (default 3), recording parse/schema success, repair use, attempts, latency, tokens and cost.
 * Output: runs/smoke-<timestamp>/report.md and calls.jsonl (one redacted record per call, with
 * per-attempt details and OpenRouter generation ids).
 *
 *   npm run live:smoke -- --live   real OpenRouter calls (explicit opt-in; needs LLM_PROVIDER=openrouter
 *                                  and OPENROUTER_API_KEY, normally in .env)
 *   npm run live:smoke -- --dry    the same flow against the mock LLM (offline pipeline validation)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  describeConfig,
  liveOptInProblem,
  loadConfig,
  LIVE_SETUP_HELP,
  type AppConfig,
  type NarrativeLang,
} from '../config/env.js';
import { AGENT_SCHEMAS } from '../agents/schemas.js';
import { buildAgentSamples } from '../agents/samples.js';
import { createLlmClient } from '../llm/client.js';
import type { MockLlmClient } from '../llm/mock/index.js';
import type { FetchLike } from '../llm/openrouter.js';
import { redactSecrets } from '../llm/redact.js';
import { JsonlSink, MemorySink, MultiSink } from '../llm/usage.js';
import type { ChatMessage, CostSource, LlmAttemptRecord, LlmErrorKind, LlmResult } from '../llm/types.js';

export const SMOKE_ROLES = ['character', 'judge', 'narrator', 'mapper'] as const;
export type SmokeRole = (typeof SMOKE_ROLES)[number];

interface SmokeCase {
  actor: string;
  schemaName: string;
  schema: z.ZodType<unknown>;
  /** Messages built by the agents layer from a fixed sample context (real prompts, real content). */
  messages(lang: NarrativeLang): ChatMessage[];
  /** Structured context of the same call (read by the mock personas; never sent to the API). */
  meta(lang: NarrativeLang): Record<string, unknown>;
  /** The deterministic mock's answer for the same context. */
  mockOutput(lang: NarrativeLang): unknown;
}

/**
 * One fixed sample per role with the REAL agent output schemas and prompts, built from dev config D1 (never a
 * frozen case; PLAN §0/§14): Sang's turn at the council, the Judge on Shi's approve+dispatch, the narrator on a
 * committed deliberation step, the mapper on a silk-amount command.
 */
function smokeCase(role: SmokeRole): SmokeCase {
  return {
    actor: role === 'character' ? 'sang_weihan' : role === 'mapper' ? 'player' : role,
    schemaName: AGENT_SCHEMAS[role].name,
    schema: AGENT_SCHEMAS[role].schema as z.ZodType<unknown>,
    messages: (lang) => buildAgentSamples(lang)[role].messages,
    meta: (lang) => buildAgentSamples(lang)[role].meta,
    mockOutput: (lang) => buildAgentSamples(lang)[role].mockOutput,
  };
}

export const SMOKE_CASES: Readonly<Record<SmokeRole, SmokeCase>> = {
  character: smokeCase('character'),
  judge: smokeCase('judge'),
  narrator: smokeCase('narrator'),
  mapper: smokeCase('mapper'),
};

export interface SmokeCallSummary {
  role: SmokeRole;
  index: number;
  ok: boolean;
  errorKind?: LlmErrorKind;
  error?: string;
  /** Outcome of the first model reply (before the repair retry); null when no reply was parsed. */
  firstParseOk: boolean | null;
  firstSchemaOk: boolean | null;
  repairUsed: boolean;
  attempts: number;
  attemptStatuses: string[];
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  costUsd: number | null;
  costSource: CostSource;
  /** Attempt-level cost split (PLAN §9: reported and estimated are summed separately; none = unknown). */
  costReportedUsd: number;
  costEstimatedUsd: number;
  unknownCostAttempts: number;
  model: string;
  provider?: string;
  generationId?: string;
  generationIds: string[];
}

export interface SmokeOptions {
  dry: boolean;
  config: AppConfig;
  /** Parent directory of the run folder (default `runs`). */
  outRoot?: string;
  attemptsPerRole?: number;
  now?: () => Date;
  /** Injected fetch for the live path (tests). */
  fetch?: FetchLike;
  log?: (line: string) => void;
}

export interface SmokeOutcome {
  dir: string;
  reportPath: string;
  jsonlPath: string;
  attemptsPath: string;
  calls: SmokeCallSummary[];
  samples: Partial<Record<SmokeRole, string>>;
  allRolesSucceeded: boolean;
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function createRunDir(root: string, name: string): string {
  mkdirSync(root, { recursive: true });
  for (let n = 1; n < 1000; n++) {
    const dir = join(root, n === 1 ? name : `${name}-${n}`);
    try {
      mkdirSync(dir);
      return dir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`could not create a run directory under ${root}`);
}

function registerSmokeMocks(lang: NarrativeLang): (mock: MockLlmClient) => void {
  return (mock) => {
    for (const role of SMOKE_ROLES) mock.register(role, () => SMOKE_CASES[role].mockOutput(lang));
    // Exercise the repair and HTTP-retry paths so a dry report covers every column.
    mock.injectFaults(['invalid_json'], { role: 'character', callTag: 'smoke-2' });
    mock.injectFaults(['http_429'], { role: 'judge', callTag: 'smoke-3' });
  };
}

function summarize(role: SmokeRole, index: number, result: LlmResult<unknown>, attempts: readonly LlmAttemptRecord[]): SmokeCallSummary {
  const repairUsed = result.repairUsed === true;
  let firstParseOk: boolean | null;
  let firstSchemaOk: boolean | null;
  if (repairUsed) {
    firstParseOk = result.repairReason !== 'parse';
    firstSchemaOk = result.repairReason === 'parse' ? null : false;
  } else if (result.ok) {
    firstParseOk = true;
    firstSchemaOk = true;
  } else {
    firstParseOk = null;
    firstSchemaOk = null;
  }
  const summary: SmokeCallSummary = {
    role,
    index,
    ok: result.ok,
    firstParseOk,
    firstSchemaOk,
    repairUsed,
    attempts: result.attempts,
    attemptStatuses: attempts.map((a) => `${a.kind}:${a.status}${a.httpStatus !== undefined ? `(${a.httpStatus})` : ''}`),
    latencyMs: result.latencyMs,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    costUsd: result.usage.costUsd,
    costSource: result.usage.costSource,
    costReportedUsd: attempts.filter((a) => a.costSource === 'reported').reduce((n, a) => n + (a.costUsd ?? 0), 0),
    costEstimatedUsd: attempts.filter((a) => a.costSource === 'estimated').reduce((n, a) => n + (a.costUsd ?? 0), 0),
    unknownCostAttempts: attempts.filter((a) => a.costSource === 'none' || a.costUsd === null).length,
    model: result.model,
    generationIds: attempts.map((a) => a.generationId).filter((g): g is string => g !== null),
  };
  if (!result.ok) {
    summary.errorKind = result.error.kind;
    summary.error = result.error.message;
  }
  if (result.usage.reasoningTokens !== undefined) summary.reasoningTokens = result.usage.reasoningTokens;
  if (result.provider !== undefined) summary.provider = result.provider;
  if (result.generationId !== undefined) summary.generationId = result.generationId;
  return summary;
}

function yesNo(v: boolean | null): string {
  return v === null ? '–' : v ? 'yes' : 'no';
}

function fmtCost(costUsd: number | null, source: CostSource): string {
  return costUsd === null ? `unknown (${source})` : `$${costUsd.toFixed(6)} (${source})`;
}

function fmtSplit(reported: number, estimated: number, unknown: number): string {
  return `$${reported.toFixed(6)} / $${estimated.toFixed(6)}${unknown > 0 ? ` / ${unknown} unknown` : ''}`;
}

function sumSplit(rows: readonly SmokeCallSummary[]): [number, number, number] {
  return [
    rows.reduce((n, r) => n + r.costReportedUsd, 0),
    rows.reduce((n, r) => n + r.costEstimatedUsd, 0),
    rows.reduce((n, r) => n + r.unknownCostAttempts, 0),
  ];
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

export function buildSmokeReport(input: {
  started: Date;
  dry: boolean;
  configText: string;
  attemptsPerRole: number;
  calls: SmokeCallSummary[];
  samples: Partial<Record<SmokeRole, string>>;
}): string {
  const { calls } = input;
  const lines: string[] = [];
  lines.push(input.dry ? '# LLM smoke report — DRY RUN (mock LLM)' : '# LLM smoke report — live (OpenRouter)');
  lines.push('');
  lines.push(`Started: ${input.started.toISOString()} · calls per role: ${input.attemptsPerRole}`);
  if (input.dry) {
    lines.push('');
    lines.push('> Dry run against the deterministic mock LLM with two injected faults (one invalid-JSON reply, one HTTP 429).');
    lines.push('> Pipeline validation only — these numbers are not findings.');
  }
  lines.push('', '## Configuration', '', '```', input.configText, '```', '', '## Summary by role', '');
  lines.push('| role | model | ok | first-reply JSON ok | first-reply schema ok | repairs | median / p95 latency ms | tokens in / out | reasoning tokens | cost reported / estimated / unknown attempts |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const role of SMOKE_ROLES) {
    const rows = calls.filter((c) => c.role === role);
    if (rows.length === 0) continue;
    const latencies = rows.map((r) => r.latencyMs);
    const [reported, estimated, unknown] = sumSplit(rows);
    const reasoning = rows.some((r) => r.reasoningTokens !== undefined)
      ? String(rows.reduce((s, r) => s + (r.reasoningTokens ?? 0), 0))
      : 'n/a';
    const models = [...new Set(rows.map((r) => r.model))].join(', ');
    lines.push(
      `| ${role} | ${cell(models)} | ${rows.filter((r) => r.ok).length}/${rows.length} | ` +
        `${rows.filter((r) => r.firstParseOk === true).length}/${rows.length} | ` +
        `${rows.filter((r) => r.firstSchemaOk === true).length}/${rows.length} | ` +
        `${rows.filter((r) => r.repairUsed).length} | ${percentile(latencies, 0.5)} / ${percentile(latencies, 0.95)} | ` +
        `${rows.reduce((s, r) => s + r.inputTokens, 0)} / ${rows.reduce((s, r) => s + r.outputTokens, 0)} | ${reasoning} | ` +
        `${fmtSplit(reported, estimated, unknown)} |`,
    );
  }
  const [reportedTotal, estimatedTotal, unknownTotal] = sumSplit(calls);
  lines.push('');
  lines.push(
    `Totals: ${calls.filter((c) => c.ok).length}/${calls.length} calls ok · ${calls.reduce((s, c) => s + c.attempts, 0)} attempts · ` +
      `cost reported $${reportedTotal.toFixed(6)} · estimated $${estimatedTotal.toFixed(6)}` +
      `${unknownTotal > 0 ? ` · ${unknownTotal} attempt(s) with unknown cost` : ''}`,
  );
  lines.push('', '## Calls', '');
  lines.push('| role | # | result | first JSON | first schema | repair | attempts (kind:status) | latency ms | tokens in / out | call cost | provider | generation ids |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const c of calls) {
    const result = c.ok ? 'ok' : `**${c.errorKind}**: ${cell((c.error ?? '').slice(0, 160))}`;
    lines.push(
      `| ${c.role} | ${c.index} | ${result} | ${yesNo(c.firstParseOk)} | ${yesNo(c.firstSchemaOk)} | ${c.repairUsed ? 'yes' : 'no'} | ` +
        `${c.attempts} (${c.attemptStatuses.join(' → ') || '–'}) | ${c.latencyMs} | ${c.inputTokens} / ${c.outputTokens}` +
        `${c.reasoningTokens !== undefined ? ` (reasoning ${c.reasoningTokens})` : ''} | ${fmtCost(c.costUsd, c.costSource)} | ` +
        `${cell(c.provider ?? '–')} | ${cell(c.generationIds.join(', ') || '–')} |`,
    );
  }
  lines.push('', '## Sample outputs (first successful call per role)', '');
  for (const role of SMOKE_ROLES) {
    const sample = input.samples[role];
    lines.push(`### ${role}`, '');
    if (sample === undefined) lines.push('_no successful call_', '');
    else lines.push('```json', sample, '```', '');
  }
  lines.push('## Notes', '');
  lines.push('- "first JSON" / "first schema": outcome of the first model reply, before the single repair retry; "–" = no reply was parsed (HTTP error, timeout, truncation).');
  lines.push('- Cost: `reported` = OpenRouter `usage.cost` (credits, 1 credit = 1 USD); `estimated` = token counts priced at the price bound (an upper bound; the same bound is sent as `provider.max_price`) or a known zero for an unbilled failure; `unknown` = no reliable accounting evidence (lost connection, timeout, malformed response, missing token counts). `filtered` = provider content filter or model refusal (no repair).');
  lines.push('- `calls.jsonl`: one redacted record per logical call; `attempts.jsonl`: one record per attempt (`first` / `http_retry` / `repair`) with its OpenRouter generation id, tokens and cost (`reconciled: false` until a later reconciliation). Call totals are sums over attempts.');
  lines.push('');
  return lines.join('\n');
}

export async function runSmoke(opts: SmokeOptions): Promise<SmokeOutcome> {
  if (!opts.dry && opts.config.provider !== 'openrouter') {
    throw new Error('a live smoke run requires LLM_PROVIDER=openrouter (use dry mode for the mock)');
  }
  const started = (opts.now ?? (() => new Date()))();
  const attemptsPerRole = opts.attemptsPerRole ?? 3;
  const dir = createRunDir(resolve(opts.outRoot ?? 'runs'), `smoke-${stamp(started)}`);
  const jsonlPath = join(dir, 'calls.jsonl');
  const attemptsPath = join(dir, 'attempts.jsonl');
  const reportPath = join(dir, 'report.md');
  const memory = new MemorySink();
  const sink = new MultiSink(memory, new JsonlSink(jsonlPath, attemptsPath));
  const log = (line: string): void => opts.log?.(redactSecrets(line));
  const lang = opts.config.narrativeLang;
  const config: AppConfig = opts.dry ? { ...opts.config, provider: 'mock' } : opts.config;
  const client = createLlmClient(config, sink, {
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.log ? { logger: log } : {}),
    ...(opts.dry ? { mockSetup: registerSmokeMocks(lang) } : {}),
  });
  const sessionId = `smoke-${stamp(started)}`;
  const calls: SmokeCallSummary[] = [];
  const samples: Partial<Record<SmokeRole, string>> = {};

  for (const role of SMOKE_ROLES) {
    const smokeCase = SMOKE_CASES[role];
    for (let index = 1; index <= attemptsPerRole; index++) {
      const before = memory.records.length;
      const result = await client.complete({
        role,
        actor: smokeCase.actor,
        sessionId,
        round: index,
        callTag: `smoke-${index}`,
        messages: smokeCase.messages(lang),
        meta: smokeCase.meta(lang),
        schema: smokeCase.schema,
        schemaName: smokeCase.schemaName,
      });
      const callRecord = memory.records[before];
      const summary = summarize(role, index, result, callRecord ? memory.attemptsOf(callRecord.callId) : []);
      calls.push(summary);
      if (result.ok && samples[role] === undefined) samples[role] = redactSecrets(JSON.stringify(result.value, null, 2));
      log(
        `[smoke] ${role} #${index}: ${result.ok ? 'ok' : `${result.error.kind}`} · attempts ${result.attempts} · ` +
          `${result.latencyMs} ms · ${fmtCost(result.usage.costUsd, result.usage.costSource)}`,
      );
    }
  }

  const report = buildSmokeReport({
    started,
    dry: opts.dry,
    configText: describeConfig(config),
    attemptsPerRole,
    calls,
    samples,
  });
  writeFileSync(reportPath, redactSecrets(report), 'utf8');
  const allRolesSucceeded = SMOKE_ROLES.every((role) => calls.some((c) => c.role === role && c.ok));
  return { dir, reportPath, jsonlPath, attemptsPath, calls, samples, allRolesSucceeded };
}

export const SMOKE_USAGE = [
  'Usage: npm run live:smoke -- (--live | --dry) [--attempts N] [--out DIR] [--no-env-file]',
  '  --live         real OpenRouter calls (explicit opt-in; needs LLM_PROVIDER=openrouter and OPENROUTER_API_KEY)',
  '  --dry          the same flow against the mock LLM (no network)',
  '  --attempts N   calls per role (default 3)',
  '  --out DIR      parent directory of the run folder (default runs)',
  '  --no-env-file  do not load .env (use only the shell environment)',
].join('\n');

export async function main(argv: readonly string[], io: { out: (l: string) => void; err: (l: string) => void } = {
  out: (l) => console.log(redactSecrets(l)),
  err: (l) => console.error(redactSecrets(l)),
}): Promise<number> {
  let values: { live?: boolean; dry?: boolean; attempts?: string; out?: string; 'no-env-file'?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        live: { type: 'boolean' },
        dry: { type: 'boolean' },
        attempts: { type: 'string' },
        out: { type: 'string' },
        'no-env-file': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    io.err(`${(err as Error).message}\n${SMOKE_USAGE}`);
    return 1;
  }
  if (values.help) {
    io.out(SMOKE_USAGE);
    return 0;
  }
  if (values.live && values.dry) {
    io.err('Choose either --live or --dry, not both.');
    return 1;
  }
  if (!values.live && !values.dry) {
    io.err(`Refusing to run: live LLM calls need the explicit --live flag (or use --dry for an offline mock run).\n\n${LIVE_SETUP_HELP}`);
    return 1;
  }
  const attemptsPerRole = values.attempts !== undefined ? Number(values.attempts) : 3;
  if (!Number.isInteger(attemptsPerRole) || attemptsPerRole < 1 || attemptsPerRole > 20) {
    io.err('--attempts must be an integer between 1 and 20');
    return 1;
  }
  let config: AppConfig;
  try {
    config = loadConfig({ envFile: values['no-env-file'] ? false : '.env' });
  } catch (err) {
    io.err((err as Error).message);
    return 1;
  }
  if (values.live) {
    const problem = liveOptInProblem(config, { live: true });
    if (problem) {
      io.err(`${problem}\n\n${LIVE_SETUP_HELP}`);
      return 1;
    }
  }
  io.out(values.dry ? 'Dry smoke run (mock LLM, no network).' : 'Live smoke run (OpenRouter).');
  io.out(describeConfig(values.dry ? { ...config, provider: 'mock' } : config));
  const outcome = await runSmoke({
    dry: values.dry === true,
    config,
    outRoot: values.out ?? 'runs',
    attemptsPerRole,
    log: io.out,
  });
  io.out(`\nSmoke report: ${outcome.reportPath}`);
  io.out(`Call log:     ${outcome.jsonlPath}`);
  io.out(`Attempt log:  ${outcome.attemptsPath}`);
  if (!outcome.allRolesSucceeded) io.out('At least one role had no successful call; see the report.');
  return outcome.allRolesSucceeded ? 0 : 2;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(entry).toLowerCase();
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(redactSecrets(err instanceof Error ? (err.stack ?? err.message) : String(err)));
      process.exitCode = 1;
    },
  );
}
