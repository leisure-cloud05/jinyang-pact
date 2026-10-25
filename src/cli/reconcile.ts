/**
 * Reconcile CLI (PLAN §9): `npm run reconcile -- <dir> --live` fills reconciled costs from OpenRouter generation
 * records. Explicit opt-in (`--live` AND LLM_PROVIDER=openrouter AND a key); never run by tests.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { liveOptInProblem, loadConfig, LIVE_SETUP_HELP } from '../config/env.js';
import { redactSecrets } from '../llm/redact.js';
import { reconcileDir, type FetchFn } from '../eval/reconcile.js';

export const RECONCILE_USAGE = 'Usage: npm run reconcile -- <experiment dir> --live';

export async function main(argv: readonly string[], io = { out: (l: string) => console.log(redactSecrets(l)), err: (l: string) => console.error(redactSecrets(l)) }): Promise<number> {
  let parsed: { values: { live?: boolean; help?: boolean }; positionals: string[] };
  try {
    parsed = parseArgs({ args: [...argv], options: { live: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: true, strict: true });
  } catch (err) {
    io.err(`${(err as Error).message}\n${RECONCILE_USAGE}`);
    return 1;
  }
  if (parsed.values.help) {
    io.out(RECONCILE_USAGE);
    return 0;
  }
  const dir = parsed.positionals[0];
  if (!dir) {
    io.err(RECONCILE_USAGE);
    return 1;
  }
  if (!parsed.values.live) {
    io.err(`Refusing: reconciliation calls the OpenRouter API and needs the explicit --live flag.\n\n${LIVE_SETUP_HELP}`);
    return 1;
  }
  const config = loadConfig({ envFile: '.env' });
  const problem = liveOptInProblem(config, { live: true });
  if (problem || !config.openrouterApiKey) {
    io.err(`${problem ?? 'OPENROUTER_API_KEY is missing'}\n\n${LIVE_SETUP_HELP}`);
    return 1;
  }
  const result = await reconcileDir({ dir: resolve(dir), apiKey: config.openrouterApiKey.reveal(), fetch: globalThis.fetch as unknown as FetchFn, log: io.out });
  io.out(`Reconciled ${result.ok}/${result.rows} attempt(s) across ${result.runs} run(s). Re-run \`npm run report\` to include them.`);
  return 0;
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
      console.error(redactSecrets(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    },
  );
}
