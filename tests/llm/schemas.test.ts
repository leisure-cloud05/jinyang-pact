import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validateOutput } from '../../src/llm/parse.js';
import {
  describeSchemaCompact,
  nullableOptional,
  StrictSchemaError,
  toStrictJsonSchema,
  type JsonSchema,
} from '../../src/llm/schemas.js';

const STRIPPED = [
  '$schema',
  'format',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minItems',
  'maxItems',
  'default',
];

function walk(node: unknown, visit: (n: Record<string, unknown>, path: string) => void, path = '$'): void {
  if (Array.isArray(node)) {
    node.forEach((n, i) => walk(n, visit, `${path}[${i}]`));
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const obj = node as Record<string, unknown>;
  visit(obj, path);
  for (const [k, v] of Object.entries(obj)) walk(v, visit, `${path}.${k}`);
}

/** Every object is closed and requires all of its properties; no unsupported keywords anywhere. */
function expectStrict(schema: JsonSchema): void {
  walk(schema, (n, path) => {
    for (const kw of [...STRIPPED, 'oneOf', 'allOf', 'const', 'prefixItems']) {
      // property *names* may legitimately be anything; only check schema keywords
      if (!path.endsWith('.properties')) expect(n, `${path} has ${kw}`).not.toHaveProperty(kw);
    }
    if (n.type === 'object' && !path.endsWith('.properties')) {
      expect(n.additionalProperties, path).toBe(false);
      expect(n.required, path).toEqual(Object.keys(n.properties as object));
    }
  });
}

const Action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('speak'), to: z.array(z.string()).min(1), text: z.string().min(1).max(200) }),
  z.object({
    type: z.literal('revise'),
    terms: z.object({
      cession: z.enum(['none', 'yanmen_north', 'sixteen_prefectures']),
      annual_silk: z.number().int().min(0).max(500000),
    }),
    note: z.string().optional(),
  }),
  z.object({ type: z.literal('wait') }),
]);

const Output = z.object({
  speech: z.string().regex(/\S/),
  actions: z.array(Action).max(3),
  grid: z.array(z.array(z.number().min(0))),
  ask_player: z.object({ question: z.string() }).nullable(),
  mood: z.enum(['calm', 'angry']).optional(),
  weight: z.number().default(1),
  email: z.email().optional(),
  maybe: nullableOptional(z.string()),
});

describe('toStrictJsonSchema', () => {
  const schema = toStrictJsonSchema(Output);
  const props = schema.properties as Record<string, JsonSchema>;

  it('closes every object, requires every key and strips unsupported keywords', () => {
    expect(schema.type).toBe('object');
    expect(schema).not.toHaveProperty('$schema');
    expect(schema.required).toEqual(['speech', 'actions', 'grid', 'ask_player', 'mood', 'weight', 'email', 'maybe']);
    expectStrict(schema);
  });

  it('turns a discriminated union into anyOf of strict objects with enum discriminators', () => {
    const items = (props.actions as JsonSchema).items as JsonSchema;
    const branches = items.anyOf as JsonSchema[];
    expect(branches).toHaveLength(3);
    const discriminators = branches.map((b) => ((b.properties as Record<string, JsonSchema>).type as JsonSchema).enum);
    expect(discriminators).toEqual([['speak'], ['revise'], ['wait']]);
    const revise = branches[1] as JsonSchema;
    const reviseProps = revise.properties as Record<string, JsonSchema>;
    expect(revise.required).toEqual(['type', 'terms', 'note']);
    expect(reviseProps.note).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });
    expect(reviseProps.terms).toEqual({
      type: 'object',
      properties: {
        cession: { type: 'string', enum: ['none', 'yanmen_north', 'sixteen_prefectures'] },
        annual_silk: { type: 'integer' },
      },
      required: ['cession', 'annual_silk'],
      additionalProperties: false,
    });
  });

  it('keeps nested arrays, nullable objects and enums; optional fields become nullable', () => {
    expect(props.grid).toEqual({ type: 'array', items: { type: 'array', items: { type: 'number' } } });
    const ask = props.ask_player as JsonSchema;
    expect((ask.anyOf as JsonSchema[])[1]).toEqual({ type: 'null' });
    expect((ask.anyOf as JsonSchema[])[0]).toMatchObject({ type: 'object', additionalProperties: false, required: ['question'] });
    expect(props.mood).toEqual({ anyOf: [{ type: 'string', enum: ['calm', 'angry'] }, { type: 'null' }] });
    expect(props.email).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });
    expect(props.maybe).toEqual({ type: ['string', 'null'] });
  });

  it('makes a .default() field required and non-nullable', () => {
    expect(props.weight).toEqual({ type: 'number' });
  });

  it('inlines reused named definitions and keeps recursive ones consistently in $defs', () => {
    const Named = z.object({ a: z.string() }).meta({ id: 'NamedThing' });
    const reused = toStrictJsonSchema(z.object({ x: Named, y: Named }));
    expect(reused).not.toHaveProperty('$defs');
    expect((reused.properties as Record<string, unknown>).x).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
      additionalProperties: false,
    });

    interface TreeNode {
      name: string;
      children: TreeNode[];
    }
    const Node: z.ZodType<TreeNode> = z.object({
      name: z.string(),
      get children() {
        return z.array(Node);
      },
    });
    const tree = toStrictJsonSchema(z.object({ root: Node }));
    const refs: string[] = [];
    walk(tree, (n) => {
      if (typeof n.$ref === 'string') refs.push(n.$ref);
    });
    expect(refs.length).toBeGreaterThan(0);
    const defs = (tree.$defs ?? {}) as Record<string, JsonSchema>;
    for (const ref of refs) {
      if (ref === '#') continue;
      const name = ref.replace('#/$defs/', '');
      expect(defs[name], `missing def for ${ref}`).toBeDefined();
    }
    expectStrict(tree);
  });

  it('rejects constructs strict mode cannot express', () => {
    const cases: Array<[string, z.ZodType]> = [
      ['root union', z.discriminatedUnion('k', [z.object({ k: z.literal('a') }), z.object({ k: z.literal('b') })])],
      ['record', z.object({ m: z.record(z.string(), z.number()) })],
      ['tuple', z.object({ t: z.tuple([z.string(), z.number()]) })],
      ['any', z.object({ v: z.any() })],
      ['date', z.object({ d: z.date() })],
    ];
    for (const [label, s] of cases) {
      expect(() => toStrictJsonSchema(s), label).toThrow(StrictSchemaError);
    }
  });

  it('caches and freezes the converted schema', () => {
    expect(toStrictJsonSchema(Output)).toBe(schema);
    expect(Object.isFrozen(schema)).toBe(true);
    expect(Object.isFrozen(props.actions)).toBe(true);
  });
});

describe('nullableOptional', () => {
  it('accepts a value, null and absence', () => {
    const S = z.object({ a: nullableOptional(z.string()) });
    expect(S.parse({ a: 'x' })).toEqual({ a: 'x' });
    expect(S.parse({ a: null })).toEqual({ a: null });
    expect(S.parse({})).toEqual({});
  });
});

describe('describeSchemaCompact', () => {
  it('renders a TypeScript-like description with unions, arrays and nulls', () => {
    const text = describeSchemaCompact(toStrictJsonSchema(Output));
    expect(text).toContain('"speech": string');
    expect(text).toContain('Array<{"type": "speak"');
    expect(text).toContain('"ask_player": {"question": string} | null');
    expect(text).toContain('"mood": "calm" | "angry" | null');
  });

  it('includes field descriptions as comments', () => {
    const text = describeSchemaCompact(toStrictJsonSchema(z.object({ speech: z.string().describe('in Chinese') })));
    expect(text).toBe('{"speech": string /* in Chinese */}');
  });
});

describe('strict conversion and validation agree (review finding 7)', () => {
  /** A value allowed by a strict JSON schema: null wherever null is allowed (preferNull), else a minimal value. */
  function sample(node: JsonSchema, preferNull: boolean): unknown {
    if (Array.isArray(node.anyOf)) {
      const branches = node.anyOf as JsonSchema[];
      const nullBranch = branches.find((b) => b.type === 'null');
      if (preferNull && nullBranch) return null;
      return sample(branches.find((b) => b.type !== 'null') ?? branches[0]!, preferNull);
    }
    if (Array.isArray(node.enum)) return preferNull && node.enum.includes(null) ? null : node.enum[0];
    const types = Array.isArray(node.type) ? (node.type as string[]) : [node.type as string];
    if (preferNull && types.includes('null')) return null;
    const type = types.find((t) => t !== 'null');
    switch (type) {
      case 'object':
        return Object.fromEntries(Object.entries(node.properties as Record<string, JsonSchema>).map(([k, v]) => [k, sample(v, preferNull)]));
      case 'array':
        return [sample(node.items as JsonSchema, preferNull), sample(node.items as JsonSchema, preferNull)];
      case 'string':
        return 'x';
      case 'number':
      case 'integer':
        return 1;
      case 'boolean':
        return true;
      default:
        return null;
    }
  }

  const Contract = z.object({
    mood: z.enum(['calm', 'angry']).optional(),
    tag: z.literal('x').optional(),
    choice: z.union([z.string(), z.number()]).optional(),
    obj: z.object({ a: z.string() }).optional(),
    plain: z.string().optional(),
    both: nullableOptional(z.enum(['u', 'v'])),
    nullable: z.string().nullable(),
    def: z.number().default(2),
    list: z.array(
      z.object({
        kind: z.enum(['a', 'b']).optional(),
        lit: z.literal(3).optional(),
        inner: z.array(z.object({ e: z.enum(['p', 'q']).optional(), u: z.union([z.literal('m'), z.literal('n')]).optional() })),
      }),
    ),
    action: z.discriminatedUnion('type', [
      z.object({ type: z.literal('speak'), mood: z.enum(['calm', 'angry']).optional() }),
      z.object({ type: z.literal('wait') }),
    ]),
  });

  it('every null the strict schema permits is accepted by validation (optional keys are dropped)', () => {
    const strict = toStrictJsonSchema(Contract);
    const withNulls = sample(strict, true);
    const r = validateOutput(Contract, withNulls);
    expect(r.ok, r.ok ? '' : r.summary).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      both: null,
      nullable: null,
      def: 1,
      list: [
        { inner: [{}, {}] },
        { inner: [{}, {}] },
      ],
      action: { type: 'speak' },
    });
    expect(r.droppedNullKeys).toContain('$.mood');
    expect(r.droppedNullKeys).toContain('$.list[1].inner[0].e');
  });

  it('a non-null sample of the strict schema validates too', () => {
    const r = validateOutput(Contract, sample(toStrictJsonSchema(Contract), false));
    expect(r.ok, r.ok ? '' : r.summary).toBe(true);
  });

  it('a null for a required non-nullable enum still fails', () => {
    const S = z.object({ mood: z.enum(['calm', 'angry']) });
    expect(validateOutput(S, { mood: null }).ok).toBe(false);
  });
});
