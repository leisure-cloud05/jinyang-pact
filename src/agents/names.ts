/**
 * Canonical display names (zh/en) derived from content: characters (name, aliases, short titles), the player,
 * locations, factions, term labels and cession levels. Used by the context builders, the fact header, the
 * narration checker and the fallback prose.
 */
import { CESSION_VALUES, CHAR_IDS, FACTION_IDS, LOC_IDS, SCALAR_TERM_KEYS } from '../core/types.js';
import type { ActorId, Cession, CharId, FactionId, Localized, LocId, ResourceKey, ScalarTermKey } from '../core/types.js';
import type { AgentContent, Lang, PersonaMap } from './types.js';

export interface CharacterNames {
  id: CharId;
  name: Localized;
  title: Localized;
  aliases: { zh: string[]; en: string[] };
}

export interface AgentNames {
  characters: Record<CharId, CharacterNames>;
  player: { name: Localized; title: Localized };
  locations: Record<LocId, Localized>;
  factions: Record<FactionId, Localized>;
  terms: Record<ScalarTermKey, Localized>;
  cession: Record<Cession, Localized>;
}

export const RESOURCE_LABELS: Record<ResourceKey, Localized & { unitZh: string; unitEn: string }> = {
  grain: { zh: '粮', en: 'grain', unitZh: '日粮', unitEn: "days' grain" },
  silk: { zh: '帛', en: 'silk', unitZh: '匹', unitEn: 'bolts' },
  cavalry: { zh: '骑兵', en: 'cavalry', unitZh: '骑', unitEn: 'horse' },
  reserve_troops: { zh: '预备兵', en: 'reserve troops', unitZh: '人', unitEn: 'men' },
};

const CESSION_FALLBACK: Record<Cession, Localized> = {
  none: { zh: '不割地', en: 'no cession' },
  yanmen_north: { zh: '雁门关以北诸州', en: 'the prefectures north of Yanmen Pass' },
  lulong_only: { zh: '仅卢龙一道（不含雁门关以北诸州）', en: 'the Lulong circuit only (not the prefectures north of Yanmen Pass)' },
  sixteen_prefectures: { zh: '卢龙一道及雁门关以北诸州', en: 'the Lulong circuit and the prefectures north of Yanmen Pass' },
};

export function loc(text: Localized, lang: Lang): string {
  return lang === 'zh' ? text.zh : text.en;
}

export function buildNames(content: AgentContent, personas: PersonaMap = {}): AgentNames {
  const s = content.scenario;
  const characters = {} as Record<CharId, CharacterNames>;
  for (const id of CHAR_IDS) {
    const c = personas[id] ?? content.characters[id];
    characters[id] = {
      id,
      name: { ...c.name },
      title: { ...c.title },
      aliases: { zh: [...c.aliases.zh], en: [...c.aliases.en] },
    };
  }
  const locations = {} as Record<LocId, Localized>;
  for (const id of LOC_IDS) {
    const l = s.locations.find((x) => x.id === id);
    locations[id] = l ? { ...l.name } : { zh: id, en: id };
  }
  const factions = {} as Record<FactionId, Localized>;
  for (const id of FACTION_IDS) {
    const f = s.factions.find((x) => x.id === id);
    factions[id] = f ? { ...f.name } : { zh: id, en: id };
  }
  const terms = {} as Record<ScalarTermKey, Localized>;
  const cession = { ...CESSION_FALLBACK };
  for (const key of SCALAR_TERM_KEYS) {
    const entry = s.terms_catalog.terms.find((t) => t.key === key);
    terms[key] = entry ? { ...entry.label } : { zh: key, en: key };
    if (key === 'cession' && entry?.value_labels) {
      for (const v of CESSION_VALUES) {
        const label = entry.value_labels[v];
        if (label) cession[v] = { ...label };
      }
    }
  }
  return {
    characters,
    player: { name: { ...s.player.name }, title: { ...s.player.title } },
    locations,
    factions,
    terms,
    cession,
  };
}

/** Display name of an actor in `lang` (`system` → "the system"). */
export function actorName(names: AgentNames, actor: ActorId | string, lang: Lang): string {
  if (actor === 'player') return loc(names.player.name, lang);
  if (actor === 'system') return lang === 'zh' ? '系统' : 'the system';
  const c = (names.characters as Record<string, CharacterNames | undefined>)[actor];
  return c ? loc(c.name, lang) : actor;
}

export function locationName(names: AgentNames, id: LocId | string, lang: Lang): string {
  const l = (names.locations as Record<string, Localized | undefined>)[id];
  return l ? loc(l, lang) : id;
}

/**
 * Every surface form that refers to a character: names, aliases and short titles, in both languages (the
 * checker scans prose for all of them regardless of the narrative language). Longest first.
 */
export function surfaceForms(names: AgentNames, id: CharId): string[] {
  const c = names.characters[id];
  const forms = [c.name.zh, c.name.en, ...c.aliases.zh, ...c.aliases.en];
  if (c.title.zh.length > 0 && c.title.zh.length <= 6 && !/[（(]/.test(c.title.zh)) forms.push(c.title.zh);
  if (c.title.en.length > 0 && c.title.en.length <= 30 && !/[(]/.test(c.title.en)) forms.push(c.title.en);
  return [...new Set(forms.filter((f) => f.trim().length > 0))].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
}
