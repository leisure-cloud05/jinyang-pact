/**
 * Output parsing and validation: JSON extraction (code fences, leaked <think> blocks, surrounding
 * prose), zod validation with a null-tolerance fallback for optional keys, compact error summaries and
 * the repair prompt.
 */
import type { z } from 'zod';
import type { RepairReason } from './types.js';

export type JsonParseOutcome = { ok: true; value: unknown } | { ok: false; message: string };

/** Removes a surrounding ```json … ``` fence (or extracts the first fenced block inside prose). */
export function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const whole = /^```[\w-]*[ \t]*\r?\n?([\s\S]*?)\r?\n?[ \t]*```$/.exec(trimmed);
  if (whole?.[1] !== undefined) return whole[1].trim();
  const inner = /```[\w-]*[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/.exec(trimmed);
  if (inner?.[1] !== undefined) return inner[1].trim();
  return trimmed;
}

export function parseJsonContent(content: string | null | undefined): JsonParseOutcome {
  if (content === null || content === undefined || content.trim() === '') {
    return { ok: false, message: 'empty content' };
  }
  let text = content.replace(/^﻿/, '').trim();
  text = text.replace(/^<think>[\s\S]*?<\/think>/i, '').trim();
  text = stripJsonFences(text);
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return { ok: true, value: JSON.parse(text.slice(start, end + 1)) };
      } catch {
        // fall through to the original error
      }
    }
    return { ok: false, message: `invalid JSON: ${(err as Error).message}` };
  }
}

type Issue = z.core.$ZodIssue;
type PathSegment = PropertyKey;

export function formatIssuePath(path: readonly PathSegment[]): string {
  let out = '$';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else if (typeof seg === 'string' && /^[A-Za-z_$][\w$]*$/.test(seg)) out += `.${seg}`;
    else out += `[${JSON.stringify(String(seg))}]`;
  }
  return out;
}

interface FlatIssue {
  path: PathSegment[];
  code: string;
  message: string;
}

/** Flattens union issues: for an `invalid_union`, the branch with the fewest issues is reported. */
function flattenIssues(issues: readonly Issue[], prefix: readonly PathSegment[] = []): FlatIssue[] {
  const out: FlatIssue[] = [];
  for (const issue of issues) {
    const path = [...prefix, ...issue.path];
    if (issue.code === 'invalid_union' && Array.isArray(issue.errors) && issue.errors.length > 0) {
      const best = [...issue.errors].sort((a, b) => a.length - b.length)[0] ?? [];
      if (best.length > 0) {
        out.push(...flattenIssues(best, path));
        continue;
      }
    }
    out.push({ path, code: issue.code, message: issue.message });
  }
  return out;
}

export function summarizeZodIssues(issues: readonly Issue[], maxIssues = 8): string {
  const flat = flattenIssues(issues);
  const lines = flat.slice(0, maxIssues).map((i) => `- ${formatIssuePath(i.path)}: ${i.message}`);
  if (flat.length > maxIssues) lines.push(`- … and ${flat.length - maxIssues} more issue(s)`);
  return lines.join('\n');
}

function getAt(root: unknown, path: readonly PathSegment[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[seg];
  }
  return cur;
}

function deleteNullKey(root: unknown, path: readonly PathSegment[]): boolean {
  const key = path[path.length - 1];
  if (typeof key !== 'string') return false;
  const parent = getAt(root, path.slice(0, -1));
  if (typeof parent !== 'object' || parent === null || Array.isArray(parent)) return false;
  const record = parent as Record<string, unknown>;
  if (!(key in record) || record[key] !== null) return false;
  delete record[key];
  return true;
}

/** Paths of all issues, including every branch of union issues (branch paths are relative to the union). */
function issuePaths(issues: readonly Issue[], prefix: readonly PathSegment[] = []): PathSegment[][] {
  const out: PathSegment[][] = [];
  for (const issue of issues) {
    const path = [...prefix, ...issue.path];
    out.push(path);
    if (issue.code === 'invalid_union' && Array.isArray(issue.errors)) {
      for (const branch of issue.errors) out.push(...issuePaths(branch, path));
    }
  }
  return out;
}

export type ValidateOutcome<T> =
  | { ok: true; value: T; droppedNullKeys: string[] }
  | { ok: false; summary: string };

/**
 * Validates with zod. Strict JSON Schema makes optional keys nullable; if zod rejects a `null` at an
 * object key (e.g. a plain `.optional()` field), that key is dropped and validation is retried.
 * The failure summary always describes the original output.
 */
export function validateOutput<T>(schema: z.ZodType<T>, value: unknown): ValidateOutcome<T> {
  const first = schema.safeParse(value);
  if (first.success) return { ok: true, value: first.data, droppedNullKeys: [] };

  let current: unknown = structuredClone(value);
  let latest: z.ZodSafeParseResult<T> = first;
  const dropped: string[] = [];
  for (let pass = 0; pass < 5 && !latest.success; pass++) {
    // Any issue (invalid_type, invalid_value for enums/literals, invalid_union, …) located at a null.
    const candidates = issuePaths(latest.error.issues).filter((path) => getAt(current, path) === null);
    let removed = 0;
    for (const path of candidates) {
      if (deleteNullKey(current, path)) {
        removed++;
        dropped.push(formatIssuePath(path));
      }
    }
    if (removed === 0) break;
    latest = schema.safeParse(current);
  }
  if (latest.success) return { ok: true, value: latest.data, droppedNullKeys: dropped };
  return { ok: false, summary: summarizeZodIssues(first.error.issues) };
}

/** Caps that bound the repair request (the budget's worst-case reservation relies on them). */
export const REPAIR_DETAIL_MAX_CHARS = 1_200;
/** Upper bound on the full repair prompt: fixed text (< 300 chars) + capped detail. */
export const REPAIR_PROMPT_MAX_CHARS = REPAIR_DETAIL_MAX_CHARS + 300;

/** The echoed bad reply is truncated to max(2000, 4 × max_tokens) characters. */
export function repairEchoMaxChars(maxTokens: number | undefined): number {
  return Math.max(2_000, 4 * (maxTokens ?? 1_000));
}

/** The bad reply as echoed back (as the assistant turn) in the repair request; bounded. */
export function repairEcho(content: string, maxTokens: number | undefined): string {
  if (content.length === 0) return '(empty reply)';
  const max = repairEchoMaxChars(maxTokens);
  return content.length > max ? `${content.slice(0, max - 16)} …[truncated]` : content;
}

/** The user message appended (after the bad assistant output) for the single repair retry; ≤ REPAIR_PROMPT_MAX_CHARS. */
export function buildRepairPrompt(reason: RepairReason, rawDetail: string): string {
  const detail =
    rawDetail.length > REPAIR_DETAIL_MAX_CHARS ? `${rawDetail.slice(0, REPAIR_DETAIL_MAX_CHARS - 14)} …[truncated]` : rawDetail;
  if (reason === 'parse') {
    return (
      `Your previous reply could not be parsed as JSON (${detail}). ` +
      'Reply again with ONLY one valid JSON object that matches the required schema: no prose, no markdown code fences.'
    );
  }
  return (
    'Your previous reply was valid JSON but did not match the required schema:\n' +
    `${detail}\n` +
    'Reply again with ONLY the corrected JSON object: no prose, no markdown code fences.'
  );
}
