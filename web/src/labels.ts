/** Display helpers: bilingual text, category/option labels, number formatting. */
import type { L10n, Lang } from '../../src/server/api-types';

export function t(text: L10n | null | undefined, lang: Lang): string {
  if (!text) return '';
  return lang === 'zh' ? text.zh : text.en;
}

/** Name as "中文 · English" (the other language small). */
export function both(text: L10n): string {
  return text.zh === text.en ? text.zh : `${text.zh} · ${text.en}`;
}

export function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('en-US');
}

export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined) return 'unknown';
  return `$${n.toFixed(n < 0.01 ? 5 : 4)}`;
}

export const CATEGORY_LABELS: Record<string, string> = {
  dispatch_request: 'Dispatch of the request',
  major_commitment: 'Major commitment',
  strategic_turn: 'Strategic turn',
  mutiny: 'Mutiny',
  death: 'Death',
  allegiance: 'Change of allegiance',
  negotiation_deadlock: 'Negotiation deadlock',
  internal_disagreement: 'The council disagrees',
  goal_conflict: 'Beyond your goal',
  risky_delay: 'Risky delay',
  ambiguity: 'Unclear intent',
  prompt_request: 'A character asks you',
  user_requested: 'Paused at your request',
  error_recovery: 'A call failed',
};

export const OPTION_LABELS: Record<string, { label: string; help: string }> = {
  endorse: { label: 'Endorse', help: 'Let it proceed. The harness still validates it when it commits.' },
  withhold: { label: 'Withhold', help: 'Block this proposal; your objection reaches the actor as advice. The rest of the round proceeds.' },
  amend: { label: 'Amend the draft', help: 'Revise the draft yourself. The round regenerates; editing never creates anyone’s consent.' },
  counter_draft: { label: 'Counter-draft', help: 'Withhold, and advise Shi Jingtang with counter-terms (non-binding).' },
  delegate: { label: 'Delegate', help: 'Endorse, and authorize this character to decide such matters within limits without pausing.' },
  ask: { label: 'Ask', help: 'Put a question to the actor. The pause stays open.' },
  let_it_happen: { label: 'Let it happen', help: 'Do not intervene; the outcome commits.' },
  urge_payment: { label: 'Urge payment', help: 'Urge Shi Jingtang to pay the troops; the mutiny is averted for now.' },
  adjust_goal: { label: 'Adjust your goal', help: 'Change your goal limits; a new negotiation segment opens.' },
  urge_accept: { label: 'Urge acceptance', help: 'Urge Shi Jingtang to accept what is on the table; a new segment opens.' },
  urge_stop: { label: 'Urge stopping', help: 'Urge Shi Jingtang to stop negotiating.' },
  resume: { label: 'Resume', help: 'Continue the story.' },
  retry: { label: 'Retry', help: 'Try the failed call again.' },
  skip_actor: { label: 'Skip this character', help: 'Treat the character as waiting this round.' },
  stop: { label: 'Stop the run', help: 'End the session here (run outcome: error).' },
};

export const STATUS_TONE: Record<string, string> = {
  committed: 'ok',
  rejected: 'bad',
  withheld: 'warn',
  stale_epoch: 'muted',
  obsolete: 'muted',
  format_error: 'bad',
  unapplied: 'bad',
  pending: 'info',
  open: 'info',
  resolved: 'ok',
};

export const TERMINAL_LABELS: Record<string, L10n> = {
  pact_concluded: { zh: '盟约成立', en: 'The pact is concluded' },
  jinyang_falls: { zh: '晋阳陷落', en: 'Jinyang falls' },
  no_assistance: { zh: '不求外援', en: 'No foreign assistance' },
  talks_failed: { zh: '和议不成', en: 'The talks failed' },
};

export const CONTROL_LABELS: Record<string, string> = {
  starting: 'Starting…',
  running: 'The council deliberates…',
  awaiting_player: 'Your turn',
  awaiting_decision: 'Your decision is needed',
  suspended: 'Suspended',
  finished: 'Chapter ended',
  stopped: 'Stopped',
  error: 'Error',
  unavailable: 'Read-only (needs a live server)',
};
