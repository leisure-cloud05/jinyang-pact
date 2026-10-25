/** Prompt templates (versioned, hashed, strict rendering) and the agent output schemas (strict JSON Schema). */
import { describe, expect, it } from 'vitest';
import {
  ACTION_REFERENCE,
  CHARACTER_SYSTEM_BASELINE,
  CHARACTER_SYSTEM_HARNESS,
  PROMPT_TEMPLATES,
  PromptRenderError,
  defineTemplate,
  placeholders,
  promptManifest,
  promptSetHash,
  render,
  renderCharacterSystem,
  templateHash,
} from '../../src/agents/prompts/index.js';
import { AGENT_SCHEMAS, CharacterOutputSchema, MapperOutputSchema } from '../../src/agents/schemas.js';
import { ACTION_TYPES } from '../../src/core/types.js';
import { toStrictJsonSchema } from '../../src/llm/schemas.js';
import { validateOutput } from '../../src/llm/parse.js';
import { buildAgentSamples } from '../../src/agents/samples.js';

describe('prompt templates', () => {
  it('hash id, version and text, stably', () => {
    for (const t of PROMPT_TEMPLATES) {
      expect(t.hash).toBe(templateHash(t.id, t.version, t.text));
      expect(t.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(Object.isFrozen(t)).toBe(true);
    }
    const ids = PROMPT_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(promptManifest()).toEqual(promptManifest());
    expect(promptSetHash()).toBe(promptSetHash());
    const changed = defineTemplate(CHARACTER_SYSTEM_HARNESS.id, CHARACTER_SYSTEM_HARNESS.version, `${CHARACTER_SYSTEM_HARNESS.text} `);
    expect(changed.hash).not.toBe(CHARACTER_SYSTEM_HARNESS.hash);
    const bumped = defineTemplate(CHARACTER_SYSTEM_HARNESS.id, CHARACTER_SYSTEM_HARNESS.version + 1, CHARACTER_SYSTEM_HARNESS.text);
    expect(bumped.hash).not.toBe(CHARACTER_SYSTEM_HARNESS.hash);
  });

  it('renders strictly (missing variables fail; values are not re-scanned)', () => {
    const t = defineTemplate('t', 1, 'a {{x}} b {{y}}');
    expect(placeholders(t)).toEqual(['x', 'y']);
    expect(() => render(t, { x: 1 })).toThrow(PromptRenderError);
    expect(render(t, { x: '{{y}}', y: 2 })).toBe('a {{y}} b 2');
  });

  it('states the closed action set, permissions and world rules; the baseline adds the ask_player rule', () => {
    const vars = {
      name: '桑维翰',
      title: '河东掌书记',
      permissions: ['speak', 'send_letter', 'revise_document', 'suggest_revision', 'wait'] as const,
      roundDays: 5,
      segmentRoundCap: 2,
      pairOfferCap: 5,
      langName: 'Simplified Chinese',
    };
    const harness = renderCharacterSystem('harness', { ...vars, permissions: [...vars.permissions] });
    const baseline = renderCharacterSystem('baseline', { ...vars, permissions: [...vars.permissions] });
    for (const text of [harness, baseline]) {
      expect(text).toContain('YOUR PERMITTED ACTIONS: speak, send_letter, revise_document, suggest_revision, wait');
      expect(text).toContain('approve_document'); // named among the non-permitted types
      expect(text).toContain(ACTION_REFERENCE.revise_document);
      expect(text).not.toContain(ACTION_REFERENCE.confirm_commitment);
      expect(text).toMatch(/Consent is given only by a principal himself/);
      expect(text).toMatch(/can never consent or decide for anyone/);
      expect(text).toMatch(/Nobody knows unsent or undelivered content/);
      expect(text).toMatch(/Khitan relief cavalry .* exclude each other/);
      expect(text).toMatch(/Never invent outcomes/);
      expect(text).toMatch(/recorded history .* apart from assumption/);
      expect(text).toMatch(/ONE JSON object only/);
      expect(text).not.toMatch(/\{\{[a-z_]+\}\}/);
    }
    expect(baseline).toMatch(/If a decision is consequential .* set ask_player/);
    expect(harness).not.toMatch(/If a decision is consequential/);
    expect(harness).toMatch(/the game checks every action/);
    expect(CHARACTER_SYSTEM_BASELINE.hash).not.toBe(CHARACTER_SYSTEM_HARNESS.hash);
    for (const type of ACTION_TYPES) expect(ACTION_REFERENCE[type]).toContain(type);
  });
});

describe('agent output schemas', () => {
  it('convert to strict JSON Schema (every key required, optional ⇒ nullable, no open objects)', () => {
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node !== 'object' || node === null) return;
      const n = node as Record<string, unknown>;
      if (n.type === 'object') {
        expect(n.additionalProperties).toBe(false);
        expect(Object.keys(n.properties as object).sort()).toEqual([...(n.required as string[])].sort());
      }
      Object.values(n).forEach(walk);
    };
    for (const { schema } of Object.values(AGENT_SCHEMAS)) {
      const json = toStrictJsonSchema(schema);
      expect(json.type).toBe('object');
      walk(json);
    }
    const character = toStrictJsonSchema(CharacterOutputSchema) as { properties: { actions: { items: { anyOf: unknown[] } }; ask_player: { anyOf: unknown[] } } };
    expect(character.properties.actions.items.anyOf).toHaveLength(ACTION_TYPES.length);
    expect(JSON.stringify(character.properties.ask_player)).toContain('"null"');
    const mapper = toStrictJsonSchema(MapperOutputSchema) as { properties: { action: { anyOf: unknown[] } } };
    expect(mapper.properties.action.anyOf).toHaveLength(8); // 7 player actions + null
  });

  it('round-trip the sample outputs of every role through JSON and validation (zh and en)', () => {
    for (const lang of ['zh', 'en'] as const) {
      const samples = buildAgentSamples(lang);
      for (const role of ['character', 'judge', 'narrator', 'mapper'] as const) {
        const s = samples[role];
        const parsed = validateOutput(s.schema, JSON.parse(JSON.stringify(s.mockOutput)));
        expect(parsed.ok, `${role}/${lang}`).toBe(true);
      }
    }
  });

  it('round-trips one item of every action type and rejects extra keys', () => {
    const argsFor: Record<string, unknown> = {
      speak: { to: ['player'], text: 'x' },
      send_letter: { to: 'yelu_deguang', text: 'x' },
      revise_document: {
        docId: 'doc:1',
        baseDocVersion: 1,
        note: '',
        terms: { vassal: true, filial: false, cession: 'none', annual_silk: 0, immediate_silk: 0, aid_cavalry: 0, aid_arrival_days: 0, neutrality: false, marriage_alliance: false, secret_clauses: [] },
      },
      suggest_revision: {
        target: { kind: 'document', id: 'doc:1' },
        reason: 'x',
        terms: { vassal: null, filial: false, cession: null, annual_silk: null, immediate_silk: null, aid_cavalry: null, aid_arrival_days: null, neutrality: null, marriage_alliance: null, secret_clauses: null },
      },
      approve_document: { docId: 'doc:1', docVersion: 1 },
      set_dispatch_timing: { docId: 'doc:1', mode: 'delay', rounds: 1 },
      dispatch_document: { docId: 'doc:1', docVersion: 1 },
      propose_terms: {
        to: 'yelu_deguang',
        note: null,
        terms: { vassal: false, filial: false, cession: 'none', annual_silk: 0, immediate_silk: 0, aid_cavalry: 0, aid_arrival_days: 0, neutrality: true, marriage_alliance: false, secret_clauses: [] },
      },
      respond_to_offer: { offerId: 'offer:1', response: 'reject', counterTerms: null, reason: 'x' },
      withdraw_offer: { offerId: 'offer:1' },
      confirm_commitment: { commitmentId: 'cmt:1', offerId: 'offer:1', termsVersion: 1 },
      allocate_resources: { faction: 'hedong', resource: 'silk', amount: 10000, purpose: 'pay_troops' },
      abandon_request: { reason: 'x' },
      revoke_authorization: { authId: 'auth:1' },
      wait: {},
    };
    const output = {
      speech: '',
      private_rationale: 'r',
      actions: ACTION_TYPES.map((type) => ({ type, args: argsFor[type], rationale: 'r', cites: [] })),
      ask_player: null,
    };
    for (let i = 0; i < output.actions.length; i += 3) {
      const chunk = { ...output, actions: output.actions.slice(i, i + 3) };
      expect(validateOutput(CharacterOutputSchema, JSON.parse(JSON.stringify(chunk))).ok).toBe(true);
    }
    expect(validateOutput(CharacterOutputSchema, { ...output, actions: output.actions.slice(0, 4) }).ok).toBe(false);
    const extra = { ...output, actions: [{ type: 'wait', args: {}, rationale: 'r', cites: [], sneaky: 1 }] };
    expect(validateOutput(CharacterOutputSchema, extra).ok).toBe(false);
  });
});
