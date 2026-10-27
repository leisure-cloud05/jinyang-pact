/**
 * Content schemas (PLAN §12): sources, scenario (G parameters, travel, factions, terms catalog, initial world,
 * correspondence access, player, epilogue), characters, cases (incl. the decision_policy DSL), reference traces,
 * dev and pilot configs. Keys follow the spelling PLAN uses (`accessibleBy`, `knownBy`, `commitPriority`,
 * `agendaTriggers`, `periodicActivation`); keys PLAN does not name are snake_case.
 *
 * Objects are strict (unknown keys are errors) except source entries, whose archival metadata may grow.
 * Cross-references (ids, source refs, permissions, feasible policy options) are checked by the loader.
 */
import { z } from 'zod';
import { DEFAULT_TERMS } from '../core/terms.js';
import {
  ACTION_TYPES,
  CESSION_VALUES,
  CHAR_IDS,
  DECISION_OPTIONS,
  FACTION_IDS,
  LOC_IDS,
  PAIR_IDS,
  PAUSE_CATEGORIES,
  RESOURCE_KEYS,
  RULE_IDS,
  SCALAR_TERM_KEYS,
  SYSTEM_ACTION_TYPES,
  TERMINAL_KINDS,
} from '../core/types.js';

// ---------------------------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------------------------

export const LocalizedSchema = z.strictObject({ zh: z.string().min(1), en: z.string().min(1) });
export const CharIdSchema = z.enum(CHAR_IDS);
export const PersonIdSchema = z.enum([...CHAR_IDS, 'player']);
export const ActorIdSchema = z.enum([...CHAR_IDS, 'player', 'system']);
export const FactionIdSchema = z.enum(FACTION_IDS);
export const LocIdSchema = z.enum(LOC_IDS);
export const PairIdSchema = z.enum(PAIR_IDS);
export const ResourceKeySchema = z.enum(RESOURCE_KEYS);
export const ActionTypeSchema = z.enum(ACTION_TYPES);
export const PauseCategorySchema = z.enum(PAUSE_CATEGORIES);
export const DecisionOptionSchema = z.enum(DECISION_OPTIONS);
export const TerminalKindSchema = z.enum(TERMINAL_KINDS);
export const RuleIdSchema = z.enum(RULE_IDS);
export const DocIdSchema = z.string().regex(/^doc:[1-9]\d*$/, 'document ids look like doc:1');
const SourceRefs = z.array(z.string().min(1)).default([]);
const NonNegInt = z.number().int().min(0);

// ---------------------------------------------------------------------------------------------------------------
// Sources (§12.1)
// ---------------------------------------------------------------------------------------------------------------

export const EventTimeSchema = z.looseObject({
  year: z.number().int(),
  month: z.number().int().min(1).max(12).nullable(),
  leap: z.boolean(),
  lunar: z.literal(true),
  note: z.string().default(''),
});

export const SourceEntrySchema = z.looseObject({
  id: z.string().min(1),
  work: z.string().min(1),
  volume: z.union([z.number().int(), z.string().min(1)]),
  locator: z.string().min(1),
  url: z.string().min(1),
  original_zh: z.string().min(1),
  gloss_en: z.string().min(1),
  persons: z.array(z.string().min(1)).default([]),
  event_time: EventTimeSchema,
  location: z.string().min(1).nullable().default(null),
  topics: z.array(z.string().min(1)).default([]),
  kind: z.string().min(1),
  learnable_by: z.array(z.strictObject({ holder: PersonIdSchema, when: z.enum(['initial', 'never_initial']) })),
  derived_from: z
    .union([z.string().min(1), z.array(z.string().min(1))])
    .nullable()
    .default([])
    .transform((v) => (v === null ? [] : typeof v === 'string' ? [v] : v)),
  conflicts_with: z.array(z.string().min(1)).default([]),
  credibility: z.number().min(0).max(1),
  credibility_note: z.string().default(''),
});
export type SourceEntry = z.infer<typeof SourceEntrySchema>;

/** A source file is a list of entries (or `{entries: [...]}`). */
export const SourceFileSchema = z.union([
  z.array(SourceEntrySchema),
  z.looseObject({ entries: z.array(SourceEntrySchema) }).transform((f) => f.entries),
]);

// ---------------------------------------------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------------------------------------------

/** A term set as written in content: omitted keys take their default (no obligation); clauses by id. */
export const TermSetSeedSchema = z.strictObject({
  vassal: z.boolean().default(DEFAULT_TERMS.vassal),
  filial: z.boolean().default(DEFAULT_TERMS.filial),
  cession: z.enum(CESSION_VALUES).default(DEFAULT_TERMS.cession),
  annual_silk: NonNegInt.default(DEFAULT_TERMS.annual_silk),
  immediate_silk: NonNegInt.default(DEFAULT_TERMS.immediate_silk),
  aid_cavalry: NonNegInt.default(DEFAULT_TERMS.aid_cavalry),
  aid_arrival_days: NonNegInt.default(DEFAULT_TERMS.aid_arrival_days),
  neutrality: z.boolean().default(DEFAULT_TERMS.neutrality),
  marriage_alliance: z.boolean().default(DEFAULT_TERMS.marriage_alliance),
  secret_clauses: z.array(z.string().min(1)).default([]),
});
export type TermSetSeed = z.infer<typeof TermSetSeedSchema>;

/** Partial term overrides (case initial_overrides). */
export const TermSetPatchSchema = z.strictObject({
  vassal: z.boolean().optional(),
  filial: z.boolean().optional(),
  cession: z.enum(CESSION_VALUES).optional(),
  annual_silk: NonNegInt.optional(),
  immediate_silk: NonNegInt.optional(),
  aid_cavalry: NonNegInt.optional(),
  aid_arrival_days: NonNegInt.optional(),
  neutrality: z.boolean().optional(),
  marriage_alliance: z.boolean().optional(),
  secret_clauses: z.array(z.string().min(1)).optional(),
});

const OptNum = z.number().nullable().default(null);
const OptCession = z.enum(CESSION_VALUES).nullable().default(null);
const OptBool = z.boolean().nullable().default(null);

/** Bounds on terms (player goal limits, authorization limits, persona reservation/tolerance). */
export const TermLimitsSchema = z.strictObject({
  vassal: OptBool,
  filial: OptBool,
  neutrality: OptBool,
  marriage_alliance: OptBool,
  cession_min: OptCession,
  cession_max: OptCession,
  annual_silk_min: OptNum,
  annual_silk_max: OptNum,
  immediate_silk_min: OptNum,
  immediate_silk_max: OptNum,
  aid_cavalry_min: OptNum,
  aid_cavalry_max: OptNum,
  aid_arrival_days_min: OptNum,
  aid_arrival_days_max: OptNum,
  burden_min: OptNum,
  burden_max: OptNum,
  secret_clauses_allowed: OptBool,
});

/** Persona preferences (never enforced by the Harness): limits plus a note. */
export const TermPreferenceSchema = TermLimitsSchema.extend({ note: LocalizedSchema.optional() });
export type TermPreference = z.infer<typeof TermPreferenceSchema>;

const PairPreferenceMapSchema = z.partialRecord(PairIdSchema, TermPreferenceSchema);

/**
 * A reservation/tolerance, written either flat (one preference for every pair) or keyed by principal pair
 * (`hedong-khitan: {...}`, `khitan-tang: {...}`). Parsed to the flat fields plus `by_pair` (null for the flat
 * form; for the keyed form the flat fields are unconstrained). Use `preferenceFor(pref, pair)` to read it.
 */
export const PairScopedPreferenceSchema = z
  .union([TermPreferenceSchema, PairPreferenceMapSchema])
  .transform((value): TermPreference & { by_pair: z.infer<typeof PairPreferenceMapSchema> | null } => {
    const keys = Object.keys(value);
    const keyed = keys.length > 0 && keys.every((k) => (PAIR_IDS as readonly string[]).includes(k));
    if (!keyed) return { ...(value as TermPreference), by_pair: null };
    return { ...TermPreferenceSchema.parse({}), by_pair: value as z.infer<typeof PairPreferenceMapSchema> };
  });
export type PairScopedPreference = z.infer<typeof PairScopedPreferenceSchema>;

/** The preference that applies to a principal pair (keyed entry, else the flat preference; null if none). */
export function preferenceFor(pref: PairScopedPreference | null | undefined, pair: (typeof PAIR_IDS)[number]): TermPreference | null {
  if (!pref) return null;
  if (pref.by_pair === null) {
    const { by_pair: _unused, ...flat } = pref;
    return flat;
  }
  return pref.by_pair[pair] ?? null;
}

export const TermCatalogEntrySchema = z.strictObject({
  key: z.enum(SCALAR_TERM_KEYS),
  label: LocalizedSchema,
  /** Documented type; must equal the key's fixed semantics. */
  type: z.enum(['boolean', 'integer', 'enum']),
  min: z.number().int().nullable().default(null),
  max: z.number().int().nullable().default(null),
  step: z.number().int().positive().nullable().default(null),
  /** Enum values (must equal the fixed cession levels if given). */
  values: z.array(z.string()).nullable().default(null),
  value_labels: z.record(z.string(), LocalizedSchema).nullable().default(null),
  burden_weight: z.number().min(0).default(0),
  burden_unit: z.number().positive().nullable().default(null),
  burden_by_value: z.record(z.string(), z.number()).nullable().default(null),
  applicable_pairs: z.array(PairIdSchema).min(1),
  note: LocalizedSchema.optional(),
  source_refs: SourceRefs,
});

export const SecretClauseSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'clause ids use letters, digits, _ and -'),
  text: LocalizedSchema,
  canary: z.string().min(6),
  /** A-priori holders. Empty for clauses whose holders are set per case (`initial_overrides.secret_clauses`). */
  knownBy: z.array(PersonIdSchema).default([]),
  applicable_pairs: z.array(PairIdSchema).min(1),
  burden_weight: z.number().min(0).default(0),
  source_refs: SourceRefs,
});

/**
 * Case-level clause entry: overrides fields (typically `knownBy`) of a scenario clause with the same id, or
 * defines a case-only clause (then `text`, `canary` and `applicable_pairs` are required — checked by the loader).
 */
export const CaseSecretClauseSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'clause ids use letters, digits, _ and -'),
  text: LocalizedSchema.optional(),
  canary: z.string().min(6).optional(),
  knownBy: z.array(PersonIdSchema).optional(),
  applicable_pairs: z.array(PairIdSchema).min(1).optional(),
  burden_weight: z.number().min(0).optional(),
  source_refs: z.array(z.string().min(1)).optional(),
});

// ---------------------------------------------------------------------------------------------------------------
// Scenario (§12.2)
// ---------------------------------------------------------------------------------------------------------------

/** G parameters with PLAN defaults (content may tune values, never semantics). */
export const GameParamsSchema = z.strictObject({
  round_days: z.number().int().positive().default(5),
  max_rounds: z.number().int().positive().default(6),
  segment_round_cap: z.number().int().positive().default(2),
  pair_offer_cap: z.number().int().positive().default(5),
  delay_rounds_min: z.number().int().positive().default(1),
  delay_rounds_max: z.number().int().positive().default(3),
  grain_per_advance: NonNegInt.default(5),
  pressure_per_advance: NonNegInt.default(8),
  pressure_cap: z.number().int().positive().default(100),
  morale_decay: NonNegInt.default(5),
  morale_low_grain: NonNegInt.default(15),
  morale_high_pressure: NonNegInt.default(70),
  morale_cap: z.number().int().positive().default(100),
  intensify_troops_step: z.number().int().positive().default(5000),
  intensify_pressure_per_step: NonNegInt.default(2),
  pay_silk_step: z.number().int().positive().default(10000),
  pay_morale_per_step: NonNegInt.default(3),
  mutiny_grain_max: NonNegInt.default(10),
  mutiny_morale_max: NonNegInt.default(30),
  mutiny_pressure_add: NonNegInt.default(20),
  fall_grain_max: NonNegInt.default(0),
  fall_pressure_min: z.number().int().positive().default(100),
  intel_delay_days: NonNegInt.default(5),
  intel_credibility: z.number().min(0).max(1).default(0.6),
  letter_credibility: z.number().min(0).max(1).default(0.5),
  projection_max_steps: z.number().int().positive().default(200),
});

const KnowledgeValueSchema = z.json();

export const KnowledgeSeedSchema = z.strictObject({
  holder: PersonIdSchema,
  subject: z.string().min(1),
  predicate: z.enum(['terms', 'status', 'content', 'value', 'claim']),
  value: KnowledgeValueSchema,
  credibility: z.number().min(0).max(1).default(1),
  visibility: z.enum(['private', 'faction', 'public']).default('private'),
  source_ref: z.string().min(1).nullable().default(null),
});
/** A character's or the player's own initial knowledge (holder implied). */
export const OwnKnowledgeSeedSchema = KnowledgeSeedSchema.omit({ holder: true });

export const TimingSeedSchema = z.strictObject({
  mode: z.enum(['now', 'delay', 'hold']).default('now'),
  notBeforeRound: z.number().int().min(1).nullable().default(null),
});

export const DocumentSeedSchema = z.strictObject({
  id: DocIdSchema,
  kind: z.literal('assistance_request').default('assistance_request'),
  holder: CharIdSchema,
  to: CharIdSchema,
  accessibleBy: z.array(PersonIdSchema).min(1),
  terms: TermSetSeedSchema.prefault({}),
  note: z.string().default(''),
  timing: TimingSeedSchema.prefault({}),
});

export const PlayerGoalSchema = z.strictObject({
  text: LocalizedSchema,
  limits: TermLimitsSchema.prefault({}),
});

export const PlayerSchema = z.strictObject({
  role: z.string().min(1),
  name: LocalizedSchema,
  title: LocalizedSchema,
  faction: FactionIdSchema,
  location: LocIdSchema,
  permissions: z.array(ActionTypeSchema).min(1),
  default_goal: PlayerGoalSchema,
  initial_knowledge: z.array(OwnKnowledgeSeedSchema).default([]),
  source_refs: SourceRefs,
});

/** A resource amount, optionally with its own game-assumption note and sources. */
export const ResourceSeedSchema = z.union([
  NonNegInt,
  z.strictObject({
    amount: NonNegInt,
    assumption: z.boolean().default(true),
    assumption_note: LocalizedSchema.optional(),
    source_refs: SourceRefs,
  }),
]);
export type ResourceSeed = z.infer<typeof ResourceSeedSchema>;

export function resourceAmount(seed: ResourceSeed): number {
  return typeof seed === 'number' ? seed : seed.amount;
}

export const ScenarioSchema = z.strictObject({
  id: z.string().min(1),
  title: LocalizedSchema,
  start_note: LocalizedSchema,
  parameters: GameParamsSchema.prefault({}),
  locations: z.array(z.strictObject({ id: LocIdSchema, name: LocalizedSchema, source_refs: SourceRefs })).min(1),
  travel: z.array(z.strictObject({ from: LocIdSchema, to: LocIdSchema, days: NonNegInt })),
  factions: z
    .array(
      z.strictObject({
        id: FactionIdSchema,
        name: LocalizedSchema,
        principal: CharIdSchema,
        resources: z.partialRecord(ResourceKeySchema, ResourceSeedSchema),
        assumption: z.boolean(),
        assumption_note: LocalizedSchema.optional(),
        source_refs: SourceRefs,
      }),
    )
    .min(1),
  terms_catalog: z.strictObject({
    terms: z.array(TermCatalogEntrySchema).min(1),
    secret_clauses: z.array(SecretClauseSchema).default([]),
  }),
  initial_world: z.strictObject({
    /** Optional per-character status/location overrides of the character files. */
    characters: z
      .array(
        z.strictObject({
          id: CharIdSchema,
          status: z.enum(['alive', 'dead', 'captured']).optional(),
          location: LocIdSchema.optional(),
        }),
      )
      .default([]),
    siege: z.strictObject({ pressure: NonNegInt, morale: NonNegInt }),
    documents: z.array(DocumentSeedSchema).min(1),
    knowledge: z.array(KnowledgeSeedSchema).default([]),
  }),
  correspondence_access: z
    .array(z.strictObject({ principal: CharIdSchema, readers: z.array(PersonIdSchema).min(1) }))
    .default([]),
  player: PlayerSchema,
  epilogue: z
    .strictObject({
      note: LocalizedSchema.optional(),
      historical_comparison: z
        .array(z.strictObject({ text: LocalizedSchema, source_refs: z.array(z.string().min(1)).min(1) }))
        .default([]),
    })
    .prefault({}),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Characters (§12.3)
// ---------------------------------------------------------------------------------------------------------------

/** Deterministic scheduler events an agenda can react to (§10.3). */
export const AGENDA_EVENTS = [
  'round_start',
  'offer_delivered',
  'response_delivered',
  'document_revised',
  'document_approved',
  'suggestion_made',
  'letter_delivered',
  'intel_delivered',
  'grain_below',
  'pressure_above',
  'morale_below',
] as const;

/** A private memory item; `source_refs` must be learnable `initial` by the character. */
export const PrivateMemorySchema = z.strictObject({
  zh: z.string().min(1),
  en: z.string().min(1),
  source_refs: SourceRefs,
});

export const AgendaTriggerSchema = z.strictObject({
  id: z.string().min(1),
  on: z.enum(AGENDA_EVENTS),
  threshold: z.number().nullable().default(null),
  agenda: LocalizedSchema,
});

export const CharacterSchema = z.strictObject({
  id: CharIdSchema,
  name: LocalizedSchema,
  title: LocalizedSchema,
  aliases: z
    .strictObject({ zh: z.array(z.string().min(1)).default([]), en: z.array(z.string().min(1)).default([]) })
    .prefault({}),
  faction: FactionIdSchema,
  location: LocIdSchema,
  principal: z.boolean(),
  permissions: z.array(ActionTypeSchema).min(1),
  commitPriority: z.number().int().min(1),
  goals: z.array(LocalizedSchema).min(1),
  private_memory: z.array(PrivateMemorySchema).default([]),
  voice: LocalizedSchema,
  /**
   * Public manner of speech only (register, style, manner of address; no facts, relationships, practices, plans,
   * stances or source content): the only persona text an `ask` answer sees besides name and title (PLAN §7).
   */
  public_voice: LocalizedSchema,
  /** Curated player-facing biography; never derived from private memory or model goals. */
  public_profile: z.strictObject({
    background: LocalizedSchema,
    stance: LocalizedSchema,
    concern: LocalizedSchema,
  }).nullable().default(null),
  initial_knowledge: z.array(OwnKnowledgeSeedSchema).default([]),
  agendaTriggers: z.array(AgendaTriggerSchema).default([]),
  periodicActivation: z
    .strictObject({ every_rounds: z.number().int().min(1), offset: NonNegInt.default(0) })
    .nullable()
    .default(null),
  reservation: PairScopedPreferenceSchema.nullable().default(null),
  tolerance: PairScopedPreferenceSchema.nullable().default(null),
  source_refs: SourceRefs,
  history_vs_assumption: z
    .array(
      z.strictObject({
        claim: LocalizedSchema,
        basis: z.enum(['history', 'assumption']),
        source_refs: SourceRefs,
      }),
    )
    .default([]),
});
export type CharacterConfig = z.infer<typeof CharacterSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Cases, dev and pilot configs (§12.4)
// ---------------------------------------------------------------------------------------------------------------

/** Per-case character override: world status/location plus persona fields (replacing the character file's). */
export const CharacterOverrideSchema = z.strictObject({
  status: z.enum(['alive', 'dead', 'captured']).optional(),
  location: LocIdSchema.optional(),
  goals: z.array(LocalizedSchema).min(1).optional(),
  private_memory: z.array(PrivateMemorySchema).optional(),
  reservation: PairScopedPreferenceSchema.nullable().optional(),
  tolerance: PairScopedPreferenceSchema.nullable().optional(),
  agendaTriggers: z.array(AgendaTriggerSchema).optional(),
});
export type CharacterOverride = z.infer<typeof CharacterOverrideSchema>;

/**
 * A message already on the road when the chapter starts (PLAN §12.4). `offer` opens a thread from `from` (a
 * principal) to `to` exactly like a committed proposal; `letter` is a plain letter. `sent_day` defaults to
 * `arrival_day − travel`; both may be negative (sent before day 0). Delivered at the first PREPARE with day ≥ arrival.
 */
export const InTransitSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('offer'),
    from: CharIdSchema,
    to: CharIdSchema,
    terms: TermSetSeedSchema.prefault({}),
    note: z.string().default(''),
    arrival_day: z.number().int(),
    sent_day: z.number().int().optional(),
  }),
  z.strictObject({
    kind: z.literal('letter'),
    from: CharIdSchema,
    to: CharIdSchema,
    text: z.string().min(1),
    arrival_day: z.number().int(),
    sent_day: z.number().int().optional(),
  }),
]);
export type InTransit = z.infer<typeof InTransitSchema>;

export const InitialOverridesSchema = z.strictObject({
  siege: z.strictObject({ pressure: NonNegInt.optional(), morale: NonNegInt.optional() }).optional(),
  /** Pre-start messages/offers in transit (validated like committed offers). */
  in_transit: z.array(InTransitSchema).optional(),
  resources: z.partialRecord(FactionIdSchema, z.partialRecord(ResourceKeySchema, ResourceSeedSchema)).optional(),
  /** Case clause library: `knownBy` (or other field) overrides of scenario clauses, and case-only clauses. */
  secret_clauses: z.array(CaseSecretClauseSchema).optional(),
  documents: z
    .array(
      z.strictObject({
        id: DocIdSchema,
        terms: TermSetPatchSchema.optional(),
        note: z.string().optional(),
        accessibleBy: z.array(PersonIdSchema).min(1).optional(),
        timing: TimingSeedSchema.optional(),
      }),
    )
    .optional(),
  /** `{<charId>: override}` (persona + world fields), or the older list form `[{id, status?, location?}]`. */
  characters: z
    .union([
      z.partialRecord(CharIdSchema, CharacterOverrideSchema),
      z.array(
        z.strictObject({
          id: CharIdSchema,
          status: z.enum(['alive', 'dead', 'captured']).optional(),
          location: LocIdSchema.optional(),
        }),
      ),
    ])
    .optional(),
  knowledge: z.array(KnowledgeSeedSchema).optional(),
});
export type InitialOverrides = z.infer<typeof InitialOverridesSchema>;

const TextSchema = z.union([z.string().min(1), LocalizedSchema]);

const ReceivedSpecSchema = z.strictObject({
  kind: z.enum(['offer', 'response', 'letter', 'withdrawal_result', 'intel']),
  from: CharIdSchema.optional(),
});

/** When a scripted input applies (evaluated at the PLAYER step on the player's knowledge only). */
export const ScriptConditionSchema = z.union([
  z.literal('always'),
  z.strictObject({ player_received: ReceivedSpecSchema }),
  z.strictObject({ player_not_received: ReceivedSpecSchema }),
  z.strictObject({
    doc_status: z.strictObject({ docId: DocIdSchema, status: z.enum(['draft', 'approved', 'sent', 'withdrawn']) }),
  }),
  z.strictObject({ round_at_least: z.number().int().min(1) }),
]);
export type ScriptConditionConfig = z.infer<typeof ScriptConditionSchema>;

const ScriptMeta = {
  /** Omitted ⇒ `always`. */
  when: ScriptConditionSchema.optional(),
  /** Enforcement probe: scored separately and excluded from model-behaviour metrics (§12.4). Omitted ⇒ false. */
  probe: z.boolean().optional(),
};

export const ScriptInputSchema = z.union([
  z.strictObject({ dialogue: z.strictObject({ to: z.array(PersonIdSchema).min(1), text: TextSchema }), ...ScriptMeta }),
  /** Action args may use "$current" for `baseDocVersion` / `docVersion`. */
  z.strictObject({ action: z.json(), ...ScriptMeta }),
]);
export type ScriptInput = z.infer<typeof ScriptInputSchema>;

export const AuthorizationGrantSchema = z.strictObject({
  grantee: CharIdSchema,
  categories: z.array(PauseCategorySchema).min(1),
  limits: TermLimitsSchema.prefault({}),
  expiresRound: z.number().int().min(1).nullable().default(null),
});

/** Structured term args used by counter_draft / amend payloads (same shape as the action's terms). */
const TermArgsSchema = z.strictObject({
  vassal: z.boolean(),
  filial: z.boolean(),
  cession: z.enum(CESSION_VALUES),
  annual_silk: NonNegInt,
  immediate_silk: NonNegInt,
  aid_cavalry: NonNegInt,
  aid_arrival_days: NonNegInt,
  neutrality: z.boolean(),
  marriage_alliance: z.boolean(),
  secret_clauses: z.array(z.string().min(1)),
});

export const AmendSchema = z.strictObject({
  docId: DocIdSchema,
  /** A version, or "$current": the version the player can see when the decision is taken. */
  baseDocVersion: z.union([z.number().int().min(1), z.literal('$current')]),
  terms: TermArgsSchema,
  note: z.string().default(''),
});

export const PolicyRuleSchema = z.strictObject({
  match: z.strictObject({
    category: PauseCategorySchema,
    within_limits: z.boolean().optional(),
    actor: ActorIdSchema.optional(),
    action_type: z.enum([...ACTION_TYPES, ...SYSTEM_ACTION_TYPES]).optional(),
  }),
  choose: DecisionOptionSchema,
  advice: z.string().nullable().default(null),
  authorization: AuthorizationGrantSchema.nullable().default(null),
  goal_limits: TermLimitsSchema.nullable().default(null),
  counter_terms: TermArgsSchema.nullable().default(null),
  amend: AmendSchema.nullable().default(null),
});

export const CaseSchema = z.strictObject({
  id: z.string().min(1),
  title: LocalizedSchema,
  purpose: LocalizedSchema,
  initial_overrides: InitialOverridesSchema.prefault({}),
  player_goal: PlayerGoalSchema,
  script: z
    .array(z.strictObject({ round: z.number().int().min(1), inputs: z.array(ScriptInputSchema).default([]) }))
    .default([]),
  decision_policy: z.array(PolicyRuleSchema).default([]),
  expected_checkpoints: z
    .array(
      z.strictObject({
        type: PauseCategorySchema,
        round: z.number().int().min(1).nullable().default(null),
        object: z.string().nullable().default(null),
        note: z.string().default(''),
      }),
    )
    .default([]),
  constraints: z
    .array(z.looseObject({ id: z.string().min(1), kind: z.string().min(1), description: z.string().optional() }))
    .default([]),
  valid_terminals: z.array(TerminalKindSchema).min(1),
  max_rounds: z.number().int().min(1).default(6),
});
export type CaseConfig = z.infer<typeof CaseSchema>;

export const DevConfigSchema = CaseSchema.extend({
  interrupts: z
    .array(
      z.strictObject({
        round: z.number().int().min(1),
        phase: z.enum(['generate', 'assess', 'decide']),
        instruction: z.string().min(1),
      }),
    )
    .default([]),
  faults: z
    .array(
      z.strictObject({
        round: z.number().int().min(1),
        kind: z.enum(['duplicate_request', 'narration_failure', 'llm_timeout', 'budget_exhausted']),
        target: z.string().nullable().default(null),
      }),
    )
    .default([]),
});
export type DevConfig = z.infer<typeof DevConfigSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Reference traces (§12.4)
// ---------------------------------------------------------------------------------------------------------------

const TraceExpectSchema = z.strictObject({
  status: z.enum(['committed', 'rejected', 'withheld', 'unapplied']),
  rule: RuleIdSchema.nullable().default(null),
});

const TraceProposalSchema = z.strictObject({
  ref: z.string().min(1).nullable().default(null),
  actor: ActorIdSchema,
  action: z.json(),
  ask_player: z.strictObject({ question: z.string().min(1) }).nullable().default(null),
  expect: TraceExpectSchema.nullable().default(null),
  note: z.string().optional(),
});

const TraceDecisionSchema = z.strictObject({
  ref: z.string().min(1).nullable().default(null),
  category: PauseCategorySchema.nullable().default(null),
  choose: DecisionOptionSchema,
  advice: z.string().nullable().default(null),
  authorization: AuthorizationGrantSchema.nullable().default(null),
  goal_limits: TermLimitsSchema.nullable().default(null),
  amend: AmendSchema.nullable().default(null),
});

const TraceGenerationSchema = z.strictObject({
  proposals: z.array(TraceProposalSchema).default([]),
  decisions: z.array(TraceDecisionSchema).default([]),
});

export const TraceSchema = z.strictObject({
  case: z.string().min(1),
  description: z.string().optional(),
  max_rounds: z.number().int().min(1).default(6),
  rounds: z.array(
    z.strictObject({
      round: z.number().int().min(1),
      note: z.string().optional(),
      player: z
        .array(z.strictObject({ action: z.json(), expect: TraceExpectSchema.nullable().default(null) }))
        .default([]),
      proposals: z.array(TraceProposalSchema).default([]),
      decisions: z.array(TraceDecisionSchema).default([]),
      regenerations: z.array(TraceGenerationSchema).default([]),
      mutiny: z.enum(['let_it_happen', 'urge_payment']).nullable().default(null),
    }),
  ),
  expected: z.strictObject({
    terminal: TerminalKindSchema.nullable(),
    round: z.number().int().min(1).nullable().default(null),
  }),
});
export type TraceConfig = z.infer<typeof TraceSchema>;
