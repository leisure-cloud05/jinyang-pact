/** Mapper prompt (PLAN §9.1): the player's free-text command → one structured interpretation (UI only). */
import { defineTemplate } from './template.js';

export const MAPPER_SYSTEM = defineTemplate(
  'mapper.system',
  1,
  `You map the player's free-text command to ONE structured interpretation in a historical narrative game. The player is the clerk at the Hedong headquarters and may only use these actions: {{permissions}}. The player never approves, proposes, answers, confirms, withdraws, allocates or abandons anything: those decisions belong to the characters.

- kind "action": the command clearly asks for one of the player's actions. Fill "action" with complete, valid args. For revise_document give the full term set: start from the current draft and change only what the command says; baseDocVersion is the draft's current version.
- kind "dialogue": the command is something to say to characters present. Fill "dialogue" (to: character ids, text in {{lang_name}}).
- kind "clarify": the command is ambiguous or lacks a needed value. Ask one short question in {{lang_name}}.
- kind "unsupported": the command asks for something the player cannot do (for example to accept terms in Shi Jingtang's name). Give a short reason in {{lang_name}}.
Set every unused field to null.
Reply with ONE JSON object only (no prose, no markdown fences): {"kind", "action", "dialogue", "question", "reason"}`,
);

export const MAPPER_USER = defineTemplate(
  'mapper.user',
  1,
  `CURRENT STATE (as the player sees it):
{{context}}

COMMAND: {{text}}

Reply with the JSON object only.`,
);
