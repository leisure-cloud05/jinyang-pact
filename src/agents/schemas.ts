/**
 * LLM-facing output contracts of the four roles (PLAN §9.1). Every key is required in strict mode, so optional
 * values are `.nullable()`. The character's action items reuse the core closed-set argument schemas
 * (`ActionArgsSchemas`), so valid output here is exactly a valid H01 action shape plus rationale and cites.
 * The full closed set is offered to every character (the prompt states its permissions): permission (H02) and
 * every other rule are the harness's to enforce, and baseline runs need to be able to show violations.
 */
import { z } from 'zod';
import { ActionArgsSchemas } from '../core/actions.js';
import { CHAR_IDS } from '../core/types.js';

const Rationale = z.string().describe('one short English sentence: why this action');
const Cites = z.array(z.string()).describe('ids from your context that ground this action (source ids, refs, doc/offer ids)');

function item<T extends keyof typeof ActionArgsSchemas>(type: T) {
  return z.object({ type: z.literal(type), args: ActionArgsSchemas[type], rationale: Rationale, cites: Cites }).strict();
}

export const CharacterActionItemSchema = z.discriminatedUnion('type', [
  item('speak'),
  item('send_letter'),
  item('revise_document'),
  item('suggest_revision'),
  item('approve_document'),
  item('set_dispatch_timing'),
  item('dispatch_document'),
  item('propose_terms'),
  item('respond_to_offer'),
  item('withdraw_offer'),
  item('confirm_commitment'),
  item('allocate_resources'),
  item('abandon_request'),
  item('revoke_authorization'),
  item('wait'),
]);
export type CharacterActionItem = z.infer<typeof CharacterActionItemSchema>;

export const MAX_CHARACTER_ACTIONS = 3;

export const CharacterOutputSchema = z
  .object({
    speech: z.string().describe('what you say aloud to everyone present this turn, in character; "" if nothing'),
    private_rationale: z.string().describe('your private reasoning in 1-3 short English sentences (never shown to others)'),
    actions: z.array(CharacterActionItemSchema).max(MAX_CHARACTER_ACTIONS).describe('0-3 actions, applied in order'),
    ask_player: z
      .object({ question: z.string().min(1) })
      .strict()
      .nullable()
      .describe('a question for the clerk (the player) before your consequential action proceeds, or null'),
  })
  .strict();
export type CharacterOutput = z.infer<typeof CharacterOutputSchema>;

export const JUDGE_VERDICTS = ['CONTINUE', 'PAUSE', 'REVISE'] as const;
export type JudgeVerdictKind = (typeof JUDGE_VERDICTS)[number];
export const JUDGE_CATEGORIES = ['internal_disagreement', 'goal_conflict', 'risky_delay', 'ambiguity'] as const;
export type SemanticCategory = (typeof JUDGE_CATEGORIES)[number];

export const JudgeOutputSchema = z
  .object({
    items: z.array(
      z
        .object({
          proposal_id: z.string(),
          verdict: z.enum(JUDGE_VERDICTS),
          category: z.enum(JUDGE_CATEGORIES).nullable().describe('null when the verdict is CONTINUE'),
          reason: z.string().describe('short English reason'),
          question: z.string().nullable().describe('question for the player (PAUSE only), in the narrative language'),
        })
        .strict(),
    ),
  })
  .strict();
export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;

export const NarratorOutputSchema = z
  .object({
    prose: z.string().min(1).describe('the scene prose, without any numbers or quantities'),
    mentioned_facts: z.array(z.number().int().min(0)).describe('indexes of the listed facts the prose mentions'),
  })
  .strict();
export type NarratorOutput = z.infer<typeof NarratorOutputSchema>;

/** Actions the mapper may produce: the player's closed set (further filtered by the configured permissions). */
export const MAPPER_ACTION_TYPES = [
  'speak',
  'revise_document',
  'suggest_revision',
  'set_dispatch_timing',
  'dispatch_document',
  'revoke_authorization',
  'wait',
] as const;

function playerMember<T extends (typeof MAPPER_ACTION_TYPES)[number]>(type: T) {
  return z.object({ type: z.literal(type), args: ActionArgsSchemas[type] }).strict();
}

export const MapperActionSchema = z.discriminatedUnion('type', [
  playerMember('speak'),
  playerMember('revise_document'),
  playerMember('suggest_revision'),
  playerMember('set_dispatch_timing'),
  playerMember('dispatch_document'),
  playerMember('revoke_authorization'),
  playerMember('wait'),
]);

export const MAPPER_KINDS = ['action', 'dialogue', 'clarify', 'unsupported'] as const;
export type MapperKind = (typeof MAPPER_KINDS)[number];

export const MapperOutputSchema = z
  .object({
    kind: z.enum(MAPPER_KINDS),
    action: MapperActionSchema.nullable().describe('the structured action when kind is "action", else null'),
    dialogue: z
      .object({ to: z.array(z.enum([...CHAR_IDS])).min(1), text: z.string().min(1) })
      .strict()
      .nullable()
      .describe('speech to characters when kind is "dialogue", else null'),
    question: z.string().nullable().describe('clarifying question when kind is "clarify"'),
    reason: z.string().nullable().describe('why the command is unsupported, when kind is "unsupported"'),
  })
  .strict();
export type MapperOutput = z.infer<typeof MapperOutputSchema>;

/** Every agent output schema with its strict-schema name (for round-trip tests, the smoke CLI and freezing). */
/** In-character answer to the player's `ask` during a pause (PLAN §7): speech only, no actions. */
export const AnswerOutputSchema = z.object({ speech: z.string().max(1200) }).strict();
export type AnswerOutput = z.infer<typeof AnswerOutputSchema>;

export const AGENT_SCHEMAS = {
  character: { name: 'character_turn', schema: CharacterOutputSchema },
  judge: { name: 'judge_verdicts', schema: JudgeOutputSchema },
  narrator: { name: 'scene_narration', schema: NarratorOutputSchema },
  mapper: { name: 'player_command', schema: MapperOutputSchema },
  answer: { name: 'character_answer', schema: AnswerOutputSchema },
} as const;
