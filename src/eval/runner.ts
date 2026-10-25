/**
 * Experiment runner (PLAN §13, §14): plans, one database per run, seeds per (case, rep), per-run folders
 * `<out>/<case>-<mode>-r<rep>/{run.sqlite, audit/, run.json, replay.json}` and `<out>/plan.json`.
 * Plans: `dev` = D1–D3 (mock ok); `pilot` = D1–D3 + P1–P3 (live prompt tuning only); `main` = C1–C6 ×
 * {baseline, no_judge, full} × 2 reps = 36 runs. Completed runs are skipped when a plan is resumed.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Lang } from '../agents/types.js';
import { registerMockPersonas } from '../agents/mock-personas/index.js';
import type { ContentBundle } from '../content/loader.js';
import type { Mode } from '../core/types.js';
import type { PricingOptions } from '../engine/types.js';
import { MockLlmClient } from '../llm/mock/index.js';
import type { LlmClient, UsageSink } from '../llm/types.js';
import { redactSecrets } from '../llm/redact.js';
import { executeRun, type AdapterResult } from './engine-adapter.js';
import { narrationListing } from './narration-listing.js';
import type { FreezeRecord } from './freeze.js';
import { loadBundle } from './oracle/index.js';

export const PLAN_NAMES = ['dev', 'pilot', 'main'] as const;
export type PlanName = (typeof PLAN_NAMES)[number];
export const ALL_MODES: readonly Mode[] = ['baseline', 'no_judge', 'full'];
export const MOCK_LABEL = 'PIPELINE VALIDATION (mock LLM) — not findings';

export interface PlanSpec {
  name: PlanName;
  cases: string[];
  modes: Mode[];
  reps: number;
}

export function planSpec(name: PlanName, overrides: { reps?: number; cases?: string[]; modes?: Mode[] } = {}): PlanSpec {
  const base: Record<PlanName, PlanSpec> = {
    dev: { name: 'dev', cases: ['D1', 'D2', 'D3'], modes: [...ALL_MODES], reps: 1 },
    pilot: { name: 'pilot', cases: ['D1', 'D2', 'D3', 'P1', 'P2', 'P3'], modes: [...ALL_MODES], reps: 1 },
    main: { name: 'main', cases: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'], modes: [...ALL_MODES], reps: 2 },
  };
  const spec = base[name];
  return {
    name,
    cases: overrides.cases ?? spec.cases,
    modes: overrides.modes ?? spec.modes,
    reps: overrides.reps ?? spec.reps,
  };
}

/** The configs a plan may run (PLAN §13): dev/pilot never touch the held-out cases C1–C6. */
export const PLAN_CASES: Record<PlanName, readonly string[]> = {
  dev: ['D1', 'D2', 'D3'],
  pilot: ['D1', 'D2', 'D3', 'P1', 'P2', 'P3'],
  main: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'],
};
export const HELD_OUT_CASES: readonly string[] = PLAN_CASES.main;

/** Problems with running these case ids under this plan (empty = allowed). */
export function planCaseProblems(plan: PlanName, cases: readonly string[]): string[] {
  return cases.filter((c) => !PLAN_CASES[plan].includes(c)).map((c) => `${c} is not part of plan ${plan} (allowed: ${PLAN_CASES[plan].join(', ')})`);
}

export interface RunEntry {
  runId: string;
  caseId: string;
  mode: Mode;
  rep: number;
}

export function planRuns(spec: PlanSpec): RunEntry[] {
  const out: RunEntry[] = [];
  for (const caseId of spec.cases) for (const mode of spec.modes) for (let rep = 1; rep <= spec.reps; rep++) out.push({ runId: `${caseId}-${mode}-r${rep}`, caseId, mode, rep });
  return out;
}

export type LlmFactory = (entry: RunEntry) => (sink: UsageSink, seed: number) => LlmClient;

/** Offline mock personas (optionally with the seeded misbehaviour injector). */
export function mockFactory(misbehaviourRate = 0): LlmFactory {
  return () => (sink) => {
    const mock = new MockLlmClient({ sink });
    registerMockPersonas(mock, { misbehaviourRate });
    return mock;
  };
}

export interface RunRecordFile {
  runId: string;
  caseId: string;
  mode: Mode;
  rep: number;
  seed: number;
  sessionId: string;
  outcome: string | null;
  error: string | null;
  mock: boolean;
  live: boolean;
  startedAt: string;
  finishedAt: string;
  rounds: number | null;
  calls: number | null;
  terminal: string | null;
  complete: boolean;
  provenance: Provenance;
}

export interface ExperimentOptions {
  plan: PlanSpec;
  outDir: string;
  content: ContentBundle;
  llm: LlmFactory;
  live: boolean;
  lang: Lang;
  misbehaviourRate?: number;
  freeze?: { status: 'match' | 'mismatch' | 'missing' | 'not_required'; problems: string[] };
  /** Identity of the matching freeze (live held-out runs); null otherwise. */
  freezeHash?: string | null;
  models?: Record<string, string>;
  pricing?: PricingOptions;
  /** Credential-free effective settings; retained even for an unfrozen pilot. */
  runtimeSettings?: FreezeRecord['settings'];
  log?: (line: string) => void;
  clock?: () => number;
  now?: () => Date;
}

export interface ExperimentResult {
  outDir: string;
  runs: RunRecordFile[];
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${redactSecrets(JSON.stringify(value, null, 2))}\n`, 'utf8');
}

/** Who produced an output directory (PLAN §13 "Freeze scope"): a directory with different provenance is refused. */
export interface Provenance {
  provider: 'mock' | 'openrouter';
  live: boolean;
  plan: PlanName;
  freezeHash: string | null;
  lang: string;
  misbehaviourRate: number | null;
}

export class ProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvenanceError';
  }
}

export function provenanceDiff(a: Provenance, b: Provenance): string[] {
  return (Object.keys(b) as Array<keyof Provenance>).filter((k) => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)).map((k) => `${k}: ${JSON.stringify(a[k] ?? null)} ≠ ${JSON.stringify(b[k])}`);
}

export function provenanceOf(opts: Pick<ExperimentOptions, 'live' | 'plan' | 'lang' | 'misbehaviourRate' | 'freezeHash'>): Provenance {
  return {
    provider: opts.live ? 'openrouter' : 'mock',
    live: opts.live,
    plan: opts.plan.name,
    freezeHash: opts.freezeHash ?? null,
    lang: opts.lang,
    misbehaviourRate: opts.live ? null : (opts.misbehaviourRate ?? 0),
  };
}

/** Refuses an output directory produced under different provenance (or of unknown provenance with runs in it). */
export function checkProvenance(outDir: string, mine: Provenance): void {
  const file = path.join(outDir, 'provenance.json');
  if (existsSync(file)) {
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Provenance;
    const diff = provenanceDiff(stored, mine);
    if (diff.length > 0) throw new ProvenanceError(`refusing to resume ${outDir}: it was produced with different provenance (${diff.join('; ')})`);
    return;
  }
  const hasRuns = existsSync(outDir) && readdirSync(outDir).some((n) => existsSync(path.join(outDir, n, 'run.json')) || existsSync(path.join(outDir, n, 'audit')));
  if (hasRuns) throw new ProvenanceError(`refusing to resume ${outDir}: it holds runs without a provenance record`);
}

export async function runExperiment(opts: ExperimentOptions): Promise<ExperimentResult> {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => undefined);
  const provenance = provenanceOf(opts);
  checkProvenance(opts.outDir, provenance);
  const planFile = path.join(opts.outDir, 'plan.json');
  if (opts.runtimeSettings && existsSync(planFile)) {
    const stored = JSON.parse(readFileSync(planFile, 'utf8')) as { runtimeSettings?: FreezeRecord['settings'] };
    if (JSON.stringify(stored.runtimeSettings) !== JSON.stringify(opts.runtimeSettings)) {
      throw new ProvenanceError(`refusing to resume ${opts.outDir}: runtime settings changed or were not recorded; use a fresh output directory`);
    }
  }
  mkdirSync(opts.outDir, { recursive: true });
  writeJson(path.join(opts.outDir, 'provenance.json'), provenance);
  const entries = planRuns(opts.plan);
  writeJson(path.join(opts.outDir, 'plan.json'), {
    provenance,
    plan: opts.plan,
    runs: entries.map((e) => e.runId),
    live: opts.live,
    mock: !opts.live,
    label: opts.live ? null : MOCK_LABEL,
    misbehaviourRate: opts.live ? null : (opts.misbehaviourRate ?? 0),
    lang: opts.lang,
    models: opts.models ?? null,
    runtimeSettings: opts.runtimeSettings ?? null,
    freeze: opts.freeze ?? null,
    createdAt: now().toISOString(),
  });
  const runs: RunRecordFile[] = [];
  for (const [i, entry] of entries.entries()) {
    const runDir = path.join(opts.outDir, entry.runId);
    const runFile = path.join(runDir, 'run.json');
    if (existsSync(runFile)) {
      const done = JSON.parse(readFileSync(runFile, 'utf8')) as RunRecordFile;
      const diff = done.provenance ? provenanceDiff(done.provenance, provenance) : ['missing provenance'];
      if (diff.length > 0) throw new ProvenanceError(`refusing to resume run ${entry.runId}: ${diff.join('; ')}`);
      if (done.complete) {
        log(`[${i + 1}/${entries.length}] ${entry.runId}: already complete (skipped)`);
        runs.push(done);
        continue;
      }
    }
    mkdirSync(runDir, { recursive: true });
    const startedAt = now().toISOString();
    log(`[${i + 1}/${entries.length}] ${entry.runId}: running…`);
    const result: AdapterResult = await executeRun({
      caseId: entry.caseId,
      mode: entry.mode,
      rep: entry.rep,
      runDir,
      content: opts.content,
      lang: opts.lang,
      llm: opts.llm(entry),
      ...(opts.models ? { models: opts.models } : {}),
      ...(opts.pricing ? { pricing: opts.pricing } : {}),
      ...(opts.clock ? { clock: opts.clock } : {}),
    });
    const record: RunRecordFile = {
      ...entry,
      seed: result.seed,
      sessionId: result.sessionId,
      outcome: result.outcome,
      error: result.error,
      mock: !opts.live,
      live: opts.live,
      startedAt,
      finishedAt: now().toISOString(),
      rounds: result.summary?.rounds ?? null,
      calls: result.summary?.calls ?? null,
      terminal: result.summary?.terminal?.kind ?? null,
      complete: result.error === null,
      provenance,
    };
    writeJson(path.join(runDir, 'replay.json'), result.replay);
    if (existsSync(path.join(result.auditDir, 'session.json'))) {
      // PLAN §9.4: every displayed narration paragraph of the run, next to its audit bundle.
      writeFileSync(path.join(result.auditDir, 'narrations_displayed.md'), redactSecrets(narrationListing(loadBundle(result.auditDir), entry.runId)), 'utf8');
    }
    writeJson(runFile, record);
    runs.push(record);
    log(
      `[${i + 1}/${entries.length}] ${entry.runId}: ${record.outcome ?? 'no outcome'}${record.error ? ` (error: ${record.error})` : ''} · ` +
        `replay patch ${String(result.replay.patch?.ok ?? 'n/a')} / rederive ${String(result.replay.rederive?.ok ?? 'n/a')}`,
    );
  }
  return { outDir: opts.outDir, runs };
}
