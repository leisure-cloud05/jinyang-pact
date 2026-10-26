/** Request body / query schemas of the play API (zod; unknown keys are refused). */
import { z } from 'zod';
import { TermSetArgsSchema } from '../core/actions.js';
import { AuthorizationGrantSchema, DecisionOptionSchema, TermLimitsSchema } from '../content/schema.js';
import { CHAR_IDS } from '../core/types.js';

export const RequestIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'requestId: letters, digits and . _ : - only');

const Wait = z.number().int().min(0).max(120_000).optional();
/** The awaited player turn (`control.turn`): binds an input to the turn it was made in. */
const TurnToken = z.string().min(1).max(64);

export const CreateSessionSchema = z.strictObject({
  requestId: RequestIdSchema,
  caseId: z.string().min(1).max(64),
  mode: z.enum(['full', 'no_judge', 'baseline']).default('full'),
  lang: z.enum(['zh', 'en']).optional(),
  llm: z.enum(['mock', 'live']).optional(),
  script: z.boolean().default(false),
  director: z.boolean().default(false),
  wait: Wait,
});

const Text = z.string().trim().min(1).max(2000);
const Listener = z.enum(CHAR_IDS);

export const InputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    requestId: RequestIdSchema,
    turn: TurnToken,
    kind: z.literal('action'),
    action: z.strictObject({ type: z.string().min(1), args: z.record(z.string(), z.unknown()) }),
    wait: Wait,
  }),
  z.strictObject({ requestId: RequestIdSchema, turn: TurnToken, kind: z.literal('dialogue'), to: z.array(Listener).min(1).max(5), text: Text, wait: Wait }),
  z.strictObject({ requestId: RequestIdSchema, turn: TurnToken, kind: z.literal('text'), text: Text, wait: Wait }),
]);

/** Like the content AmendSchema, but the document is named by the alias the player was shown (resolved server-side). */
const AmendSchema = z.strictObject({
  docId: z.string().min(1).max(64),
  baseDocVersion: z.union([z.number().int().min(1), z.literal('$current')]),
  terms: TermSetArgsSchema,
  note: z.string().default(''),
});

export const DecisionSchema = z.strictObject({
  requestId: RequestIdSchema,
  pauseId: z.string().min(1).max(200),
  option: DecisionOptionSchema,
  advice: z.string().max(2000).nullable().optional(),
  /** `ask` only: whom to ask (one of the pause's `askable` characters; default: the paused actor). */
  to: Listener.nullable().optional(),
  authorization: AuthorizationGrantSchema.nullable().optional(),
  goalLimits: TermLimitsSchema.nullable().optional(),
  amend: AmendSchema.nullable().optional(),
  counterTerms: TermSetArgsSchema.nullable().optional(),
  wait: Wait,
});

export const InterruptSchema = z.strictObject({ requestId: RequestIdSchema, text: Text, wait: Wait });
/** Ending a turn needs its token; resuming a suspended run does not. */
export const AdvanceSchema = z.strictObject({ requestId: RequestIdSchema, turn: TurnToken.nullable().optional(), wait: Wait,
  extendBudget: z.strictObject({ addCalls: z.number().int().min(0).max(200), addUsd: z.number().min(0).max(2) }).optional(),
});
export const SaveSchema = z.strictObject({
  requestId: RequestIdSchema,
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9 ._-]+$/, 'checkpoint names: letters, digits, space and . _ -'),
  exportAudit: z.boolean().default(false),
});
export const BranchSchema = z
  .strictObject({
    requestId: RequestIdSchema,
    round: z.number().int().min(1).optional(),
    checkpoint: z.string().min(1).max(64).optional(),
    wait: Wait,
  })
  .refine((b) => (b.round === undefined) !== (b.checkpoint === undefined), 'give exactly one of round or checkpoint');
export const ReplaySchema = z.strictObject({ requestId: RequestIdSchema, mode: z.enum(['patch', 'rederive']) });
export const RegenerateSchema = z.strictObject({ requestId: RequestIdSchema, batchId: z.string().min(1).max(200), scene: z.string().min(1).max(64).optional() });
export const DirectorSchema = z.strictObject({ requestId: RequestIdSchema });
