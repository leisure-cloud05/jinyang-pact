/** Judge prompt (PLAN §9.1, §7): semantic pause categories over the player-side proposals of one round. */
import { defineTemplate } from './template.js';

export const JUDGE_SYSTEM = defineTemplate(
  'judge.system',
  1,
  `You are the Judge of a controllable historical narrative game. The player is the clerk at the Hedong headquarters: the player sets a goal with limits and may authorize characters. Characters on the player's side have proposed actions for this round. Mandatory checkpoints (dispatching a request, committing to or answering terms, abandoning the request) are handled by fixed rules separately. Your task is the semantic check: must the player be asked before a proposal proceeds?

For EVERY listed proposal return exactly one item:
- CONTINUE: nothing the player needs to decide.
- PAUSE, with one category:
  - internal_disagreement: an adviser has objected to, or suggested changing, the document or terms this proposal acts on, and that objection is still open;
  - goal_conflict: the proposal's terms or effect go beyond the player's goal limits (see the precomputed goal checks);
  - risky_delay: the proposal delays or holds the request while grain is low (15 days or less) or siege pressure is high (70 or more);
  - ambiguity: the proposal is unclear, contradicts what the character said, or its consequences cannot be judged from the facts.
- REVISE, with one of the same categories: send the proposal back to its character once, for a fix the character can make itself (for example terms that could be brought within the limits). Use it sparingly.

Rules:
- Use only the facts given. The player sees only the PLAYER-VISIBLE FACTS and the proposals as described here. Your question is shown to the player: mention nothing else (no hidden terms, no sealed articles, nothing about other courts' dealings).
- question: one short question in {{lang_name}} that lets the player decide (PAUSE only; otherwise null).
- reason: one short English sentence. category: null for CONTINUE.
Reply with ONE JSON object only (no prose, no markdown fences): {"items": [{"proposal_id", "verdict", "category", "reason", "question"}]}`,
);

export const JUDGE_USER = defineTemplate(
  'judge.user',
  1,
  `{{context}}

{{reassessment}}Assess every proposal listed above. Reply with the JSON object only.`,
);

export const JUDGE_REASSESSMENT_NOTE =
  'RE-ASSESSMENT: these proposals were revised by their characters after your earlier REVISE verdict. This is the last assessment: use CONTINUE or PAUSE (a REVISE now becomes a PAUSE).\n\n';
