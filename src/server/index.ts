/**
 * Play server entry point (PLAN §11, §14 step 7):
 *
 *   npm run play:server -- [--port 8787] [--db data/play.sqlite] [--lang zh|en]
 *                          [--static web/dist] [--director] [--live]
 *
 * Mock LLM by default. Live OpenRouter calls only with `--live` AND `LLM_PROVIDER=openrouter` (normally in .env,
 * loaded only when `--live` is given); if `--live` is requested but not possible the server refuses to start.
 * `--director` never locks the director view (development only; every session then says so).
 * One server process owns the play database (the harness writer lock refuses a second one).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { LIVE_SETUP_HELP, describeConfig, liveOptInProblem, loadConfig, type AppConfig } from '../config/env.js';
import { redactSecrets } from '../llm/redact.js';
import { buildApp, type AppOptions, type PlayApp } from './app.js';
import { DEFAULT_PLAY_DB } from './manager.js';

export const DEFAULT_PORT = 8787;
/**
 * The only address the play server binds. It has no authentication (sessions, decisions and the director unlock
 * are open to whoever can reach it), so it must never listen beyond the loopback interface. `--host` accepts only
 * this value (`localhost` and `::1` are deliberately refused: one explicit IPv4 loopback address, no resolution).
 */
export const LOOPBACK_HOST = '127.0.0.1';
export const WEB_DIST = fileURLToPath(new URL('../../web/dist/', import.meta.url));

export interface ServerArgs {
  port: number;
  /** Always LOOPBACK_HOST. */
  host: typeof LOOPBACK_HOST;
  db: string;
  lang: 'zh' | 'en' | null;
  staticDir: string | null;
  director: boolean;
  live: boolean;
}

export function parseServerArgs(argv: readonly string[]): ServerArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      db: { type: 'string' },
      lang: { type: 'string' },
      static: { type: 'string' },
      'no-static': { type: 'boolean', default: false },
      director: { type: 'boolean', default: false },
      live: { type: 'boolean', default: false },
    },
    strict: true,
  });
  const port = Number(values.port ?? process.env.JINYANG_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be a TCP port, not ${String(values.port)}`);
  return {
    port,
    host: loopbackOnly(values.host),
    db: values.db ?? DEFAULT_PLAY_DB,
    lang: values.lang === 'en' || values.lang === 'zh' ? values.lang : null,
    staticDir: values['no-static'] ? null : (values.static ?? WEB_DIST),
    director: values.director ?? false,
    live: values.live ?? false,
  };
}

/** `--host`: only the loopback address is accepted (anything else is refused, not silently replaced). */
export function loopbackOnly(host: string | undefined): typeof LOOPBACK_HOST {
  if (host === undefined || host === LOOPBACK_HOST) return LOOPBACK_HOST;
  throw new Error(`--host ${host} refused: the play server has no authentication and binds ${LOOPBACK_HOST} only`);
}

/** Resolves the live opt-in: null config (mock only) unless `--live` and LLM_PROVIDER=openrouter both hold. */
export function resolveLive(args: Pick<ServerArgs, 'live'>, print: (line: string) => void): AppConfig | null {
  if (!args.live) return null;
  const config = loadConfig();
  const problem = liveOptInProblem(config, { live: true });
  if (problem) {
    print(problem);
    print(LIVE_SETUP_HELP);
    throw new Error('live calls were requested (--live) but are not configured');
  }
  print(describeConfig(config));
  return config;
}

export async function startServer(args: ServerArgs, extra: Partial<AppOptions> = {}): Promise<PlayApp & { url: string }> {
  const print = (line: string): void => {
    process.stdout.write(`${redactSecrets(line)}\n`);
  };
  const live = resolveLive(args, print);
  const opts: AppOptions = {
    dbPath: args.db,
    live,
    liveProblem: live ? null : 'the server was started without --live (mock LLM only)',
    directorOpen: args.director,
    defaultLang: args.lang ?? live?.narrativeLang ?? 'zh',
    staticDir: args.staticDir,
    ...extra,
  };
  const play = await buildApp(opts);
  const url = await play.app.listen({ port: args.port, host: loopbackOnly(args.host) });
  print(`The Jinyang Pact play server: ${url}  (db ${path.resolve(args.db)}; LLM ${live ? 'live (OpenRouter)' : 'mock'}${args.director ? '; DIRECTOR VIEW UNLOCKED' : ''})`);
  return { ...play, url };
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startServer(parseServerArgs(process.argv.slice(2)))
    .then(({ app }) => {
      const stop = (): void => {
        void app.close().then(() => process.exit(0));
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    })
    .catch((err: unknown) => {
      process.stderr.write(`${redactSecrets(err instanceof Error ? err.message : String(err))}\n`);
      process.exitCode = 1;
    });
}
