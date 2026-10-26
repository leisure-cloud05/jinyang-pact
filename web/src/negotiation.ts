/**
 * Negotiation track helpers (谈判拉锯): stage labels, where the talks stand, a caption for the road, and what each
 * counter-offer changed. Everything comes from `StateView.negotiationTrack`, i.e. what the clerk knows.
 */
import type { CatalogView, Lang, NegotiationTrackView, OfferCardView, OfferStage, TermsView } from '../../src/server/api-types.js';
import { t, termValueText } from './labels.js';

export const STAGE_LABELS: Record<OfferStage, string> = {
  proposed: 'Proposed',
  awaiting: 'Awaiting reply',
  received: 'Counter-offer received',
  countered: 'Countered',
  confirmed: 'Both confirmed',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

export const STAGE_TONE: Record<OfferStage, string> = {
  proposed: 'info',
  awaiting: 'info',
  received: 'warn',
  countered: 'muted',
  confirmed: 'ok',
  rejected: 'bad',
  withdrawn: 'muted',
};

/** The steps a round of talks goes through, as the clerk follows them. */
export const TALK_STEPS = ['proposed', 'awaiting', 'received', 'confirmed'] as const satisfies readonly OfferStage[];

/** Index in `TALK_STEPS` of where the talks stand (-1: nothing sent yet, or the talks ended without agreement). */
export function talkStep(last: OfferCardView | undefined): number {
  if (!last) return -1;
  if (last.stage === 'countered') return TALK_STEPS.indexOf('received');
  return (TALK_STEPS as readonly OfferStage[]).indexOf(last.stage);
}

/** One sentence on where the last letter is, worded by what the clerk can know. */
export function trackCaption(track: NegotiationTrackView): string {
  const last = track.cards.at(-1);
  const far = track.far.name.en;
  const near = track.near.name.en;
  if (!last) return `No letter has gone to ${far} yet. A courier needs ${track.travelDays} days each way.`;
  const v = `v${last.termsVersion}`;
  const said: Record<OfferStage, string> = {
    proposed: `${v} is on the road to ${track.far.place.en}: due there on day ${last.dueDay ?? '?'} by the courier’s schedule.`,
    awaiting: `By the courier’s schedule ${v} reached ${track.far.place.en} on day ${last.dueDay ?? '?'}. No reply has reached headquarters yet.`,
    received: `${far}’s counter-offer ${v} reached headquarters on day ${last.sinceDay}. It is for ${near} to answer.`,
    countered: `${v} was answered with a counter-offer.`,
    confirmed: `Both sides confirmed ${v}.`,
    rejected: last.direction === 'out' ? `${far} rejected ${v}; the reply reached headquarters on day ${last.statusDay ?? '?'}.` : `${near} rejected ${far}’s ${v}.`,
    withdrawn: `${v} was withdrawn.`,
  };
  const withdrawal = last.withdrawal === 'pending' ? ' A withdrawal is on its way.' : last.withdrawal === 'late' ? ' The withdrawal came too late.' : '';
  return said[last.stage] + withdrawal;
}

export interface TermChange {
  key: string;
  label: string;
  from: string;
  to: string;
}

/** What `after` changed against `before` (terms the clerk knows on both sides; empty if either is unknown). */
export function termChanges(before: TermsView | null, after: TermsView | null, catalog: CatalogView, lang: Lang): TermChange[] {
  if (!before || !after) return [];
  const a = before as unknown as Record<string, unknown>;
  const b = after as unknown as Record<string, unknown>;
  const out: TermChange[] = catalog.terms
    .filter((e) => a[e.key] !== b[e.key])
    .map((e) => ({ key: e.key, label: t(e.label, lang), from: termValueText(e, a[e.key], lang), to: termValueText(e, b[e.key], lang) }));
  const ids = (x: TermsView): string[] => x.secret_clauses.map((c) => c.id);
  const article = lang === 'zh' ? '密约' : 'Secret article';
  for (const c of after.secret_clauses) if (!ids(before).includes(c.id)) out.push({ key: c.id, label: article, from: '—', to: t(c.text, lang) });
  for (const c of before.secret_clauses) if (!ids(after).includes(c.id)) out.push({ key: c.id, label: article, from: t(c.text, lang), to: '—' });
  return out;
}
