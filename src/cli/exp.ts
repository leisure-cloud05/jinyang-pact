/**
 * Experiment CLI (PLAN §13, §14).
 *
 *   npm run exp -- --plan dev|pilot|main [--live | --mock] [--reps N] [--out DIR]
 *   npm run exp -- --freeze                  write runs/freeze.json (models, provider settings, hashes)
 *
 * Live calls need BOTH `--live` and LLM_PROVIDER=openrouter (+ key, normally in .env). Without `--live` the mock
 * personas run offline (the `main` plan then uses a modest misbehaviour rate so baseline violations show) and all
 * outputs are labelled "PIPELINE VALIDATION (mock LLM) — not findings". The live `main` plan refuses to start
 * without a matching runs/freeze.json.
 */
import { resolve } from 'node:path';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { liveOptInProblem, loadConfig, LIVE_SETUP_HELP, type AppConfig } from '../config/env.js';
import { loadContent } from '../content/loader.js';
import type { Mode } from '../core/types.js';
import { DEFAULT_CONTENT_ROOT } from '../engine/runner.js';
import { createLlmClient } from '../llm/client.js';
import { redactSecrets } from '../llm/redact.js';
import { buildFreeze, freezeHash, freezeMismatches, MAIN_SETTINGS, readFreeze, writeFreeze } from '../eval/freeze.js';
import { ALL_MODES, HELD_OUT_CASES, mockFactory, PLAN_NAMES, planCaseProblems, planSpec, ProvenanceError, runExperiment, type LlmFactory, type PlanName } from '../eval/runner.js';

export const EXP_USAGE = [
  'Usage: npm run exp -- --plan dev|pilot|main [--live | --mock] [options]',
  '       npm run exp -- --freeze [--no-env-file]',
  '  --plan NAME         dev = D1–D3; pilot = D1–D3 + P1–P3 (live tuning only); main = C1–C6 × 3 modes × 2 reps',
  '  --live              real OpenRouter calls (needs LLM_PROVIDER=openrouter and OPENROUTER_API_KEY)',
  '  --mock              offline mock personas (default when --live is absent)',
  '  --reps N            repetitions per case × mode (default: main 2, else 1)',
  '  --out DIR           output folder (default runs/<plan>-<mock|live>-<timestamp>)',
  '  --cases C1,C2       subset of the plan configs (dev: D1–D3, pilot: D1–D3/P1–P3, main: C1–C6);',
  '                      a live run of any C1–C6 case needs plan main and a matching freeze (incl. cases/modes/reps/lang)',
  '  --modes full,...    subset of modes',
  '  --misbehaviour R    mock misbehaviour rate (default: main 0.1, else 0)',
  '  --lang zh|en        narrative language (default NARRATIVE_LANG or zh)',
  '  --runs-root DIR     where freeze.json lives (default runs)',
  '  --no-env-file       do not load .env',
].join('\n');

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaultIo: Io = { out: (l) => console.log(redactSecrets(l)), err: (l) => console.error(redactSecrets(l)) };

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export async function main(argv: readonly string[], io: Io = defaultIo, deps: { now?: () => Date; config?: AppConfig } = {}): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        plan: { type: 'string' },
        live: { type: 'boolean' },
        mock: { type: 'boolean' },
        freeze: { type: 'boolean' },
        reps: { type: 'string' },
        out: { type: 'string' },
        cases: { type: 'string' },
        modes: { type: 'string' },
        misbehaviour: { type: 'string' },
        lang: { type: 'string' },
        'runs-root': { type: 'string' },
        'no-env-file': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    io.err(`${(err as Error).message}\n${EXP_USAGE}`);
    return 1;
  }
  if (values.help) {
    io.out(EXP_USAGE);
    return 0;
  }
  const now = deps.now ?? (() => new Date());
  const live = values.live === true;
  if (live && values.mock) {
    io.err('Choose either --live or --mock, not both.');
    return 1;
  }
  const envFile = values['no-env-file'] ? false : '.env';
  const runsRoot = resolve(typeof values['runs-root'] === 'string' ? values['runs-root'] : 'runs');
  const freezeFile = path.join(runsRoot, 'freeze.json');
  let config: AppConfig;
  try {
    // The .env file is read only for live runs and the freeze (which records the live settings).
    config = deps.config ?? loadConfig({ envFile: live || values.freeze ? envFile : false, ...(live || values.freeze ? {} : { env: { ...process.env, LLM_PROVIDER: 'mock' } }) });
  } catch (err) {
    io.err((err as Error).message);
    return 1;
  }
  const content = loadContent(DEFAULT_CONTENT_ROOT, { requireSources: true });

  const langOpt = typeof values.lang === 'string' ? values.lang : null;
  if (langOpt !== null && langOpt !== 'zh' && langOpt !== 'en') {
    io.err('--lang must be zh or en');
    return 1;
  }
  const lang = (langOpt ?? config.narrativeLang) as 'zh' | 'en';

  if (values.freeze) {
    const record = buildFreeze(config, content, { now, run: MAIN_SETTINGS(lang) });
    writeFreeze(freezeFile, record);
    io.out(`Freeze written: ${freezeFile} (identity ${freezeHash(record).slice(0, 12)})`);
    io.out(`  models ${JSON.stringify(record.models)} · provider ${record.settings.provider} · reasoning ${record.settings.reasoning} · lang ${record.settings.lang}`);
    io.out(`  files ${record.hashes.files.slice(0, 12)} · prompts ${record.hashes.prompts.slice(0, 12)} · ${Object.keys(record.hashes.byPath).length} frozen paths`);
    return 0;
  }

  const planName = values.plan as PlanName | undefined;
  if (!planName || !(PLAN_NAMES as readonly string[]).includes(planName)) {
    io.err(`--plan must be one of ${PLAN_NAMES.join('|')}\n${EXP_USAGE}`);
    return 1;
  }
  const reps = typeof values.reps === 'string' ? Number(values.reps) : undefined;
  if (reps !== undefined && (!Number.isInteger(reps) || reps < 1 || reps > 10)) {
    io.err('--reps must be an integer between 1 and 10');
    return 1;
  }
  const modes = typeof values.modes === 'string' ? (values.modes.split(',').map((m) => m.trim()) as Mode[]) : undefined;
  if (modes && modes.some((m) => !ALL_MODES.includes(m))) {
    io.err(`--modes must be a subset of ${ALL_MODES.join(',')}`);
    return 1;
  }
  const cases = typeof values.cases === 'string' ? values.cases.split(',').map((c) => c.trim()) : undefined;
  const spec = planSpec(planName, { ...(reps ? { reps } : {}), ...(cases ? { cases } : {}), ...(modes ? { modes } : {}) });
  for (const id of spec.cases) {
    if (!content.cases[id] && !content.dev[id] && !content.pilot[id]) {
      io.err(`unknown config ${id}`);
      return 1;
    }
  }
  // dev/pilot never touch the held-out cases; main runs only C1–C6 (checked on the actual case ids).
  const caseProblems = planCaseProblems(planName, spec.cases);
  if (caseProblems.length > 0) {
    io.err(`Refusing: ${caseProblems.join('; ')}.`);
    return 1;
  }
  const heldOut = spec.cases.some((c) => HELD_OUT_CASES.includes(c));
  const runSettings = { lang, cases: spec.cases, modes: spec.modes, reps: spec.reps };

  let llm: LlmFactory;
  let freeze: { status: 'match' | 'mismatch' | 'missing' | 'not_required'; problems: string[] } = { status: 'not_required', problems: [] };
  let frozenId: string | null = null;
  const misbehaviour = typeof values.misbehaviour === 'string' ? Number(values.misbehaviour) : planName === 'main' ? 0.1 : 0;
  if (live) {
    const problem = liveOptInProblem(config, { live: true });
    if (problem) {
      io.err(`${problem}\n\n${LIVE_SETUP_HELP}`);
      return 1;
    }
    if (heldOut) {
      // Any live run of a C1–C6 case id requires plan main and a matching freeze (incl. cases, modes, reps, lang).
      if (planName !== 'main') {
        io.err('Refusing: live runs of C1–C6 require plan main and a matching freeze.');
        return 1;
      }
      const stored = readFreeze(freezeFile);
      if (!stored) {
        io.err(`Refusing the live main run: ${freezeFile} is missing (run \`npm run exp -- --freeze\` first).`);
        return 1;
      }
      const problems = freezeMismatches(stored, buildFreeze(config, content, { now, run: runSettings }));
      if (problems.length > 0) {
        io.err(`Refusing the live main run: the frozen configuration changed:\n- ${problems.join('\n- ')}`);
        return 1;
      }
      freeze = { status: 'match', problems: [] };
      frozenId = freezeHash(stored);
    }
    llm = () => (sink) => createLlmClient(config, sink);
  } else {
    if (!(misbehaviour >= 0 && misbehaviour <= 1)) {
      io.err('--misbehaviour must be a rate between 0 and 1');
      return 1;
    }
    if (planName === 'main') {
      const stored = readFreeze(freezeFile);
      const problems = stored ? freezeMismatches(stored, buildFreeze(config, content, { now, run: runSettings })).filter((p) => !p.startsWith('settings.provider') && !p.startsWith('models')) : [];
      freeze = stored ? { status: problems.length > 0 ? 'mismatch' : 'match', problems } : { status: 'missing', problems: [] };
      if (freeze.status !== 'match') io.out(`Note: freeze ${freeze.status} (mock pipeline validation proceeds; a live main run would refuse).`);
    }
    llm = mockFactory(misbehaviour);
  }  const outDir = resolve(typeof values.out === 'string' ? values.out : path.join('runs', `${planName}-${live ? 'live' : 'mock'}-${stamp(now())}`));
  io.out(live ? `Live ${planName} plan (OpenRouter).` : `Mock ${planName} plan — PIPELINE VALIDATION (mock LLM), not findings. Misbehaviour rate ${misbehaviour}.`);
  let result: Awaited<ReturnType<typeof runExperiment>>;
  try {
    result = await runExperiment({
    plan: spec,
    outDir,
    content,
    llm,
    live,
    lang,
    misbehaviourRate: misbehaviour,
    freeze,
    freezeHash: frozenId,
    models: live ? { ...config.models } : { character: 'mock', judge: 'mock', narrator: 'mock', mapper: 'mock' },
    ...(live ? {
      runtimeSettings: buildFreeze(config, content, { run: runSettings }).settings,
      pricing: {
        models: config.models,
        maxTokens: config.maxTokens,
        prices: config.prices,
        httpRetries: config.httpRetries,
        requirePrice: true,
      },
    } : {}),
    log: io.out,
    now,
    });
  } catch (err) {
    if (err instanceof ProvenanceError) {
      io.err(err.message);
      return 1;
    }
    throw err;
  }
  const errors = result.runs.filter((r) => r.error !== null);
  io.out(`\n${result.runs.length} run(s) in ${outDir}${errors.length ? ` (${errors.length} with errors)` : ''}.`);
  io.out(`Next: npm run report -- "${outDir}"`);
  return errors.length > 0 ? 2 : 0;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(entry).toLowerCase();
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(redactSecrets(err instanceof Error ? (err.stack ?? err.message) : String(err)));
      process.exit(1);
    },
  );
}
