/**
 * H16 for the oracle (PLAN §5, §9.4), re-implemented on the rendered text, independent of src/agents:
 * - header: the deterministic fact header is in the displayed text; it is re-derived from the committed events of
 *   the scene and compared — scene name, day, one line per fact, each line naming the fact's actor and its
 *   document/offer — so a substituted or misattributed header is caught;
 * - model prose (status `ok`): atmosphere only — any character or player name, alias, title or honorific, any place
 *   or polity name, any numeral (\p{N}, zh numeral characters, number/ordinal/magnitude words; closed list of
 *   lexicalized exemptions), outcome vocabulary, treaty/resource/spoils vocabulary, or canary/secret-clause text is
 *   a hit (a conservative lexical guard written from the plan's wording, not from the checker's lists);
 * - template prose (status `fallback`): it may carry names and quantities by design, so it is checked for
 *   consistency instead — no living character dead, no quantity absent from the facts/state, no agreement or
 *   arrival before it happened, no secret shown to a non-holder.
 * Implicit contradictions in free prose are out of scope (measured by human annotation).
 */
import type { ContentBundle } from '../../content/loader.js';
import type { CharId, CoreConfig, NarrationFact, WorldState } from '../../core/types.js';
import type { BNarration } from './bundle.js';
import type { Violation } from './checks.js';
import { CHARS, knowsClause, presentAt, threadsOf, HEDONG_KHITAN } from './world.js';

export type NameTable = Record<CharId, string[]>;

/** Names, places and the player's forms used by the H16 checks. */
export interface NarrationLexicon {
  chars: NameTable;
  player: string[];
  places: string[];
  /** Location id → display names (zh, en), for the header's scene line. */
  locations: Record<string, string[]>;
}

const STATIC_HONORIFICS = ['陛下', '主公', '明公', '大王', '可汗', '天子', '晋王', 'Your Majesty', 'my lord', 'His Majesty'];
const STATIC_PLACES = ['晋阳', '洛阳', '太原', '契丹', '河东', '雁门', '卢龙', '幽州', '云州', '幽云', '大唐', '唐军', '唐主', '唐帝', 'Jinyang', 'Luoyang', 'Taiyuan', 'Khitan', 'Hedong', 'Yanmen', 'Lulong', 'Tang'];

export const DEFAULT_NAMES: NameTable = {
  shi_jingtang: ['石敬瑭', 'Shi Jingtang'],
  sang_weihan: ['桑维翰', 'Sang Weihan'],
  liu_zhiyuan: ['刘知远', 'Liu Zhiyuan'],
  yelu_deguang: ['耶律德光', 'Yelü Deguang', 'Yelu Deguang'],
  li_congke: ['李从珂', 'Li Congke'],
};

export const DEFAULT_LEXICON: NarrationLexicon = {
  chars: DEFAULT_NAMES,
  player: ['书记', 'clerk'],
  places: STATIC_PLACES,
  locations: { jinyang_hq: ['晋阳', 'Jinyang'], khitan_court: ['契丹', 'Khitan'], luoyang_court: ['洛阳', 'Luoyang'] },
};

const stripNote = (s: string) => s.replace(/[（(].*?[）)]/g, '').trim();

/** Surface forms from content: character names, aliases and titles; the player's name and title; places. */
export function namesFromContent(content: ContentBundle): NarrationLexicon {
  const chars = {} as NameTable;
  for (const id of CHARS) {
    const ch = content.characters[id];
    const forms = new Set<string>(DEFAULT_NAMES[id]);
    if (ch) {
      for (const f of [ch.name.zh, ch.name.en, stripNote(ch.title.zh), stripNote(ch.title.en), ...ch.aliases.zh, ...ch.aliases.en]) forms.add(f);
    }
    chars[id] = [...forms].filter((f) => f.length >= 2);
  }
  const p = content.scenario.player;
  const locations: Record<string, string[]> = {};
  for (const l of content.scenario.locations) locations[l.id] = [l.name.zh, l.name.en];
  const places = new Set<string>([...STATIC_PLACES, ...content.scenario.locations.flatMap((l) => [l.name.zh, l.name.en]), ...content.scenario.factions.flatMap((f) => [f.name.zh, f.name.en])]);
  return {
    chars,
    player: [p.name.zh, p.name.en, stripNote(p.title.zh), stripNote(p.title.en)].filter((x) => x.length >= 2),
    places: [...places].filter((x) => x.length >= 2),
    locations,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Numerals and quantities
// ---------------------------------------------------------------------------------------------------------------

const ZH_DIGITS: Record<string, number> = { 〇: 0, 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const ZH_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

/** Parses a Chinese numeral (一 … 九, 十 百 千 万, 两, 〇). */
export function zhNumber(text: string): number {
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const ch of text) {
    if (ch in ZH_DIGITS) digit = ZH_DIGITS[ch] as number;
    else if (ch in ZH_UNITS) {
      section += (digit === 0 ? 1 : digit) * (ZH_UNITS[ch] as number);
      digit = 0;
    } else if (ch === '万') {
      total += (section + digit) * 10_000;
      section = 0;
      digit = 0;
    }
  }
  return total + section + digit;
}

export interface Quantity {
  value: number;
  unit: string;
  text: string;
}

const QTY_ZH = /([0-9][0-9,]*|[〇零一二两三四五六七八九十百千万]+)\s*(万)?\s*(匹|骑|州|日|天)/g;
const QTY_EN = /([0-9][0-9,]*)\s*(bolts|horsemen|horse|cavalry|riders|prefectures|days)\b/gi;

export function quantitiesIn(text: string): Quantity[] {
  const out: Quantity[] = [];
  for (const m of text.matchAll(QTY_ZH)) {
    const raw = m[1] as string;
    let value = /^[0-9]/.test(raw) ? Number(raw.replace(/,/g, '')) : zhNumber(raw);
    if (m[2]) value *= 10_000;
    out.push({ value, unit: m[3] as string, text: m[0] });
  }
  for (const m of text.matchAll(QTY_EN)) out.push({ value: Number((m[1] as string).replace(/,/g, '')), unit: (m[2] as string).toLowerCase(), text: m[0] });
  return out;
}

/** Every number that appears in a JSON value (numeric leaves, digits inside strings, array lengths). */
export function numbersIn(value: unknown, into: Set<number> = new Set()): Set<number> {
  if (typeof value === 'number') into.add(value);
  else if (typeof value === 'string') for (const m of value.matchAll(/\d+/g)) into.add(Number(m[0]));
  else if (Array.isArray(value)) {
    into.add(value.length);
    for (const x of value) numbersIn(x, into);
  } else if (value && typeof value === 'object') {
    for (const [k, x] of Object.entries(value)) {
      if (k === 'sixteen_prefectures' || x === 'sixteen_prefectures') into.add(16);
      numbersIn(x, into);
    }
  }
  return into;
}

// ---------------------------------------------------------------------------------------------------------------
// Model prose restrictions (§9.4)
// ---------------------------------------------------------------------------------------------------------------

const ZH_NUMERAL_CHARS = /[二三四五六七八九十百千万亿两廿卅零〇壹贰叁肆伍陆柒捌玖拾佰仟]/u;
const YI_EXEMPT = ['一切', '一直', '一起', '一样', '唯一', '一旦', '统一'];
const BAN_EXEMPT = ['半夜', '半空', '半晌'];
const EN_NUMBER_WORDS =
  /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|millions?|myriads?|dozens?|score|scores|half|halves|twice|thrice|double|triple|quarter|quarters|thirds?|couple|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|percent|fold)\b/i;
const EN_ONE = /\bone\b/gi;
const EN_ONE_EXEMPT = /\b(no one|someone|anyone|everyone|one another)\b/gi;

const OUTCOME_ZH = [
  '允诺', '应允', '允许', '答应', '许诺', '同意', '拒绝', '回绝', '婉拒', '撤回', '撤兵', '退兵', '遣使', '出使', '送达', '抵达', '到达', '来援', '援军', '援兵',
  '割地', '割让', '兵变', '哗变', '叛乱', '陷落', '城破', '破城', '投降', '归降', '攻陷', '死去', '身亡', '阵亡', '被杀', '遇害', '被擒', '被俘', '处死', '斩首',
  '结盟', '盟约', '和议', '订约', '立约', '中立', '已死', '驾崩',
];
const OUTCOME_EN = /\b(agree[sd]?|agreement|accept(s|ed|ance)?|refus(e|ed|al)|reject(s|ed|ion)?|withdr(aw|ew|awn|awal)|dispatch(ed)?|envoys?|arriv(e|ed|al)|deliver(ed|y)?|ced(e|ed)|cession|surrender(ed)?|mutin(y|ied|ous)|conquer(ed)?|captur(e|ed)|died|dead|death|killed|slain|executed|pact|alliance|allied|treaty|neutral(ity)?)\b/i;
const TERMS_ZH = ['帛', '府库', '岁币', '粮', '骑兵', '援骑', '称臣', '父礼', '和亲', '疆土', '州郡', '财货', '均分'];
const TERMS_EN = /\b(silk|treasury|tribute|prefectures?|cavalry|grain|vassal(age)?|marriage|territor(y|ies)|spoils)\b/i;

function hit(code: string, detail: string): Violation {
  return { rule: 'H16', detail, code };
}

function windows(text: string, size: number, words: boolean): string[] {
  const units = words ? text.split(/\s+/).filter(Boolean) : [...text.replace(/[\s\p{P}\p{S}]/gu, '')];
  if (units.length <= size) return units.length > 0 ? [units.join(words ? ' ' : '')] : [];
  const out: string[] = [];
  for (let i = 0; i + size <= units.length; i++) out.push(units.slice(i, i + size).join(words ? ' ' : ''));
  return out;
}

function secretFindings(prose: string, scene: NarrationScene, config: CoreConfig): Violation[] {
  const out: Violation[] = [];
  const s = scene.state;
  const present = presentAt(s, scene.narration.scene);
  const compactZh = prose.replace(/[\s\p{P}\p{S}]/gu, '');
  for (const [id, def] of Object.entries(config.catalog.secretClauses)) {
    const shown =
      (def.canary.length >= 4 && prose.includes(def.canary)) ||
      windows(def.text.zh, 8, false).some((w) => w.length >= 8 && compactZh.includes(w)) ||
      windows(def.text.en, 6, true).some((w) => w.split(' ').length >= 6 && prose.includes(w));
    if (!shown) continue;
    const outsiders = present.filter((p) => !knowsClause(s, config, p, id));
    if (outsiders.length > 0 || present.length === 0) out.push(hit('secret', `secret clause ${id} shown in ${scene.narration.scene} to non-holders ${outsiders.join(', ') || '(nobody present)'}`));
  }
  return out;
}

/** §9.4 restrictions on model prose: atmosphere only. */
export function restrictionFindings(prose: string, scene: NarrationScene, config: CoreConfig, lex: NarrationLexicon): Violation[] {
  const out: Violation[] = [];
  const lower = prose.toLowerCase();
  const has = (form: string) => (/[a-z]/i.test(form) ? new RegExp(`\\b${form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(prose) : prose.includes(form));
  for (const id of CHARS) for (const form of lex.chars[id]) if (has(form)) out.push(hit('name', `character name "${form}" in prose`));
  for (const form of [...lex.player, ...STATIC_HONORIFICS]) if (has(form)) out.push(hit('name', `name/title/honorific "${form}" in prose`));
  for (const form of lex.places) if (has(form)) out.push(hit('place', `place or polity "${form}" in prose`));
  // Numerals: any \p{N}; zh numeral characters; 一 / 半 outside the closed exemption lists; en number words.
  if (/\p{N}/u.test(prose)) out.push(hit('quantity', 'numeric character in prose'));
  if (ZH_NUMERAL_CHARS.test(prose)) out.push(hit('quantity', 'Chinese numeral in prose'));
  let yi = prose;
  for (const w of YI_EXEMPT) yi = yi.split(w).join('');
  if (yi.includes('一')) out.push(hit('quantity', '"一" outside the lexicalized exemptions'));
  let ban = prose;
  for (const w of BAN_EXEMPT) ban = ban.split(w).join('');
  if (ban.includes('半')) out.push(hit('quantity', '"半" outside the lexicalized exemptions'));
  if (EN_NUMBER_WORDS.test(prose)) out.push(hit('quantity', 'number word in prose'));
  if (lower.replace(EN_ONE_EXEMPT, '').match(EN_ONE)) out.push(hit('quantity', '"one" outside no one / one another'));
  // Outcomes, treaty terms, resources.
  for (const w of OUTCOME_ZH) if (prose.includes(w)) out.push(hit('outcome', `outcome word "${w}" in prose`));
  const en = OUTCOME_EN.exec(prose);
  if (en) out.push(hit('outcome', `outcome word "${en[0]}" in prose`));
  for (const w of TERMS_ZH) if (prose.includes(w)) out.push(hit('terms', `treaty/resource word "${w}" in prose`));
  const te = TERMS_EN.exec(prose);
  if (te) out.push(hit('terms', `treaty/resource word "${te[0]}" in prose`));
  out.push(...secretFindings(prose, scene, config));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Template (fallback) prose: consistency with the committed facts
// ---------------------------------------------------------------------------------------------------------------

const DEATH_ZH = ['已死', '死于', '身死', '死去', '之死', '卒于', '薨', '崩殂', '殁', '殒命', '被杀', '遇害', '身亡', '阵亡', '被擒', '被俘', '就擒', '伏诛', '自尽', '自焚'];
const DEATH_EN = /\b(died|dies|dead|killed|slain|captured|executed|perished)\b/i;
const AGREE_ZH = ['盟约已成', '盟约成立', '盟成', '和议已成', '约已成', '已允其请', '许其所请', '允其所请', '定盟', '结盟已成'];
const AGREE_EN = /\b(agreed to the|accepted the (terms|offer|request)|pact (was|is|has been) (concluded|sealed)|alliance (was|is|has been) sealed)\b/i;
const ARRIVE_ZH = ['援军已至', '援兵已至', '援骑已至', '契丹兵至', '契丹军至', '援军到达城下', '援军至城下'];
const ARRIVE_EN = /\b(relief|khitan cavalry|reinforcements)\b[^.]{0,30}\barrived\b/i;

function clauses(text: string): string[] {
  return text.split(/[。！？；，、\n.!?;,]/).filter((c) => c.trim().length > 0);
}

export interface NarrationScene {
  narration: BNarration;
  /** State after the narrated events. */
  state: WorldState;
  facts: NarrationFact[];
  /** Days of the narrated events. */
  days?: number[];
}

export function proseOf(n: BNarration): string {
  if (n.header && n.displayed.startsWith(n.header)) return n.displayed.slice(n.header.length);
  if (n.header && n.displayed.includes(n.header)) return n.displayed.replace(n.header, '');
  return n.displayed;
}

/** Consistency of template prose (and of any text): death of the living, unsupported quantities, early claims, secrets. */
export function consistencyFindings(prose: string, scene: NarrationScene, config: CoreConfig, lex: NarrationLexicon): Violation[] {
  const out: Violation[] = [];
  const s = scene.state;
  for (const clause of clauses(prose)) {
    for (const id of CHARS) {
      if (s.characters[id]?.status !== 'alive') continue;
      for (const form of lex.chars[id]) {
        const at = clause.indexOf(form);
        if (at < 0) continue;
        const rest = clause.slice(at + form.length);
        if (DEATH_ZH.some((w) => rest.includes(w)) || DEATH_EN.test(rest)) out.push(hit('name_status', `death/capture of living ${id}: "${clause.trim()}"`));
      }
    }
  }
  const allowed = numbersIn(scene.facts);
  for (const part of [s.factions, s.offers, s.documents, s.siege, s.flags, config.travel]) numbersIn(part, allowed);
  allowed.add(s.day);
  allowed.add(s.round);
  for (const key of ['round_days', 'intel_delay_days'] as const) allowed.add(config.params[key]);
  for (const q of quantitiesIn(prose)) if (!allowed.has(q.value)) out.push(hit('quantity', `unsupported quantity "${q.text}" (${q.value})`));
  const confirmed = Object.values(s.commitments).some((t) => t.status === 'confirmed');
  if (!confirmed && (AGREE_ZH.some((w) => prose.includes(w)) || AGREE_EN.test(prose))) out.push(hit('outcome', 'agreement claimed but no thread is confirmed'));
  const arrived = s.flags.khitanArrivalDay !== null && s.day >= s.flags.khitanArrivalDay;
  if (!arrived && (ARRIVE_ZH.some((w) => prose.includes(w)) || ARRIVE_EN.test(prose))) out.push(hit('outcome', 'relief arrival claimed before it happened'));
  out.push(...secretFindings(prose, scene, config));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Header: re-derived from the committed facts of the scene
// ---------------------------------------------------------------------------------------------------------------

type FactData = Record<string, unknown>;

const num = (d: FactData, k: string): number | null => (typeof d[k] === 'number' ? (d[k] as number) : null);
const str = (d: FactData, k: string): string | null => (typeof d[k] === 'string' ? (d[k] as string) : null);

/** Numeric terms a terms rendering must state (non-default amounts and the sealed-clause count). */
function termNumbers(t: unknown): number[] {
  if (typeof t !== 'object' || t === null) return [];
  const terms = t as Record<string, unknown>;
  const out: number[] = [];
  for (const k of ['annual_silk', 'immediate_silk', 'aid_cavalry', 'aid_arrival_days']) if (typeof terms[k] === 'number' && (terms[k] as number) > 0) out.push(terms[k] as number);
  const clauses = terms.secret_clause_ids;
  if (Array.isArray(clauses) && clauses.length > 0) out.push(clauses.length);
  return out;
}

/**
 * The expected content of one header line, re-derived from the committed fact (independent of the renderer's
 * wording): values that must be stated (versions, amounts, days, the terms' amounts), ids that must be named and
 * the parties (besides the actor) that must be named. Kinds not listed here only get the generic checks.
 */
export function expectedLine(f: NarrationFact): { numbers: number[]; ids: string[]; parties: string[] } {
  const d = f.data as FactData;
  const nums = (...xs: Array<number | null>) => xs.filter((x): x is number => x !== null);
  const ids = (...xs: Array<string | null>) => xs.filter((x): x is string => x !== null);
  const parties = (...xs: Array<string | null>) => xs.filter((x): x is string => x !== null && x !== f.actor && (CHARS as readonly string[]).includes(x));
  switch (f.kind) {
    case 'document_revised':
      return { numbers: [...nums(num(d, 'version')), ...termNumbers(d.terms)], ids: ids(str(d, 'docId')), parties: [] };
    case 'document_approved':
      return { numbers: nums(num(d, 'version')), ids: ids(str(d, 'docId')), parties: [] };
    case 'document_dispatched':
      return { numbers: nums(num(d, 'docVersion'), num(d, 'arrivalDay')), ids: ids(str(d, 'docId'), str(d, 'offerId')), parties: parties(str(d, 'to')) };
    case 'terms_proposed':
      return { numbers: [...nums(num(d, 'arrivalDay')), ...termNumbers(d.terms)], ids: ids(str(d, 'offerId')), parties: parties(str(d, 'to')) };
    case 'offer_countered':
      return { numbers: [...nums(num(d, 'termsVersion'), num(d, 'arrivalDay')), ...termNumbers(d.terms)], ids: ids(str(d, 'counterOfferId')), parties: parties(str(d, 'to')) };
    case 'offer_rejected':
      return { numbers: [], ids: ids(str(d, 'offerId')), parties: parties(str(d, 'to')) };
    case 'commitment_confirmed':
      return { numbers: [...nums(num(d, 'termsVersion'), num(d, 'khitanArrivalDay')), ...termNumbers(d.terms)], ids: ids(str(d, 'offerId')), parties: parties(str(d, 'to')) };
    case 'resources_allocated':
      return { numbers: nums(num(d, 'amount'), num(d, 'pressure'), num(d, 'morale')), ids: [], parties: [] };
    case 'suggestion_made':
      return { numbers: nums(num(d, 'targetVersion')), ids: ids(str(d, 'targetId')), parties: [] };
    case 'terminal':
      return { numbers: d.terminal === 'pact_concluded' ? nums(num(d, 'khitanArrivalDay')) : [], ids: [], parties: [] };
    default:
      return { numbers: [], ids: [], parties: [] };
  }
}

/**
 * Outcome vocabulary of header lines and the facts that license it: a word may appear only in the line of a fact
 * whose kind (and, for endings, terminal kind) states that outcome.
 */
const OUTCOME_LICENSE: ReadonlyArray<{ words: RegExp; ok: (f: NarrationFact) => boolean }> = [
  { words: /结局|ending/i, ok: (f) => f.kind === 'terminal' },
  { words: /盟约成立|pact is concluded/i, ok: (f) => f.kind === 'terminal' && (f.data as FactData).terminal === 'pact_concluded' },
  { words: /陷落|城破|jinyang falls|has fallen/i, ok: (f) => f.kind === 'terminal' && (f.data as FactData).terminal === 'jinyang_falls' },
  { words: /和议不成|talks failed/i, ok: (f) => f.kind === 'terminal' && (f.data as FactData).terminal === 'talks_failed' },
  { words: /不求外援|no foreign assistance/i, ok: (f) => f.kind === 'terminal' && (f.data as FactData).terminal === 'no_assistance' },
  { words: /拒绝|reject|refus/i, ok: (f) => f.kind === 'offer_rejected' || (f.kind === 'response_delivered' && (f.data as FactData).response === 'reject') || f.kind === 'terminal' },
  { words: /允.{0,8}之约|成约：|accepted|confirmed the/i, ok: (f) => f.kind === 'commitment_confirmed' || (f.kind === 'response_delivered' && (f.data as FactData).response === 'accept') },
  { words: /还价|counter/i, ok: (f) => f.kind === 'offer_countered' || (f.kind === 'response_delivered' && (f.data as FactData).response === 'counter') },
  { words: /兵变|哗变|mutin/i, ok: (f) => f.kind === 'mutiny_outbreak' || f.kind === 'mutiny_averted_for_now' },
  { words: /撤回|withdr/i, ok: (f) => f.kind.startsWith('withdrawal') || f.kind === 'authorization_revoked' },
  { words: /放弃|abandon/i, ok: (f) => f.kind === 'assistance_abandoned' },
  { words: /身死|已死|阵亡|died|killed/i, ok: (f) => f.kind === 'character_death' },
  { words: /批准|approved/i, ok: (f) => f.kind === 'document_approved' },
];

export function headerFindings(scene: NarrationScene, lex: NarrationLexicon): Violation[] {
  const n = scene.narration;
  const out: Violation[] = [];
  if (n.status === 'failed') return out;
  if (scene.facts.length > 0 && n.header.trim().length === 0) return [hit('header', 'missing fact header')];
  if (n.header && !n.displayed.includes(n.header)) out.push(hit('header', 'displayed text does not contain the fact header'));
  const lines = n.header.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const head = lines[0] ?? '';
  const factLines = lines.slice(1).filter((l) => l.startsWith('·'));
  const sceneNames = lex.locations[n.scene] ?? [];
  if (sceneNames.length > 0 && !sceneNames.some((name) => head.includes(name))) out.push(hit('header', `scene line does not name ${n.scene}`));
  const day = /第(\d+)日|day (\d+)/i.exec(head);
  const days = scene.days ?? [scene.state.day];
  if (day && !days.includes(Number(day[1] ?? day[2]))) out.push(hit('header', `header day ${day[1] ?? day[2]} differs from the narrated events (${days.join(', ')})`));
  if (factLines.length !== scene.facts.length) out.push(hit('header', `header has ${factLines.length} fact line(s) for ${scene.facts.length} committed fact(s)`));
  scene.facts.forEach((f, i) => {
    const line = factLines[i];
    if (line === undefined) return;
    if (f.actor && (CHARS as readonly string[]).includes(f.actor) && !lex.chars[f.actor as CharId].some((form) => line.includes(form))) {
      out.push(hit('header', `fact line ${i + 1} (${f.kind}) does not name its actor ${f.actor}`));
    }
    const want = expectedLine(f);
    const stated = [...line.replace(/(\d),(?=\d{3}\b)/g, '$1').matchAll(/\d+/g)].map((m) => Number(m[0]));
    const licensed = numbersIn(f.data);
    for (const v of stated) if (!licensed.has(v)) out.push(hit('header', `fact line ${i + 1} (${f.kind}) states ${v}, not in the committed fact`));
    for (const v of want.numbers) if (!stated.includes(v)) out.push(hit('header', `fact line ${i + 1} (${f.kind}) omits ${v}`));
    for (const id of want.ids) if (!line.includes(id)) out.push(hit('header', `fact line ${i + 1} (${f.kind}) does not name ${id}`));
    for (const p of want.parties) if (!lex.chars[p as CharId].some((form) => line.includes(form))) out.push(hit('header', `fact line ${i + 1} (${f.kind}) does not name ${p}`));
    for (const o of OUTCOME_LICENSE) {
      const m = o.words.exec(line);
      if (m && !o.ok(f)) out.push(hit('header', `fact line ${i + 1} (${f.kind}) states "${m[0]}", which that fact does not license`));
    }
  });
  return out;
}

export interface NarrationResult {
  narrationId: number;
  scene: string;
  status: string;
  displayed: Violation[];
  raw: Violation[];
}

/** The model's prose from a stored raw output (the JSON {prose, mentioned_facts}, or plain text). */
export function rawProseOf(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { prose?: unknown };
    if (parsed && typeof parsed.prose === 'string') return parsed.prose;
  } catch {
    /* plain text */
  }
  return raw;
}

export function checkNarration(scene: NarrationScene, config: CoreConfig, lex: NarrationLexicon): NarrationResult {
  const n = scene.narration;
  const prose = proseOf(n);
  const displayed =
    n.status === 'failed'
      ? []
      : [...headerFindings(scene, lex), ...(n.status === 'ok' ? restrictionFindings(prose, scene, config, lex) : consistencyFindings(prose, scene, config, lex))];
  const rawProse = n.raw && n.status !== 'ok' ? rawProseOf(n.raw) : null;
  const raw = rawProse ? restrictionFindings(rawProse, scene, config, lex) : [];
  return { narrationId: n.narrationId, scene: n.scene, status: n.status, displayed, raw };
}

/** True if any thread of the assistance pair is confirmed (helper for claims elsewhere). */
export function pactConfirmed(s: WorldState): boolean {
  return threadsOf(s, HEDONG_KHITAN).some((t) => t.status === 'confirmed');
}
