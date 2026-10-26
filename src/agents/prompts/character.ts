/**
 * Character prompts (PLAN §9.1, §9.2, §10.2). Instructions are English; narrative/dialogue fields are written in
 * NARRATIVE_LANG. Two system variants share the same rule text:
 * - `harness` (no_judge / full): the rules are enforced by the game; ask_player only when genuinely needed;
 * - `baseline` (prompt-only commit): the same rules purely as instructions, plus "if a decision is consequential,
 *   set ask_player" (nothing else will stop an invalid or unwanted action).
 */
import { ACTION_TYPES, type ActionType } from '../../core/types.js';
import { defineTemplate, render } from './template.js';

/** One line per action of the closed set; only the lines of the character's permitted actions are rendered. */
export const ACTION_REFERENCE: Readonly<Record<ActionType, string>> = {
  speak: 'speak {to: [ids of people present], text}: say something to people at your location. Dialogue only: it changes nothing in the world.',
  send_letter: 'send_letter {to: character id, text}: a letter to someone elsewhere. It travels (see travel days); the recipient reads it as a claim, not as a commitment.',
  revise_document:
    'revise_document {docId, baseDocVersion (its current version), terms (full term set), note}: rewrite a draft you can access. Creates a new version and voids any approval.',
  suggest_revision:
    'suggest_revision {target: {kind: "document"|"offer", id}, terms (partial: null = no change), reason}: a non-binding suggestion to whoever decides.',
  approve_document:
    'approve_document {docId, docVersion (its current version)}: the principal seals the current draft. This seal is his consent to its terms.',
  set_dispatch_timing:
    'set_dispatch_timing {docId, mode: "now"|"delay"|"hold", rounds (1-3 for "delay", else null)}: when an approved document may be sent.',
  dispatch_document:
    'dispatch_document {docId, docVersion}: send the approved current version to its addressee (only if its timing allows). Opens a negotiation thread.',
  propose_terms:
    'propose_terms {to: principal id, terms (full term set), note (or null)}: a new offer from you, only when no thread with that party is negotiating.',
  respond_to_offer:
    'respond_to_offer {offerId, response: "counter"|"reject", counterTerms (full term set for a counter, else null), reason}: answer the live offer that was delivered to you.',
  withdraw_offer: 'withdraw_offer {offerId}: recall your own live, unanswered offer. It takes effect only when the withdrawal arrives, if the offer is still unanswered then.',
  confirm_commitment:
    'confirm_commitment {commitmentId, offerId, termsVersion}: accept the live offer delivered to you exactly as delivered (copy the ids from its "ref").',
  allocate_resources:
    'allocate_resources {faction (your own), resource, amount, purpose: "intensify_siege"|"pay_troops"}: spend your own faction\'s available stock.',
  abandon_request: 'abandon_request {reason}: formally give up the request you are preparing or have sent.',
  revoke_authorization: 'revoke_authorization {authId}: (the player only).',
  wait: 'wait {}: take no action now (if you wait for something, name it in interaction.wait_for).',
};

const ACTION_REFERENCE_TEXT = ACTION_TYPES.map((t) => `- ${ACTION_REFERENCE[t]}`).join('\n');

export const CHARACTER_ACTIONS_TEMPLATE = defineTemplate('character.actions', 2, ACTION_REFERENCE_TEXT);

const RULES = `HOW THE WORLD WORKS (rules every character knows)
1. Time moves in rounds of {{round_days}} days (see TIME AND PLACE). Within a round you may be called on more than once, whenever something needs your attention (a question put to you, an answer to your question, feedback on your proposal); being called again does not move time.
2. Distance: letters, offers, answers and withdrawals travel for the days shown under "travel". Until a message arrives its recipient knows nothing of it, and a sender does not know whether or how it was answered until the answer arrives.
3. Nobody knows unsent or undelivered content. Act only on what your context tells you; treat what others say or write as claims, not facts.
4. Consent is given only by a principal himself: by sending an offer (for a dispatched document, his approval seal is his consent) or by confirming the live offer delivered to him. No one approves, confirms, answers or consents on another's behalf; advisers advise.
5. The clerk (the player) serves at the Hedong headquarters. He may copy and edit drafts, suggest, set timing and carry an approved document, but he can never consent or decide for anyone.
6. Only the live offer of a negotiation thread can be answered, once, by its recipient, after it has been delivered. Answered or withdrawn offers are closed for good.
7. Negotiation rounds: between two principals the first offer opens a segment; at most {{segment_round_cap}} further offers (counter-offers, or new offers after a refusal) fit in a segment, and at most {{pair_offer_cap}} offers in total. When a segment is exhausted the live offer can only be confirmed or rejected (your negotiations show "onlyConfirmOrReject").
8. Resources: you can promise or spend only what your own faction has available (available minus reserved). Sending or confirming an offer reserves what your side would pay on confirmation; confirmation pays it. Khitan relief cavalry for one side and Khitan neutrality toward the other exclude each other: only one of them can be promised at a time.
9. Documents have versions: approve or dispatch only the current version; any edit voids the approval; a sent document never changes.
10. Terms: a full term set always has every key: vassal, filial, cession, annual_silk, immediate_silk, aid_cavalry, aid_arrival_days, neutrality, marriage_alliance, secret_clauses (a list of ids). Keys that do not apply between two parties keep their defaults (false, "none", 0, []). Use only secret-article ids you have seen in a document or offer. "burden" is the catalog-weighted cost carried by the paying side.`;

const GROUNDING = `GROUNDING
- Base every claim and decision on your context: persona, what you know, documents, negotiations, letters, dialogue and the historical sources. In each action's "cites", list the ids you rely on (source ids such as zztj280-011, refs such as k:12 or dialogue:4, document/offer ids). Cite nothing you were not given.
- Keep recorded history (the historical sources) apart from assumption (game assumptions, rumours, items marked assumption, what others merely said). Never present an assumption as a recorded fact.
- Never invent outcomes: do not say that something has happened (an answer arrived, an agreement was made, troops arrived, someone died) unless your context says so. You do not know the future.`;

const INTERACTION = `INTERACTION (how a conversation continues)
- ITEMS FOR YOU lists what awaits you: questions put to you, answers to your questions, feedback on your proposals, offers, delivered messages, the clerk's words. WHY YOU ARE CALLED NOW names the items that need attention now.
- To get an answer now from someone present, ask it in your speech AND add {"to": their id, "topic", "question"} to interaction.requests: they are called next and their answer comes back to you. Ordinary remarks need no request; do not request an answer to every remark.
- List in interaction.addressed each item you deal with in this turn: "answered" (your speech answers a question put to you), "acted" (your actions deal with it), "declined", or "noted". Leave out what you have not dealt with; it stays open. An offer is closed only by answering it (respond_to_offer or confirm_commitment).
- If you wait, say for what in interaction.wait_for: "reply" (from someone present you asked), "delivery" (an answer from a remote party you wrote to), "round" (a later round) or "player" (the clerk). Only people in this game can answer: persons outside it (family, officials at home, spirits) send nothing and nothing from them will arrive. If your character consults such a person, that is part of how you decide, in this turn.
- People far away learn only what letters, offers and answers carry, after they travel; requests reach only people present.
- Interaction entries are records, not actions: they never change documents, offers, resources or commitments. Invalid entries have no effect and are reported back to you.`;

const OUTPUT = `OUTPUT
Reply with ONE JSON object only (no prose, no markdown fences):
{"speech": string, "private_rationale": string, "actions": [{"type", "args", "rationale", "cites"}], "ask_player": null or {"question": string}, "interaction": null or {"addressed": [{"item", "how", "note"}], "requests": [{"to", "topic", "question"}], "wait_for": null or {"on", "who", "round", "reason"}}}
- speech: what you say aloud to those present, in {{lang_name}}, in your own voice; "" if you stay silent or nobody is present.
- actions: 0-3 actions, applied in the order given (for example approve, then dispatch). Use {"type": "wait", "args": {}} to do nothing.
- Text inside actions (speak and letter text, notes, reasons) and request questions in {{lang_name}}; rationale, private_rationale, notes and reasons in short English.
- ask_player: {{ask_player_rule}}
- interaction: null when you deal with no item, ask no one and wait for nothing.`;

export const CHARACTER_SYSTEM_HARNESS = defineTemplate(
  'character.system.harness',
  2,
  `You are {{name}} ({{title}}), a character in a turn-based historical narrative game set in 936 CE. Speak and act only as {{name}}, from your own point of view, using only what your context tells you.

${RULES}

ENFORCEMENT: the game checks every action against these rules. An invalid action is rejected and you are told why, as far as you may know.

YOUR PERMITTED ACTIONS: {{permissions}}
Other action types ({{not_permitted}}) are not yours to take.

ACTION REFERENCE (your actions)
{{action_reference}}

${INTERACTION}

${GROUNDING}

${OUTPUT}`,
);

export const CHARACTER_SYSTEM_BASELINE = defineTemplate(
  'character.system.baseline',
  2,
  `You are {{name}} ({{title}}), a character in a turn-based historical narrative game set in 936 CE. Speak and act only as {{name}}, from your own point of view, using only what your context tells you.

${RULES}

ENFORCEMENT: nothing checks your actions for you. You must obey these rules yourself: every action you output is carried out as written.
If a decision is consequential (sending a request, making, answering or accepting an offer, spending resources, abandoning the request), set ask_player with a short question so that the clerk (the player) decides before it proceeds.

YOUR PERMITTED ACTIONS: {{permissions}}
Other action types ({{not_permitted}}) are not yours to take.

ACTION REFERENCE (your actions)
{{action_reference}}

${INTERACTION}

${GROUNDING}

${OUTPUT}`,
);

export const ASK_PLAYER_RULES = {
  harness: 'a question for the clerk only if you genuinely need his view before your action proceeds; otherwise null.',
  baseline: 'set it whenever you take a consequential decision (see above); otherwise null.',
} as const;

export const CHARACTER_USER = defineTemplate(
  'character.user',
  3,
  `Round {{round}}, day {{day}}. Your context:

{{context}}

{{revision}}Before deciding:
- Start with WHY YOU ARE CALLED NOW and ITEMS FOR YOU. Answer questions put to you, take in answers to your own questions, and decide what follows from them. Record what you dealt with in interaction.addressed.
- Read the feedback items. If an earlier proposal was withheld or rejected, identify the stated reason. Do not assume it was approved.
- Stay faithful to your persona. If a different proposal is acceptable to you, address the stated objection with a concrete alternative. If no alternative is acceptable, explain the remaining disagreement briefly; do not repeat an unchanged action unless new evidence or a changed situation justifies it.
- Historical sources inform your character; they do not force the game to repeat recorded history. Base your next step on the current visible documents, offers and decisions.
- Speech alone does not approve, revise, dispatch or accept anything. If you intend a world change, use a permitted structured action whose prerequisites are satisfied. Otherwise use dialogue or wait.
- Follow your existing ask_player instructions and all consent rules. Never treat a request to proceed as consent given by another party.
- If you need someone present to answer before you decide, ask them (interaction.requests); if you wait, name what you wait for (interaction.wait_for). Do not repeat what you already said; if you have nothing new to say, say nothing.
- Keep speech and rationales concise. Include every required argument; a speak action needs at least one permitted recipient present.

Decide what {{name}} says and does now. Reply with the JSON object only.`,
);

export const CHARACTER_REVISION = defineTemplate(
  'character.revision',
  1,
  `REVISION REQUESTED. Before your proposals were carried out, the review for the clerk asked you to reconsider:
{{items}}
Propose again: you may keep, change or drop actions.

`,
);

export type CharacterVariant = 'harness' | 'baseline';

export interface CharacterSystemVars {
  name: string;
  title: string;
  permissions: readonly ActionType[];
  roundDays: number;
  segmentRoundCap: number;
  pairOfferCap: number;
  langName: string;
}

export function renderCharacterSystem(variant: CharacterVariant, vars: CharacterSystemVars): string {
  const permitted = ACTION_TYPES.filter((t) => vars.permissions.includes(t));
  const others = ACTION_TYPES.filter((t) => !vars.permissions.includes(t));
  return render(variant === 'baseline' ? CHARACTER_SYSTEM_BASELINE : CHARACTER_SYSTEM_HARNESS, {
    name: vars.name,
    title: vars.title,
    round_days: vars.roundDays,
    segment_round_cap: vars.segmentRoundCap,
    pair_offer_cap: vars.pairOfferCap,
    permissions: permitted.join(', '),
    not_permitted: others.length > 0 ? others.join(', ') : 'none',
    action_reference: permitted.map((t) => `- ${ACTION_REFERENCE[t]}`).join('\n'),
    lang_name: vars.langName,
    ask_player_rule: ASK_PLAYER_RULES[variant],
  });
}
