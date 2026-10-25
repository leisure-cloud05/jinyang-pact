/**
 * Usage sinks, prompt hashing, token estimates, call ids and usage aggregation across attempts.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { redactSecrets } from './redact.js';
import type { ChatMessage, CostSource, LlmAttemptRecord, LlmCallRecord, Usage, UsageSink } from './types.js';

function redacted<T>(record: T): T {
  return JSON.parse(redactSecrets(JSON.stringify(record))) as T;
}

/** Keeps (redacted) call and attempt records in memory. */
export class MemorySink implements UsageSink {
  readonly records: LlmCallRecord[] = [];
  readonly attempts: LlmAttemptRecord[] = [];

  record(call: LlmCallRecord, attempts: readonly LlmAttemptRecord[]): void {
    this.records.push(redacted(call));
    for (const a of attempts) this.attempts.push(redacted(a));
  }

  /** Attempt records of one call, in order. */
  attemptsOf(callId: string): LlmAttemptRecord[] {
    return this.attempts.filter((a) => a.callId === callId);
  }

  clear(): void {
    this.records.length = 0;
    this.attempts.length = 0;
  }
}

/** Default attempts file next to a calls file: `calls.jsonl` → `attempts.jsonl`, `x.jsonl` → `x.attempts.jsonl`. */
export function defaultAttemptsPath(callsPath: string): string {
  const name = basename(callsPath);
  if (name === 'calls.jsonl') return join(dirname(callsPath), 'attempts.jsonl');
  return join(dirname(callsPath), `${name.replace(/\.jsonl$/i, '')}.attempts.jsonl`);
}

/**
 * Appends redacted JSON lines synchronously (lines survive a crash and keep order): one line per logical
 * call to `callsPath` (PLAN §9 `llm_calls`) and one line per attempt to `attemptsPath` (`llm_attempts`).
 */
export class JsonlSink implements UsageSink {
  readonly filePath: string;
  readonly attemptsPath: string;

  constructor(callsPath: string, attemptsPath: string = defaultAttemptsPath(callsPath)) {
    this.filePath = callsPath;
    this.attemptsPath = attemptsPath;
    mkdirSync(dirname(callsPath), { recursive: true });
    mkdirSync(dirname(attemptsPath), { recursive: true });
  }

  record(call: LlmCallRecord, attempts: readonly LlmAttemptRecord[]): void {
    appendFileSync(this.filePath, `${redactSecrets(JSON.stringify(call))}\n`, 'utf8');
    if (attempts.length > 0) {
      const lines = attempts.map((a) => `${redactSecrets(JSON.stringify(a))}\n`).join('');
      appendFileSync(this.attemptsPath, lines, 'utf8');
    }
  }
}

/** Fans records out to several sinks (e.g. memory for a report + JSONL on disk). */
export class MultiSink implements UsageSink {
  private readonly sinks: UsageSink[];

  constructor(...sinks: UsageSink[]) {
    this.sinks = sinks;
  }

  record(call: LlmCallRecord, attempts: readonly LlmAttemptRecord[]): void {
    for (const sink of this.sinks) sink.record(call, attempts);
  }
}

/** SHA-256 (hex) of the caller's messages (role + content), before any repair/format additions. */
export function promptHash(messages: readonly ChatMessage[]): string {
  return createHash('sha256')
    .update(JSON.stringify(messages.map((m) => [m.role, m.content])))
    .digest('hex');
}

let callCounter = 0;

/** Process-unique, deterministic (given call order) call ids. */
export function nextCallId(): string {
  callCounter += 1;
  return `call-${String(callCounter).padStart(6, '0')}`;
}

/** Mock token estimate: characters / 4. */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / 4);
}

/** Conservative token estimate for budget reservations: UTF-8 bytes / 3 (≈1 token per CJK character). */
export function conservativeTokenEstimate(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
}

export function messageChars(messages: readonly ChatMessage[]): number {
  return messages.reduce((n, m) => n + m.content.length, 0);
}

/**
 * Call-level usage from the attempt log. Tokens are summed. Cost is `null`/`none` as soon as one
 * attempt has an unknown cost; otherwise it is the sum, and the source is `reported` when every attempt
 * that contributes a non-zero cost was reported (known-zero attempts such as unbilled HTTP errors do not
 * downgrade it). A call without attempts sent nothing and costs a known 0 (`estimated`).
 */
export function aggregateUsage(attempts: readonly LlmAttemptRecord[]): Usage {
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens: number | undefined;
  let costUsd = 0;
  let unknown = false;
  for (const a of attempts) {
    inputTokens += a.inputTokens;
    outputTokens += a.outputTokens;
    if (a.reasoningTokens !== undefined) reasoningTokens = (reasoningTokens ?? 0) + a.reasoningTokens;
    if (a.costUsd === null || a.costSource === 'none') unknown = true;
    else costUsd += a.costUsd;
  }
  let costSource: CostSource;
  if (unknown) {
    costSource = 'none';
  } else {
    const contributing = attempts.filter((a) => (a.costUsd ?? 0) > 0);
    const basis = contributing.length > 0 ? contributing : attempts;
    costSource = basis.length > 0 && basis.every((a) => a.costSource === 'reported') ? 'reported' : 'estimated';
  }
  const usage: Usage = { inputTokens, outputTokens, costUsd: unknown ? null : costUsd, costSource };
  if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens;
  return usage;
}
