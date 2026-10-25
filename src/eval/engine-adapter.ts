/**
 * The single integration point of the evaluation package with the engine (WP-D `runCase`): runs one config in its
 * own database, exports the audit bundle (harness JSONL + engine.json + summary.json), and computes patch and
 * rederive replay for every run — complete, failed or crashed (then the bundle is exported from the database).
 */
import path from 'node:path';
import type { Lang } from '../agents/types.js';
import type { ContentBundle } from '../content/loader.js';
import type { Mode } from '../core/types.js';
import { runCase } from '../engine/runner.js';
import { runSeed } from '../engine/session.js';
import type { EngineHooks, EngineOptions, PricingOptions, RunSummary } from '../engine/types.js';
import { Harness } from '../harness/index.js';
import type { LlmClient, UsageSink } from '../llm/types.js';
import type { ReplayResult } from './metrics.js';

export interface AdapterInput {
  caseId: string;
  mode: Mode;
  rep: number;
  runDir: string;
  content: ContentBundle;
  lang: Lang;
  llm: (sink: UsageSink, seed: number) => LlmClient;
  models?: EngineOptions['models'];
  pricing?: PricingOptions;
  clock?: () => number;
  hooks?: EngineHooks;
  budget?: { maxCalls?: number; maxUsd?: number };
}

export interface AdapterResult {
  sessionId: string;
  seed: number;
  dbPath: string;
  auditDir: string;
  summary: RunSummary | null;
  outcome: string | null;
  error: string | null;
  replay: ReplayResult;
}

export const RUN_DB = 'run.sqlite';

export function seedOf(caseId: string, rep: number): number {
  return runSeed(caseId, rep);
}

function replayOf(harness: Harness, sessionId: string): ReplayResult {
  const one = (mode: 'patch' | 'rederive') => {
    try {
      const r = harness.replay(sessionId, mode);
      return { ok: r.ok, mismatches: r.mismatches };
    } catch (err) {
      return { ok: false, mismatches: [`replay failed: ${(err as Error).message}`] };
    }
  };
  return { patch: one('patch'), rederive: one('rederive') };
}

export async function executeRun(input: AdapterInput): Promise<AdapterResult> {
  const dbPath = path.join(input.runDir, RUN_DB);
  const auditDir = path.join(input.runDir, 'audit');
  const sessionId = `${input.caseId}-${input.mode}-r${input.rep}`;
  const seed = seedOf(input.caseId, input.rep);
  try {
    const result = await runCase({
      caseId: input.caseId,
      mode: input.mode,
      rep: input.rep,
      dbPath,
      sessionId,
      content: input.content,
      lang: input.lang,
      llm: input.llm,
      ...(input.models ? { models: input.models } : {}),
      ...(input.pricing ? { pricing: input.pricing } : {}),
      keepOpen: true,
      ...(input.clock ? { clock: input.clock } : {}),
      ...(input.hooks ? { hooks: input.hooks } : {}),
      ...(input.budget ? { budget: input.budget } : {}),
    });
    const engine = result.engine;
    if (!engine) throw new Error('runCase returned no engine session');
    try {
      engine.exportAudit(auditDir);
      const { engine: _e, ...summary } = result;
      return { sessionId, seed, dbPath, auditDir, summary, outcome: result.outcome, error: null, replay: replayOf(engine.harness, sessionId) };
    } finally {
      engine.harness.close();
    }
  } catch (err) {
    // Crash: export whatever the database holds; replay is still computed (PLAN §8.5: all runs).
    const message = (err as Error).message;
    let replay: ReplayResult = { patch: null, rederive: null };
    try {
      const harness = Harness.open(dbPath);
      try {
        if (harness.repo.findSession(sessionId)) {
          harness.exportAudit(sessionId, auditDir);
          replay = replayOf(harness, sessionId);
        }
      } finally {
        harness.close();
      }
    } catch {
      /* nothing to export */
    }
    return { sessionId, seed, dbPath, auditDir, summary: null, outcome: 'error', error: message, replay };
  }
}
