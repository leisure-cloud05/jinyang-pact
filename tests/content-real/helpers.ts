/**
 * Shared helpers for the real-content tests (WP-B2). Pure: reads content/ from disk, no network, no LLM.
 */
import { fileURLToPath } from 'node:url';
import { buildCoreConfig, caseCoreConfig, loadContent, type ContentBundle } from '../../src/content/loader.js';
import type { CaseConfig } from '../../src/content/schema.js';
import type { CoreConfig } from '../../src/core/types.js';

export const CONTENT_ROOT = fileURLToPath(new URL('../../content/', import.meta.url));

let bundle: ContentBundle | null = null;
let cfg: CoreConfig | null = null;

export function content(): ContentBundle {
  bundle ??= loadContent(CONTENT_ROOT, { requireSources: true });
  return bundle;
}

/** Scenario-level rules configuration (no case applied). */
export function coreConfig(): CoreConfig {
  cfg ??= buildCoreConfig(content());
  return cfg;
}

const caseCfg = new Map<string, CoreConfig>();

/** Rules configuration of one case/dev/pilot config (its clause library applied), as sessions use it. */
export function caseConfig(id: string): CoreConfig {
  let c = caseCfg.get(id);
  if (!c) {
    c = caseCoreConfig(content(), id);
    caseCfg.set(id, c);
  }
  return c;
}

/** Case, dev or pilot config by id. */
export function configOf(id: string): CaseConfig {
  const b = content();
  const c = b.cases[id] ?? b.dev[id] ?? b.pilot[id];
  if (!c) throw new Error(`no config ${id}`);
  return c;
}

export const CASE_IDS = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'] as const;
export const DEV_IDS = ['D1', 'D2', 'D3'] as const;
export const PILOT_IDS = ['P1', 'P2', 'P3'] as const;
export const TRACE_IDS = [...CASE_IDS, ...DEV_IDS] as const;

/** Holders whose context may contain an entry: `initial` in its learnable_by. */
export function isInitialFor(sourceId: string, holder: string): boolean {
  const entry = content().sources[sourceId];
  return entry !== undefined && entry.learnable_by.some((l) => l.holder === holder && l.when === 'initial');
}
