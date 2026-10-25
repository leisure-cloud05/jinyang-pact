/** Test helpers for the LLM layer: fake fetch (no network), canned OpenRouter responses, fixtures. */
import { z } from 'zod';
import { OpenRouterClient, type FetchLike, type OpenRouterClientOptions } from '../../src/llm/openrouter.js';
import { MemorySink } from '../../src/llm/usage.js';
import type { LlmRequest } from '../../src/llm/types.js';

/** Synthetic key in the OpenRouter format. Never a real key. */
export const FAKE_KEY = 'sk-or-v1-0000fake1111fake2222fake3333fake4444fake5555fake6666fake7777fake';

export interface FakeCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export type FakeStep =
  | { status?: number; json?: unknown; text?: string; headers?: Record<string, string> }
  | { throw: Error }
  | { hang: true };

/** A fetch replacement that records calls and replays steps (the last step repeats). */
export function fakeFetch(steps: FakeStep[] | ((call: FakeCall, index: number) => FakeStep)): {
  fetch: FetchLike;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: FakeCall = { url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> };
    calls.push(call);
    const index = calls.length - 1;
    const step = typeof steps === 'function' ? steps(call, index) : (steps[index] ?? steps[steps.length - 1]);
    if (!step) throw new Error('fakeFetch: no step');
    if ('throw' in step) throw step.throw;
    if ('hang' in step) {
      return new Promise((_, reject) => {
        if (init.signal.aborted) reject(init.signal.reason);
        init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')), { once: true });
      });
    }
    const status = step.status ?? 200;
    const text = step.text ?? JSON.stringify(step.json);
    const headers = step.headers ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      text: async () => text,
    };
  };
  return { fetch, calls };
}

export interface CompletionOpts {
  finishReason?: string;
  usage?: Record<string, unknown> | null;
  provider?: string;
  id?: string;
}

/** A canned OpenRouter chat-completion body. */
export function completion(content: string | null, opts: CompletionOpts = {}): Record<string, unknown> {
  return {
    id: opts.id ?? 'gen-test-1',
    provider: opts.provider ?? 'TestProvider',
    model: 'deepseek/deepseek-v4-flash',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: opts.finishReason ?? 'stop' }],
    ...(opts.usage === null
      ? {}
      : { usage: opts.usage ?? { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.00001 } }),
  };
}

export const TestSchema = z.object({
  speech: z.string().min(1),
  mood: z.enum(['calm', 'angry']),
  note: z.string().nullable(),
});
export type TestOutput = z.infer<typeof TestSchema>;

export const VALID_JSON = JSON.stringify({ speech: '主公且慢。', mood: 'calm', note: null });

export function testRequest(overrides: Partial<LlmRequest<TestOutput>> = {}): LlmRequest<TestOutput> {
  return {
    role: 'character',
    actor: 'sang_weihan',
    sessionId: 'sess-1',
    round: 1,
    callTag: 'unit',
    messages: [
      { role: 'system', content: 'You are a test persona.' },
      { role: 'user', content: 'Say something.' },
    ],
    schema: TestSchema,
    schemaName: 'test output',
    ...overrides,
  };
}

/** OpenRouter client wired to a fake fetch, a memory sink and a recording (non-waiting) sleep. */
export function makeClient(fetch: FetchLike, overrides: Partial<OpenRouterClientOptions> = {}) {
  const sink = new MemorySink();
  const sleeps: number[] = [];
  const logs: string[] = [];
  const client = new OpenRouterClient({
    apiKey: FAKE_KEY,
    fetch,
    sink,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    timeoutMs: 5_000,
    temperatures: { character: 0.7 },
    maxTokens: { character: 700 },
    logger: (line) => logs.push(line),
    ...overrides,
  });
  return { client, sink, sleeps, logs };
}
