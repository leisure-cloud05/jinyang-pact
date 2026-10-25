import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  buildRepairPrompt,
  parseJsonContent,
  stripJsonFences,
  summarizeZodIssues,
  validateOutput,
} from '../../src/llm/parse.js';

describe('JSON extraction', () => {
  it('strips ```json fences, bare fences and fences inside prose', () => {
    expect(stripJsonFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripJsonFences('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripJsonFences('Here you go:\n```json\n{"a":1}\n```\nThanks')).toBe('{"a":1}');
    expect(stripJsonFences('{"a":1}')).toBe('{"a":1}');
  });

  it('parses fenced JSON, leaked <think> blocks, BOM and JSON embedded in prose', () => {
    expect(parseJsonContent('```json\r\n{"a": 1}\r\n```')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonContent('<think>hmm {"no": 1}</think>\n{"a": 2}')).toEqual({ ok: true, value: { a: 2 } });
    expect(parseJsonContent('﻿{"a": 3}')).toEqual({ ok: true, value: { a: 3 } });
    expect(parseJsonContent('Sure! {"a": 4} Hope this helps.')).toEqual({ ok: true, value: { a: 4 } });
  });

  it('reports empty and invalid content', () => {
    expect(parseJsonContent(null)).toEqual({ ok: false, message: 'empty content' });
    expect(parseJsonContent('   ')).toEqual({ ok: false, message: 'empty content' });
    const bad = parseJsonContent('{"a": tru');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toMatch(/^invalid JSON/);
  });
});

describe('validateOutput', () => {
  const S = z.object({
    text: z.string(),
    opt: z.string().optional(),
    nullable: z.string().nullable(),
    items: z.array(z.discriminatedUnion('type', [z.object({ type: z.literal('a'), n: z.number().optional() }), z.object({ type: z.literal('b') })])),
  });

  it('accepts null for nullable fields', () => {
    const r = validateOutput(S, { text: 't', nullable: null, items: [] });
    expect(r).toEqual({ ok: true, value: { text: 't', nullable: null, items: [] }, droppedNullKeys: [] });
  });

  it('drops a null that zod rejects for an optional key (strict mode sends null for absent)', () => {
    const r = validateOutput(S, { text: 't', opt: null, nullable: 'x', items: [{ type: 'a', n: null }] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ text: 't', nullable: 'x', items: [{ type: 'a' }] });
      expect(r.droppedNullKeys.sort()).toEqual(['$.items[0].n', '$.opt']);
    }
  });

  it('still fails when a required key is null, with a path-level summary of the original output', () => {
    const r = validateOutput(S, { text: null, nullable: 'x', items: [{ type: 'c' }] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.summary).toContain('- $.text: Invalid input: expected string, received null');
      expect(r.summary).toContain('$.items[0]');
    }
  });

  it('summarizes the closest union branch and caps the number of issues', () => {
    const U = z.object({ u: z.union([z.object({ x: z.string() }), z.number()]) });
    const res = U.safeParse({ u: { x: 5 } });
    expect(res.success).toBe(false);
    if (!res.success) expect(summarizeZodIssues(res.error.issues)).toBe('- $.u.x: Invalid input: expected string, received number');
    const Many = z.object(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, z.string()])));
    const many = Many.safeParse({});
    if (!many.success) {
      const summary = summarizeZodIssues(many.error.issues, 8);
      expect(summary.split('\n')).toHaveLength(9);
      expect(summary).toContain('and 4 more issue(s)');
    }
  });
});

describe('buildRepairPrompt', () => {
  it('asks for corrected JSON only', () => {
    expect(buildRepairPrompt('parse', 'invalid JSON: x')).toContain('could not be parsed as JSON (invalid JSON: x)');
    const schema = buildRepairPrompt('schema', '- $.a: bad');
    expect(schema).toContain('- $.a: bad');
    expect(schema).toContain('ONLY the corrected JSON object');
  });
});
