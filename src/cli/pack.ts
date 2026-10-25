/**
 * Pack CLI (PLAN §14): `npm run pack -- <dir> [--out file.zip] [--no-env-file]` → a ZIP next to the folder with no
 * `.env`, keys, credential headers or raw WAL files (databases via VACUUM INTO, redacted). The configured API key is
 * loaded only to redact it; it is never printed.
 */
import path, { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config/env.js';
import { redactSecrets } from '../llm/redact.js';
import { packDir } from '../eval/pack.js';

export const PACK_USAGE = 'Usage: npm run pack -- <dir> [--out FILE.zip] [--no-env-file]';

export function main(argv: readonly string[], io = { out: (l: string) => console.log(redactSecrets(l)), err: (l: string) => console.error(redactSecrets(l)) }, extraSecrets: readonly string[] = []): number {
  let parsed: { values: { out?: string; 'no-env-file'?: boolean; help?: boolean }; positionals: string[] };
  try {
    parsed = parseArgs({ args: [...argv], options: { out: { type: 'string' }, 'no-env-file': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: true, strict: true });
  } catch (err) {
    io.err(`${(err as Error).message}\n${PACK_USAGE}`);
    return 1;
  }
  if (parsed.values.help) {
    io.out(PACK_USAGE);
    return 0;
  }
  const dir = parsed.positionals[0];
  if (!dir) {
    io.err(PACK_USAGE);
    return 1;
  }
  const secrets = [...extraSecrets];
  if (!parsed.values['no-env-file']) {
    try {
      const key = loadConfig({ envFile: '.env' }).openrouterApiKey;
      if (key) secrets.push(key.reveal());
    } catch {
      /* configuration problems do not block packing; pattern redaction still applies */
    }
  }
  const root = resolve(dir);
  const zip = resolve(parsed.values.out ?? `${root.replace(/[\\/]+$/, '')}.zip`);
  try {
    const result = packDir(root, zip, { extraSecrets: secrets });
    io.out(`Packed ${result.included.length} file(s) into ${zip}`);
    if (result.excluded.length > 0) io.out(`Excluded ${result.excluded.length}: ${result.excluded.map((e) => `${path.basename(e.file)} (${e.reason})`).join('; ')}`);
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
