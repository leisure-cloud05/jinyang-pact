/**
 * Freeze record (PLAN §0, §13 "Freeze scope", §14 step 4): `runs/freeze.json` pins everything a main-experiment run
 * executes or reads, plus the effective runtime settings:
 * - files: `content/**`, `src/{core,harness,store,llm,agents,engine,content,config}/**`, the eval runner and engine
 *   adapter (with the displayed-narration listing they write), the detectors, case constraints and the oracle and
 *   leak scanner they use, the experiment CLI, this module, and `package-lock.json` (line endings normalised);
 * - settings: provider, model slugs, price bounds, token caps, input caps, timeouts, retries, response format,
 *   reasoning, sampling temperatures, per-run budgets, language, cases, modes, reps, seeds and max rounds.
 * Reporting-only code (metrics, report, figures, agreement, pack, reconcile, human-eval packets) is NOT frozen, so a
 * reporting bug can be fixed without re-running. A live run of any C1–C6 case requires plan `main` and a matching
 * freeze.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promptSetHash } from '../agents/prompts/index.js';
import type { AppConfig } from '../config/env.js';
import { findCase, type ContentBundle } from '../content/loader.js';
import { canonicalJson, sha256Hex } from '../core/hash.js';
import type { Mode } from '../core/types.js';
import { DEFAULT_MAX_CALLS, DEFAULT_MAX_USD, DEFAULT_WALL_CLOCK_MS } from '../engine/types.js';
import { seedOf } from './engine-adapter.js';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const MAIN_CASES = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'] as const;

/** Paths (relative to the repository root) whose files are part of the freeze. */
export const FROZEN_PATHS = [
  'content',
  'src/core',
  'src/harness',
  'src/store',
  'src/llm',
  'src/agents',
  'src/engine',
  'src/content',
  'src/config',
  'src/eval/runner.ts',
  'src/eval/engine-adapter.ts',
  'src/eval/narration-listing.ts',
  'src/eval/detectors.ts',
  'src/eval/constraints.ts',
  'src/eval/leak.ts',
  'src/eval/oracle',
  'src/eval/freeze.ts',
  'src/cli/exp.ts',
  'package-lock.json',
] as const;

export interface RunSettings {
  lang: string;
  cases: string[];
  modes: Mode[];
  reps: number;
}

export interface FreezeRecord {
  freezeFormat: 2;
  createdAt: string;
  models: Record<string, string>;
  settings: {
    provider: string;
    responseFormat: string;
    reasoning: string;
    providerIgnore: string[];
    temperatures: Record<string, number>;
    maxTokens: Record<string, number>;
    maxInputChars: Record<string, number>;
    timeoutMs: number;
    httpRetries: number;
    clientBudget: { maxCallsPerSession: number; maxUsdPerSession: number };
    runBudget: { maxCalls: number; maxUsd: number; wallClockMs: number };
    priceBounds: Record<string, { inputUsdPerMTok: number; outputUsdPerMTok: number }>;
    lang: string;
    cases: string[];
    modes: Mode[];
    reps: number;
    seeds: Record<string, number>;
    maxRounds: Record<string, number>;
  };
  hashes: {
    /** One hash over every frozen file (path + content). */
    files: string;
    /** Per-path hashes (for readable mismatch reports). */
    byPath: Record<string, string>;
    prompts: string;
  };
}

function listFiles(abs: string): string[] {
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return [abs];
  return readdirSync(abs)
    .sort()
    .flatMap((n) => listFiles(path.join(abs, n)));
}

function fileHash(root: string, files: readonly string[]): string {
  return sha256Hex(files.map((f) => `${path.relative(root, f).replace(/\\/g, '/')}\n${readFileSync(f, 'utf8').replace(/\r\n/g, '\n')}`).join('\n\u0000\n'));
}

/** Hashes of the frozen files under `root` (overall and per frozen path). */
export function frozenFileHashes(root = REPO_ROOT): { files: string; byPath: Record<string, string> } {
  const byPath: Record<string, string> = {};
  const all: string[] = [];
  for (const p of FROZEN_PATHS) {
    const files = listFiles(path.join(root, p));
    byPath[p] = files.length === 0 ? 'missing' : fileHash(root, files);
    all.push(...files);
  }
  return { files: fileHash(root, all), byPath };
}

export const MAIN_SETTINGS = (lang: string): RunSettings => ({ lang, cases: [...MAIN_CASES], modes: ['baseline', 'no_judge', 'full'], reps: 2 });

export function buildFreeze(config: AppConfig, content: ContentBundle, opts: { root?: string; now?: () => Date; run?: RunSettings } = {}): FreezeRecord {
  const run = opts.run ?? MAIN_SETTINGS(config.narrativeLang);
  const models = { character: config.models.character, judge: config.models.judge, narrator: config.models.narrator, mapper: config.models.mapper };
  const priceBounds: FreezeRecord['settings']['priceBounds'] = {};
  for (const slug of new Set(Object.values(models))) {
    const p = config.prices[slug];
    if (p) priceBounds[slug] = { inputUsdPerMTok: p.inputUsdPerMTok, outputUsdPerMTok: p.outputUsdPerMTok };
  }
  const seeds: Record<string, number> = {};
  const maxRounds: Record<string, number> = {};
  for (const c of run.cases) {
    for (let rep = 1; rep <= run.reps; rep++) seeds[`${c}-r${rep}`] = seedOf(c, rep);
    try {
      maxRounds[c] = findCase(content, c).max_rounds;
    } catch {
      maxRounds[c] = -1;
    }
  }
  const files = frozenFileHashes(opts.root);
  return {
    freezeFormat: 2,
    createdAt: (opts.now ?? (() => new Date()))().toISOString(),
    models,
    settings: {
      provider: config.provider,
      responseFormat: config.responseFormat,
      reasoning: config.reasoning,
      providerIgnore: [...config.providerIgnore],
      temperatures: { ...config.temperatures },
      maxTokens: { ...config.maxTokens },
      maxInputChars: { ...config.maxInputChars },
      timeoutMs: config.timeoutMs,
      httpRetries: config.httpRetries,
      clientBudget: { ...config.budget },
      runBudget: { maxCalls: DEFAULT_MAX_CALLS, maxUsd: DEFAULT_MAX_USD, wallClockMs: DEFAULT_WALL_CLOCK_MS },
      priceBounds,
      lang: run.lang,
      cases: [...run.cases],
      modes: [...run.modes],
      reps: run.reps,
      seeds,
      maxRounds,
    },
    hashes: { files: files.files, byPath: files.byPath, prompts: promptSetHash() },
  };
}

/** Identity of a freeze (everything except its creation time). */
export function freezeHash(record: FreezeRecord): string {
  const { createdAt: _c, ...rest } = record;
  return sha256Hex(canonicalJson(rest));
}

export function writeFreeze(file: string, record: FreezeRecord): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

export function readFreeze(file: string): FreezeRecord | null {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as FreezeRecord) : null;
}

/** Differences between a stored freeze and the current state (empty = match). `createdAt` is ignored. */
export function freezeMismatches(stored: FreezeRecord, current: FreezeRecord): string[] {
  const out: string[] = [];
  const cmp = (label: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${label}: frozen ${JSON.stringify(a)?.slice(0, 120)} ≠ current ${JSON.stringify(b)?.slice(0, 120)}`);
  };
  if (stored.freezeFormat !== current.freezeFormat) out.push(`freeze format ${String(stored.freezeFormat)} ≠ ${current.freezeFormat} (re-freeze)`);
  cmp('models', stored.models, current.models);
  for (const key of Object.keys(current.settings) as Array<keyof FreezeRecord['settings']>) cmp(`settings.${key}`, stored.settings?.[key], current.settings[key]);
  cmp('hashes.prompts', stored.hashes?.prompts, current.hashes.prompts);
  for (const p of Object.keys(current.hashes.byPath)) cmp(`files ${p}`, stored.hashes?.byPath?.[p], current.hashes.byPath[p]);
  if (out.length === 0) cmp('hashes.files', stored.hashes?.files, current.hashes.files);
  return out;
}
