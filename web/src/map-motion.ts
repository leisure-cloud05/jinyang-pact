import type { DraftView, OfferCardView, WorldView } from '../../src/server/api-types.js';

/** Schematic courier route; coordinates are illustrative, not geographic measurements. */
export const COURIER_ROUTE = [[100, 265], [200, 205], [310, 180], [440, 100], [530, 65]] as const;

export function routePoint(progress: number): { x: number; y: number } {
  const p = Math.min(1, Math.max(0, progress)) * (COURIER_ROUTE.length - 1);
  const index = Math.min(COURIER_ROUTE.length - 2, Math.floor(p));
  const a = COURIER_ROUTE[index]!;
  const b = COURIER_ROUTE[index + 1]!;
  return { x: a[0] + (b[0] - a[0]) * (p - index), y: a[1] + (b[1] - a[1]) * (p - index) };
}

export interface ReliefPlan { cavalry: number; arrivalDay: number; confirmedDay: number }

/** The chapter ends at agreement. This projects known terms, never an observed arrival. */
export function reliefPlan(card: OfferCardView | undefined, terminal: WorldView['terminal']): ReliefPlan | null {
  if (terminal?.kind !== 'pact_concluded' || card?.stage !== 'confirmed' || !card.terms || card.terms.aid_cavalry <= 0) return null;
  const { confirmedDay, khitanArrivalDay } = terminal.detail;
  if (typeof confirmedDay !== 'number' || typeof khitanArrivalDay !== 'number' || !Number.isFinite(confirmedDay) || !Number.isFinite(khitanArrivalDay) || khitanArrivalDay < confirmedDay) return null;
  return { cavalry: card.terms.aid_cavalry, confirmedDay, arrivalDay: khitanArrivalDay };
}

export interface MapSnapshot {
  cards: OfferCardView[];
  draft?: Pick<DraftView, 'docId' | 'version'> | null;
  relief: ReliefPlan | null;
}

export interface MapScene {
  kind: 'draft' | 'seal' | 'courier' | 'confirmation' | 'closed' | 'relief';
  card?: OfferCardView;
  from: number;
  to: number;
  title: string;
  duration: number;
  /** Local departure from headquarters to the gate, without advancing game time. */
  departure?: boolean;
  relief?: ReliefPlan;
}

export function letterScenes(card: OfferCardView, before?: OfferCardView): MapScene[] {
  const scenes: MapScene[] = [];
  const fresh = !before;
  const reply = card.direction === 'out' && ['confirmed', 'rejected', 'countered'].includes(card.stage);
  const from = reply ? 1 : before?.position ?? (card.direction === 'out' ? 0 : 1);
  const to = reply ? 0 : card.position;
  if (fresh && card.direction === 'out') scenes.push({ kind: 'seal', card, from: 0, to: 0, title: 'Sealing the request', duration: 650 });
  const moving = fresh || from !== to || reply;
  if (moving) scenes.push({ kind: 'courier', card, from, to, duration: 1700,
    departure: fresh && card.direction === 'out' && to === 0 && !reply,
    title: reply ? 'A reply reaches Jinyang' : card.direction === 'in' ? 'A counter-offer reaches Jinyang' : to === 0 ? 'The courier leaves headquarters' : 'Courier progress · estimated from the schedule',
  });
  if (card.stage === 'confirmed') scenes.push({ kind: 'confirmation', card, from: 0, to: 0, title: 'Agreement confirmed', duration: 1100 });
  else if (card.stage === 'rejected' || card.stage === 'withdrawn') scenes.push({ kind: 'closed', card, from: to, to, title: card.stage === 'rejected' ? 'The proposal was rejected' : 'The proposal was withdrawn', duration: 1000 });
  else if (!moving) scenes.push({ kind: 'courier', card, from, to, title: card.withdrawal === 'pending' ? 'Withdrawal sent · awaiting a response' : 'Negotiation updated', duration: 1000 });
  return scenes;
}

/** Compare visible snapshots only; unchanged polling results never replay an event. */
export function mapScenes(before: MapSnapshot, next: MapSnapshot): MapScene[] {
  const scenes: MapScene[] = [];
  if (next.draft && before.draft && (next.draft.docId !== before.draft.docId || next.draft.version !== before.draft.version)) {
    scenes.push({ kind: 'draft', card: next.cards.at(-1), from: 0, to: 0, title: 'Draft revised · awaiting dispatch', duration: 1000 });
  }
  const fresh = next.cards.filter((c) => !before.cards.some((old) => old.offerId === c.offerId));
  if (fresh.length) {
    for (const card of fresh) scenes.push(...letterScenes(card));
  } else {
    const card = next.cards.at(-1);
    const old = before.cards.find((c) => c.offerId === card?.offerId);
    if (card && (!old || card.stage !== old.stage || card.position !== old.position || card.withdrawal !== old.withdrawal || card.termsVersion !== old.termsVersion)) scenes.push(...letterScenes(card, old));
  }
  if (next.relief && JSON.stringify(before.relief) !== JSON.stringify(next.relief)) scenes.push({ kind: 'relief', card: next.cards.at(-1), from: 1, to: 0, title: 'Projected relief route · after the chapter', duration: 2600, relief: next.relief });
  return scenes;
}
