/**
 * Closed action set (PLAN §4) as zod schemas.
 *
 * These schemas are LLM-facing: they are converted to strict JSON Schema (`toStrictJsonSchema`) and sent to the
 * model, so optional arguments are modelled as `.nullable()` (every key present, `null` = absent) and never as
 * `.optional()`. Numeric ranges and pair applicability are semantic checks done by the rules (H01), not here.
 */
import { z } from 'zod';
import {
  ACTION_TYPES,
  ALLOCATION_PURPOSES,
  CESSION_VALUES,
  CHAR_IDS,
  FACTION_IDS,
  RESOURCE_KEYS,
  SYSTEM_ACTION_TYPES,
  type ActionType,
  type SystemActionType,
} from './types.js';

const DocId = z.string().regex(/^doc:[1-9]\d*$/).describe('document id, e.g. doc:1');
const OfferId = z.string().regex(/^offer:[1-9]\d*$/).describe('offer id, e.g. offer:2');
const CommitmentId = z.string().regex(/^cmt:[1-9]\d*$/).describe('commitment (thread) id, e.g. cmt:1');
const AuthId = z.string().regex(/^auth:[1-9]\d*$/).describe('authorization id, e.g. auth:1');
/** Secret clause ids are content ids (letters, digits, `_`, `-`); never `__proto__`-like keys. */
export const ClauseId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const CharIdSchema = z.enum(CHAR_IDS);
const ListenerSchema = z.enum([...CHAR_IDS, 'player']);
const NonNegInt = z.number().int().min(0);

/** Full term set as an actor writes it; secret clauses are referenced by id (only clauses the actor knows). */
export const TermSetArgsSchema = z
  .object({
    vassal: z.boolean(),
    filial: z.boolean(),
    cession: z.enum(CESSION_VALUES),
    annual_silk: NonNegInt,
    immediate_silk: NonNegInt,
    aid_cavalry: NonNegInt,
    aid_arrival_days: NonNegInt,
    neutrality: z.boolean(),
    marriage_alliance: z.boolean(),
    secret_clauses: z.array(ClauseId).describe('ids of secret clauses to include (only clauses you know)'),
  })
  .strict();
export type TermSetArgs = z.infer<typeof TermSetArgsSchema>;

/** Partial terms for non-binding suggestions: `null` = no change suggested for that key. */
export const TermSuggestionSchema = z
  .object({
    vassal: z.boolean().nullable(),
    filial: z.boolean().nullable(),
    cession: z.enum(CESSION_VALUES).nullable(),
    annual_silk: NonNegInt.nullable(),
    immediate_silk: NonNegInt.nullable(),
    aid_cavalry: NonNegInt.nullable(),
    aid_arrival_days: NonNegInt.nullable(),
    neutrality: z.boolean().nullable(),
    marriage_alliance: z.boolean().nullable(),
    secret_clauses: z.array(ClauseId).nullable(),
  })
  .strict();

function member<T extends ActionType, A extends z.ZodType>(type: T, args: A) {
  return z.object({ type: z.literal(type), args }).strict();
}

export const ActionArgsSchemas = {
  speak: z.object({ to: z.array(ListenerSchema).min(1), text: z.string().min(1) }).strict(),
  send_letter: z.object({ to: CharIdSchema, text: z.string().min(1) }).strict(),
  revise_document: z
    .object({ docId: DocId, baseDocVersion: z.number().int().min(1), terms: TermSetArgsSchema, note: z.string() })
    .strict(),
  suggest_revision: z
    .object({
      target: z
        .object({ kind: z.enum(['document', 'offer']), id: z.string().regex(/^(doc|offer):[1-9]\d*$/).describe('doc:N or offer:N') })
        .strict(),
      terms: TermSuggestionSchema,
      reason: z.string().min(1),
    })
    .strict(),
  approve_document: z.object({ docId: DocId, docVersion: z.number().int().min(1) }).strict(),
  set_dispatch_timing: z
    .object({
      docId: DocId,
      mode: z.enum(['now', 'delay', 'hold']),
      rounds: z.number().int().nullable().describe('rounds of delay (only for mode "delay")'),
    })
    .strict(),
  dispatch_document: z.object({ docId: DocId, docVersion: z.number().int().min(1) }).strict(),
  propose_terms: z.object({ to: CharIdSchema, terms: TermSetArgsSchema, note: z.string().nullable() }).strict(),
  respond_to_offer: z
    .object({
      offerId: OfferId,
      response: z.enum(['counter', 'reject']),
      counterTerms: TermSetArgsSchema.nullable().describe('required when response is "counter"'),
      reason: z.string(),
    })
    .strict(),
  withdraw_offer: z.object({ offerId: OfferId }).strict(),
  confirm_commitment: z
    .object({ commitmentId: CommitmentId, offerId: OfferId, termsVersion: z.number().int().min(1) })
    .strict(),
  allocate_resources: z
    .object({
      faction: z.enum(FACTION_IDS),
      resource: z.enum(RESOURCE_KEYS),
      amount: z.number().int(),
      purpose: z.enum(ALLOCATION_PURPOSES),
    })
    .strict(),
  abandon_request: z.object({ reason: z.string() }).strict(),
  revoke_authorization: z.object({ authId: AuthId }).strict(),
  wait: z.object({}).strict(),
} as const satisfies Record<ActionType, z.ZodType>;

export const ActionMemberSchemas = {
  speak: member('speak', ActionArgsSchemas.speak),
  send_letter: member('send_letter', ActionArgsSchemas.send_letter),
  revise_document: member('revise_document', ActionArgsSchemas.revise_document),
  suggest_revision: member('suggest_revision', ActionArgsSchemas.suggest_revision),
  approve_document: member('approve_document', ActionArgsSchemas.approve_document),
  set_dispatch_timing: member('set_dispatch_timing', ActionArgsSchemas.set_dispatch_timing),
  dispatch_document: member('dispatch_document', ActionArgsSchemas.dispatch_document),
  propose_terms: member('propose_terms', ActionArgsSchemas.propose_terms),
  respond_to_offer: member('respond_to_offer', ActionArgsSchemas.respond_to_offer),
  withdraw_offer: member('withdraw_offer', ActionArgsSchemas.withdraw_offer),
  confirm_commitment: member('confirm_commitment', ActionArgsSchemas.confirm_commitment),
  allocate_resources: member('allocate_resources', ActionArgsSchemas.allocate_resources),
  abandon_request: member('abandon_request', ActionArgsSchemas.abandon_request),
  revoke_authorization: member('revoke_authorization', ActionArgsSchemas.revoke_authorization),
  wait: member('wait', ActionArgsSchemas.wait),
} as const;

export const ActionSchema = z.discriminatedUnion('type', [
  ActionMemberSchemas.speak,
  ActionMemberSchemas.send_letter,
  ActionMemberSchemas.revise_document,
  ActionMemberSchemas.suggest_revision,
  ActionMemberSchemas.approve_document,
  ActionMemberSchemas.set_dispatch_timing,
  ActionMemberSchemas.dispatch_document,
  ActionMemberSchemas.propose_terms,
  ActionMemberSchemas.respond_to_offer,
  ActionMemberSchemas.withdraw_offer,
  ActionMemberSchemas.confirm_commitment,
  ActionMemberSchemas.allocate_resources,
  ActionMemberSchemas.abandon_request,
  ActionMemberSchemas.revoke_authorization,
  ActionMemberSchemas.wait,
]);
export type Action = z.infer<typeof ActionSchema>;
export type ActionOf<T extends ActionType> = Extract<Action, { type: T }>;

/** Wrapper so the union can be the root of a strict JSON schema (roots must be objects). */
export const ActionEnvelopeSchema = z.object({ action: ActionSchema }).strict();

// System outcomes: harness-internal, never LLM-facing.
export const SystemActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('mutiny_outbreak'), args: z.object({}).strict() }).strict(),
  z.object({ type: z.literal('character_death'), args: z.object({ charId: CharIdSchema }).strict() }).strict(),
  z
    .object({
      type: z.literal('allegiance_change'),
      args: z.object({ charId: CharIdSchema, faction: z.enum(FACTION_IDS) }).strict(),
    })
    .strict(),
]);
export type SystemAction = z.infer<typeof SystemActionSchema>;

// Compile-time guarantee that the schemas cover exactly the closed sets declared in types.ts.
type _ActionTypesMatch = [ActionType] extends [Action['type']]
  ? [Action['type']] extends [ActionType]
    ? true
    : never
  : never;
type _SystemTypesMatch = [SystemActionType] extends [SystemAction['type']]
  ? [SystemAction['type']] extends [SystemActionType]
    ? true
    : never
  : never;
export const ACTION_SCHEMA_CHECK: _ActionTypesMatch & _SystemTypesMatch = true;
void ACTION_TYPES;
void SYSTEM_ACTION_TYPES;

export function isSystemActionType(type: unknown): type is SystemActionType {
  return typeof type === 'string' && (SYSTEM_ACTION_TYPES as readonly string[]).includes(type);
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
}

/** H01 parse of a character/player action (valid JSON ≠ valid action). */
export function parseAction(raw: unknown): ParseResult<Action> {
  const result = ActionSchema.safeParse(raw);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: formatIssues(result.error) };
}

export function parseSystemAction(raw: unknown): ParseResult<SystemAction> {
  const result = SystemActionSchema.safeParse(raw);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: formatIssues(result.error) };
}

export function parseTermSetArgs(raw: unknown): ParseResult<TermSetArgs> {
  const result = TermSetArgsSchema.safeParse(raw);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: formatIssues(result.error) };
}
