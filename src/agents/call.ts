/** Shared plumbing for agent LLM calls: result summaries and default input caps (PLAN §9). */
import type { LlmResult, LlmRole } from '../llm/types.js';
import type { LlmCallSummary } from './types.js';

/**
 * Character prompts are trimmed to this size (PLAN §9); the character input cap above it is headroom for content the
 * context builder cannot trim (e.g. model-written document notes), so such growth never fails a call.
 */
export const CHARACTER_PROMPT_TARGET = 24_000;

/** PLAN §9 max input size per role (characters over all messages). */
export const DEFAULT_INPUT_CAPS: Readonly<Record<'character' | 'judge' | 'narrator' | 'mapper' | 'answer', number>> = {
  character: 32_000,
  answer: 24_000,
  judge: 16_000,
  narrator: 12_000,
  mapper: 8_000,
};

/** Safety margin kept free under the cap (message framing differences, repair text is not counted by the guard). */
export const INPUT_MARGIN = 200;

export function summarizeCall(result: LlmResult<unknown>): LlmCallSummary {
  return {
    ok: result.ok,
    errorKind: result.ok ? null : result.error.kind,
    errorMessage: result.ok ? null : result.error.message,
    attempts: result.attempts,
    repairUsed: result.repairUsed === true,
    latencyMs: result.latencyMs,
    raw: result.raw ?? null,
  };
}

export type AgentRole = Extract<LlmRole, 'character' | 'judge' | 'narrator' | 'mapper' | 'answer'>;
