/**
 * Development runner (`npm run play:web`): the play API server (mock LLM unless `--live`) and the Vite dev server
 * for `web/` with `/api` proxied to it (hot reload). Accepts the server's flags (`--db`, `--lang`, `--live`,
 * `--director`, `--port` for the API) plus `--web-port` (default 5173).
 */
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createServer } from 'vite';
import { redactSecrets } from '../llm/redact.js';
import { parseServerArgs, startServer } from './index.js';

const WEB_ROOT = fileURLToPath(new URL('../../web/', import.meta.url));

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { values } = parseArgs({ args: argv, options: { 'web-port': { type: 'string' } }, strict: false });
  const webPort = Number(values['web-port'] ?? 5173);
  const serverArgv = argv.filter((a, i) => a !== '--web-port' && argv[i - 1] !== '--web-port' && !a.startsWith('--web-port='));
  const args = { ...parseServerArgs(serverArgv), staticDir: null };
  const api = await startServer(args);
  process.env.JINYANG_API = api.url;
  const vite = await createServer({
    configFile: fileURLToPath(new URL('../../web/vite.config.ts', import.meta.url)),
    root: WEB_ROOT,
    // The dev server proxies the unauthenticated API: loopback only, like the API itself.
    server: { port: webPort, strictPort: false, host: '127.0.0.1' },
  });
  await vite.listen();
  vite.printUrls();
  const stop = (): void => {
    void Promise.allSettled([vite.close(), api.app.close()]).then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err: unknown) => {
  process.stderr.write(`${redactSecrets(err instanceof Error ? (err.stack ?? err.message) : String(err))}\n`);
  process.exitCode = 1;
});
