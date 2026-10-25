/**
 * Headless run of one case/dev/pilot config (used by the evaluation package): opens (or creates) the run database,
 * creates the session — or resumes it after a crash when it already exists — drives it to a run outcome with the
 * case's scripted policy and inputs, and returns the run summary. `llm` may be a client or a factory receiving the
 * database's usage sink (so llm_calls/llm_attempts land next to the run) and the run seed.
 */
import { fileURLToPath } from 'node:url';
import type { Lang } from '../agents/types.js';
import { loadContent, type ContentBundle } from '../content/loader.js';
import type { Mode } from '../core/types.js';
import { Harness } from '../harness/index.js';
import type { LlmClient, UsageSink } from '../llm/types.js';
import { EngineSession, runSeed } from './session.js';
import type { EngineOptions, RunSummary } from './types.js';

export const DEFAULT_CONTENT_ROOT = fileURLToPath(new URL('../../content/', import.meta.url));

let cachedContent: ContentBundle | null = null;

export function defaultContent(): ContentBundle {
  cachedContent ??= loadContent(DEFAULT_CONTENT_ROOT, { requireSources: true });
  return cachedContent;
}

export interface RunCaseOptions extends Omit<Partial<EngineOptions>, 'llm' | 'content' | 'lang'> {
  caseId: string;
  mode: Mode;
  rep: number;
  llm: LlmClient | ((sink: UsageSink, seed: number) => LlmClient);
  dbPath: string;
  lang?: Lang;
  content?: ContentBundle;
  /** Default `<caseId>-<mode>-r<rep>`. */
  sessionId?: string;
  /** Harness clock (ISO timestamps); default derived from `clock`. */
  harnessClock?: () => string;
  /** Keep the harness open and return it (tests); default: closed after the run. */
  keepOpen?: boolean;
}

export interface RunCaseResult extends RunSummary {
  dbPath: string;
  /** Present when `keepOpen`. */
  engine?: EngineSession;
}

export function defaultSessionId(caseId: string, mode: Mode, rep: number): string {
  return `${caseId}-${mode}-r${rep}`;
}

export async function runCase(opts: RunCaseOptions): Promise<RunCaseResult> {
  const content = opts.content ?? defaultContent();
  const clock = opts.clock ?? Date.now;
  const harness = Harness.open(opts.dbPath, { clock: opts.harnessClock ?? (() => new Date(clock()).toISOString()) });
  const sessionId = opts.sessionId ?? defaultSessionId(opts.caseId, opts.mode, opts.rep);
  try {
    const llm = typeof opts.llm === 'function' ? opts.llm(harness.usageSink(sessionId), runSeed(opts.caseId, opts.rep)) : opts.llm;
    const { caseId: _c, mode: _m, rep: _r, llm: _l, dbPath: _d, sessionId: _s, harnessClock: _h, keepOpen: _k, ...rest } = opts;
    const engineOptions: EngineOptions = { ...rest, content, llm, lang: opts.lang ?? 'zh' };
    const engine = harness.repo.findSession(sessionId)
      ? EngineSession.open(harness, engineOptions, sessionId)
      : EngineSession.create(harness, engineOptions, { sessionId, caseId: opts.caseId, mode: opts.mode, rep: opts.rep });
    const summary = await engine.run();
    return { ...summary, dbPath: opts.dbPath, ...(opts.keepOpen ? { engine } : {}) };
  } finally {
    if (!opts.keepOpen) harness.close();
  }
}
