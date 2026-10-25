/**
 * Narration checker v7 (PLAN §9.4, H16): ATMOSPHERE-ONLY PROSE, ENFORCED STRUCTURALLY. The deterministic fact header
 * is the only place names, quantities and outcomes are stated; the model prose may contain none of them. The
 * checker inspects the rendered prose itself (independent of `mentioned_facts`) and reports a hit for:
 *  (a2) ANY place or polity name (河东, 契丹, 洛阳, 晋阳, 唐 …; Hedong, Khitan, Luoyang, Tang …) — "the city" is enough;
 *  (a) ANY character name, alias or title (zh + en, from content: 石郎, 契丹主, 唐主, 河东节度使 …) and generic
 *      honorifics that point at one (陛下, 主公, 明公, 晋王, Your Majesty, my lord …), and the player's name;
 *  (b) CLOSED NUMERAL RULE: any zh numeral character except 一 (二…九 十百千万亿 两 廿卅 零〇, financial forms) or any
 *      Unicode numeric character (\p{N}: digits of any script, ½ ¼, Ⅳ, ①, 〇 …), anywhere, no exemptions; 一 except in 一切/一直/一起/一样/唯一/一旦/统一 (not before a classifier);
 *      半 except 半夜/半空/半晌; en digits, cardinals, ordinals and magnitude words (dozen, score, hundred, thousand,
 *      million, myriad, tens, half, twice, thrice, couple, plurals), fractions and multiples (quarter, thirds,
 *      double, triple, -fold, percent, %) and "one" outside no one / one another.
 *      No value matching: a correct number is still a hit;
 *  (c) outcome vocabulary (agreement, refusal, withdrawal, dispatch/arrival, cession, mutiny, fall, death/capture
 *      incl. paraphrases such as 气绝 / 归天 / "breathed his last", pact) — single characters on purpose (when unsure,
 *      hit); only compounds that are clearly not outcomes (头发, 大约, 至于, 死寂, 破晓 …) are exempt;
 *  (d) treaty-term / resource / spoils-and-division vocabulary (财货, 均分, spoils, divide …) and (帛, 金, 府库, 岁币, 州, 骑, 粮, 称臣, 父, 子, 和亲 …; silk, treasury, tribute,
 *      prefecture, cavalry, grain, vassal, father, son, marriage …);
 *  (e) canaries and secret-clause text (8-character zh windows, 6-word en windows) of undisclosed clauses. Secrecy is
 *      guaranteed first by input restriction (the narrator never receives clause text); this is a second line.
 * Any hit ⇒ the caller displays the template fallback instead of the prose.
 */
import type { Localized, NarrationFact } from '../../core/types.js';
import { CHAR_IDS } from '../../core/types.js';
import { surfaceForms, type AgentNames } from '../names.js';

export const CHECKER_VERSION = 'checker.v10';

export type CheckKind = 'name' | 'place' | 'quantity' | 'outcome' | 'terms' | 'secret';
export const CHECK_KINDS: readonly CheckKind[] = ['name', 'place', 'quantity', 'outcome', 'terms', 'secret'];

export interface CheckHit {
  check: CheckKind;
  detail: string;
  excerpt: string;
}

export interface CheckResult {
  version: string;
  ok: boolean;
  hits: CheckHit[];
  counts: Record<CheckKind, number>;
}

export interface SecretSpec {
  id: string;
  canary: string;
  text: Localized;
}

export interface CheckInput {
  prose: string;
  /** The scene's facts (kept for the record; v7 licenses nothing from them). */
  facts: readonly NarrationFact[];
  names: AgentNames;
  /** Clauses NOT disclosed to this scene (their canary and text must not appear). */
  secrets?: readonly SecretSpec[];
}

// ---------------------------------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------------------------------

function indexesOf(text: string, needle: string): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  let i = text.indexOf(needle);
  while (i >= 0) {
    out.push(i);
    i = text.indexOf(needle, i + needle.length);
  }
  return out;
}

function blank(text: string, at: number, length: number): string {
  return text.slice(0, at) + '□'.repeat(length) + text.slice(at + length);
}

function mask(text: string, phrases: readonly string[], keep?: (end: number) => boolean): string {
  let out = text;
  for (const p of [...phrases].sort((a, b) => b.length - a.length)) {
    for (const at of indexesOf(out, p)) if (!keep?.(at + p.length)) out = blank(out, at, p.length);
  }
  return out;
}

function excerpt(text: string, start: number, end: number): string {
  return text.slice(Math.max(0, start - 12), Math.min(text.length, end + 12)).replace(/\s+/g, ' ');
}

function isLatin(form: string): boolean {
  return /^[\x20-\x7e]+$/.test(form);
}

/** Occurrences of a surface form (latin forms: case-insensitive, whole words). */
function occurrences(prose: string, form: string): number[] {
  if (!isLatin(form)) return indexesOf(prose, form);
  const lower = prose.toLowerCase();
  return indexesOf(lower, form.toLowerCase()).filter((at) => {
    const before = prose[at - 1] ?? ' ';
    const after = prose[at + form.length] ?? ' ';
    return !/[A-Za-z]/.test(before) && !/[A-Za-z]/.test(after);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// (a) names, aliases, titles, honorifics
// ---------------------------------------------------------------------------------------------------------------

/** Honorifics and titles that point at a character without naming him. */
export const HONORIFICS_ZH: readonly string[] = [
  '陛下', '圣上', '天子', '皇帝', '唐帝', '唐主', '主上', '主公', '明公', '晋王', '石郎', '节度使', '可汗', '契丹主', '掌书记',
  '押牙', '书记',
];
export const HONORIFICS_EN: readonly string[] = [
  'your majesty', 'his majesty', 'my lord', 'the emperor', 'emperor', 'the khan', 'khan', 'military governor', 'the governor',
  'the secretary', 'the clerk',
];

function stripParenthetical(title: string): string {
  return title.replace(/[（(].*?[）)]/g, '').trim();
}

/** Every surface form that names or designates a character (or the player). Longest first. */
export function nameForms(names: AgentNames): string[] {
  const forms = new Set<string>();
  for (const id of CHAR_IDS) {
    for (const f of surfaceForms(names, id)) forms.add(f);
    const c = names.characters[id];
    for (const t of [stripParenthetical(c.title.zh), stripParenthetical(c.title.en)]) if (t.length >= 2) forms.add(t);
  }
  for (const t of [names.player.name.zh, names.player.name.en, names.player.title.zh, names.player.title.en]) {
    if (t.trim().length >= 2) forms.add(t.trim());
  }
  for (const h of [...HONORIFICS_ZH, ...HONORIFICS_EN]) forms.add(h);
  return [...forms].filter((f) => f.trim().length > 0).sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
}

function checkNames(input: CheckInput, hits: CheckHit[]): void {
  const taken: { start: number; end: number }[] = [];
  for (const form of nameForms(input.names)) {
    for (const at of occurrences(input.prose, form)) {
      const end = at + form.length;
      if (taken.some((t) => at < t.end && end > t.start)) continue;
      taken.push({ start: at, end });
      hits.push({ check: 'name', detail: `name or title "${input.prose.slice(at, end)}" in prose`, excerpt: excerpt(input.prose, at, end) });
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// (a2) places and polities — atmosphere needs none ("the city", "the hall" are enough)
// ---------------------------------------------------------------------------------------------------------------

export const PLACES_ZH: readonly string[] = [
  '河东', '契丹', '洛阳', '晋阳', '后唐', '唐室', '唐廷', '太原', '幽州', '燕云', '雁门', '卢龙', '晋安', '中原', '大梁', '汴', '云州',
  '应州', '河南', '河北', '天平', '郓州', '辽', '晋', '唐', '胡', '虏',
];
const PLACES_EN =
  /\b(?:hedong|khitans?|luoyang|jinyang|later tang|tang|taiyuan|youzhou|yanmen|lulong|jin'an|central plains?|daliang|kaifeng|tianping|yunzhou|yingzhou|jin|liao|shatuo)\b/gi;

function stripParens(t: string): string {
  return t.replace(/[（(].*?[）)]/g, '').trim();
}

/** Place and polity forms: the static list plus content's location and faction names (zh + en). */
export function placeForms(names: AgentNames): string[] {
  const forms = new Set<string>(PLACES_ZH);
  for (const l of [...Object.values(names.locations), ...Object.values(names.factions)]) {
    for (const t of [l.zh, l.en]) {
      for (const part of [stripParens(t), ...[...t.matchAll(/[（(](.*?)[）)]/g)].map((m) => (m[1] ?? '').trim())]) {
        if (part.length >= 2 && !/^(?:the|court|headquarters)$/i.test(part)) forms.add(part);
      }
    }
  }
  return [...forms].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
}

function checkPlaces(input: CheckInput, hits: CheckHit[]): void {
  let masked = input.prose;
  const found: { start: number; end: number }[] = [];
  for (const form of placeForms(input.names)) {
    for (const at of occurrences(masked, form)) {
      found.push({ start: at, end: at + form.length });
      masked = blank(masked, at, form.length);
    }
  }
  for (const m of masked.matchAll(PLACES_EN)) found.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  for (const f of found.sort((a, b) => a.start - b.start)) {
    hits.push({ check: 'place', detail: `place or polity "${input.prose.slice(f.start, f.end)}" in prose`, excerpt: excerpt(input.prose, f.start, f.end) });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// (b) numerals
// ---------------------------------------------------------------------------------------------------------------

const ZH_DIGIT: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 贰: 2, 貳: 2, 两: 2, 兩: 2, 三: 3, 叁: 3, 參: 3, 四: 4, 肆: 4, 五: 5, 伍: 5, 六: 6, 陆: 6,
  陸: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9,
};
const ZH_UNIT: Record<string, number> = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000 };
const ZH_BIG: Record<string, number> = { 万: 10_000, 萬: 10_000, 亿: 100_000_000, 億: 100_000_000 };
const ZH_TENS: Record<string, number> = { 廿: 20, 卅: 30, 卌: 40 };

/** Parses a Chinese numeral (三十万 → 300000, 一万五千 → 15000, 叁萬 → 30000, 廿 → 20). NaN if not a numeral. */
export function parseChineseNumeral(text: string): number {
  let total = 0;
  let section = 0;
  let number = 0;
  let seen = false;
  for (const ch of text) {
    if (ch in ZH_DIGIT) {
      number = ZH_DIGIT[ch] as number;
      seen = true;
    } else if (ch in ZH_UNIT) {
      section += (number === 0 && !seen ? 1 : number || 1) * (ZH_UNIT[ch] as number);
      number = 0;
      seen = false;
    } else if (ch in ZH_TENS) {
      section += ZH_TENS[ch] as number;
    } else if (ch in ZH_BIG) {
      const base = section + number;
      total += (base === 0 ? 1 : base) * (ZH_BIG[ch] as number);
      section = 0;
      number = 0;
      seen = false;
    } else {
      return Number.NaN;
    }
  }
  return total + section + number;
}

/**
 * Closed numeral rule (checker v9). zh: every numeral character other than 一 — 二…九, 十百千万亿, 两, 廿卅卌, 零〇,
 * the financial/traditional forms — and every digit is a hit, anywhere, with no exemptions (四周, 万籁, 两旁, 千秋 all
 * hit). 一 is a hit except inside a closed list of lexicalized words with no quantitative reading, and even those hit
 * when a unit or classifier follows. Fractions and proportions hit: 半 anywhere except 半夜 / 半空 / 半晌.
 */
export const ZH_NUMERAL_HIT_CHARS = '二三四五六七八九十百千万亿两廿卅卌零〇壹贰貳叁參肆伍陆陸柒捌玖拾佰仟萬億兩';
export const ZH_ONE_EXEMPT: readonly string[] = ['一切', '一直', '一起', '一样', '唯一', '一旦', '统一'];
const ZH_CLASSIFIERS = '个只位名人匹骑州郡日天年月时辰里石斗两贯缗户家条张封件次回番阵片队支员口座道声句夜刻更旬周';
export const ZH_HALF_EXEMPT: readonly string[] = ['半夜', '半空', '半晌'];

/**
 * en: digits, cardinal and ordinal number words, and magnitude words are hits. Magnitudes are derived as
 * base × {singular, plural} ("of" follows either form): dozen, score, hundred, thousand, million, billion, myriad,
 * ten(s), half/halves, twice, thrice, couple. "one" is a hit except in the pronoun phrases no one / one another
 * (someone, anyone, everyone are other words and never match).
 */
const EN_CARDINALS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen',
  'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty',
  'seventy', 'eighty', 'ninety',
];
const EN_ORDINALS = [
  'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth',
  'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth',
  'thirtieth', 'fortieth', 'fiftieth', 'sixtieth', 'seventieth', 'eightieth', 'ninetieth', 'hundredth', 'thousandth',
  'millionth',
];
const EN_MAGNITUDE_BASES: readonly (readonly [string, string | null])[] = [
  ['dozen', 'dozens'],
  ['score', 'scores'],
  ['hundred', 'hundreds'],
  ['thousand', 'thousands'],
  ['million', 'millions'],
  ['billion', 'billions'],
  ['myriad', 'myriads'],
  ['ten', 'tens'],
  ['half', 'halves'],
  ['twice', null],
  ['thrice', null],
  ['couple', 'couples'],
];
/** Fractions and multiples (ordinal fractions such as "a third" are ordinals, plurals included). */
const EN_FRACTIONS_MULTIPLES = ['quarter', 'quarters', 'double', 'doubled', 'doubles', 'triple', 'tripled', 'triples', 'quadruple', 'quadrupled', 'percent', 'percentage'];
export const EN_NUMBER_WORDS: readonly string[] = [
  ...new Set([
    ...EN_CARDINALS,
    ...EN_ORDINALS,
    ...EN_ORDINALS.map((o) => `${o}s`),
    ...EN_MAGNITUDE_BASES.flatMap(([base, plural]) => (plural ? [base, plural] : [base])),
    ...EN_FRACTIONS_MULTIPLES,
  ]),
];
const EN_PRONOUN_ONE = [/\bno one\b/gi, /\bone another\b/gi];

const EN_SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const EN_TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const EN_SCALE: Record<string, number> = { hundred: 100, thousand: 1000, thousands: 1000, hundreds: 100, million: 1_000_000, dozen: 12, dozens: 12, score: 20 };

export function parseEnglishNumberWords(words: readonly string[]): number {
  let total = 0;
  let current = 0;
  for (const raw of words) {
    const w = raw.toLowerCase();
    if (w in EN_SMALL) current += EN_SMALL[w] as number;
    else if (w in EN_TENS) current += EN_TENS[w] as number;
    else if (w === 'hundred') current = (current || 1) * 100;
    else if (w in EN_SCALE) {
      total += (current || 1) * (EN_SCALE[w] as number);
      current = 0;
    }
  }
  return total + current;
}

function checkNumerals(prose: string, hits: CheckHit[]): void {
  let text = prose.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  // zh: lexicalized 一-words not followed by a classifier, and 半夜 / 半空 / 半晌, are the only exemptions.
  for (const word of [...ZH_ONE_EXEMPT, ...ZH_HALF_EXEMPT]) {
    for (const at of indexesOf(text, word)) {
      if (ZH_CLASSIFIERS.includes(text[at + word.length] ?? '\u0000')) continue;
      text = blank(text, at, word.length);
    }
  }
  // en: pronoun phrases with "one".
  for (const re of EN_PRONOUN_ONE) for (const m of text.matchAll(re)) text = blank(text, m.index ?? 0, m[0].length);
  const found: { start: number; end: number; raw: string }[] = [];
  // Any Unicode numeric character (digits of any script, vulgar fractions, Roman numerals, circled numbers, 〇 …),
  // the zh numeral characters and 半.
  for (const m of text.matchAll(new RegExp(`\\p{N}+(?:[.,]\\p{N}+)*|[一半${ZH_NUMERAL_HIT_CHARS}]+`, 'gu'))) {
    found.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, raw: prose.slice(m.index ?? 0, (m.index ?? 0) + m[0].length) });
  }
  for (const m of text.matchAll(new RegExp(`\\b(?:${EN_NUMBER_WORDS.join('|')})\\b`, 'gi'))) {
    found.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, raw: m[0] });
  }
  // Multiplicative -fold words, "per cent" and percent / per-mille signs.
  for (const m of text.matchAll(/\b[a-z]+fold\b|\bper cent\b|[%‰％]/gi)) {
    found.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, raw: m[0] });
  }
  for (const f of found.sort((x, y) => x.start - y.start)) {
    hits.push({ check: 'quantity', detail: `numeral "${f.raw}" in prose (quantities belong to the header)`, excerpt: excerpt(prose, f.start, f.end) });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// (c) outcome vocabulary
// ---------------------------------------------------------------------------------------------------------------

export type OutcomeCategory =
  | 'agreement'
  | 'refusal'
  | 'withdrawal'
  | 'dispatch_arrival'
  | 'cession'
  | 'mutiny'
  | 'fall'
  | 'death_capture'
  | 'pact';

/** zh outcome words (single characters included on purpose: when unsure, hit). */
export const OUTCOME_LEXICON_ZH: Readonly<Record<OutcomeCategory, readonly string[]>> = {
  agreement: ['应允', '答应', '同意', '允', '许', '纳', '受', '准', '诺', '批'],
  refusal: ['不许', '不允', '回绝', '驳回', '拒', '却', '辞'],
  withdrawal: ['收回', '追回', '撤回', '撤', '罢'],
  dispatch_arrival: ['送达', '到达', '抵达', '遣', '发', '至', '抵', '达', '送', '寄', '递', '到'],
  cession: ['割', '献', '让', '奉', '交', '予'],
  mutiny: ['哗变', '兵变', '作乱', '叛', '乱'],
  fall: ['失守', '易帜', '献城', '开城', '入城', '归附', '归降', '投降', '接管', '陷', '破', '降', '败', '胜', '克', '占', '据', '夺'],
  death_capture: [
    '气绝', '归天', '驾崩', '捐躯', '自焚', '身故', '长逝', '仙逝', '不治', '丧命', '殒命', '毙命', '就义', '升遐', '晏驾',
    '处死', '伏诛', '枭首', '弃市', '赐死', '死', '亡', '杀', '擒', '俘', '薨', '崩', '殁', '殒', '陨', '殂', '诛', '斩', '囚',
    '毙', '殉', '逝', '戮', '缢', '绞', '刑', '刺', '鸩',
  ],
  pact: ['和亲', '中立', '和议', '盟', '约', '契约', '条款'],
};

/** Compounds containing a lexicon character that are clearly NOT outcomes. */
export const OUTCOME_SAFE_ZH: readonly string[] = [
  '头发', '白发', '须发', '鬓发', '发丝', '大约', '约莫', '隐约', '约略', '许多', '或许', '也许', '些许', '几许', '少许', '许久',
  '至于', '甚至', '乃至', '以至', '至今', '死寂', '肃杀', '杀气', '存亡', '破晓', '感受', '难受', '忍受', '享受', '到处',
  '誓死', '死守', '拼死', '效死', '感到', '想到', '听到', '看到', '交谈', '交织', '交加', '交错', '凌乱', '纷乱', '杂乱', '克制',
  '言辞', '让人', '据说', '根据', '依据', '占卜', '刺骨', '刺眼',
];

const OUTCOME_EN: Readonly<Record<OutcomeCategory, RegExp>> = {
  agreement: /\b(?:agree[sd]?|agreeing|accept(?:s|ed|ing|ance)?|consent(?:s|ed|ing)?|approv(?:e|es|ed|ing|al)|confirm(?:s|ed|ing|ation)?|seal(?:s|ed|ing)?|promis(?:e|es|ed|ing)|conclud(?:e|es|ed|ing))\b/gi,
  refusal: /\b(?:refus(?:e|es|ed|ing|al)|reject(?:s|ed|ing|ion)?|declin(?:e|es|ed|ing)|rebuff(?:s|ed|ing)?|turn(?:s|ed|ing)? down)\b/gi,
  withdrawal: /\b(?:withdr(?:aw|aws|awn|ew|awing|awal)|retract(?:s|ed|ing|ion)?|recall(?:s|ed|ing)?|revok(?:e|es|ed|ing))\b/gi,
  dispatch_arrival: /\b(?:dispatch(?:es|ed|ing)?|send(?:s|ing)?|sent|arriv(?:e|es|ed|ing|al)|deliver(?:s|ed|ing|y)?|reach(?:es|ed|ing)?|came to)\b/gi,
  cession: /\b(?:ced(?:e|es|ed|ing)|cession|transfer(?:s|red|ring)?|hand(?:s|ed|ing)? over|offer(?:s|ed|ing)? up|yield(?:s|ed|ing)?|surrender(?:s|ed|ing)?|give up|gave up|given up)\b/gi,
  mutiny: /\b(?:mutin(?:y|ies|ied|ous|eers?)|revolt(?:s|ed|ing)?|rebel(?:s|led|ling|lion)?|uprising)\b/gi,
  fall: /\b(?:fall(?:s|en|ing)?|fell|defeat(?:s|ed|ing)?|victor(?:y|ious)|conquer(?:s|ed|ing)?|taken|took|seiz(?:e|es|ed|ing)|occup(?:y|ies|ied|ying|ation)|storm(?:s|ed|ing)?|overr(?:an|un)|sack(?:s|ed|ing)?|surrender(?:s|ed|ing)?|capitulat(?:e|ed|ion)|entered the (?:city|town|gates)|(?:gates?|doors?) (?:were |was )?(?:opened|flung open|thrown open)|opened the gates|(?:banners?|flags?|standards?)\b[^.;!?\n]{0,40}?\b(?:changed|lowered|struck|replaced|hauled down|torn down|taken down)|(?:changed|lowered|replaced|hauled down|tore down|took down)\b[^.;!?\n]{0,20}?\b(?:banners?|flags?|standards?))\b/gi,
  death_capture: /\b(?:die[sd]?|dying|dead|death|kill(?:s|ed|ing)?|slain|slay|slew|slaughter(?:s|ed|ing)?|perish(?:es|ed|ing)?|execut(?:e|es|ed|ing|ion)|behead(?:s|ed|ing)?|captur(?:e|es|ed|ing)|captive|prisoner|murder(?:s|ed)?|breathed (?:his|her|their) last|passed away|expir(?:e|es|ed|ing)|succumb(?:s|ed|ing)?|gave up the ghost|lifeless|corpse|martyr(?:ed)?|hang(?:s|ed|ing)?|strangl(?:e|es|ed|ing)|put to death|stab(?:s|bed|bing)?|poison(?:s|ed|ing)?|struck down|cut down|run through|assassin(?:s|ation)?)\b/gi,
  pact: /\b(?:pacts?|alliances?|allied|treat(?:y|ies)|neutral(?:ity)?|truce|accord|agreements?|marriage)\b/gi,
};

function checkOutcomes(prose: string, hits: CheckHit[]): void {
  let masked = mask(prose, OUTCOME_SAFE_ZH);
  const found: { category: OutcomeCategory; word: string; start: number; end: number }[] = [];
  for (const [category, words] of Object.entries(OUTCOME_LEXICON_ZH) as [OutcomeCategory, readonly string[]][]) {
    for (const w of [...words].sort((a, b) => b.length - a.length)) {
      for (const at of indexesOf(masked, w)) {
        found.push({ category, word: w, start: at, end: at + w.length });
        masked = blank(masked, at, w.length);
      }
    }
  }
  for (const [category, re] of Object.entries(OUTCOME_EN) as [OutcomeCategory, RegExp][]) {
    for (const m of prose.matchAll(re)) found.push({ category, word: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  for (const f of found.sort((a, b) => a.start - b.start)) {
    hits.push({ check: 'outcome', detail: `outcome word "${f.word}" (${f.category}) in prose`, excerpt: excerpt(prose, f.start, f.end) });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// (d) treaty-term / resource vocabulary
// ---------------------------------------------------------------------------------------------------------------

export const TERMS_LEXICON_ZH: readonly string[] = [
  '岁币', '岁输', '岁帛', '府库', '金帛', '称臣', '和亲', '中立', '燕云', '雁门', '卢龙', '土地', '兵马', '援骑', '援兵', '援军',
  '财货', '财物', '财宝', '均分', '平分', '瓜分', '分赃', '分享', '分之', '帛', '绢', '金', '银', '钱', '贡', '州', '郡', '骑', '粮',
  '臣', '父', '子', '货', '赋',
];
/** Compounds containing a terms character that are clearly not treaty terms. */
export const TERMS_SAFE_ZH: readonly string[] = ['子夜', '影子', '帘子', '日子', '孩子', '君子', '父老'];
const TERMS_EN =
  /\b(?:silks?|gold|silver|coins?|money|treasur(?:y|ies)|tribute|prefectures?|territor(?:y|ies)|lands?|cavalry|horsemen|troops|grain|vassal(?:s|age)?|fathers?|sons?|filial|marriage|neutral(?:ity)?|bolts|spoils|plunder(?:ed|ing)?|loot(?:ed|ing)?|wealth|riches|divid(?:e|es|ed|ing)|division|split(?:s|ting)?|shar(?:e|es|ed|ing))\b/gi;

function checkTerms(prose: string, hits: CheckHit[]): void {
  let masked = mask(prose, TERMS_SAFE_ZH);
  const found: { word: string; start: number; end: number }[] = [];
  for (const w of [...TERMS_LEXICON_ZH].sort((a, b) => b.length - a.length)) {
    for (const at of indexesOf(masked, w)) {
      found.push({ word: w, start: at, end: at + w.length });
      masked = blank(masked, at, w.length);
    }
  }
  for (const m of prose.matchAll(TERMS_EN)) found.push({ word: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  for (const f of found.sort((a, b) => a.start - b.start)) {
    hits.push({ check: 'terms', detail: `treaty-term / resource word "${f.word}" in prose`, excerpt: excerpt(prose, f.start, f.end) });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// (e) secrets
// ---------------------------------------------------------------------------------------------------------------

function stripPunct(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, '');
}

/** Secret hits (canary or clause text) of `secrets` in any text (also used to scrub Judge questions). */
export function secretHits(prose: string, secrets: readonly SecretSpec[]): CheckHit[] {
  const hits: CheckHit[] = [];
  const flatZh = stripPunct(prose);
  const lowerWords = prose.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  const enJoined = ` ${lowerWords.join(' ')} `;
  for (const s of secrets) {
    if (s.canary.length > 0 && prose.includes(s.canary)) {
      hits.push({ check: 'secret', detail: `canary of undisclosed clause ${s.id}`, excerpt: s.canary });
      continue;
    }
    if (prose.includes(s.id)) {
      hits.push({ check: 'secret', detail: `id of undisclosed clause ${s.id}`, excerpt: s.id });
      continue;
    }
    const zh = stripPunct(s.text.zh);
    let found: string | null = null;
    for (let i = 0; i + 8 <= zh.length && !found; i++) {
      const window = zh.slice(i, i + 8);
      if (flatZh.includes(window)) found = window;
    }
    const enWords = s.text.en.toLowerCase().match(/[a-z0-9']+/g) ?? [];
    for (let i = 0; i + 6 <= enWords.length && !found; i++) {
      const window = enWords.slice(i, i + 6).join(' ');
      if (enJoined.includes(` ${window} `)) found = window;
    }
    if (found) hits.push({ check: 'secret', detail: `text of undisclosed clause ${s.id}`, excerpt: found });
  }
  return hits;
}

// ---------------------------------------------------------------------------------------------------------------

export function checkProse(input: CheckInput): CheckResult {
  const hits: CheckHit[] = [];
  checkNames(input, hits);
  checkPlaces(input, hits);
  checkNumerals(input.prose, hits);
  checkOutcomes(input.prose, hits);
  checkTerms(input.prose, hits);
  hits.push(...secretHits(input.prose, input.secrets ?? []));
  const counts: Record<CheckKind, number> = { name: 0, place: 0, quantity: 0, outcome: 0, terms: 0, secret: 0 };
  for (const h of hits) counts[h.check] += 1;
  return { version: CHECKER_VERSION, ok: hits.length === 0, hits, counts };
}
