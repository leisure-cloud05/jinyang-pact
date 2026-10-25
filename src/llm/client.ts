/**
 * Client factory. `createLlmClient(config, sink)` returns the configured client (OpenRouter or mock)
 * wrapped in the per-session `BudgetedClient`. It never makes a network call by itself; entry points
 * that can reach the network must additionally require the explicit `--live` opt-in
 * (`liveOptInProblem` in src/config/env.ts).
 */
import { BudgetedClient } from './budget.js';
import { MockLlmClient, MOCK_MODEL, type MockLlmClientOptions } from './mock/index.js';
import { OpenRouterClient, type ClientDeps } from './openrouter.js';
import type { LlmClient, UsageSink } from './types.js';
import type { AppConfig } from '../config/env.js';

export type * from './types.js';

export interface CreateLlmClientOptions extends ClientDeps {
  /** Mock provider only: register handlers (e.g. personas) on the created mock client. */
  mockSetup?: (mock: MockLlmClient) => void;
  /** Mock provider only: extra options (seed, faultRates, …). */
  mockOptions?: Omit<MockLlmClientOptions, 'sink'>;
}

export function createLlmClient(config: AppConfig, sink: UsageSink, options: CreateLlmClientOptions = {}): BudgetedClient {
  const { mockSetup, mockOptions, ...deps } = options;
  let inner: LlmClient;
  let resolveModel: (req: { role: keyof AppConfig['models']; model?: string }) => string;
  if (config.provider === 'openrouter') {
    inner = OpenRouterClient.fromConfig(config, sink, deps);
    resolveModel = (req) => req.model ?? config.models[req.role];
  } else {
    const mock = new MockLlmClient({
      maxTokens: config.maxTokens,
      maxInputChars: config.maxInputChars,
      httpRetries: config.httpRetries,
      timeoutMs: config.timeoutMs,
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.newCallId ? { newCallId: deps.newCallId } : {}),
      ...(deps.logger ? { logger: deps.logger } : {}),
      ...mockOptions,
      sink,
    });
    mockSetup?.(mock);
    inner = mock;
    const recorded = mockOptions?.model ?? MOCK_MODEL;
    resolveModel = () => recorded;
  }
  return new BudgetedClient(inner, config.budget, {
    sink,
    resolveModel,
    resolveMaxTokens: (req) => config.maxTokens[req.role],
    httpRetries: config.httpRetries,
    prices: config.prices,
    // Live calls need a price bound for every model; the mock (cost 0) is exempt.
    requirePrice: config.provider === 'openrouter',
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.newCallId ? { newCallId: deps.newCallId } : {}),
  });
}
