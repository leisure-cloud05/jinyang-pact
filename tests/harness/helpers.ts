/** Harness test utilities: temp databases (paths with spaces), fixture sessions and a trace driver. */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { caseCoreConfig, caseInitialState, toTraceSpec } from '../../src/content/loader.js';
import type { TraceDecisionSpec, TraceSpec } from '../../src/core/simulate.js';
import type { Mode, WorldState } from '../../src/core/types.js';
import { Harness, type HarnessOptions, type ProposalInput } from '../../src/harness/harness.js';
import type { DecisionInput } from '../../src/harness/decisions.js';
import { fixture } from '../core/helpers.js';

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

/** A fresh temp directory whose path contains spaces (removed after the test). */
export function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jinyang pact test '));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function openHarness(dbPath: string, opts: HarnessOptions = {}): Harness {
  const h = Harness.open(dbPath, { clock: () => '2026-09-28T00:00:00.000Z', ...opts });
  cleanup.unshift(() => h.close());
  return h;
}

export function newHarness(opts: HarnessOptions = {}): { h: Harness; dbPath: string; dir: string } {
  const dir = tempDir();
  const dbPath = path.join(dir, 'play db.sqlite');
  return { h: openHarness(dbPath, opts), dbPath, dir };
}

export function createSession(h: Harness, sessionId: string, caseId = 'FX1', mode: Mode = 'full', state?: WorldState): void {
  h.createSession({
    sessionId,
    mode,
    caseId,
    config: caseCoreConfig(fixture(), caseId),
    initialState: state ?? caseInitialState(fixture(), caseId),
    rngSeed: 42,
  });
}

let counter = 0;
export const rid = (): string => `req-${++counter}`;

export function traceOf(caseId: string): TraceSpec {
  const trace = fixture().traces[caseId];
  if (!trace) throw new Error(`no trace ${caseId}`);
  return toTraceSpec(trace);
}

function decisionInput(d: TraceDecisionSpec): DecisionInput {
  return {
    option: d.choose,
    advice: d.advice ?? null,
    authorization: d.authorization ?? null,
    goalLimits: d.goal_limits ?? null,
    amend: d.amend ?? null,
    by: 'policy',
  };
}

/**
 * Plays a reference trace through the harness API exactly as an engine would: PREPARE → PLAYER → character batch
 * (submit, assess, resolve pauses; regenerate on regenerating decisions) → narration → ADVANCE → mutiny outcome.
 */
export function playTrace(h: Harness, sessionId: string, trace: TraceSpec, opts: { narrate?: boolean } = {}): void {
  for (let guard = 0; guard < 20; guard++) {
    const state = h.getState(sessionId);
    if (state.terminal || state.round > trace.max_rounds) return;
    const round = state.round;
    const spec = trace.rounds.find((r) => r.round === round);
    h.runSystemPrepare(sessionId, rid());
    if (h.getState(sessionId).terminal) return;
    if (spec && spec.player.length > 0) {
      h.applyPlayerAction(sessionId, spec.player.map((p) => ({ kind: 'action' as const, action: p.action })), rid());
      if (h.getState(sessionId).terminal) return;
    }
    const generations = spec ? [{ proposals: spec.proposals, decisions: spec.decisions }, ...spec.regenerations] : [{ proposals: [], decisions: [] }];
    let g = 0;
    let committedBatch: string | null = null;
    generation: while (g < generations.length) {
      const gen = generations[g]!;
      const { batchId } = h.openCharacterBatch(sessionId, rid());
      const inputs: ProposalInput[] = gen.proposals.map((p) => ({ actor: p.actor, action: p.action, askPlayer: p.ask_player ?? null }));
      const { proposalIds } = h.submitProposals(sessionId, batchId, inputs, rid());
      const refs = new Map<string, string>();
      gen.proposals.forEach((p, i) => {
        if (p.ref) refs.set(p.ref, proposalIds[i]!);
      });
      h.assess(sessionId, batchId, rid());
      for (let loop = 0; loop < 20; loop++) {
        const pause = h.openPauses(sessionId).find((p) => p.batchId === batchId);
        if (!pause) break;
        const d = gen.decisions.find((x) =>
          pause.category === 'negotiation_deadlock'
            ? x.category === 'negotiation_deadlock'
            : x.ref !== null && x.ref !== undefined && pause.proposalIds.includes(refs.get(x.ref) ?? ''),
        );
        if (!d) throw new Error(`round ${round}: no trace decision for ${pause.category} on ${pause.proposalIds.join(',')}`);
        const res = h.resolvePause(sessionId, pause.id, decisionInput(d), rid());
        if (res.status === 'regenerated') {
          g += 1;
          continue generation;
        }
      }
      const batch = h.repo.getBatch(batchId);
      if (batch.status !== 'committed') {
        const commit = h.commitBatch({ sessionId, batchId, requestId: rid() });
        if (!commit.ok) throw new Error(`commit failed: ${commit.reason}`);
      }
      committedBatch = batchId;
      break;
    }
    if (committedBatch && opts.narrate !== false) {
      for (const scene of h.narrationScenes(sessionId, committedBatch)) {
        h.recordNarration(
          sessionId,
          {
            batchId: committedBatch,
            scene: scene.scene,
            eventVersions: scene.eventVersions,
            status: 'ok',
            raw: 'prose',
            header: 'header',
            displayed: 'header\nprose',
            check: { hits: [] },
          },
          rid(),
        );
      }
    }
    if (h.getState(sessionId).terminal) return;
    const adv = h.runSystemAdvance(sessionId, rid());
    if (!adv.ok) throw new Error(`advance refused: ${adv.rule} ${adv.reason}`);
    if (adv.staged?.pauseId) h.resolvePause(sessionId, adv.staged.pauseId, { option: spec?.mutiny ?? 'let_it_happen' }, rid());
  }
}
