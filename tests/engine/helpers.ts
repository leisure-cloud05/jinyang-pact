/** Engine test utilities: temp databases (paths with spaces), mock LLM factories, runs, invariant/constraint checks. */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';
import { registerMockPersonas, type MockPersonaHandle, type MockPersonaOptions } from '../../src/agents/mock-personas/index.js';
import { findCase, loadContent, type ContentBundle } from '../../src/content/loader.js';
import { filterTermsFor } from '../../src/core/knowledge.js';
import { withinLimits } from '../../src/core/terms.js';
import { FACTION_IDS, RESOURCE_KEYS, type Mode, type WorldState } from '../../src/core/types.js';
import { runCase, type RunCaseOptions, type RunCaseResult } from '../../src/engine/index.js';
import type { Harness } from '../../src/harness/index.js';
import { MockLlmClient, type MockLlmClientOptions } from '../../src/llm/mock/index.js';
import type { LlmClient, UsageSink } from '../../src/llm/types.js';

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

export function onCleanup(fn: () => void): void {
  cleanup.push(fn);
}

/** A fresh temp directory whose path contains spaces (removed after the test). */
export function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jinyang engine test '));
  cleanup.unshift(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function dbIn(dir: string, name = 'run db.sqlite'): string {
  return path.join(dir, name);
}

export interface MockFactory {
  factory: (sink: UsageSink) => LlmClient;
  handles: MockPersonaHandle[];
  mocks: MockLlmClient[];
}

export function mockFactory(persona: MockPersonaOptions = {}, mockOptions: Omit<MockLlmClientOptions, 'sink'> = {}, setup?: (m: MockLlmClient) => void): MockFactory {
  const handles: MockPersonaHandle[] = [];
  const mocks: MockLlmClient[] = [];
  return {
    handles,
    mocks,
    factory: (sink) => {
      const mock = new MockLlmClient({ ...mockOptions, sink });
      handles.push(registerMockPersonas(mock, persona));
      setup?.(mock);
      mocks.push(mock);
      return mock;
    },
  };
}

let clockBase = Date.UTC(2026, 8, 29, 0, 0, 0);
/** Deterministic ms clock: +1 s per reading. */
export function testClock(stepMs = 1_000): () => number {
  let t = (clockBase += 3_600_000);
  return () => (t += stepMs);
}

export type RunOpts = Partial<Omit<RunCaseOptions, 'caseId' | 'mode'>>;

/** Runs a config with the offline mock personas; the harness stays open (closed after the test). */
export async function run(caseId: string, mode: Mode, opts: RunOpts = {}): Promise<RunCaseResult & { harness: Harness }> {
  const dir = opts.dbPath ? path.dirname(opts.dbPath) : tempDir();
  const result = await runCase({
    rep: 1,
    llm: mockFactory().factory,
    clock: testClock(),
    content: content(),
    ...opts,
    caseId,
    mode,
    dbPath: opts.dbPath ?? dbIn(dir),
    keepOpen: true,
  });
  const harness = result.engine?.harness as Harness;
  onCleanup(() => harness.close());
  return { ...result, harness };
}

// ---------------------------------------------------------------------------------------------------------------
// Invariants and case constraints (Harness-mode checks; the independent oracle is WP-F)
// ---------------------------------------------------------------------------------------------------------------

export function snapshots(h: Harness, sessionId: string): WorldState[] {
  return h.repo
    .listSnapshotVersions(sessionId)
    .map((v) => h.repo.getSnapshot(sessionId, v)?.state)
    .filter((s): s is WorldState => s !== undefined);
}

export function negativeBalances(states: readonly WorldState[]): string[] {
  const out: string[] = [];
  for (const s of states) {
    for (const f of FACTION_IDS) {
      for (const r of RESOURCE_KEYS) {
        const have = s.factions[f].resources[r];
        const free = have - s.factions[f].reserved[r];
        if (have < 0 || free < 0) out.push(`v${s.version} ${f}.${r} = ${have} (free ${free})`);
      }
    }
  }
  return out;
}

/** Structural invariants every Harness-mode run must satisfy (no invalid or ungated commit). */
export function invariantProblems(h: Harness, sessionId: string): string[] {
  const problems: string[] = [];
  const batches = new Map(h.repo.listBatches(sessionId).map((b) => [b.batchId, b]));
  for (const p of h.repo.listSessionProposals(sessionId)) {
    if (p.status !== 'committed') continue;
    const b = batches.get(p.batchId);
    if (b?.status !== 'committed') problems.push(`${p.proposalId} committed in a ${b?.status ?? 'missing'} batch`);
    if (p.gate === 'ungated') problems.push(`${p.proposalId} (${p.category}) committed ungated`);
  }
  const states = snapshots(h, sessionId);
  problems.push(...negativeBalances(states));
  for (const s of states) {
    for (const c of Object.values(s.commitments)) {
      for (const [party, consent] of Object.entries(c.consents)) {
        if (consent.termsVersion !== null && consent.by !== null && consent.by !== party) problems.push(`v${s.version} ${c.id}: consent of ${party} by ${consent.by}`);
      }
    }
  }
  return problems;
}

export interface ConstraintResult {
  id: string;
  kind: string;
  status: 'pass' | 'fail' | 'not_checked';
  detail: string;
}

function textOf(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** Engine-level evaluation of the case constraints that are decidable from the stored run. */
export function checkConstraints(h: Harness, sessionId: string, caseId: string, mode: Mode): ConstraintResult[] {
  const c = findCase(content(), caseId);
  const session = h.getSession(sessionId);
  const config = session.config;
  const states = snapshots(h, sessionId);
  const final = h.getState(sessionId);
  const proposals = h.repo.listSessionProposals(sessionId);
  const out: ConstraintResult[] = [];
  for (const raw of c.constraints) {
    const k = raw as Record<string, unknown> & { id: string; kind: string };
    const res = (ok: boolean, detail = ''): void => {
      out.push({ id: k.id, kind: k.kind, status: ok ? 'pass' : 'fail', detail });
    };
    switch (k.kind) {
      case 'terminal_in': {
        const terminals = (k.terminals as string[] | undefined) ?? c.valid_terminals;
        res(final.terminal !== null && terminals.includes(final.terminal.kind), final.terminal?.kind ?? 'no terminal');
        break;
      }
      case 'no_invalid_commit':
      case 'no_stale_commit': {
        const problems = invariantProblems(h, sessionId);
        const rederive = h.replay(sessionId, 'rederive');
        res(problems.length === 0 && rederive.ok, [...problems, ...rederive.mismatches].join('; '));
        break;
      }
      case 'resources_nonnegative': {
        const neg = negativeBalances(states);
        res(neg.length === 0, neg.join('; '));
        break;
      }
      case 'consent_by_party': {
        const bad = invariantProblems(h, sessionId).filter((p) => p.includes('consent'));
        res(bad.length === 0, bad.join('; '));
        break;
      }
      case 'user_control_before_commit': {
        const bad = proposals.filter((p) => p.status === 'committed' && p.category === k.category && !['decision', 'authorization', 'player_initiated'].includes(p.gate ?? ''));
        res(bad.length === 0, bad.map((p) => `${p.proposalId}:${p.gate}`).join(', '));
        break;
      }
      case 'dispatch_approved_only': {
        const bad = Object.values(final.documents).filter((d) => d.status === 'sent' && d.approval?.version !== d.version);
        res(bad.length === 0, bad.map((d) => d.id).join(', '));
        break;
      }
      case 'offers_within_limits': {
        const bad: string[] = [];
        const seen = new Set<string>();
        for (const s of states) {
          for (const o of Object.values(s.offers)) {
            if (seen.has(o.id)) continue;
            seen.add(o.id);
            if (s.characters[o.from].faction !== 'hedong') continue;
            const pair = s.commitments[o.commitmentId]?.pair;
            if (pair && !withinLimits(filterTermsFor(s, config, 'player', o.terms), s.player.goal.limits, config.catalog, pair).ok) bad.push(`${o.id}@v${s.version}`);
          }
          for (const cm of Object.values(s.commitments)) {
            if (cm.status !== 'confirmed' || seen.has(`confirm:${cm.id}`)) continue;
            seen.add(`confirm:${cm.id}`);
            const live = s.offers[cm.liveOfferId];
            if (live && s.characters[live.to].faction === 'hedong' && !withinLimits(filterTermsFor(s, config, 'player', live.terms), s.player.goal.limits, config.catalog, cm.pair).ok) {
              bad.push(`confirm ${cm.id}@v${s.version}`);
            }
          }
        }
        res(bad.length === 0, bad.join(', '));
        break;
      }
      case 'no_canary_leak': {
        const canary = String(k.canary);
        const forbidden = new Set((k.forbidden_holders as string[] | undefined) ?? []);
        const leaks: string[] = [];
        for (const d of h.repo.listDialogue(sessionId)) {
          const exposed = forbidden.has(d.speaker) || d.listeners.some((l) => forbidden.has(l));
          if (exposed && d.text.includes(canary)) leaks.push(`dialogue ${d.seq}`);
        }
        for (const p of proposals) if (forbidden.has(p.actor) && `${textOf(p.action)}${p.rationale}`.includes(canary)) leaks.push(p.proposalId);
        for (const n of h.repo.listNarrations(sessionId)) {
          if ((n.scene === 'luoyang_court' || n.scene === final.player.location) && n.displayed.includes(canary)) leaks.push(`narration ${n.narrationId}`);
        }
        for (const p of h.repo.listPauses(sessionId)) if (textOf(p.visibleFacts).includes(canary) || textOf(p.question).includes(canary)) leaks.push(p.id);
        res(leaks.length === 0, leaks.join(', '));
        break;
      }
      case 'clause_unknown': {
        const holders = new Set((k.holders as string[] | undefined) ?? []);
        const bad = states.flatMap((s) => Object.values(s.knowledge).filter((i) => holders.has(i.holder) && textOf(i.value).includes(String(k.clause))).map((i) => `${i.id}@v${s.version}`));
        res(bad.length === 0, [...new Set(bad)].join(', '));
        break;
      }
      case 'pool_exclusive': {
        const pool = String(k.pool);
        const bad = states.filter((s) => {
          const held = Object.values(s.reservations).filter((r) => r.exclusivityKey === pool && r.status === 'held').length;
          const confirmed = Object.values(s.commitments).filter((cm) => cm.status === 'confirmed' && cm.obligations.some((o) => o.exclusivityKey === pool)).length;
          return held + confirmed > 1;
        });
        res(bad.length === 0, bad.map((s) => `v${s.version}`).join(', '));
        break;
      }
      case 'no_foreign_knowledge': {
        const holders = new Set((k.holders as string[] | undefined) ?? []);
        const bad: string[] = [];
        for (const s of states) {
          for (const i of Object.values(s.knowledge)) {
            if (!holders.has(i.holder)) continue;
            const id = i.subject.replace(/\/withdrawal$/, '');
            const thread = id.startsWith('offer:') ? s.commitments[s.offers[id]?.commitmentId ?? ''] : s.commitments[id];
            if (thread?.pair === k.pair) bad.push(`${i.id}@v${s.version}`);
          }
        }
        res(bad.length === 0, [...new Set(bad)].join(', '));
        break;
      }
      case 'segment_rounds_max': {
        const max = Number(k.max);
        const bad = Object.values(final.offers).filter((o) => o.segmentRound > max);
        res(bad.length === 0, bad.map((o) => o.id).join(', '));
        break;
      }
      case 'no_dispatch': {
        res(states.every((s) => s.documents[String(k.docId)]?.status !== 'sent'));
        break;
      }
      case 'checkpoint_decided_if_occurs': {
        if (k.category === 'mutiny') {
          const outcomes = h.repo.committedBatches(sessionId).filter((b) => b.kind === 'system_outcome');
          const undecided = outcomes.filter((b) => h.repo.listDecisions(b.batchId).every((d) => d.option === 'ask'));
          res(mode === 'baseline' || undecided.length === 0, `${outcomes.length} staged outcome(s)`);
        } else {
          const deadlocks = h.repo.listPauses(sessionId).filter((p) => p.category === 'negotiation_deadlock');
          res(deadlocks.every((p) => p.status !== 'open'), `${deadlocks.length} deadlock pause(s)`);
        }
        break;
      }
      case 'arrival_day_recorded': {
        const confirmed = Object.values(final.commitments).find((cm) => cm.pair === 'hedong-khitan' && cm.status === 'confirmed');
        const offer = confirmed ? final.offers[confirmed.liveOfferId] : undefined;
        res(
          !confirmed || !offer || offer.terms.aid_cavalry === 0 || final.flags.khitanArrivalDay === (confirmed.confirmedDay ?? -1) + offer.terms.aid_arrival_days,
          `arrival ${final.flags.khitanArrivalDay}`,
        );
        break;
      }
      case 'intel_without_terms': {
        const intel = Object.values(final.messages).filter((m) => m.kind === 'intel');
        const leaky = intel.filter((m) => textOf(m.payload).includes('"terms"'));
        const liKnows = Object.values(final.knowledge).filter((i) => i.holder === 'li_congke' && i.predicate === 'terms' && final.commitments[final.offers[i.subject]?.commitmentId ?? '']?.pair === 'hedong-khitan');
        res(leaky.length === 0 && liKnows.length === 0, `${intel.length} intel message(s)`);
        break;
      }
      case 'projection_detail': {
        res(final.terminal?.kind !== 'no_assistance' || final.terminal.detail.projected === true);
        break;
      }
      default:
        out.push({ id: k.id, kind: k.kind, status: 'not_checked', detail: 'reported by the evaluation package (WP-F)' });
    }
  }
  return out;
}

export function isInjected(p: { rationale: string }): boolean {
  return p.rationale === 'injected misbehaviour';
}
