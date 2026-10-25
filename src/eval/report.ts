/**
 * Experiment report (PLAN §13.2): reads every run folder of an experiment, evaluates it (oracle, detectors,
 * constraints, leakage, efficiency) and writes `<dir>/report/`: metrics.json, metrics.csv (long form: scope, group,
 * measure, numerator, denominator, value), cases.csv (per-case pass table), runs.csv, findings/<run>.json,
 * summary.md and SVG figures. Mock experiments are labelled "PIPELINE VALIDATION (mock LLM) — not findings".
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ContentBundle } from '../content/loader.js';
import { lookupPrice, DEFAULT_PRICES } from '../llm/prices.js';
import { redactSecrets } from '../llm/redact.js';
import {
  aggregate,
  costSensitivity,
  evaluateRunDir,
  fmtRatio,
  PROPOSAL_PRICES,
  roleMeans,
  type GroupMetrics,
  type PriceSet,
  type Ratio,
  missingRunEvaluation,
  type RunEvaluation,
  type RunMeta,
  type SensitivityRow,
} from './metrics.js';
import { narrationListing } from './narration-listing.js';
import { loadBundle } from './oracle/index.js';
import { MOCK_LABEL } from './runner.js';
import { groupedBarChart, matrixChart } from './svg.js';

export const MODE_ORDER = ['baseline', 'no_judge', 'full'] as const;

export interface ReportOptions {
  dir: string;
  content: ContentBundle;
  outDir?: string;
  now?: () => Date;
}

export interface ReportResult {
  outDir: string;
  files: string[];
  evaluations: RunEvaluation[];
  mock: boolean;
  byMode: GroupMetrics[];
}

/** Expected run ids: the plan manifest's list, plus any other run folder found (a crashed run keeps its slot). */
export function expectedRunIds(dir: string, planned: readonly string[] | null): string[] {
  const found = existsSync(dir)
    ? readdirSync(dir).filter((n) => statSync(path.join(dir, n)).isDirectory() && (existsSync(path.join(dir, n, 'run.json')) || existsSync(path.join(dir, n, 'audit', 'session.json'))))
    : [];
  const ids = [...(planned ?? [])];
  for (const n of found.sort()) if (!ids.includes(n)) ids.push(n);
  return ids;
}

function evaluateExpected(dir: string, id: string, content: ContentBundle): RunEvaluation {
  const runDir = path.join(dir, id);
  const runJsonFile = path.join(runDir, 'run.json');
  const runJson = existsSync(runJsonFile) ? (JSON.parse(readFileSync(runJsonFile, 'utf8')) as { caseId?: string; mode?: string; rep?: number; outcome?: string | null; error?: string | null; provenance?: { provider?: string } }) : null;
  const parsed = /^(.+)-(baseline|no_judge|full)-r(\d+)$/.exec(id);
  const meta: RunMeta = {
    runId: id,
    caseId: runJson?.caseId ?? parsed?.[1] ?? id,
    mode: runJson?.mode ?? parsed?.[2] ?? '?',
    rep: runJson?.rep ?? Number(parsed?.[3] ?? 1),
    dir: runDir,
    outcome: runJson?.outcome ?? 'missing',
    mock: runJson?.provenance?.provider !== 'openrouter',
    probes: false,
    provider: runJson?.provenance?.provider ?? 'unknown',
  };
  if (!existsSync(path.join(runDir, 'audit', 'session.json'))) return missingRunEvaluation({ ...meta, missing: `no audit bundle${runJson?.error ? ` (${runJson.error})` : ''}` });
  try {
    return evaluateRunDir(runDir, content);
  } catch (err) {
    return missingRunEvaluation({ ...meta, missing: `audit could not be evaluated: ${(err as Error).message}` });
  }
}

/** Run folders of an experiment: sub-directories holding `audit/session.json`. */
export function findRunDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((n) => path.join(dir, n))
    .filter((p) => statSync(p).isDirectory() && existsSync(path.join(p, 'audit', 'session.json')))
    .sort();
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csv(rows: unknown[][]): string {
  return `${rows.map((r) => r.map(csvCell).join(',')).join('\n')}\n`;
}

function pct(r: Ratio): string {
  return fmtRatio(r);
}

function num(v: number | null, digits = 0): string {
  return v === null ? 'n/a' : v.toFixed(digits);
}

function usd(v: number | null): string {
  return v === null ? 'n/a' : `$${v.toFixed(6)}`;
}

function modesOf(evals: readonly RunEvaluation[]): string[] {
  const present = new Set(evals.map((e) => e.meta.mode));
  return [...MODE_ORDER.filter((m) => present.has(m)), ...[...present].filter((m) => !(MODE_ORDER as readonly string[]).includes(m))];
}

const RATIO_MEASURES: Array<[string, (g: GroupMetrics) => Ratio]> = [
  ['invalid_commit_rate', (g) => g.invalidCommit],
  ['rejection_rate', (g) => g.rejection],
  ['critical_pause_recall', (g) => g.recall],
  ['authorization_coverage', (g) => g.authorizationCoverage],
  ['player_initiated_share', (g) => g.playerInitiatedShare],
  ['user_control_rate', (g) => g.userControl],
  ['pause_precision_proxy', (g) => g.pausePrecisionProxy],
  ['completion_rate', (g) => g.completion],
  ['replay_rederive', (g) => g.replayRederive],
  ['replay_patch', (g) => g.replayPatch],
  ['case_pass', (g) => g.casePass],
  ['narration_fallback_rate', (g) => g.fallbackRate],
  ['format_failure_rate', (g) => g.formatFailureRate],
];

const COUNT_MEASURES: Array<[string, (g: GroupMetrics) => number | null]> = [
  ['runs', (g) => g.runs],
  ['unapplied_attempts', (g) => g.unapplied],
  ['judge_defaulted_misses', (g) => g.judgeDefaultedMisses],
  ['judge_misses', (g) => g.judgeMisses],
  ['revise_originals', (g) => g.revisedOriginals],
  ['unseen_terms_decisions', (g) => g.unseenTermsDecisions],
  ['leak_hits', (g) => g.leakHits],
  ['narrations', (g) => g.narrations],
  ['narration_checker_hits', (g) => g.checkerHits],
  ['narration_fallbacks', (g) => g.fallbacks],
  ['oracle_h16_displayed', (g) => g.oracleNarrationDisplayed],
  ['calls', (g) => g.calls],
  ['format_failed_calls', (g) => g.formatFailedCalls],
  ['input_tokens', (g) => g.inputTokens],
  ['output_tokens', (g) => g.outputTokens],
  ['cost_reported_usd', (g) => g.costReported],
  ['cost_estimated_usd', (g) => g.costEstimated],
  ['cost_reconciled_usd', (g) => g.costReconciled],
  ['unknown_cost_attempts', (g) => g.unknownCostAttempts],
  ['latency_call_median_ms', (g) => g.latencyCallMedian],
  ['latency_call_p95_ms', (g) => g.latencyCallP95],
  ['latency_round_median_ms', (g) => g.latencyRoundMedian],
  ['latency_round_p95_ms', (g) => g.latencyRoundP95],
  ['latency_run_median_ms', (g) => g.latencyRunMedian],
  ['latency_run_p95_ms', (g) => g.latencyRunP95],
  ['http_retries', (g) => g.retries],
  ['repairs', (g) => g.repairs],
  ['aborted_attempts', (g) => g.aborted],
  ['format_errors', (g) => g.formatErrors],
  ['semantic_pauses', (g) => g.semanticPauses],
  ['user_requested_pauses', (g) => g.userRequestedPauses],
  ['error_recovery_pauses', (g) => g.errorRecoveryPauses],
];

function longRows(scope: string, g: GroupMetrics): unknown[][] {
  const rows: unknown[][] = [];
  for (const [name, f] of RATIO_MEASURES) {
    const r = f(g);
    rows.push([scope, g.group, name, r.num, r.den, r.value === null ? 'n/a' : r.value]);
  }
  for (const [name, f] of COUNT_MEASURES) {
    const v = f(g);
    rows.push([scope, g.group, name, '', '', v === null ? 'n/a' : v]);
  }
  return rows;
}

function sensitivityTable(rows: SensitivityRow[], prices: PriceSet): string[] {
  const out = [`Prices: ${prices.label}.`, '', '| active characters k | calls per round | input / output tokens | cost per round (US$) | cost for 20 rounds (US$) |', '|---|---|---|---|---|'];
  for (const r of rows) {
    out.push(
      `| ${r.k}${r.extrapolation ? ' (extrapolation: above the scheduler cap of 4)' : ''} | ${r.callsPerRound} | ${Math.round(r.inputTokens).toLocaleString('en-US')} / ${Math.round(r.outputTokens).toLocaleString('en-US')} | ${r.costPerRound === null ? 'n/a' : r.costPerRound.toFixed(5)} | ${r.costPer20Rounds === null ? 'n/a' : r.costPer20Rounds.toFixed(4)} |`,
    );
  }
  return out;
}

export function buildReport(opts: ReportOptions): ReportResult {
  const dir = path.resolve(opts.dir);
  const outDir = path.resolve(opts.outDir ?? path.join(dir, 'report'));
  const now = opts.now ?? (() => new Date());
  const plan = existsSync(path.join(dir, 'plan.json')) ? (JSON.parse(readFileSync(path.join(dir, 'plan.json'), 'utf8')) as { plan?: { name?: string }; runs?: string[]; misbehaviourRate?: number | null; freeze?: { status?: string } | null }) : null;
  const expected = expectedRunIds(dir, plan?.runs ?? null);
  if (expected.length === 0) throw new Error(`no runs (plan.json or run folders) under ${dir}`);
  const evaluations = expected.map((id) => evaluateExpected(dir, id, opts.content));
  const missing = evaluations.filter((e) => e.meta.missing);
  // Labelling comes from each run's own recorded provider; a mixed set is refused (PLAN §13 "Freeze scope").
  const providers = new Set(evaluations.map((e) => e.meta.provider ?? 'unknown').filter((p) => p !== 'unknown'));
  if (providers.size > 1) throw new Error(`refusing to report a mixed set of runs (providers: ${[...providers].join(', ')})`);
  const mock = !providers.has('openrouter');
  const banner = mock ? MOCK_LABEL : null;
  const modes = modesOf(evaluations);
  const cases = [...new Set(evaluations.map((e) => e.meta.caseId))].sort();
  const byMode = modes.map((m) => aggregate(m, evaluations.filter((e) => e.meta.mode === m)));
  const byCaseMode: GroupMetrics[] = [];
  for (const c of cases) for (const m of modes) {
    const list = evaluations.filter((e) => e.meta.caseId === c && e.meta.mode === m);
    if (list.length > 0) byCaseMode.push(aggregate(`${c}/${m}`, list));
  }
  const overall = aggregate('all', evaluations);
  const means = roleMeans(evaluations);
  const boundPrice = lookupPrice('deepseek/deepseek-v4-flash', DEFAULT_PRICES);
  const priceSets: PriceSet[] = [PROPOSAL_PRICES, ...(boundPrice ? [{ label: 'configured OpenRouter price bound for deepseek/deepseek-v4-flash (upper bound)', inputUsdPerMTok: boundPrice.inputUsdPerMTok, outputUsdPerMTok: boundPrice.outputUsdPerMTok }] : [])];
  const sensitivity = priceSets.map((p) => ({ prices: p, rows: costSensitivity(means, p) }));

  mkdirSync(path.join(outDir, 'figures'), { recursive: true });
  mkdirSync(path.join(outDir, 'findings'), { recursive: true });
  mkdirSync(path.join(outDir, 'narrations'), { recursive: true });
  const files: string[] = [];
  const write = (rel: string, text: string) => {
    const file = path.join(outDir, rel);
    writeFileSync(file, redactSecrets(text), 'utf8');
    files.push(file);
  };

  // ---- CSV / JSON ------------------------------------------------------------------------------------------
  const header = ['scope', 'group', 'measure', 'numerator', 'denominator', 'value'];
  write('metrics.csv', csv([header, ...longRows('all', overall), ...byMode.flatMap((g) => longRows('mode', g)), ...byCaseMode.flatMap((g) => longRows('case_mode', g))]));
  const caseRows: unknown[][] = [['case', 'mode', 'runs', 'passed', 'pass_rate', 'failing_constraints', 'exposure', 'human_annotation']];
  for (const c of cases) for (const m of modes) {
    const list = evaluations.filter((e) => e.meta.caseId === c && e.meta.mode === m);
    if (list.length === 0) continue;
    const passed = list.filter((e) => e.metrics.casePass).length;
    const failing = [...new Set(list.flatMap((e) => e.metrics.constraintFails))].join(';');
    const exposure = [...new Set(list.flatMap((e) => e.constraints.filter((x) => x.exposed !== null).map((x) => `${x.id}=${list.filter((y) => y.constraints.find((z) => z.id === x.id)?.exposed).length}/${list.length}`)))].join(';');
    const human = [...new Set(list.flatMap((e) => e.constraints.filter((x) => x.status === 'human').map((x) => x.id)))].join(';');
    caseRows.push([c, m, list.length, passed, (passed / list.length).toFixed(2), failing, exposure, human]);
  }
  write('cases.csv', csv(caseRows));
  const runRows: unknown[][] = [['run', 'case', 'mode', 'rep', 'outcome', 'terminal', 'terminal_round', 'completed', 'invalid_num', 'invalid_den', 'instances', 'paused', 'user_controlled', 'judge_misses', 'case_pass', 'replay_patch', 'replay_rederive', 'leaks', 'narrations_displayed', 'fallbacks', 'fallback_rate', 'calls', 'input_tokens', 'output_tokens', 'cost_reported', 'cost_estimated']];
  for (const e of evaluations) {
    const m = e.metrics;
    runRows.push([e.meta.runId, e.meta.caseId, e.meta.mode, e.meta.rep, e.meta.outcome, m.terminal, m.terminalRound, m.completed, m.invalidCommit.num, m.invalidCommit.den, m.instances, m.recall.num, m.userControl.num, m.judgeMisses, m.casePass, m.replayPatch, m.replayRederive, m.leakHits, m.fallbackRate.den, m.fallbackRate.num, m.fallbackRate.value === null ? 'n/a' : m.fallbackRate.value.toFixed(3), m.calls, m.inputTokens, m.outputTokens, m.costReported, m.costEstimated]);
    if (!e.meta.missing) write(path.join('narrations', `${e.meta.runId}.md`), narrationListing(loadBundle(path.join(e.meta.dir, 'audit')), e.meta.runId));
    write(
      path.join('findings', `${e.meta.runId}.json`),
      `${JSON.stringify({ meta: e.meta, constraints: e.constraints, instances: e.detectors.instances, invalidCritical: e.detectors.invalidCritical, pauses: e.detectors.pauses, oracle: { counts: e.oracle.counts, actions: e.oracle.actions.filter((a) => a.violations.length > 0), system: e.oracle.system, narration: e.oracle.narration.filter((n) => n.displayed.length + n.raw.length > 0), integrity: e.oracle.integrity, unapplied: e.oracle.unapplied }, leaks: e.leaks }, null, 2)}\n`,
    );
  }
  write('runs.csv', csv(runRows));
  const strip = (e: RunEvaluation) => {
    const { callLatencies: _c, roundLatencies: _r, ...rest } = e.metrics;
    return { meta: e.meta, metrics: rest, constraints: e.constraints };
  };
  write(
    'metrics.json',
    `${JSON.stringify({ label: banner, generatedAt: now().toISOString(), plan, overall, byMode, byCaseMode, roleMeans: means, costSensitivity: sensitivity, runs: evaluations.map(strip) }, null, 2)}\n`,
  );

  // ---- Figures -----------------------------------------------------------------------------------------
  const ratioSeries = (name: string, f: (g: GroupMetrics) => Ratio) => ({
    name,
    values: byMode.map((g) => f(g).value),
    labels: byMode.map((g) => `${f(g).value === null ? 'n/a' : f(g).value!.toFixed(2)} (${f(g).num}/${f(g).den})`),
  });
  write(
    'figures/invalid_commit_rate.svg',
    groupedBarChart({
      title: 'Invalid commit rate by configuration',
      description: 'Share of applied committed actions that violate at least one hard rule (independent oracle); numerator/denominator on each bar.',
      categories: byMode.map((g) => g.group),
      series: [ratioSeries('invalid commit rate', (g) => g.invalidCommit)],
      yMax: 1,
      yLabel: 'rate',
      banner,
    }),
  );
  const controlMeasures: Array<[string, (g: GroupMetrics) => Ratio]> = [
    ['critical-pause recall', (g) => g.recall],
    ['user-control rate', (g) => g.userControl],
    ['pause precision (proxy)', (g) => g.pausePrecisionProxy],
  ];
  write(
    'figures/control.svg',
    groupedBarChart({
      title: 'Checkpoint control by configuration',
      description: 'Critical-pause recall (actual pause), user-control rate (pause, authorization or player-initiated) and automatic pause-precision proxy per configuration.',
      categories: controlMeasures.map(([n]) => n),
      series: byMode.map((g) => ({
        name: g.group,
        values: controlMeasures.map(([, f]) => f(g).value),
        labels: controlMeasures.map(([, f]) => `${f(g).value === null ? 'n/a' : f(g).value!.toFixed(2)} (${f(g).num}/${f(g).den})`),
      })),
      yMax: 1,
      yLabel: 'rate',
      banner,
    }),
  );
  const outcomeMeasures: Array<[string, (g: GroupMetrics) => Ratio]> = [
    ['completion', (g) => g.completion],
    ['case pass', (g) => g.casePass],
    ['replay (rederive)', (g) => g.replayRederive],
  ];
  write(
    'figures/outcomes.svg',
    groupedBarChart({
      title: 'Completion, case pass and replay consistency',
      description: 'Share of runs per configuration reaching a valid terminal, passing all case constraints, and reproduced by rederive replay.',
      categories: outcomeMeasures.map(([n]) => n),
      series: byMode.map((g) => ({
        name: g.group,
        values: outcomeMeasures.map(([, f]) => f(g).value),
        labels: outcomeMeasures.map(([, f]) => `${f(g).num}/${f(g).den}`),
      })),
      yMax: 1,
      yLabel: 'share of runs',
      banner,
    }),
  );
  const primary = sensitivity[0];
  if (primary) {
    write(
      'figures/cost_sensitivity.svg',
      groupedBarChart({
        title: 'Cost per round by active characters (k)',
        description: `Cost per round from measured mean tokens per character, Judge and narrator call (${primary.prices.label}); k = 5 exceeds the scheduler cap and is an extrapolation (hatched).`,
        categories: primary.rows.map((r) => `k = ${r.k}${r.extrapolation ? ' (extrap.)' : ''}`),
        series: [{ name: 'US$ per round', values: primary.rows.map((r) => r.costPerRound), labels: primary.rows.map((r) => (r.costPerRound === null ? 'n/a' : `$${r.costPerRound.toFixed(5)}`)) }],
        yLabel: 'US$ per round',
        format: (v) => `$${v.toFixed(4)}`,
        banner,
        hatchedCategories: primary.rows.map((r, i) => (r.extrapolation ? i : -1)).filter((i) => i >= 0),
      }),
    );
  }
  write(
    'figures/latency.svg',
    groupedBarChart({
      title: 'LLM latency per call (median and p95)',
      description: 'Median and 95th-percentile latency per logical LLM call, per configuration, in milliseconds.',
      categories: ['median per call', 'p95 per call'],
      series: byMode.map((g) => ({ name: g.group, values: [g.latencyCallMedian, g.latencyCallP95], labels: [`${num(g.latencyCallMedian)} ms`, `${num(g.latencyCallP95)} ms`] })),
      yLabel: 'milliseconds',
      format: (v) => v.toFixed(0),
      banner,
    }),
  );
  write(
    'figures/case_pass.svg',
    matrixChart({
      title: 'Per-case pass (all automatic constraints satisfied)',
      description: 'Runs passing all case constraints over runs, per case and configuration.',
      rows: cases,
      columns: modes,
      cells: cases.map((c) =>
        modes.map((m) => {
          const g = byCaseMode.find((x) => x.group === `${c}/${m}`);
          if (!g) return { text: '–', state: 'neutral' as const };
          const all = g.casePass.num === g.casePass.den;
          return { text: `${all ? '✓ pass' : '✗ fail'} ${g.casePass.num}/${g.casePass.den}`, state: all ? ('good' as const) : ('bad' as const) };
        }),
      ),
      banner,
    }),
  );

  // ---- summary.md ------------------------------------------------------------------------------------------
  const L: string[] = [];
  L.push('# The Jinyang Pact — evaluation report', '');
  if (banner) L.push(`> **${banner}.** Every number below comes from the offline mock personas (deterministic, with a seeded misbehaviour injector${plan?.misbehaviourRate ? ` at rate ${plan.misbehaviourRate}` : ''}). It validates the pipeline; it is not a result about language models.`, '');
  L.push(`Generated ${now().toISOString()} from ${evaluations.length} run(s) in \`${path.basename(dir)}\`${plan?.plan?.name ? ` (plan \`${plan.plan.name}\`)` : ''}. Freeze: ${plan?.freeze?.status ?? 'n/a'}.`, '');
  if (missing.length > 0) L.push(`**Missing or unreadable audits** (kept in all-run denominators as failed, not replayed): ${missing.map((e) => `${e.meta.runId} — ${e.meta.missing}`).join('; ')}.`, '');
  L.push('Conclusions are limited to this chapter and these cases; analysis is descriptive (counts with denominators, matched case comparisons, no significance testing). Programmatic hard-rule tests (`npm test`) are reported separately from these end-to-end runs.', '');
  L.push('## Table 1 measures by configuration', '');
  L.push(`| measure | ${byMode.map((g) => g.group).join(' | ')} |`, `|---|${byMode.map(() => '---').join('|')}|`);
  const row = (label: string, f: (g: GroupMetrics) => string) => L.push(`| ${label} | ${byMode.map(f).join(' | ')} |`);
  row('runs', (g) => String(g.runs));
  row('runs with a missing or unreadable audit (failed)', (g) => String(evaluations.filter((e) => e.meta.mode === g.group && e.meta.missing).length));
  row('invalid commit rate (oracle; applied action events)', (g) => pct(g.invalidCommit));
  row('committed speech violating H08 (reported separately)', (g) => pct(g.speech));
  row('baseline unapplied attempts', (g) => String(g.unapplied));
  row('rejection rate (Harness modes; all generated proposals)', (g) => pct(g.rejection));
  row('proposal status breakdown (Harness modes)', (g) => Object.entries(g.proposalStatus).sort().map(([k, v]) => `${k} ${v}`).join(', ') || '–');
  row('critical-pause recall (actual pause)', (g) => pct(g.recall));
  row('authorization coverage', (g) => pct(g.authorizationCoverage));
  row('player-initiated share', (g) => pct(g.playerInitiatedShare));
  row('user-control rate', (g) => pct(g.userControl));
  row('Judge-defaulted instances (misses)', (g) => String(g.judgeDefaultedMisses));
  row('Judge misses (defaulted or skipped verdicts)', (g) => String(g.judgeMisses));
  row('Judge refs mapped positionally (explicit ids absent)', (g) => String(g.judgeMissPositional));
  row('REVISE originals (never executed)', (g) => String(g.revisedOriginals));
  row('decisions on partly unseen terms', (g) => String(g.unseenTermsDecisions));
  row('pause precision — automatic proxy', (g) => pct(g.pausePrecisionProxy));
  row('completion rate', (g) => pct(g.completion));
  row('replay consistency (rederive)', (g) => pct(g.replayRederive));
  row('replay (patch)', (g) => pct(g.replayPatch));
  row('case pass (runs)', (g) => pct(g.casePass));
  row('leakage hits (canary lower bound)', (g) => String(g.leakHits));
  row('narration checker hits / fallbacks / narrations', (g) => `${g.checkerHits} / ${g.fallbacks} / ${g.narrations}`);
  row('narration fallback rate', (g) => pct(g.fallbackRate));
  row('oracle H16 hits on displayed text', (g) => String(g.oracleNarrationDisplayed));
  row('semantic / user-requested / error-recovery pauses', (g) => `${g.semanticPauses} / ${g.userRequestedPauses} / ${g.errorRecoveryPauses}`);
  L.push('', 'Pause precision (primary) uses human necessity labels on the 18 human-evaluation trajectories (`npm run humaneval:agreement`); the value above is the automatic proxy (detector-matched pauses ÷ all system-triggered decision pauses, obsolete ones included). Quality ratings (character consistency, causal plausibility, perceived user control) are human-only.', '');
  L.push('## Per-case pass', '');
  L.push(`| case | ${modes.join(' | ')} |`, `|---|${modes.map(() => '---').join('|')}|`);
  for (const c of cases) {
    const cells = modes.map((m) => {
      const list = evaluations.filter((e) => e.meta.caseId === c && e.meta.mode === m);
      if (list.length === 0) return '–';
      const passed = list.filter((e) => e.metrics.casePass).length;
      const fails = [...new Set(list.flatMap((e) => e.metrics.constraintFails))];
      return `${passed}/${list.length}${fails.length ? ` (fails: ${fails.join(', ')})` : ''}`;
    });
    L.push(`| ${c} | ${cells.join(' | ')} |`);
  }
  L.push('', 'Conditional constraints (`checkpoint_decided_if_occurs`) pass when not exercised; exposure is listed in `cases.csv`. `justified_terminal` is a human annotation and not part of the automatic pass.', '');
  L.push('## Checkpoint instances by type', '');
  const types = [...new Set(evaluations.flatMap((e) => Object.keys(e.metrics.instancesByType)))].sort();
  L.push(`| type | ${modes.map((m) => `${m}: n / paused / user control`).join(' | ')} |`, `|---|${modes.map(() => '---').join('|')}|`);
  for (const t of types) {
    L.push(
      `| ${t} | ${modes
        .map((m) => {
          const list = evaluations.filter((e) => e.meta.mode === m).map((e) => e.metrics.instancesByType[t] ?? { n: 0, paused: 0, controlled: 0 });
          return `${list.reduce((a, x) => a + x.n, 0)} / ${list.reduce((a, x) => a + x.paused, 0)} / ${list.reduce((a, x) => a + x.controlled, 0)}`;
        })
        .join(' | ')} |`,
    );
  }
  L.push('', 'Invalid critical proposals that could not commit are not instances (listed in `findings/`).', '');
  L.push('## Oracle findings by rule', '');
  const rules = [...new Set(evaluations.flatMap((e) => [...Object.keys(e.metrics.invalidByRule), ...Object.keys(e.metrics.oracleSystemByRule)]))].sort();
  L.push(`| rule | ${modes.map((m) => `${m}: actions / system`).join(' | ')} |`, `|---|${modes.map(() => '---').join('|')}|`);
  for (const r of rules) {
    L.push(`| ${r} | ${modes.map((m) => {
      const list = evaluations.filter((e) => e.meta.mode === m);
      return `${list.reduce((a, e) => a + (e.metrics.invalidByRule[r] ?? 0), 0)} / ${list.reduce((a, e) => a + (e.metrics.oracleSystemByRule[r] ?? 0), 0)}`;
    }).join(' | ')} |`);
  }
  L.push('');
  L.push('## Efficiency', '');
  L.push(`| measure | ${byMode.map((g) => g.group).join(' | ')} |`, `|---|${byMode.map(() => '---').join('|')}|`);
  row('LLM calls', (g) => String(g.calls));
  row('input / output tokens', (g) => `${g.inputTokens} / ${g.outputTokens}`);
  row('cost reported (US$)', (g) => usd(g.costReported));
  row('cost estimated (US$, upper bound)', (g) => usd(g.costEstimated));
  row('attempts with unknown cost', (g) => String(g.unknownCostAttempts));
  row('cost reconciled (US$; known part / coverage)', (g) => (g.costReconciled === null ? 'n/a (not reconciled)' : `${usd(g.costReconciled)} for ${g.reconciledAttempts}/${g.attemptsTotal} attempts${g.reconciledAttempts < g.attemptsTotal ? ` (${g.attemptsTotal - g.reconciledAttempts} unknown)` : ''}`));
  row('latency per call median / p95 (ms)', (g) => `${num(g.latencyCallMedian)} / ${num(g.latencyCallP95)}`);
  row('LLM time per round median / p95 (ms, summed)', (g) => `${num(g.latencyRoundMedian)} / ${num(g.latencyRoundP95)}`);
  row('LLM time per run median / p95 (ms, summed)', (g) => `${num(g.latencyRunMedian)} / ${num(g.latencyRunP95)}`);
  row('HTTP retries / repairs / aborted attempts', (g) => `${g.retries} / ${g.repairs} / ${g.aborted}`);
  row('format errors (treated as wait)', (g) => String(g.formatErrors));
  L.push('', 'Reported and estimated costs are summed separately; attempts without cost evidence are counted as unknown, never as zero.', '');
  L.push('### Activation exposure (character calls per character)', '');
  const chars = ['shi_jingtang', 'sang_weihan', 'liu_zhiyuan', 'yelu_deguang', 'li_congke'];
  L.push(`| character | ${modes.join(' | ')} |`, `|---|${modes.map(() => '---').join('|')}|`);
  for (const ch of chars) {
    L.push(`| ${ch} | ${modes.map((m) => {
      const list = evaluations.filter((e) => e.meta.mode === m);
      return `${list.reduce((a, e) => a + (e.metrics.characterCalls[ch] ?? 0), 0)} calls · ${list.reduce((a, e) => a + (e.metrics.activations[ch] ?? 0), 0)} activations`;
    }).join(' | ')} |`);
  }
  L.push('', 'Active sets are not matched across configurations (trajectories diverge); comparisons are whole-trajectory effects.', '');
  L.push('## Cost sensitivity (proposal Table 2 form)', '');
  const fmtMean = (x: { in: number; out: number; calls: number } | null) => (x ? `${Math.round(x.in)} in / ${Math.round(x.out)} out over ${x.calls} calls` : 'no calls');
  L.push(`Measured means per call — character: ${fmtMean(means.character)}; Judge: ${fmtMean(means.judge)}; narrator: ${fmtMean(means.narrator)}. One Judge and one narrator call per round are assumed, as in the proposal.`, '');
  for (const s of sensitivity) L.push(...sensitivityTable(s.rows, s.prices), '');
  const probes = evaluations.flatMap((e) => e.metrics.probeRows);
  if (probes.length > 0) {
    L.push('## Injected probes (dev configs only; never in main-experiment metrics)', '');
    L.push('| run | proposal | actor | type | status | harness rule | oracle rules |', '|---|---|---|---|---|---|---|');
    for (const p of probes) L.push(`| ${p.runId} | ${p.proposalId} | ${p.actor} | ${p.type} | ${p.status} | ${p.rule ?? '–'} | ${p.oracleRules.join(', ') || '–'} |`);
    L.push('');
  }
  L.push('## Runs', '');
  L.push('| run | outcome | terminal | invalid | instances (paused) | case pass | replay patch / rederive | fallback rate | calls |', '|---|---|---|---|---|---|---|---|---|');
  for (const e of evaluations) {
    const m = e.metrics;
    L.push(`| ${e.meta.runId} | ${e.meta.outcome ?? '–'} | ${m.terminal ?? '–'}${m.terminalRound ? ` (R${m.terminalRound})` : ''} | ${m.invalidCommit.num}/${m.invalidCommit.den} | ${m.instances} (${m.recall.num}) | ${m.casePass ? 'pass' : `fail: ${m.constraintFails.join(', ')}`} | ${String(m.replayPatch)} / ${String(m.replayRederive)} | ${pct(m.fallbackRate)} | ${m.calls} |`);
  }
  L.push('', '## Method notes', '');
  L.push('- Shared scaffolding in every configuration: authorized context builder, action vocabulary, narration pipeline, deterministic scene scheduler. The comparison isolates commit enforcement (baseline vs no_judge) and the Judge (no_judge vs full); it does not measure context isolation.');
  L.push('- The oracle (`src/eval/oracle/`) re-implements H01–H16 and G01–G12 from the plan on the audit bundle, without harness or rule-engine code; baseline commits are checked like any other.');
  L.push('- Checkpoint instances (§13.1) come from proposals and state transitions, independent of the Judge and of pause records; eligibility excludes H05/H06/H10/H14. REVISE-replaced drafts are enumerated but never counted as commits. Judge-defaulted verdicts stay in the recall denominator as misses.');
  L.push('- Invalid commit rate counts applied action events only; committed speech (dialogue, no world event) is checked separately. Rejection rate divides by all generated proposals (Harness modes), with the status breakdown. Runs listed in the plan manifest whose audit is missing count as failed and not replayed.');
  L.push('- Leakage is an automatic lower bound (canary and clause text in outputs of non-holders); human leakage and contradiction marks complement it.');
  L.push('- Death/allegiance pauses exist in the mechanism but are not exercised by the chapter\'s cases.');
  L.push('');
  write('summary.md', `${L.join('\n')}\n`);
  return { outDir, files, evaluations, mock, byMode };
}
