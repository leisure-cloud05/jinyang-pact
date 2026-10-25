/**
 * Human-evaluation CLI (PLAN §13.4, §14 step 6):
 *   npm run humaneval:packets -- <experiment dir> [--out DIR] [--key-dir DIR] [--seed N]
 *   npm run humaneval:agreement -- <ratings dir> [--key FILE] [--out DIR]
 * Packets go to `<dir>/humaneval/` and the (separately kept) key to `<dir>/humaneval-key/key.json`.
 */
import { existsSync } from 'node:fs';
import path, { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadContent } from '../content/loader.js';
import { DEFAULT_CONTENT_ROOT } from '../engine/runner.js';
import { redactSecrets } from '../llm/redact.js';
import { runAgreement } from '../eval/agreement.js';
import { buildPackets } from '../eval/humaneval.js';

export const HUMANEVAL_USAGE = [
  'Usage: npm run humaneval:packets -- <experiment dir> [--out DIR] [--key-dir DIR] [--seed N]',
  '       npm run humaneval:agreement -- <ratings dir> [--key FILE] [--out DIR]',
].join('\n');

export function main(argv: readonly string[], io = { out: (l: string) => console.log(redactSecrets(l)), err: (l: string) => console.error(redactSecrets(l)) }): number {
  let parsed: { values: { out?: string; 'key-dir'?: string; key?: string; seed?: string; help?: boolean }; positionals: string[] };
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { out: { type: 'string' }, 'key-dir': { type: 'string' }, key: { type: 'string' }, seed: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    io.err(`${(err as Error).message}\n${HUMANEVAL_USAGE}`);
    return 1;
  }
  const [command, target] = parsed.positionals;
  if (parsed.values.help || !command || !target) {
    (parsed.values.help ? io.out : io.err)(HUMANEVAL_USAGE);
    return parsed.values.help ? 0 : 1;
  }
  try {
    if (command === 'packets') {
      const content = loadContent(DEFAULT_CONTENT_ROOT, { requireSources: true });
      const seed = parsed.values.seed !== undefined ? Number(parsed.values.seed) : null;
      const result = buildPackets({
        dir: resolve(target),
        content,
        ...(parsed.values.out ? { outDir: resolve(parsed.values.out) } : {}),
        ...(parsed.values['key-dir'] ? { keyDir: resolve(parsed.values['key-dir']) } : {}),
        seed,
      });
      io.out(`${result.packets.length} blind packet(s) in ${result.packetDir} (Markdown + HTML), rating sheet ${result.sheet}`);
      io.out(`Key (keep separate from the packets): ${result.keyFile}`);
      if (result.missing.length > 0) io.out(`Missing first-repetition runs: ${result.missing.join(', ')}`);
      return 0;
    }
    if (command === 'agreement') {
      const ratingsDir = resolve(target);
      const key = parsed.values.key ? resolve(parsed.values.key) : [path.join(ratingsDir, '..', 'humaneval-key', 'key.json'), path.join(ratingsDir, 'key.json')].find((f) => existsSync(f));
      if (!key) {
        io.err('packet key not found; pass --key <humaneval-key/key.json>');
        return 1;
      }
      const { report, files } = runAgreement({ ratingsDir, keyFile: key, ...(parsed.values.out ? { outDir: resolve(parsed.values.out) } : {}) });
      io.out(`${report.raters.length} primary rater(s)${report.supplementaryRaters.length ? `, ${report.supplementaryRaters.length} supplementary` : ''}; analysis: ${files.join(', ')}`);
      if (report.problems.length > 0) io.out(`Data problems: ${report.problems.length} (see agreement.md)`);
      return 0;
    }
    io.err(`unknown command ${command}\n${HUMANEVAL_USAGE}`);
    return 1;
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
