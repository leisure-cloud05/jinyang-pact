/**
 * Play content: the content bundle plus a synthetic free-play configuration `FREE` (the scenario's own initial world
 * and default goal, no scripted inputs, no decision policy, every terminal valid). The engine requires a case id,
 * so free play is expressed as one more pilot-like entry of a server-local bundle; evaluation runs never see it.
 */
import { CaseSchema } from '../content/schema.js';
import type { ContentBundle } from '../content/loader.js';
import { TERMINAL_KINDS } from '../core/types.js';
import type { ConfigSummary, L10n } from './api-types.js';

export const FREE_PLAY_ID = 'FREE';

export function withFreePlay(content: ContentBundle): ContentBundle {
  if (Object.hasOwn(content.pilot, FREE_PLAY_ID) || Object.hasOwn(content.cases, FREE_PLAY_ID)) return content;
  const s = content.scenario;
  const free = CaseSchema.parse({
    id: FREE_PLAY_ID,
    title: { zh: '自由游戏（剧本开局）', en: 'Free play (scenario start)' },
    purpose: {
      zh: '以剧本原定之开局进行：桑维翰所草之表、默认目标，无预设台词，亦无预设决策。',
      en: "The scenario's own opening: Sang Weihan's recorded draft and the default goal, with no scripted lines and no scripted decisions.",
    },
    player_goal: s.player.default_goal,
    valid_terminals: [...TERMINAL_KINDS],
    max_rounds: s.parameters.max_rounds,
  });
  return { ...content, pilot: { ...content.pilot, [FREE_PLAY_ID]: free } };
}

export function configKind(content: ContentBundle, id: string): ConfigSummary['kind'] {
  if (id === FREE_PLAY_ID) return 'free';
  if (Object.hasOwn(content.cases, id)) return 'case';
  if (Object.hasOwn(content.dev, id)) return 'dev';
  return 'pilot';
}

/**
 * Player-safe one-line descriptions. A configuration's `purpose` is evaluation text written for researchers and
 * names hidden set-ups (e.g. C4: Luoyang's envoy, its bid and arrival day, who holds the secret article), so it is
 * never sent to the player; the content has no player-facing description, hence these generic lines. The free-play
 * description is the server's own (it reveals nothing beyond the scenario's opening).
 */
const GENERIC: Record<ConfigSummary['kind'], L10n> = {
  free: { zh: '', en: '' },
  case: {
    zh: '评测案例。其设定与检验要点在本章结束后（或明确开启导演视图后）于导演视图中显示。',
    en: 'Evaluation case. Its set-up and what it tests are shown in the director view once the chapter ends (or after an explicit unlock).',
  },
  dev: { zh: '开发配置（集成检查用），设定于导演视图中显示。', en: 'Development configuration (integration checks); its set-up is shown in the director view.' },
  pilot: { zh: '试点变体（调试用），设定于导演视图中显示。', en: 'Pilot variant (for tuning); its set-up is shown in the director view.' },
};

export function playerDescription(content: ContentBundle, id: string, purpose: L10n): L10n {
  const kind = configKind(content, id);
  return kind === 'free' ? { ...purpose } : { ...GENERIC[kind] };
}

export function configSummaries(content: ContentBundle): ConfigSummary[] {
  const all = [
    ...Object.values(content.cases),
    ...Object.values(content.dev),
    ...Object.values(content.pilot).filter((p) => p.id !== FREE_PLAY_ID),
  ];
  const free = content.pilot[FREE_PLAY_ID];
  const ordered = [...(free ? [free] : []), ...all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))];
  return ordered.map((c) => ({
    id: c.id,
    kind: configKind(content, c.id),
    title: { ...c.title },
    description: playerDescription(content, c.id, c.purpose),
    maxRounds: c.max_rounds,
    validTerminals: [...c.valid_terminals],
    hasScript: c.script.some((s) => s.inputs.length > 0),
    hasPolicy: c.decision_policy.length > 0,
  }));
}
