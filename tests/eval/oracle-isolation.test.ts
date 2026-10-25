/**
 * PLAN §13.3: the oracle must not import the harness or the rule engine — only domain types
 * (`src/core/types.ts`) and the content loader. This test scans every import of every oracle file (static,
 * type-only, re-exports and dynamic imports) and fails on any other project module.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ORACLE = path.join(ROOT, 'src', 'eval', 'oracle');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const full = path.join(dir, n);
    return statSync(full).isDirectory() ? files(full) : full.endsWith('.ts') ? [full] : [];
  });
}

export function importsOf(source: string): string[] {
  const specs = new Set<string>();
  const patterns = [
    /(?:^|\n)\s*import\s+(?:type\s+)?[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s+(?:type\s+)?(?:\*|\{[^}]*\})(?:\s+as\s+\w+)?\s*from\s*['"]([^'"]+)['"]/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) for (const m of source.matchAll(re)) specs.add(m[1] as string);
  return [...specs];
}

const ALLOWED_PACKAGES = new Set(['zod', 'yaml']);
const FORBIDDEN_CORE = ['rules', 'resolve', 'pauses', 'knowledge', 'terminal', 'projection', 'obligations', 'negotiation', 'execute', 'plan', 'simulate', 'siege', 'system', 'permissive', 'script'];

function verdict(file: string, spec: string): string | null {
  if (spec.startsWith('node:')) return null;
  if (!spec.startsWith('.')) return ALLOWED_PACKAGES.has(spec) ? null : `package ${spec}`;
  const target = path.resolve(path.dirname(file), spec).replace(/\.js$/, '.ts');
  const rel = path.relative(ROOT, target).replace(/\\/g, '/');
  if (rel.startsWith('src/eval/oracle/')) return null;
  if (rel === 'src/core/types.ts') return null;
  if (rel === 'src/content/loader.ts' || rel === 'src/content/schema.ts') return null;
  return rel;
}

describe('oracle import isolation (PLAN §13.3)', () => {
  const list = files(ORACLE);

  it('scans a non-trivial oracle', () => {
    expect(list.length).toBeGreaterThanOrEqual(6);
  });

  it.each(list.map((f) => [path.relative(ROOT, f), f]))('%s imports only types, the content loader and its own modules', (_rel, file) => {
    const source = readFileSync(file, 'utf8');
    const bad = importsOf(source)
      .map((s) => verdict(file, s))
      .filter((x): x is string => x !== null);
    expect(bad).toEqual([]);
  });

  it('the scanner catches forbidden imports (self-test)', () => {
    const fake = path.join(ORACLE, 'fake.ts');
    const src = [
      "import { validate } from '../../core/rules.js';",
      "import type { Harness } from '../../harness/harness.js';",
      "export * from '../../core/pauses.js';",
      "const x = await import('../../core/knowledge.js');",
      "import { ok } from './checks.js';",
      "import type { WorldState } from '../../core/types.js';",
    ].join('\n');
    const bad = importsOf(src)
      .map((s) => verdict(fake, s))
      .filter((x): x is string => x !== null)
      .sort();
    expect(bad).toEqual(['src/core/knowledge.ts', 'src/core/pauses.ts', 'src/core/rules.ts', 'src/harness/harness.ts']);
    for (const name of FORBIDDEN_CORE) expect(verdict(fake, `../../core/${name}.js`)).toBe(`src/core/${name}.ts`);
    expect(verdict(fake, '../../harness/index.js')).toBe('src/harness/index.ts');
  });
});
