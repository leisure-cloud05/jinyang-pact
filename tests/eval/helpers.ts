/**
 * WP-F test helpers: offline runs through the approved engine/harness (mock personas; allowed in TESTS only — the
 * oracle never imports them), exported audit bundles, and bundle mutation utilities.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';
import { registerMockPersonas, type MockPersonaOptions } from '../../src/agents/mock-personas/index.js';
import { caseCoreConfig, caseInitialState, loadContent, type ContentBundle } from '../../src/content/loader.js';
import type { ActorId, DecisionOption, Mode, PatchOp } from '../../src/core/types.js';
import { Harness } from '../../src/harness/index.js';
import { runCase } from '../../src/engine/runner.js';
import { MockLlmClient } from '../../src/llm/mock/index.js';
import { applyPatchOps, loadBundle, type AuditBundle } from '../../src/eval/oracle/index.js';

export const CONTENT_ROOT = fileURLToPath(new URL('../../content/', import.meta.url));

let bundle: ContentBundle | null = null;
export function content(): ContentBundle {
  bundle ??= loadContent(CONTENT_ROOT, { requireSources: true });
  return bundle;
}

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length > 0) {
    try {
      cleanup.pop()?.();
    } catch {
      /* best effort */
    }
  }
});

/** A temp directory whose path contains spaces (removed after the test). */
export function tempDir(prefix = 'jinyang eval test '): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let clockBase = Date.UTC(2026, 8, 30, 0, 0, 0);
export function testClock(): () => number {
  let t = (clockBase += 3_600_000);
  return () => (t += 1_000);
}

export interface MockRun {
  dir: string;
  auditDir: string;
  bundle: AuditBundle;
}

const cache = new Map<string, MockRun>();
let sharedDir: string | null = null;

/** Runs a config with mock personas and exports its audit bundle (cached per case/mode/rep/rate for the test file). */
export async function mockRun(caseId: string, mode: Mode, opts: { rep?: number; persona?: MockPersonaOptions } = {}): Promise<MockRun> {
  const rep = opts.rep ?? 1;
  const key = `${caseId}|${mode}|${rep}|${JSON.stringify(opts.persona ?? {})}`;
  const hit = cache.get(key);
  if (hit) return hit;
  sharedDir ??= mkdtempSync(path.join(os.tmpdir(), 'jinyang eval runs '));
  const dir = path.join(sharedDir, `${caseId}-${mode}-r${rep}-${cache.size}`);
  const result = await runCase({
    caseId,
    mode,
    rep,
    content: content(),
    clock: testClock(),
    dbPath: path.join(dir, 'run db.sqlite'),
    keepOpen: true,
    llm: (sink) => {
      const mock = new MockLlmClient({ sink });
      registerMockPersonas(mock, opts.persona ?? {});
      return mock;
    },
  });
  const auditDir = path.join(dir, 'audit');
  result.engine?.exportAudit(auditDir);
  result.engine?.harness.close();
  const run: MockRun = { dir, auditDir, bundle: loadBundle(auditDir) };
  cache.set(key, run);
  return run;
}

process.on('exit', () => {
  if (sharedDir) {
    try {
      rmSync(sharedDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

export interface ScriptedProposal {
  actor: ActorId;
  action: unknown;
}

/**
 * Drives the approved harness directly with scripted proposals, one list per round (PREPARE → character batch →
 * assess → decisions (endorse / let_it_happen / first option) → commit → ADVANCE), and returns the exported bundle.
 * Used to build baseline (permissive) trajectories with specific violations.
 */
export function harnessRun(caseId: string, mode: Mode, rounds: ReadonlyArray<ReadonlyArray<ScriptedProposal>>, name = 'x'): AuditBundle {
  const dir = tempDir();
  const h = Harness.open(path.join(dir, 'db.sqlite'), { clock: () => '2026-09-30T00:00:00.000Z' });
  const sid = `${caseId}-${mode}-${name}`;
  try {
    h.createSession({ sessionId: sid, mode, caseId, config: caseCoreConfig(content(), caseId), initialState: caseInitialState(content(), caseId), rngSeed: 7 });
    let n = 0;
    const rid = () => `req-${++n}`;
    for (const proposals of rounds) {
      if (h.getState(sid).terminal) break;
      h.runSystemPrepare(sid, rid());
      if (h.getState(sid).terminal) break;
      const { batchId } = h.openCharacterBatch(sid, rid());
      h.submitProposals(sid, batchId, proposals.map((p) => ({ actor: p.actor, action: p.action })), rid());
      h.assess(sid, batchId, rid());
      for (let i = 0; i < 20; i++) {
        const pause = h.openPauses(sid).find((p) => p.batchId === batchId);
        if (!pause) break;
        const option = pause.options.includes('endorse') ? 'endorse' : pause.options.includes('urge_stop') ? 'urge_stop' : (pause.options[0] as DecisionOption);
        const res = h.resolvePause(sid, pause.id, { option }, rid());
        if (res.status === 'regenerated') break;
      }
      const batch = h.repo.getBatch(batchId);
      if (batch.status !== 'committed' && batch.status !== 'obsolete') h.commitBatch({ sessionId: sid, batchId, requestId: rid() });
      if (h.getState(sid).terminal) break;
      const adv = h.runSystemAdvance(sid, rid());
      if (adv.staged?.pauseId) h.resolvePause(sid, adv.staged.pauseId, { option: 'let_it_happen' }, rid());
    }
    h.exportAudit(sid, path.join(dir, 'audit'));
  } finally {
    h.close();
  }
  return loadBundle(path.join(dir, 'audit'));
}

/** Deep copy of a bundle for mutation. */
export function cloneBundle(b: AuditBundle): AuditBundle {
  return structuredClone(b);
}

/** Recomputes every stored snapshot after the events (or the base snapshot) were mutated. */
export function rebuildSnapshots(b: AuditBundle): AuditBundle {
  const base = b.snapshots.find((s) => s.version === b.session.baseVersion) ?? b.snapshots[0];
  if (!base) return b;
  const states = new Map<number, unknown>([[base.version, base.state]]);
  let cur = base.state;
  for (const e of b.events) {
    if (e.version <= base.version) continue;
    cur = applyPatchOps(cur, e.changes as PatchOp[]);
    states.set(e.version, cur);
  }
  for (const s of b.snapshots) {
    const st = states.get(s.version);
    if (st) s.state = structuredClone(st) as typeof s.state;
  }
  return b;
}

export function rulesOf(list: ReadonlyArray<{ rule: string }>): string[] {
  return [...new Set(list.map((x) => x.rule))].sort();
}
