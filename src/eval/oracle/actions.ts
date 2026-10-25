/**
 * H01 for the oracle: the closed action set of PLAN §4 (argument names as in the table) and the system outcomes of
 * §6, as independent zod schemas. Valid JSON is not a valid action: unknown keys and unknown types fail.
 */
import { z } from 'zod';

const CHAR = z.enum(['shi_jingtang', 'sang_weihan', 'liu_zhiyuan', 'yelu_deguang', 'li_congke']);
const PERSON = z.enum(['shi_jingtang', 'sang_weihan', 'liu_zhiyuan', 'yelu_deguang', 'li_congke', 'player']);
const FACTION = z.enum(['hedong', 'khitan', 'tang']);
const RESOURCE = z.enum(['grain', 'silk', 'cavalry', 'reserve_troops']);
const DOC = z.string().regex(/^doc:[1-9]\d*$/);
const OFFER = z.string().regex(/^offer:[1-9]\d*$/);
const CMT = z.string().regex(/^cmt:[1-9]\d*$/);
const INT0 = z.number().int().min(0);
const V1 = z.number().int().min(1);
const CLAUSE = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);

export const OracleTermArgs = z.strictObject({
  vassal: z.boolean(),
  filial: z.boolean(),
  cession: z.enum(['none', 'yanmen_north', 'sixteen_prefectures']),
  annual_silk: INT0,
  immediate_silk: INT0,
  aid_cavalry: INT0,
  aid_arrival_days: INT0,
  neutrality: z.boolean(),
  marriage_alliance: z.boolean(),
  secret_clauses: z.array(CLAUSE),
});

const Suggestion = z.strictObject({
  vassal: z.boolean().nullable(),
  filial: z.boolean().nullable(),
  cession: z.enum(['none', 'yanmen_north', 'sixteen_prefectures']).nullable(),
  annual_silk: INT0.nullable(),
  immediate_silk: INT0.nullable(),
  aid_cavalry: INT0.nullable(),
  aid_arrival_days: INT0.nullable(),
  neutrality: z.boolean().nullable(),
  marriage_alliance: z.boolean().nullable(),
  secret_clauses: z.array(CLAUSE).nullable(),
});

const act = <T extends string, A extends z.ZodType>(type: T, args: A) => z.strictObject({ type: z.literal(type), args });

export const OracleAction = z.discriminatedUnion('type', [
  act('speak', z.strictObject({ to: z.array(PERSON).min(1), text: z.string().min(1) })),
  act('send_letter', z.strictObject({ to: CHAR, text: z.string().min(1) })),
  act('revise_document', z.strictObject({ docId: DOC, baseDocVersion: V1, terms: OracleTermArgs, note: z.string() })),
  act(
    'suggest_revision',
    z.strictObject({
      target: z.strictObject({ kind: z.enum(['document', 'offer']), id: z.string().regex(/^(doc|offer):[1-9]\d*$/) }),
      terms: Suggestion,
      reason: z.string().min(1),
    }),
  ),
  act('approve_document', z.strictObject({ docId: DOC, docVersion: V1 })),
  act('set_dispatch_timing', z.strictObject({ docId: DOC, mode: z.enum(['now', 'delay', 'hold']), rounds: z.number().int().nullable() })),
  act('dispatch_document', z.strictObject({ docId: DOC, docVersion: V1 })),
  act('propose_terms', z.strictObject({ to: CHAR, terms: OracleTermArgs, note: z.string().nullable() })),
  act(
    'respond_to_offer',
    z.strictObject({ offerId: OFFER, response: z.enum(['counter', 'reject']), counterTerms: OracleTermArgs.nullable(), reason: z.string() }),
  ),
  act('withdraw_offer', z.strictObject({ offerId: OFFER })),
  act('confirm_commitment', z.strictObject({ commitmentId: CMT, offerId: OFFER, termsVersion: V1 })),
  act(
    'allocate_resources',
    z.strictObject({ faction: FACTION, resource: RESOURCE, amount: z.number().int(), purpose: z.enum(['intensify_siege', 'pay_troops']) }),
  ),
  act('abandon_request', z.strictObject({ reason: z.string() })),
  act('revoke_authorization', z.strictObject({ authId: z.string().regex(/^auth:[1-9]\d*$/) })),
  act('wait', z.strictObject({})),
]);
export type OAction = z.infer<typeof OracleAction>;

export const OracleSystemAction = z.discriminatedUnion('type', [
  act('mutiny_outbreak', z.strictObject({})),
  act('character_death', z.strictObject({ charId: CHAR })),
  act('allegiance_change', z.strictObject({ charId: CHAR, faction: FACTION })),
]);
export type OSystemAction = z.infer<typeof OracleSystemAction>;

export const SYSTEM_TYPES = ['mutiny_outbreak', 'character_death', 'allegiance_change'] as const;
export const ACTION_TYPE_LIST: readonly string[] = [
  'speak',
  'send_letter',
  'revise_document',
  'suggest_revision',
  'approve_document',
  'set_dispatch_timing',
  'dispatch_document',
  'propose_terms',
  'respond_to_offer',
  'withdraw_offer',
  'confirm_commitment',
  'allocate_resources',
  'abandon_request',
  'revoke_authorization',
  'wait',
];

export type Parsed = { ok: true; system: false; action: OAction } | { ok: true; system: true; action: OSystemAction } | { ok: false; error: string };

export function parseOracleAction(actor: string, raw: unknown): Parsed {
  const type = typeof raw === 'object' && raw !== null ? (raw as { type?: unknown }).type : undefined;
  if (actor === 'system' || (typeof type === 'string' && (SYSTEM_TYPES as readonly string[]).includes(type))) {
    const r = OracleSystemAction.safeParse(raw);
    return r.success ? { ok: true, system: true, action: r.data } : { ok: false, error: r.error.issues.map((i) => i.message).join('; ') };
  }
  const r = OracleAction.safeParse(raw);
  return r.success ? { ok: true, system: false, action: r.data } : { ok: false, error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
}

/** Action types whose effects are world events (speak and wait never produce one). */
export const WORLD_ACTION_TYPES: ReadonlySet<string> = new Set(ACTION_TYPE_LIST.filter((t) => t !== 'speak' && t !== 'wait'));
