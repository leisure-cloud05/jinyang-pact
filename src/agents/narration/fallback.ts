/**
 * Template prose (PLAN §9.4 fallback, checker v6). The fact header states every outcome and quantity; the prose —
 * model or template — is atmosphere only. The template is one setting line for the scene plus one mood line per
 * kind of business in the scene (council, correspondence, siege, ending), with no names, places, numbers, terms or
 * outcome vocabulary, so it always passes the checker. Displayed whenever model prose fails the checker or the call fails.
 */
import type { NarrationFact } from '../../core/types.js';
import type { AgentNames } from '../names.js';
import type { Lang } from '../types.js';

export const FALLBACK_VERSION = 'fallback.v4';

type Line = { zh: string; en: string };

const SETTING: Record<string, Line> = {
  jinyang_hq: {
    zh: '帅府之内，烛影摇动，秋风穿堂而过。',
    en: 'In the headquarters the candlelight flickered as the autumn wind swept through the hall.',
  },
  khitan_court: {
    zh: '牙帐之外，朔风卷起旌旗，马嘶声远。',
    en: 'Outside the great tent the north wind snapped at the banners, and horses whinnied far off.',
  },
  luoyang_court: {
    zh: '宫中殿宇深沉，香烟袅袅。',
    en: 'In the palace the halls were hushed, and incense curled in the still air.',
  },
};

const DEFAULT_SETTING: Line = { zh: '天色阴沉，周遭寂然。', en: 'The sky was overcast, and all around was quiet.' };

type Mood = 'council' | 'correspondence' | 'siege' | 'ending' | 'grave';

const MOOD: Record<Mood, Line> = {
  council: { zh: '众人低声相议，案上笔墨犹湿。', en: 'Voices were kept low, and the ink on the desk was still wet.' },
  correspondence: { zh: '驿道上尘土微扬，灯影摇曳，人人各怀心思。', en: 'Dust hung over the post road; lamplight wavered, and each man kept his own counsel.' },
  siege: { zh: '城头风急，旌旗猎猎，守城军士默然远望。', en: 'Wind tore at the flags on the walls, and the defenders stared into the distance.' },
  ending: { zh: '天色渐暗，城中寂然无声。', en: 'Dusk settled over the city, and a heavy stillness followed.' },
  grave: { zh: '众人默然，良久无言。', en: 'No one spoke for a long while.' },
};

const MOOD_OF: Record<string, Mood> = {
  document_revised: 'council',
  suggestion_made: 'council',
  document_approved: 'council',
  dispatch_timing_set: 'council',
  authorization_granted: 'council',
  authorization_revoked: 'council',
  goal_adjusted: 'council',
  deadlock_resolved: 'council',
  assistance_abandoned: 'council',
  document_dispatched: 'correspondence',
  terms_proposed: 'correspondence',
  offer_countered: 'correspondence',
  offer_rejected: 'correspondence',
  withdrawal_sent: 'correspondence',
  offer_delivered: 'correspondence',
  response_delivered: 'correspondence',
  withdrawal_effective: 'correspondence',
  withdrawal_late: 'correspondence',
  withdrawal_result_delivered: 'correspondence',
  letter_delivered: 'correspondence',
  letter_sent: 'correspondence',
  intel_delivered: 'correspondence',
  commitment_confirmed: 'correspondence',
  resources_allocated: 'siege',
  time_advanced: 'siege',
  mutiny_outbreak: 'siege',
  mutiny_averted_for_now: 'siege',
  terminal: 'ending',
  character_death: 'grave',
  allegiance_change: 'grave',
};

const MOOD_ORDER: readonly Mood[] = ['council', 'correspondence', 'siege', 'grave', 'ending'];

/** Atmosphere-only template prose for a scene's facts (no names, numbers or outcome words). */
export function fallbackProse(facts: readonly NarrationFact[], _names: AgentNames, lang: Lang, scene?: string): string {
  const where = scene ?? facts[0]?.scene ?? '';
  const setting = SETTING[where] ?? DEFAULT_SETTING;
  const moods = new Set(facts.map((f) => MOOD_OF[f.kind]).filter((m): m is Mood => m !== undefined));
  const lines = [setting, ...MOOD_ORDER.filter((m) => moods.has(m)).map((m) => MOOD[m])];
  return lines.map((l) => (lang === 'zh' ? l.zh : l.en)).join(lang === 'zh' ? '' : ' ');
}

/** Every template line (for tests: each must pass the checker on its own). */
export function fallbackLines(): Line[] {
  return [...Object.values(SETTING), DEFAULT_SETTING, ...Object.values(MOOD)];
}
