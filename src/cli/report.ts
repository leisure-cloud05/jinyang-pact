/**
 * Report CLI (PLAN §13.2, §14): `npm run report -- <dir> [--out DIR]` → metrics.csv/json, cases.csv, runs.csv,
 * summary.md, findings/ and SVG figures in `<dir>/report/`. Offline; never calls a model.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadContent } from '../content/loader.js';
import { DEFAULT_CONTENT_ROOT } from '../engine/runner.js';
import { redactSecrets } from '../llm/redact.js';
import { buildReport } from '../eval/report.js';

export const REPORT_USAGE = 'Usage: npm run report -- <experiment dir> [--out DIR]';

export function main(argv: readonly string[], io = { out: (l: string) => console.log(redactSecrets(l)), err: (l: string) => console.error(redactSecrets(l)) }): number {
  let parsed: { values: { out?: string; help?: boolean }; positionals: string[] };
  try {
    parsed = parseArgs({ args: [...argv], options: { out: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: true, strict: true });
  } catch (err) {
    io.err(`${(err as Error).message}\n${REPORT_USAGE}`);
    return 1;
  }
  if (parsed.values.help) {
    io.out(REPORT_USAGE);
    return 0;
  }
  const dir = parsed.positionals[0];
  if (!dir) {
    io.err(REPORT_USAGE);
    return 1;
  }
  const content = loadContent(DEFAULT_CONTENT_ROOT, { requireSources: true });
  try {
    const result = buildReport({ dir: resolve(dir), content, ...(parsed.values.out ? { outDir: resolve(parsed.values.out) } : {}) });
    if (result.mock) io.out('PIPELINE VALIDATION (mock LLM) — not findings.');
    io.out(`Evaluated ${result.evaluations.length} run(s); report in ${result.outDir}`);
    for (const g of result.byMode) {
      io.out(`  ${g.group}: invalid ${g.invalidCommit.num}/${g.invalidCommit.den} · recall ${g.recall.num}/${g.recall.den} · completion ${g.completion.num}/${g.completion.den} · rederive ${g.replayRederive.num}/${g.replayRederive.den}`);
    }
    return 0;
  } catch (err) {
    io.err((err as Error).message);
    return 1;
  }
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

if (isMainModule()) process.exit(main(process.argv.slice(2)));
