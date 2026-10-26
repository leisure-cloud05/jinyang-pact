/**
 * Private counsel (附耳进言): preset openings, and the input that says one line to one person present. Only the
 * chosen listener hears it (dialogue rows carry their listeners; a character's context holds only rows it heard), and
 * the interaction engine gives that listener an item to answer. Counsel is advice, never a fact: it changes nothing in
 * the world unless the character acts on it.
 */
import type { DialogueRowView, L10n, Lang } from '../../src/server/api-types.js';

export type WhisperPreset = 'cost' | 'limits' | 'own';

export const WHISPER_PRESETS: ReadonlyArray<{ id: WhisperPreset; label: string; text: L10n }> = [
  {
    id: 'cost',
    label: 'Remind of the long-term cost',
    text: {
      zh: '（附耳低语）今日所许，他日都要偿还。所许的名分、土地与财帛，还请掂量长远的代价。',
      en: '(quietly) Whatever we promise today must be paid later. Please weigh the long-term cost of these terms.',
    },
  },
  {
    id: 'limits',
    label: 'Urge holding the line',
    text: {
      zh: '（附耳低语）彼方若再相逼，仆以为宜守前议的底线，不可轻许更多。',
      en: '(quietly) If they press us further, I advise holding to the limits we agreed and promising nothing more.',
    },
  },
  {
    id: 'own',
    label: 'Write my own',
    text: { zh: '（附耳低语）', en: '(quietly) ' },
  },
];

/** The opening of a preset in the session's narrative language (the language the characters speak). */
export function whisperText(id: WhisperPreset, lang: Lang): string {
  const preset = WHISPER_PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`unknown whisper preset ${id}`);
  return lang === 'zh' ? preset.text.zh : preset.text.en;
}

/** A line of the clerk's that exactly one person heard. */
export function isPrivateLine(row: Pick<DialogueRowView, 'speaker' | 'listeners'>): boolean {
  return row.speaker === 'player' && row.listeners.filter((l) => l !== 'player').length === 1;
}
