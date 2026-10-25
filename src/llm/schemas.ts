/**
 * zod → JSON Schema for OpenAI-style strict structured outputs (OpenRouter `response_format`
 * `{ type: 'json_schema', json_schema: { name, strict: true, schema } }`).
 *
 * Rules applied to the output of `z.toJSONSchema(schema, { io: 'input' })`:
 * - every object gets `additionalProperties: false` and lists all its properties in `required`;
 * - a property that was optional becomes nullable (`anyOf: [..., { type: 'null' }]`). The zod side
 *   must then accept `null` for it: model such fields with `.nullable()` or `nullableOptional()`.
 *   (As a safety net, `validateOutput` in parse.ts drops a `null` that zod rejects for an optional key.)
 *   Exception: a property with a zod `.default()` becomes required and non-nullable;
 * - `oneOf` (zod discriminated unions) → `anyOf`; `const` → single-value `enum`;
 * - validation-only keywords are removed (`$schema`, `format`, `pattern`, `minLength`, `maxLength`,
 *   `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `minItems`, `maxItems`,
 *   `uniqueItems`, `default`, …) — zod still enforces them when the output is validated;
 * - `$ref`s into `$defs` are inlined; only recursive definitions stay in `$defs` (processed the same way);
 * - constructs strict mode cannot express throw `StrictSchemaError`: a non-object root, records,
 *   tuples, `z.any()/z.unknown()`, `allOf`/`not`/conditionals, dates and other unrepresentable types.
 */
import { z } from 'zod';

export type JsonSchema = Record<string, unknown>;

export class StrictSchemaError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${message} (at ${path})`);
    this.name = 'StrictSchemaError';
    this.path = path;
  }
}

const STRIPPED_KEYWORDS = new Set([
  '$schema',
  '$id',
  '$comment',
  'format',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'default',
  'examples',
  'contentEncoding',
  'contentMediaType',
  'readOnly',
  'writeOnly',
  'deprecated',
]);

const UNSUPPORTED_KEYWORDS: Record<string, string> = {
  allOf: 'use a single z.object instead of a non-mergeable intersection',
  not: 'negation is not supported',
  if: 'conditional schemas are not supported',
  then: 'conditional schemas are not supported',
  else: 'conditional schemas are not supported',
  prefixItems: 'tuples are not supported; use an object with named fields',
  patternProperties: 'pattern properties are not supported',
  propertyNames: 'records are not supported; use an array of { key, value } objects',
  dependentSchemas: 'dependent schemas are not supported',
  dependentRequired: 'dependent requirements are not supported',
  contains: 'contains is not supported',
  unevaluatedProperties: 'unevaluatedProperties is not supported',
  unevaluatedItems: 'unevaluatedItems is not supported',
};

const cache = new WeakMap<z.ZodType, JsonSchema>();

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function decodePointerToken(token: string): string {
  return decodeURIComponent(token).replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Replaces `$ref: '#/$defs/X'` with the definition, except where that would recurse forever. */
function inlineRefs(
  node: unknown,
  defs: Record<string, unknown>,
  stack: readonly string[],
  recursive: Set<string>,
  path: string,
): unknown {
  if (Array.isArray(node)) return node.map((n, i) => inlineRefs(n, defs, stack, recursive, `${path}/${i}`));
  if (!isPlainObject(node)) return node;
  const ref = node.$ref;
  if (typeof ref === 'string') {
    if (ref === '#') return { $ref: '#' };
    const match = /^#\/\$defs\/(.+)$/.exec(ref);
    if (!match || match[1] === undefined) throw new StrictSchemaError(`unsupported $ref "${ref}"`, path);
    const name = decodePointerToken(match[1]);
    if (stack.includes(name)) {
      recursive.add(name);
      return { $ref: ref };
    }
    const def = defs[name];
    if (def === undefined) throw new StrictSchemaError(`dangling $ref "${ref}"`, path);
    const expanded = inlineRefs(def, defs, [...stack, name], recursive, `${path}(${name})`);
    const siblings = Object.fromEntries(Object.entries(node).filter(([k]) => k !== '$ref'));
    return isPlainObject(expanded) ? { ...expanded, ...siblings } : expanded;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = inlineRefs(value, defs, stack, recursive, `${path}/${key}`);
  }
  return out;
}

function allowsNull(schema: JsonSchema): boolean {
  const type = schema.type;
  if (type === 'null') return true;
  if (Array.isArray(type) && type.includes('null')) return true;
  if (Array.isArray(schema.enum) && schema.enum.includes(null)) return true;
  if (Array.isArray(schema.anyOf)) return schema.anyOf.some((b) => isPlainObject(b) && allowsNull(b));
  return false;
}

function makeNullable(schema: JsonSchema): JsonSchema {
  if (allowsNull(schema)) return schema;
  const { description, title, ...rest } = schema;
  const hoisted: JsonSchema = {};
  if (description !== undefined) hoisted.description = description;
  if (title !== undefined) hoisted.title = title;
  if (Array.isArray(rest.anyOf) && Object.keys(rest).length === 1) {
    return { ...hoisted, anyOf: [...rest.anyOf, { type: 'null' }] };
  }
  return { ...hoisted, anyOf: [rest, { type: 'null' }] };
}

function flattenAnyOf(branches: JsonSchema[]): JsonSchema[] {
  const out: JsonSchema[] = [];
  for (const branch of branches) {
    const keys = Object.keys(branch);
    if (Array.isArray(branch.anyOf) && keys.every((k) => k === 'anyOf')) {
      out.push(...(branch.anyOf as JsonSchema[]));
    } else {
      out.push(branch);
    }
  }
  const seenNull = out.findIndex((b) => b.type === 'null' && Object.keys(b).length === 1);
  return out.filter((b, i) => !(b.type === 'null' && Object.keys(b).length === 1) || i === seenNull);
}

function hasType(schema: Record<string, unknown>, type: string): boolean {
  return schema.type === type || (Array.isArray(schema.type) && schema.type.includes(type));
}

function strictify(node: unknown, path: string): JsonSchema {
  if (node === true || (isPlainObject(node) && Object.keys(node).length === 0)) {
    throw new StrictSchemaError('unconstrained value (z.any()/z.unknown()) is not allowed in strict mode', path);
  }
  if (!isPlainObject(node)) throw new StrictSchemaError('invalid schema node', path);
  for (const [keyword, hint] of Object.entries(UNSUPPORTED_KEYWORDS)) {
    if (keyword in node) throw new StrictSchemaError(`JSON Schema keyword "${keyword}": ${hint}`, path);
  }
  if (typeof node.$ref === 'string') return { $ref: node.$ref };

  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) {
    if (STRIPPED_KEYWORDS.has(key)) continue;
    if (key === 'properties' || key === 'required' || key === 'additionalProperties' || key === 'items') continue;
    if (key === 'anyOf' || key === 'oneOf') {
      if (!Array.isArray(value)) throw new StrictSchemaError(`"${key}" must be an array`, path);
      const branches = value.map((b, i) => strictify(b, `${path}/${key}/${i}`));
      const previous = Array.isArray(out.anyOf) ? (out.anyOf as JsonSchema[]) : [];
      out.anyOf = flattenAnyOf([...previous, ...branches]);
      continue;
    }
    if (key === 'const') {
      out.enum = [value];
      continue;
    }
    out[key] = value;
  }

  if (hasType(node, 'object') || isPlainObject(node.properties)) {
    const properties = isPlainObject(node.properties) ? node.properties : {};
    const additional = node.additionalProperties;
    if (Object.keys(properties).length === 0 && additional !== undefined && additional !== false) {
      throw new StrictSchemaError('records / open maps are not supported; use an array of { key, value } objects', path);
    }
    const required = new Set(Array.isArray(node.required) ? (node.required as unknown[]) : []);
    const strictProps: Record<string, JsonSchema> = {};
    for (const [key, sub] of Object.entries(properties)) {
      let converted = strictify(sub, `${path}/properties/${key}`);
      if (!required.has(key)) {
        const hasDefault = isPlainObject(sub) && 'default' in sub;
        if (!hasDefault) converted = makeNullable(converted);
      }
      strictProps[key] = converted;
    }
    if (out.type === undefined) out.type = 'object';
    out.properties = strictProps;
    out.required = Object.keys(strictProps);
    out.additionalProperties = false;
  }

  if (hasType(node, 'array')) {
    const items = node.items;
    if (items === undefined || items === true || (isPlainObject(items) && Object.keys(items).length === 0)) {
      throw new StrictSchemaError('arrays must declare their item schema', path);
    }
    out.items = strictify(items, `${path}/items`);
  }
  return out;
}

/** Converts a zod schema to a strict-mode JSON Schema. Cached per schema object; the result is frozen. */
export function toStrictJsonSchema(schema: z.ZodType): JsonSchema {
  const cached = cache.get(schema);
  if (cached) return cached;

  let generated: unknown;
  try {
    generated = z.toJSONSchema(schema, { io: 'input', reused: 'inline', cycles: 'ref', unrepresentable: 'throw' });
  } catch (err) {
    throw new StrictSchemaError(`zod schema cannot be represented as JSON Schema: ${(err as Error).message}`, '$');
  }
  const json = JSON.parse(JSON.stringify(generated)) as JsonSchema;
  const defs = isPlainObject(json.$defs) ? json.$defs : {};
  delete json.$defs;

  const recursive = new Set<string>();
  const root = strictify(inlineRefs(json, defs, [], recursive, '$'), '$');
  if (root.type !== 'object' || !isPlainObject(root.properties)) {
    throw new StrictSchemaError('the root output schema must be a z.object (wrap unions or arrays in a field)', '$');
  }

  const strictDefs: Record<string, JsonSchema> = {};
  const done = new Set<string>();
  let pending = [...recursive];
  while (pending.length > 0) {
    for (const name of pending) {
      done.add(name);
      strictDefs[name] = strictify(inlineRefs(defs[name], defs, [name], recursive, `$defs/${name}`), `$defs/${name}`);
    }
    pending = [...recursive].filter((n) => !done.has(n));
  }
  if (Object.keys(strictDefs).length > 0) root.$defs = strictDefs;

  deepFreeze(root);
  cache.set(schema, root);
  return root;
}

/**
 * An optional field for LLM output contracts: strict mode makes every key required, so the model sends
 * `null` for "absent"; this accepts `null` and `undefined`.
 */
export function nullableOptional<T extends z.ZodType>(schema: T): z.ZodOptional<z.ZodNullable<T>> {
  return schema.nullish();
}

function renderCompact(node: unknown): string {
  if (!isPlainObject(node)) return 'any';
  let base: string;
  if (typeof node.$ref === 'string') {
    base = node.$ref === '#' ? 'Root' : decodePointerToken(node.$ref.replace(/^#\/\$defs\//, ''));
  } else if (Array.isArray(node.anyOf)) {
    base = node.anyOf.map(renderCompact).join(' | ');
  } else if (Array.isArray(node.enum)) {
    base = node.enum.map((v) => JSON.stringify(v)).join(' | ');
  } else if (hasType(node, 'object') && isPlainObject(node.properties)) {
    const props = Object.entries(node.properties).map(([k, v]) => `${JSON.stringify(k)}: ${renderCompact(v)}`);
    base = `{${props.join(', ')}}`;
  } else if (hasType(node, 'array')) {
    base = `Array<${renderCompact(node.items)}>`;
  } else if (Array.isArray(node.type)) {
    base = node.type.map(String).join(' | ');
  } else if (typeof node.type === 'string') {
    base = node.type;
  } else {
    base = 'any';
  }
  if (typeof node.description === 'string' && node.description.length > 0) {
    base += ` /* ${node.description.replace(/\*\//g, '* /')} */`;
  }
  return base;
}

/**
 * Compact TypeScript-like rendering of a strict JSON Schema (used in `json_object` mode, where the
 * schema must be described in the prompt instead of being enforced by the provider).
 */
export function describeSchemaCompact(schema: JsonSchema): string {
  const main = renderCompact(schema);
  const defs = isPlainObject(schema.$defs) ? Object.entries(schema.$defs) : [];
  if (defs.length === 0) return main;
  return `${main}\nwhere ${defs.map(([name, def]) => `${name} = ${renderCompact(def)}`).join('; ')}`;
}
