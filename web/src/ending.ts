/**
 * Ending CG (结局演出): the scene, title and lines each ending gets, and a result summary built from what the clerk
 * knows when the chapter ends (the negotiation track and the siege at headquarters). The copy is fixed and reviewed:
 * no model call at the end, and nothing the clerk does not know is shown or implied.
 */
import type { NegotiationTrackView, OfferCardView, SiegeLevels, StateView } from '../../src/server/api-types.js';
import { fmt } from './labels.js';
import { STAGE_LABELS } from './negotiation.js';

export type EndingKind = 'pact_concluded' | 'jinyang_falls' | 'no_assistance' | 'talks_failed';

export interface EndingSpec {
  title: string;
  /** Description of the illustration (alt text). */
  alt: string;
  /** Camera of the main scene: push in towards the subject, or pull back from it. */
  camera: 'push' | 'pull';
  /** Label over a scene that shows a possible future rather than something that happened in the chapter. */
  epilogue: string | null;
  /** Button that closes the CG to look back at the chapter. */
  review: string;
}

export const ENDINGS: Record<EndingKind, EndingSpec> = {
  pact_concluded: {
    title: 'A Pact at a Price',
    alt: 'From the walls of Jinyang at dawn, an official watches cavalry and banners appear on the horizon through the dust.',
    camera: 'push',
    epilogue: 'Epilogue · A possible future',
    review: 'Review the pact',
  },
  jinyang_falls: {
    title: 'Jinyang Falls',
    alt: 'Jinyang seen from afar: fires behind the walls, smoke over the city, a breach, ladders and torn banners.',
    camera: 'push',
    epilogue: null,
    review: 'Review decisions',
  },
  no_assistance: {
    title: 'Standing Alone',
    alt: 'The gate of Jinyang at dusk under a new moon: lamps still burn on the walls, and the road outside is empty.',
    camera: 'pull',
    epilogue: null,
    review: 'Review decisions',
  },
  talks_failed: {
    title: 'The Road Closes',
    alt: 'A returned letter lies on the desk; through the open door the envoy walks away into the mist.',
    camera: 'pull',
    epilogue: null,
    review: 'Review decisions',
  },
};

/** Phase lengths in ms: the map's last move, into the illustration, the main scene, the ending card fading in. */
export const ENDING_TIMELINE = { map: 1800, enter: 1000, scene: 4500, card: 2000 } as const;

/**
 * Generated illustrations: a 16:9 WebP without any text, saved as `web/public/endings/<kind>.webp` and listed here,
 * e.g. `pact_concluded: '/endings/pact_concluded.webp'`. Until a kind is listed, or if its file fails to load, the
 * vector scene is shown.
 */
export const ENDING_ART: Partial<Record<EndingKind, string>> = {};

export function isEndingKind(kind: string): kind is EndingKind {
  return Object.hasOwn(ENDINGS, kind);
}

/** What the CG draws on: the ending, the negotiation as the clerk knows it, the siege at headquarters. */
export interface EndingFacts {
  terminal: { kind: string; round: number; day: number; detail: Record<string, unknown> };
  track: NegotiationTrackView;
  siege: SiegeLevels;
}

export function endingFacts(s: StateView): EndingFacts | null {
  return s.world.terminal ? { terminal: s.world.terminal, track: s.negotiationTrack, siege: s.siegeWatch.now } : null;
}

function confirmedCard(track: NegotiationTrackView): OfferCardView | undefined {
  return track.cards.findLast((c) => c.stage === 'confirmed');
}

/** One or two sentences; the pact's lines follow the land given, the others how the ending came about. */
export function endingLines(facts: EndingFacts): string {
  const { terminal, track } = facts;
  const last = track.cards.at(-1);
  switch (terminal.kind) {
    case 'pact_concluded': {
      const cession = confirmedCard(track)?.terms?.cession;
      if (cession === 'none') return 'The pact is sealed without giving up a single prefecture. Its price is counted in silk and submission.';
      if (cession === 'yanmen_north') return 'The pact is sealed, and the lands north of Yanmen Pass are pledged away. Help may come; the frontier will not return.';
      if (cession === 'lulong_only') return 'The pact is sealed, and the Lulong circuit is pledged away. The lands north of Yanmen Pass remain outside the promise.';
      if (cession === 'sixteen_prefectures') return 'The pact is sealed at the highest price: all of Lulong and the lands north of Yanmen. Generations will live with this border.';
      return 'The pact is sealed. Its price will be paid for years to come.';
    }
    case 'jinyang_falls':
      if (terminal.detail.cause === 'grain') return 'The last of the grain is gone, and the walls can no longer be held. Jinyang falls before help could come.';
      if (terminal.detail.cause === 'missed_opportunity') return 'No pact was sealed in time. The Tang army launches its final assault, and Jinyang falls.';
      return 'The siege breaks through the defences. Jinyang falls to the Tang army.';
    case 'no_assistance':
      return track.cards.length === 0
        ? 'No envoy rides north. Jinyang will face the siege alone, and inside the walls the lamps still burn.'
        : 'The request is withdrawn, and the road north falls quiet. Jinyang will face the siege alone.';
    case 'talks_failed':
      if (last?.stage === 'rejected' && last.direction === 'out') return `${track.far.name.en} has turned down the last offer. The envoy departs, and the road north closes.`;
      if (last?.stage === 'rejected') return `${track.near.name.en} refuses the Khitan price. The envoy departs, and the road north closes.`;
      return 'The talks have run their course without agreement. The road north closes.';
    default:
      return '';
  }
}

export interface SummaryRow {
  label: string;
  value: string;
}

const CESSION_SHORT: Record<string, string> = {
  none: 'None',
  yanmen_north: 'North of Yanmen Pass only',
  lulong_only: 'Lulong circuit only',
  sixteen_prefectures: 'All of Lulong and north of Yanmen',
};

function siegeLine(s: SiegeLevels): string {
  return `grain for ${s.grain} days · pressure ${s.pressure} / 100 · morale ${s.morale} / 100`;
}

/** The result in a few rows, from the chapter's real data as the clerk knows it (unknown terms are left out). */
export function endingSummary(facts: EndingFacts): SummaryRow[] {
  const { terminal, track, siege } = facts;
  const rows: SummaryRow[] = [];
  switch (terminal.kind) {
    case 'pact_concluded': {
      const card = confirmedCard(track);
      const t = card?.terms;
      if (t) {
        rows.push({ label: 'Territory pledged', value: CESSION_SHORT[t.cession] ?? t.cession });
        rows.push({ label: 'Immediate silk', value: `${fmt(t.immediate_silk)} bolts` });
        if (t.annual_silk > 0) rows.push({ label: 'Annual silk', value: `${fmt(t.annual_silk)} bolts a year` });
        if (t.aid_cavalry > 0) rows.push({ label: 'Relief promised', value: `${fmt(t.aid_cavalry)} cavalry, within ${t.aid_arrival_days} days of confirmation` });
      }
      rows.push({ label: 'Concluded', value: `Day ${terminal.day}${card ? `, on version ${card.termsVersion}` : ''}` });
      break;
    }
    case 'jinyang_falls': {
      const { cause, deadlineRound } = terminal.detail;
      const missed = `No pact before the deadline${typeof deadlineRound === 'number' ? ` (round ${deadlineRound})` : ''}`;
      rows.push({ label: 'Cause', value: cause === 'grain' ? 'The grain ran out' : cause === 'missed_opportunity' ? missed : 'Siege pressure reached its limit' });
      rows.push({ label: 'Fell on', value: `Day ${terminal.day}` });
      rows.push({ label: 'Last count', value: siegeLine(siege) });
      break;
    }
    case 'no_assistance':
      rows.push({ label: 'Request', value: track.cards.length === 0 ? 'Never sent' : 'Withdrawn' });
      rows.push({ label: 'Decided on', value: `Day ${terminal.day}` });
      rows.push({ label: 'The city holds with', value: siegeLine(siege) });
      break;
    case 'talks_failed': {
      const last = track.cards.at(-1);
      rows.push({ label: 'Letters exchanged', value: String(track.cards.length) });
      if (last) {
        const outcome = last.stage === 'rejected' ? `rejected by ${(last.direction === 'out' ? track.far : track.near).name.en}` : STAGE_LABELS[last.stage].toLowerCase();
        rows.push({ label: 'Last offer', value: `Version ${last.termsVersion}, ${outcome}` });
      }
      rows.push({ label: 'Talks ended', value: `Day ${terminal.day}` });
      break;
    }
  }
  return rows;
}

/** Each ending plays by itself once per session and viewer; this is the browser storage key that remembers it. */
export function endingKey(sessionId: string, kind: string): string {
  return `jinyang.ending.${sessionId}.${kind}`;
}
