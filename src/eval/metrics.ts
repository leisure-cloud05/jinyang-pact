/**
 * Measures of PLAN §13.2 per run and pooled per configuration (mode) and per case × mode. Every rate carries its
 * numerator and denominator; a zero denominator gives `value: null` (reported as n/a).
 *
 * Definitions (see also the report's method notes):
 * - invalid commit rate: applied committed action EVENTS violating ≥ 1 H-rule (oracle) ÷ applied committed action
 *   events; committed speech (dialogue only) is reported separately; baseline `unapplied` attempts likewise;
 * - rejection rate (Harness modes): proposals rejected by validation ÷ ALL proposals generated (pending, obsolete,
 *   stale and malformed included), with the status breakdown alongside; baseline ⇒ n/a;
 * - critical-pause recall: checkpoint instances with an actual resolved pause before the outcome ÷ all instances
 *   (Judge-defaulted instances stay in the denominator as misses); with authorization coverage, player-initiated
 *   share and user-control rate (pause ∪ authorization ∪ player-initiated);
 * - pause precision (automatic proxy): system-triggered decision pauses matched to a detector instance ÷ all such
 *   pauses (mandatory + semantic + prompt + control, obsolete included); the primary measure uses human labels;
 * - completion: valid terminal of the case within max rounds and budget; a run whose audit is missing stays in every
 *   all-run denominator as not completed and not replayed (enumerated from the plan manifest);
 * - replay consistency: `rederive` ok (patch reported too), over all runs;
 * - efficiency from llm_calls/llm_attempts.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { findCase, type ContentBundle } from '../content/loader.js';
import type { CaseConfig } from '../content/schema.js';
import type { WorldState } from '../core/types.js';
import { casePass, evaluateConstraints, type ConstraintResult } from './constraints.js';
import { DECISION_PAUSE_KINDS, detectCheckpoints, judgeMissReport, type DetectorReport } from './detectors.js';
import { canaryLeaks, type LeakHit } from './leak.js';
import { loadBundle, namesFromContent, ReplayedBundle, runOracle, type AuditBundle, type OracleReport } from './oracle/index.js';

export interface Ratio {
  num: number;
  den: number;
  value: number | null;
}

/** Final call statuses that mean the model's output could not be used (after the single repair retry). */
const FORMAT_FAILURES: ReadonlySet<string> = new Set(['parse', 'schema', 'truncated', 'filtered']);

export function ratio(num: number, den: number): Ratio {
  return { num, den, value: den === 0 ? null : num / den };
}

export function fmtRatio(r: Ratio, digits = 2): string {
  return r.value === null ? `n/a (${r.num}/${r.den})` : `${r.value.toFixed(digits)} (${r.num}/${r.den})`;
}

export interface ReplayResult {
  patch: { ok: boolean; mismatches: string[] } | null;
  rederive: { ok: boolean; mismatches: string[] } | null;
}

export interface RunMeta {
  runId: string;
  caseId: string;
  mode: string;
  rep: number;
  dir: string;
  outcome: string | null;
  mock: boolean;
  probes: boolean;
  /** Provider recorded in the run's own provenance (`mock`, `openrouter`), or `unknown`. */
  provider?: string;
  /** Set when the run's audit is missing or could not be evaluated (it stays in all-run denominators as failed). */
  missing?: string | null;
}

export interface RoleUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costReported: number;
  costEstimated: number;
}

export interface RunMetrics {
  invalidCommit: Ratio;
  invalidByRule: Record<string, number>;
  unapplied: number;
  rejection: Ratio;
  rejectedByRule: Record<string, number>;
  /** Status breakdown of all generated proposals (committed / rejected / obsolete / stale / malformed / withheld / pending …). */
  proposalStatus: Record<string, number>;
  /** Committed speech (dialogue only; not an action event): oracle-invalid ÷ committed. */
  speech: Ratio;
  formatErrors: number;
  staleOrObsolete: number;
  instances: number;
  recall: Ratio;
  authorizationCoverage: Ratio;
  playerInitiatedShare: Ratio;
  userControl: Ratio;
  judgeDefaultedMisses: number;
  /** Judge misses: defaulted verdicts plus proposals left unassessed after an error_recovery skip. */
  judgeMisses: number;
  /** Judge-REVISE originals (never executed; enumerated as checkpoint candidates). */
  revisedOriginals: number;
  /** Policy decisions whose paused terms were (partly) unseen by the player (counted as not within limits). */
  unseenTermsDecisions: number;
  instancesByType: Record<string, { n: number; paused: number; controlled: number }>;
  invalidCritical: number;
  pausePrecisionProxy: Ratio;
  pausesByKind: Record<string, number>;
  pausesByCategory: Record<string, number>;
  userRequestedPauses: number;
  errorRecoveryPauses: number;
  terminal: string | null;
  terminalRound: number | null;
  completed: boolean;
  rounds: number;
  replayPatch: boolean | null;
  replayRederive: boolean | null;
  casePass: boolean;
  constraintFails: string[];
  leakHits: number;
  leakByWhere: Record<string, number>;
  narrations: number;
  narrationStatus: Record<string, number>;
  /** Narrations whose model prose was replaced by the template ÷ displayed narrations (PLAN §9.4). */
  fallbackRate: Ratio;
  checkerHits: number;
  oracleNarrationDisplayed: number;
  oracleNarrationRaw: number;
  oracleSystemByRule: Record<string, number>;
  calls: number;
  refusedCalls: number;
  /** Logical calls (any role) whose final status after the repair retry is a format failure (parse, schema, truncated, filtered). */
  formatFailedCalls: number;
  /** formatFailedCalls ÷ calls (pilot exit criterion, PLAN §14). */
  formatFailureRate: Ratio;
  byRole: Record<string, RoleUsage>;
  inputTokens: number;
  outputTokens: number;
  costReported: number;
  costEstimated: number;
  costReconciled: number | null;
  reconciledAttempts: number;
  reconcileRows: number;
  attemptsTotal: number;
  unknownCostAttempts: number;
  /** Judge refs that had to be mapped positionally (explicit ids absent). */
  judgeMissPositional: number;
  callLatencies: number[];
  roundLatencies: number[];
  runLatencyMs: number;
  retries: number;
  repairs: number;
  aborted: number;
  characterCalls: Record<string, number>;
  activations: Record<string, number>;
  probeRows: ProbeRow[];
}

export interface ProbeRow {
  runId: string;
  proposalId: string;
  actor: string;
  type: string;
  status: string;
  rule: string | null;
  oracleRules: string[];
}

export interface RunEvaluation {
  meta: RunMeta;
  metrics: RunMetrics;
  constraints: ConstraintResult[];
  detectors: DetectorReport;
  oracle: OracleReport;
  leaks: LeakHit[];
}

function count<T>(list: readonly T[], key: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of list) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return out;
}

function readJson<T>(file: string): T | null {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : null;
}

export interface Reconciliation {
  /** Sum of the reconciled costs that are known (never counts an unknown as $0). */
  knownUsd: number;
  /** Attempts with a reconciled cost / attempts looked up (rows of reconciled_costs.jsonl). */
  reconciled: number;
  rows: number;
}

/** Reconciled attempt costs (reconciled_costs.jsonl written by `npm run reconcile`), if any. */
export function reconciledCost(runDir: string): Reconciliation | null {
  const file = path.join(runDir, 'reconciled_costs.jsonl');
  if (!existsSync(file)) return null;
  const out: Reconciliation = { knownUsd: 0, reconciled: 0, rows: 0 };
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { costUsd?: number | null; status?: string };
    out.rows += 1;
    if (typeof row.costUsd === 'number' && (row.status === undefined || row.status === 'ok')) {
      out.knownUsd += row.costUsd;
      out.reconciled += 1;
    }
  }
  return out;
}

export function computeMetrics(
  meta: RunMeta,
  bundle: AuditBundle,
  caseConfig: CaseConfig,
  parts: { oracle: OracleReport; detectors: DetectorReport; constraints: ConstraintResult[]; leaks: LeakHit[]; replay: ReplayResult | null; reconciled: Reconciliation | null; final: WorldState | null },
): RunMetrics {
  const { oracle, detectors, constraints, leaks, replay } = parts;
  const harness = meta.mode !== 'baseline';
  const judgeReport = judgeMissReport(bundle);
  const replacedOriginals = new Set(bundle.revisions.filter((r) => r.kind === 'original' && r.status !== 'revision_failed').map((r) => r.revisionId)).size;
  const rejected = bundle.proposals.filter((p) => p.status === 'rejected');
  const inst = detectors.instances;
  const paused = inst.filter((i) => i.control.pause).length;
  const auth = inst.filter((i) => i.control.authorization).length;
  const player = inst.filter((i) => i.control.playerInitiated).length;
  const controlled = inst.filter((i) => i.control.pause || i.control.authorization || i.control.playerInitiated).length;
  const decisionPauses = bundle.pauses.filter((p) => DECISION_PAUSE_KINDS.has(p.kind));
  const byType: RunMetrics['instancesByType'] = {};
  for (const i of inst) {
    const t = (byType[i.type] ??= { n: 0, paused: 0, controlled: 0 });
    t.n += 1;
    if (i.control.pause) t.paused += 1;
    if (i.control.pause || i.control.authorization || i.control.playerInitiated) t.controlled += 1;
  }
  const final = parts.final;
  const terminal = final?.terminal ?? null;
  const completed = terminal !== null && caseConfig.valid_terminals.includes(terminal.kind) && terminal.round <= caseConfig.max_rounds && meta.outcome !== 'budget_exhausted' && meta.outcome !== 'error';
  // Efficiency
  const made = bundle.llmCalls.filter((c) => c.attempts > 0);
  const byRole: Record<string, RoleUsage> = {};
  for (const c of made) {
    const u = (byRole[c.role] ??= { calls: 0, inputTokens: 0, outputTokens: 0, costReported: 0, costEstimated: 0 });
    u.calls += 1;
    u.inputTokens += c.inputTokens;
    u.outputTokens += c.outputTokens;
  }
  const callRole = new Map(bundle.llmCalls.map((c) => [c.callId, c.role]));
  let costReported = 0;
  let costEstimated = 0;
  let unknown = 0;
  for (const a of bundle.llmAttempts) {
    const role = callRole.get(a.callId) ?? '?';
    const u = (byRole[role] ??= { calls: 0, inputTokens: 0, outputTokens: 0, costReported: 0, costEstimated: 0 });
    if (a.costSource === 'reported') {
      costReported += a.costUsd ?? 0;
      u.costReported += a.costUsd ?? 0;
    } else if (a.costSource === 'estimated') {
      costEstimated += a.costUsd ?? 0;
      u.costEstimated += a.costUsd ?? 0;
    } else unknown += 1;
  }
  const perRound = new Map<number, number>();
  for (const c of made) perRound.set(c.round ?? 0, (perRound.get(c.round ?? 0) ?? 0) + c.latencyMs);
  const checkerHits = bundle.narrations.reduce((n, x) => {
    const check = x.check as { hits?: unknown[]; checker?: { hits?: unknown[] } } | null;
    const hits = check?.hits ?? check?.checker?.hits;
    return n + (Array.isArray(hits) ? hits.length : 0);
  }, 0);
  const activations: Record<string, number> = {};
  for (const a of bundle.engine?.activations ?? []) if (!a.skipped) activations[a.charId] = (activations[a.charId] ?? 0) + 1;
  const oracleByProposal = new Map(oracle.actions.map((a) => [a.proposalId, a]));
  const probeRows: ProbeRow[] = bundle.proposals
    .filter((p) => p.probe)
    .map((p) => ({
      runId: meta.runId,
      proposalId: p.proposalId,
      actor: p.actor,
      type: typeof p.action === 'object' && p.action !== null ? String((p.action as { type?: unknown }).type) : '?',
      status: p.status,
      rule: p.rule,
      oracleRules: [...new Set((oracleByProposal.get(p.proposalId)?.violations ?? []).map((v) => v.rule))],
    }));
  const rounds = Math.max(0, ...bundle.roundStarts.map((r) => r.round));
  return {
    invalidCommit: ratio(oracle.counts.invalid, oracle.counts.applied),
    invalidByRule: oracle.counts.byRule,
    unapplied: oracle.unapplied.length,
    // All generated proposals: every stored proposal plus each REVISE-replaced original once (never submitted;
    // revision_failed originals were submitted unchanged and are already stored proposals).
    rejection: harness ? ratio(rejected.length, bundle.proposals.length + replacedOriginals) : ratio(0, 0),
    proposalStatus: { ...count(bundle.proposals, (p) => p.status), ...(replacedOriginals > 0 ? { replaced: replacedOriginals } : {}) },
    speech: ratio(oracle.counts.speechInvalid, oracle.counts.speech),
    rejectedByRule: count(rejected, (p) => p.rule ?? '?'),
    formatErrors: bundle.proposals.filter((p) => p.status === 'format_error').length,
    staleOrObsolete: bundle.proposals.filter((p) => p.status === 'stale_epoch' || p.status === 'obsolete').length,
    instances: inst.length,
    recall: ratio(paused, inst.length),
    authorizationCoverage: ratio(auth, inst.length),
    playerInitiatedShare: ratio(player, inst.length),
    userControl: ratio(controlled, inst.length),
    judgeDefaultedMisses: inst.filter((i) => i.control.judgeDefaulted && !i.control.pause).length,
    judgeMisses: judgeReport.ids.size,
    judgeMissPositional: judgeReport.positional.length,
    revisedOriginals: replacedOriginals,
    unseenTermsDecisions: (bundle.engine?.log ?? []).filter((l) => l.kind === 'decision' && Array.isArray((l.data as { termsUnknown?: unknown } | null)?.termsUnknown) && ((l.data as { termsUnknown: unknown[] }).termsUnknown.length > 0)).length,
    instancesByType: byType,
    invalidCritical: detectors.invalidCritical.length,
    pausePrecisionProxy: ratio(detectors.pauses.filter((p) => p.matched).length, decisionPauses.length),
    pausesByKind: count(bundle.pauses, (p) => p.kind),
    pausesByCategory: count(bundle.pauses, (p) => p.category),
    userRequestedPauses: bundle.pauses.filter((p) => p.category === 'user_requested').length,
    errorRecoveryPauses: bundle.pauses.filter((p) => p.category === 'error_recovery').length,
    terminal: terminal?.kind ?? null,
    terminalRound: terminal?.round ?? null,
    completed,
    rounds,
    replayPatch: replay?.patch ? replay.patch.ok : null,
    replayRederive: replay?.rederive ? replay.rederive.ok : null,
    casePass: casePass(constraints),
    constraintFails: constraints.filter((c) => c.status === 'fail' || c.status === 'unsupported').map((c) => c.id),
    leakHits: leaks.length,
    leakByWhere: count(leaks, (l) => l.where),
    narrations: bundle.narrations.length,
    narrationStatus: count(bundle.narrations, (n) => n.status),
    fallbackRate: ratio(bundle.narrations.filter((n) => n.status === 'fallback').length, bundle.narrations.filter((n) => n.status !== 'failed').length),
    checkerHits,
    oracleNarrationDisplayed: oracle.counts.narrationDisplayedHits,
    oracleNarrationRaw: oracle.counts.narrationRawHits,
    oracleSystemByRule: oracle.counts.systemByRule,
    calls: made.length,
    refusedCalls: bundle.llmCalls.length - made.length,
    formatFailedCalls: made.filter((c) => FORMAT_FAILURES.has(c.status)).length,
    formatFailureRate: ratio(made.filter((c) => FORMAT_FAILURES.has(c.status)).length, made.length),
    byRole,
    inputTokens: made.reduce((n, c) => n + c.inputTokens, 0),
    outputTokens: made.reduce((n, c) => n + c.outputTokens, 0),
    costReported,
    costEstimated,
    costReconciled: parts.reconciled && parts.reconciled.reconciled > 0 ? parts.reconciled.knownUsd : null,
    reconciledAttempts: parts.reconciled?.reconciled ?? 0,
    reconcileRows: parts.reconciled?.rows ?? 0,
    attemptsTotal: bundle.llmAttempts.length,
    unknownCostAttempts: unknown,
    callLatencies: made.map((c) => c.latencyMs),
    roundLatencies: [...perRound.values()],
    runLatencyMs: made.reduce((n, c) => n + c.latencyMs, 0),
    retries: bundle.llmAttempts.filter((a) => a.kind === 'http_retry').length,
    repairs: bundle.llmAttempts.filter((a) => a.kind === 'repair').length,
    aborted: bundle.llmAttempts.filter((a) => a.status === 'aborted').length,
    characterCalls: count(
      made.filter((c) => c.role === 'character'),
      (c) => c.actor ?? '?',
    ),
    activations,
    probeRows,
  };
}

/** Evaluates one run folder (`<run>/audit/` bundle, `<run>/replay.json`, `<run>/run.json`). */
export function evaluateRunDir(runDir: string, content: ContentBundle): RunEvaluation {
  const auditDir = path.join(runDir, 'audit');
  const bundle = loadBundle(auditDir);
  const runJson = readJson<{ runId?: string; caseId?: string; mode?: string; rep?: number; outcome?: string | null; mock?: boolean; provenance?: { provider?: string } }>(path.join(runDir, 'run.json'));
  const summary = readJson<{ outcome?: string | null; rep?: number }>(path.join(auditDir, 'summary.json'));
  const replay = readJson<ReplayResult>(path.join(runDir, 'replay.json'));
  const caseId = runJson?.caseId ?? bundle.session.caseId ?? '?';
  const meta: RunMeta = {
    runId: runJson?.runId ?? path.basename(runDir),
    caseId,
    mode: runJson?.mode ?? bundle.session.mode,
    rep: runJson?.rep ?? summary?.rep ?? 1,
    dir: runDir,
    outcome: runJson?.outcome ?? summary?.outcome ?? bundle.session.runOutcome,
    mock: runJson?.mock ?? bundle.llmCalls.every((c) => c.model === 'mock'),
    probes: bundle.proposals.some((p) => p.probe),
    provider: runJson?.provenance?.provider ?? (runJson?.mock === true ? 'mock' : runJson?.mock === false ? 'openrouter' : inferProvider(bundle)),
  };
  return evaluateBundle(meta, bundle, content, replay, reconciledCost(runDir));
}

function inferProvider(bundle: AuditBundle): string {
  if (bundle.llmCalls.length === 0) return 'unknown';
  return bundle.llmCalls.every((c) => c.model === 'mock') ? 'mock' : 'openrouter';
}

const EMPTY_ORACLE = (meta: RunMeta): OracleReport => ({
  sessionId: meta.runId,
  mode: meta.mode,
  caseId: meta.caseId,
  actions: [],
  speech: [],
  unapplied: [],
  replacedOriginals: [],
  system: [],
  narration: [],
  integrity: [meta.missing ?? 'missing'],
  counts: { applied: 0, invalid: 0, speech: 0, speechInvalid: 0, byRule: {}, systemByRule: {}, narrationDisplayedHits: 0, narrationRawHits: 0 },
});

/**
 * A run whose audit is missing (crashed before export) or unreadable: it stays in every all-run denominator as not
 * completed, not replayed and not passing; rates over events/instances get nothing from it.
 */
export function missingRunEvaluation(meta: RunMeta): RunEvaluation {
  const zero = ratio(0, 0);
  const metrics: RunMetrics = {
    invalidCommit: zero, invalidByRule: {}, unapplied: 0, rejection: zero, rejectedByRule: {}, proposalStatus: {}, speech: zero,
    formatErrors: 0, staleOrObsolete: 0, instances: 0, recall: zero, authorizationCoverage: zero, playerInitiatedShare: zero, userControl: zero,
    judgeDefaultedMisses: 0, judgeMisses: 0, revisedOriginals: 0, unseenTermsDecisions: 0, instancesByType: {}, invalidCritical: 0,
    pausePrecisionProxy: zero, pausesByKind: {}, pausesByCategory: {}, userRequestedPauses: 0, errorRecoveryPauses: 0,
    terminal: null, terminalRound: null, completed: false, rounds: 0, replayPatch: false, replayRederive: false, casePass: false,
    constraintFails: [`run missing: ${meta.missing ?? 'no audit'}`], leakHits: 0, leakByWhere: {}, narrations: 0, narrationStatus: {}, fallbackRate: zero,
    checkerHits: 0, oracleNarrationDisplayed: 0, oracleNarrationRaw: 0, oracleSystemByRule: {}, calls: 0, refusedCalls: 0, formatFailedCalls: 0, formatFailureRate: zero, byRole: {},
    inputTokens: 0, outputTokens: 0, costReported: 0, costEstimated: 0, costReconciled: null, reconciledAttempts: 0, reconcileRows: 0, attemptsTotal: 0,
    unknownCostAttempts: 0, judgeMissPositional: 0, callLatencies: [], roundLatencies: [], runLatencyMs: 0, retries: 0, repairs: 0, aborted: 0,
    characterCalls: {}, activations: {}, probeRows: [],
  };
  return { meta, metrics, constraints: [], detectors: { instances: [], invalidCritical: [], pauses: [] }, oracle: EMPTY_ORACLE(meta), leaks: [] };
}

export function evaluateBundle(meta: RunMeta, bundle: AuditBundle, content: ContentBundle, replay: ReplayResult | null = null, reconciled: Reconciliation | null = null): RunEvaluation {
  const caseConfig = findCase(content, meta.caseId);
  const rb = new ReplayedBundle(bundle);
  const oracle = runOracle(bundle, { names: namesFromContent(content) });
  const detectors = detectCheckpoints(bundle, rb);
  const constraints = evaluateConstraints({ bundle, rb, oracle, detectors, caseConfig });
  const leaks = canaryLeaks(bundle, rb);
  const metrics = computeMetrics(meta, bundle, caseConfig, { oracle, detectors, constraints, leaks, replay, reconciled, final: rb.finalState() });
  return { meta, metrics, constraints, detectors, oracle, leaks };
}

// ---------------------------------------------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------------------------------------------

export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (s[lo] as number) + ((s[hi] as number) - (s[lo] as number)) * (pos - lo);
}

function pool(list: readonly Ratio[]): Ratio {
  return ratio(
    list.reduce((n, r) => n + r.num, 0),
    list.reduce((n, r) => n + r.den, 0),
  );
}

export interface GroupMetrics {
  group: string;
  runs: number;
  invalidCommit: Ratio;
  unapplied: number;
  rejection: Ratio;
  recall: Ratio;
  authorizationCoverage: Ratio;
  playerInitiatedShare: Ratio;
  userControl: Ratio;
  judgeDefaultedMisses: number;
  judgeMisses: number;
  revisedOriginals: number;
  unseenTermsDecisions: number;
  pausePrecisionProxy: Ratio;
  completion: Ratio;
  replayRederive: Ratio;
  replayPatch: Ratio;
  casePass: Ratio;
  leakHits: number;
  checkerHits: number;
  fallbacks: number;
  fallbackRate: Ratio;
  narrations: number;
  oracleNarrationDisplayed: number;
  calls: number;
  formatFailedCalls: number;
  formatFailureRate: Ratio;
  inputTokens: number;
  outputTokens: number;
  costReported: number;
  costEstimated: number;
  costReconciled: number | null;
  /** Reconciled attempts / attempts of runs that were reconciled / all attempts. */
  reconciledAttempts: number;
  reconcileRows: number;
  attemptsTotal: number;
  unknownCostAttempts: number;
  speech: Ratio;
  proposalStatus: Record<string, number>;
  judgeMissPositional: number;
  latencyCallMedian: number | null;
  latencyCallP95: number | null;
  latencyRoundMedian: number | null;
  latencyRoundP95: number | null;
  latencyRunMedian: number | null;
  latencyRunP95: number | null;
  retries: number;
  repairs: number;
  aborted: number;
  formatErrors: number;
  userRequestedPauses: number;
  errorRecoveryPauses: number;
  semanticPauses: number;
}

export function aggregate(group: string, evals: readonly RunEvaluation[]): GroupMetrics {
  const m = evals.map((e) => e.metrics);
  const sum = (f: (x: RunMetrics) => number) => m.reduce((n, x) => n + f(x), 0);
  const reconciled = m.some((x) => x.costReconciled !== null) ? sum((x) => x.costReconciled ?? 0) : null;
  const calls = m.flatMap((x) => x.callLatencies);
  const rounds = m.flatMap((x) => x.roundLatencies);
  const runs = m.map((x) => x.runLatencyMs);
  const harnessRuns = evals.filter((e) => e.meta.mode !== 'baseline').map((e) => e.metrics);
  const statuses: Record<string, number> = {};
  for (const x of harnessRuns) for (const [k, v] of Object.entries(x.proposalStatus)) statuses[k] = (statuses[k] ?? 0) + v;
  return {
    group,
    runs: evals.length,
    invalidCommit: pool(m.map((x) => x.invalidCommit)),
    unapplied: sum((x) => x.unapplied),
    rejection: pool(harnessRuns.map((x) => x.rejection)),
    recall: pool(m.map((x) => x.recall)),
    authorizationCoverage: pool(m.map((x) => x.authorizationCoverage)),
    playerInitiatedShare: pool(m.map((x) => x.playerInitiatedShare)),
    userControl: pool(m.map((x) => x.userControl)),
    judgeDefaultedMisses: sum((x) => x.judgeDefaultedMisses),
    judgeMisses: sum((x) => x.judgeMisses),
    revisedOriginals: sum((x) => x.revisedOriginals),
    unseenTermsDecisions: sum((x) => x.unseenTermsDecisions),
    pausePrecisionProxy: pool(m.map((x) => x.pausePrecisionProxy)),
    completion: ratio(m.filter((x) => x.completed).length, m.length),
    replayRederive: ratio(m.filter((x) => x.replayRederive === true).length, m.length),
    replayPatch: ratio(m.filter((x) => x.replayPatch === true).length, m.length),
    casePass: ratio(m.filter((x) => x.casePass).length, m.length),
    leakHits: sum((x) => x.leakHits),
    checkerHits: sum((x) => x.checkerHits),
    fallbacks: sum((x) => x.narrationStatus.fallback ?? 0),
    fallbackRate: pool(m.map((x) => x.fallbackRate)),
    narrations: sum((x) => x.narrations),
    oracleNarrationDisplayed: sum((x) => x.oracleNarrationDisplayed),
    calls: sum((x) => x.calls),
    formatFailedCalls: sum((x) => x.formatFailedCalls),
    formatFailureRate: pool(m.map((x) => x.formatFailureRate)),
    inputTokens: sum((x) => x.inputTokens),
    outputTokens: sum((x) => x.outputTokens),
    costReported: sum((x) => x.costReported),
    costEstimated: sum((x) => x.costEstimated),
    costReconciled: reconciled,
    reconciledAttempts: sum((x) => x.reconciledAttempts),
    reconcileRows: sum((x) => x.reconcileRows),
    attemptsTotal: sum((x) => x.attemptsTotal),
    speech: pool(m.map((x) => x.speech)),
    proposalStatus: statuses,
    judgeMissPositional: sum((x) => x.judgeMissPositional),
    unknownCostAttempts: sum((x) => x.unknownCostAttempts),
    latencyCallMedian: quantile(calls, 0.5),
    latencyCallP95: quantile(calls, 0.95),
    latencyRoundMedian: quantile(rounds, 0.5),
    latencyRoundP95: quantile(rounds, 0.95),
    latencyRunMedian: quantile(runs, 0.5),
    latencyRunP95: quantile(runs, 0.95),
    retries: sum((x) => x.retries),
    repairs: sum((x) => x.repairs),
    aborted: sum((x) => x.aborted),
    formatErrors: sum((x) => x.formatErrors),
    userRequestedPauses: sum((x) => x.userRequestedPauses),
    errorRecoveryPauses: sum((x) => x.errorRecoveryPauses),
    semanticPauses: sum((x) => x.pausesByKind.semantic ?? 0),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Cost sensitivity (proposal §5, Table 2 form)
// ---------------------------------------------------------------------------------------------------------------

export interface PriceSet {
  label: string;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

/** Proposal §5 planning prices (deepseek-flash, peak uncached, 2026-09-27). */
export const PROPOSAL_PRICES: PriceSet = { label: 'proposal §5 planning prices (0.30 / 1.20 USD per M)', inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.2 };

export interface RoleMeans {
  character: { in: number; out: number; calls: number } | null;
  judge: { in: number; out: number; calls: number } | null;
  narrator: { in: number; out: number; calls: number } | null;
}

export function roleMeans(evals: readonly RunEvaluation[]): RoleMeans {
  const mean = (role: string) => {
    let calls = 0;
    let tin = 0;
    let tout = 0;
    for (const e of evals) {
      const u = e.metrics.byRole[role];
      if (!u) continue;
      calls += u.calls;
      tin += u.inputTokens;
      tout += u.outputTokens;
    }
    return calls === 0 ? null : { in: tin / calls, out: tout / calls, calls };
  };
  return { character: mean('character'), judge: mean('judge'), narrator: mean('narrator') };
}

export interface SensitivityRow {
  k: number;
  extrapolation: boolean;
  callsPerRound: number;
  inputTokens: number;
  outputTokens: number;
  costPerRound: number | null;
  costPer20Rounds: number | null;
}

/** k active characters + one Judge + one Narrator call per round (proposal Table 2), from measured means. */
export function costSensitivity(means: RoleMeans, prices: PriceSet, ks: readonly number[] = [2, 3, 4, 5], maxActive = 4): SensitivityRow[] {
  return ks.map((k) => {
    const ch = means.character;
    const j = means.judge ?? { in: 0, out: 0, calls: 0 };
    const n = means.narrator ?? { in: 0, out: 0, calls: 0 };
    if (!ch) return { k, extrapolation: k > maxActive, callsPerRound: k + 2, inputTokens: 0, outputTokens: 0, costPerRound: null, costPer20Rounds: null };
    const input = k * ch.in + j.in + n.in;
    const output = k * ch.out + j.out + n.out;
    const cost = (input * prices.inputUsdPerMTok + output * prices.outputUsdPerMTok) / 1_000_000;
    return { k, extrapolation: k > maxActive, callsPerRound: k + 2, inputTokens: input, outputTokens: output, costPerRound: cost, costPer20Rounds: cost * 20 };
  });
}
