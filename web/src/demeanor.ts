/**
 * Read the room (察言观色): the clerk's impression of each person present at headquarters. It rests only on what the
 * clerk can see — the siege outlook (the hourglass alerts) and the last line the clerk heard them say this round or
 * the one before. It is the clerk's reading, never the characters' inner state, which the play view does not carry.
 */
import type { DialogueRowView, SiegeWatchView } from '../../src/server/api-types.js';

export type Bearing = 'composed' | 'uneasy' | 'pressing';

export const BEARING_LABELS: Record<Bearing, string> = { composed: 'Composed', uneasy: 'Uneasy', pressing: 'Pressing' };
export const BEARING_TONE: Record<Bearing, string> = { composed: 'ok', uneasy: 'warn', pressing: 'bad' };

export interface Impression {
  bearing: Bearing;
  /** What the reading rests on, most telling first. */
  reasons: string[];
  /** The line it draws on (null: none heard this round or the one before). */
  heard: { round: number; text: string; cues: string[] } | null;
}

const RANK: Record<Bearing, number> = { composed: 0, uneasy: 1, pressing: 2 };

/** Chinese cue words; an occurrence right after a negation (不急, 无忧, 勿虑) does not count. */
const ZH_PRESSING = ['刻不容缓', '迫在眉睫', '即日', '即刻', '立即', '立刻', '迟则', '火速', '速', '急'];
const ZH_UNEASY = ['不安', '太过', '不可', '未可', '奈何', '恐', '忧', '惧', '怕', '危', '慎', '虑'];
const ZH_NEGATION = /(?:不|无|勿|莫|毋|不必|何必)$/u;
const EN_PRESSING = /\b(?:at once|immediately|without delay|urgent(?:ly)?|hurry|haste|no time|too late|this very day)\b/giu;
const EN_UNEASY = /\b(?:fear(?:s|ed)?|afraid|worr(?:y|ied|ies)|risk(?:s|y)?|doubt(?:s|ful)?|too (?:much|far|high|heavy)|beware|careful|danger(?:ous)?|unwise|uneasy)\b/giu;

function zhCues(text: string, words: readonly string[]): string[] {
  const found: string[] = [];
  for (const w of words) {
    for (let i = text.indexOf(w); i >= 0; i = text.indexOf(w, i + w.length)) {
      // A longer cue already covers this spot (速 inside 火速), or a negation turns it around.
      if (found.some((f) => f.includes(w) && text.includes(f))) break;
      if (!ZH_NEGATION.test(text.slice(Math.max(0, i - 2), i))) {
        found.push(w);
        break;
      }
    }
  }
  return found;
}

function enCues(text: string, pattern: RegExp): string[] {
  return [...new Set([...text.matchAll(pattern)].map((m) => m[0].toLowerCase()))];
}

/** The bearing a single line suggests, with the words that suggest it. */
export function lineBearing(text: string): { bearing: Bearing; cues: string[] } {
  const pressing = [...zhCues(text, ZH_PRESSING), ...enCues(text, EN_PRESSING)];
  if (pressing.length > 0) return { bearing: 'pressing', cues: pressing };
  const uneasy = [...zhCues(text, ZH_UNEASY), ...enCues(text, EN_UNEASY)];
  if (uneasy.length > 0) return { bearing: 'uneasy', cues: uneasy };
  return { bearing: 'composed', cues: [] };
}

/** How the siege weighs on everyone at headquarters (from the hourglass alerts). */
export function siegeBearing(watch: SiegeWatchView): { bearing: Bearing; reason: string | null } {
  if (watch.alerts.some((a) => a.level === 'critical')) return { bearing: 'pressing', reason: 'The city could fall when this round ends.' };
  if (watch.alerts.some((a) => a.code === 'mutiny_next')) return { bearing: 'uneasy', reason: 'The garrison may mutiny.' };
  if (watch.alerts.some((a) => a.code === 'morale_falls')) return { bearing: 'uneasy', reason: 'Morale is falling with the siege.' };
  return { bearing: 'composed', reason: null };
}

/**
 * The clerk's impression of `charId`: the more troubled of what the siege suggests and what their last line heard
 * (this round or the one before) suggests. Rows the clerk did not hear (director view) are ignored.
 */
export function readRoom(charId: string, rows: readonly DialogueRowView[], watch: SiegeWatchView): Impression {
  const line = rows
    .filter((r) => r.speaker === charId && r.listeners.includes('player') && r.round >= watch.round - 1)
    .reduce<DialogueRowView | null>((last, r) => (last === null || r.seq > last.seq ? r : last), null);
  const siege = siegeBearing(watch);
  const speech = line ? lineBearing(line.text) : null;
  const quoted = speech && speech.cues.length > 0 ? speech.cues.map((c) => `“${c}”`).join(', ') : '';
  const said =
    !line || !speech
      ? 'You have not heard them speak this round or the last.'
      : speech.bearing === 'pressing'
        ? `Presses for speed (${quoted}, round ${line.round}).`
        : speech.bearing === 'uneasy'
          ? `Sounds doubtful or worried (${quoted}, round ${line.round}).`
          : `Spoke evenly in round ${line.round}.`;
  const bearing = speech && RANK[speech.bearing] > RANK[siege.bearing] ? speech.bearing : siege.bearing;
  // The reason that sets the bearing comes first.
  const reasons = siege.reason && RANK[siege.bearing] >= RANK[speech?.bearing ?? 'composed'] ? [siege.reason, said] : siege.reason ? [said, siege.reason] : [said];
  return { bearing, reasons, heard: line && speech ? { round: line.round, text: line.text, cues: speech.cues } : null };
}
