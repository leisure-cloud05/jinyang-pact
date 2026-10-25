// Fidelity and eligibility checks for content/sources/zztj_280.yaml (PLAN §9.2, §12.1).
// Read-only: parses the YAML with the repository's `yaml` package and compares every original_zh with the
// raw Wikisource snapshots in content/notes/raw/. No network access.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCES_FILE = join(ROOT, 'content', 'sources', 'zztj_280.yaml');
const RAW_DIR = join(ROOT, 'content', 'notes', 'raw');

const URL_TO_SNAPSHOT: Record<string, string> = {
  'https://zh.wikisource.org/wiki/資治通鑑/卷280': 'zztj_280',
  'https://zh.wikisource.org/wiki/舊五代史/卷75': 'jwds_075',
  'https://zh.wikisource.org/wiki/舊五代史/卷137': 'jwds_137',
  'https://zh.wikisource.org/wiki/新五代史/卷10': 'xwds_010',
  'https://zh.wikisource.org/wiki/新五代史/卷29': 'xwds_029',
  'https://zh.wikisource.org/wiki/新五代史/卷72': 'xwds_072',
  'https://zh.wikisource.org/wiki/遼史/卷3': 'ls_003',
  'https://zh.wikisource.org/wiki/遼史/卷4': 'ls_004',
};
const HOLDERS = ['shi_jingtang', 'sang_weihan', 'liu_zhiyuan', 'yelu_deguang', 'li_congke', 'player'];
const REQUIRED_FIELDS = [
  'id', 'work', 'volume', 'locator', 'url', 'original_zh', 'gloss_en', 'persons', 'event_time', 'location',
  'topics', 'kind', 'learnable_by', 'derived_from', 'conflicts_with', 'credibility', 'credibility_note',
];
const OPTIONAL_FIELDS = ['retrospective_note'];
const LEAP_MONTH_ENTRIES = ['zztj280-021', 'zztj280-022', 'zztj280-023', 'zztj280-024', 'zztj280-025'];
const UNDATED_SKETCHES = ['xwds-010-001', 'xwds-029-001', 'xwds-072-001'];
const OUTCOME_TOPICS = [
  'khitan_response', 'khitan_arrival', 'battle', 'investiture', 'rival_bid', 'persuasion', 'stone_oath',
  'surrender', 'zhang_jingda_death', 'li_congke_end', 'implementation',
];
// Wording that would reveal events after the scenario start (drafting of the request, early 七月 936):
// the dispatch, the Khitan reply and relief, the investiture, the cession, later titles, dynasties and eras.
const FUTURE_PATTERNS: RegExp[] = [
  /\bHan\b/, /Later Jin/i, /\bJin (dynasty|emperor)\b/i, /emperor of (the )?(Great )?Jin/i, /Gaozu/, /Taizong/,
  /Tianfu/, /Huitong/, /\baccept(ed|s|ance|ing)?\b/i, /\brelie(f|ve|ved)\b/i, /\binvest(iture|ed)?\b/i,
  /enthron/i, /\bceded\b/i, /sixteen prefectures/i, /reached the Khitan/i, /chancellor/i, /dynasty/i,
  /\b9(3[7-9]|[4-9]\d)\b/, /高祖/, /太宗/, /天福/, /後晉/, /晉書/, /漢本紀/, /晉臣/, /即皇帝位/, /十六州/,
  /敬瑭不從/, /遣間使/, /表至/, /仲秋/, /赴援/, /自焚/, /石爛/, /降於契丹/, /會同/, /冊/,
  // later dynasties, eras and dates (historiographic remarks belong in retrospective_note);
  // 'Song' alone is a personal name here (Li Song, Song Shenqian), so only dynastic uses are matched
  /\b(Northern |Southern )?Song[- ](dynasty|period|era|court|histor)/i, /\bYuan\b/, /\bMing\b/, /\bQing\b/, /Yongle/, /\bLiao\b/, /\b1\d{3}\b/, /\d+(st|nd|rd|th)-century/i,
];

interface EventTime { year: number; month: number | null; leap: boolean; lunar: boolean; note: string }
interface Learnable { holder: string; when: string }
interface SourceEntry {
  id: string; work: string; volume: number; locator: string; url: string; original_zh: string; gloss_en: string;
  persons: string[]; event_time: EventTime; location: string; topics: string[]; kind: string;
  learnable_by: Learnable[]; derived_from: string[]; conflicts_with: string[]; credibility: number;
  credibility_note: string; retrospective_note?: string;
}

/** Rendered main text: keep {{YL|…}} year labels, drop every other template (incl. {{*|…}} annotations),
 *  refs, HTML tags, -{…}- conversion markup and link brackets. Mirrors the build script's check. */
function renderMainText(raw: string): string {
  let t = raw.replace(/<ref[^>]*\/>/g, '').replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, '');
  t = t.replace(/\{\{YL\|([^{}|]*)\}\}/g, '$1');
  for (;;) {
    const next = t.replace(/\{\{[^{}]*\}\}/g, '');
    if (next === t) break;
    t = next;
  }
  t = t.replace(/-\{([^{}]*)\}-/g, '$1').replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1');
  return t.replace(/<[^>]+>/g, '');
}

const doc = parseDocument(readFileSync(SOURCES_FILE, 'utf8'), { uniqueKeys: true });
const entries = doc.toJS() as SourceEntry[];
const snapshots = new Map<string, { raw: string; rendered: string }>();
for (const name of new Set(Object.values(URL_TO_SNAPSHOT))) {
  const raw = readFileSync(join(RAW_DIR, `${name}.wikitext`), 'utf8');
  snapshots.set(name, { raw, rendered: renderMainText(raw) });
}
const initialEntries = entries.filter((e) => e.learnable_by.some((l) => l.when === 'initial'));

describe('content/sources/zztj_280.yaml', () => {
  it('parses without YAML errors or warnings and has 25–40 unique entries', () => {
    expect(doc.errors.map(String)).toEqual([]);
    expect(doc.warnings.map(String)).toEqual([]);
    expect(entries.length).toBeGreaterThanOrEqual(25);
    expect(entries.length).toBeLessThanOrEqual(40);
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
  });

  it('has exactly the §12.1 fields (plus optional retrospective_note)', () => {
    for (const e of entries) {
      const keys = Object.keys(e);
      for (const f of REQUIRED_FIELDS) expect(keys, `${e.id} missing ${f}`).toContain(f);
      for (const k of keys) expect([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS], `${e.id} unexpected ${k}`).toContain(k);
    }
  });

  it.each(entries.map((e) => [e.id, e] as const))('%s: original_zh is an exact substring of its snapshot', (_id, e) => {
    const snapshot = URL_TO_SNAPSHOT[e.url];
    expect(snapshot, `unknown url ${e.url}`).toBeDefined();
    const text = snapshots.get(snapshot ?? '');
    expect(e.original_zh.length).toBeGreaterThan(0);
    expect(text?.raw.includes(e.original_zh)).toBe(true);
    // also present in the rendered main text, i.e. not taken from an editors' annotation
    expect(text?.rendered.includes(e.original_zh)).toBe(true);
  });

  it('event_time follows {year, month|null, leap, lunar: true, note}', () => {
    for (const e of entries) {
      const t = e.event_time;
      expect(Object.keys(t).sort(), e.id).toEqual(['leap', 'lunar', 'month', 'note', 'year']);
      expect(Number.isInteger(t.year), e.id).toBe(true);
      expect(t.month === null || (Number.isInteger(t.month) && t.month >= 1 && t.month <= 12), e.id).toBe(true);
      expect(typeof t.leap, e.id).toBe('boolean');
      expect(t.lunar, e.id).toBe(true);
      if (t.leap) expect(t.month, e.id).not.toBeNull();
      expect(t.leap, e.id).toBe(LEAP_MONTH_ENTRIES.includes(e.id));
    }
    for (const id of LEAP_MONTH_ENTRIES) expect(entries.find((e) => e.id === id)?.event_time.month).toBe(11);
    for (const id of UNDATED_SKETCHES) expect(entries.find((e) => e.id === id)?.event_time.month).toBeNull();
  });

  it('lists all six holders once, with valid eligibility, and never makes an outcome initial', () => {
    for (const e of entries) {
      expect(e.learnable_by.map((l) => l.holder), e.id).toEqual(HOLDERS);
      for (const l of e.learnable_by) expect(['initial', 'never_initial'], e.id).toContain(l.when);
    }
    for (const e of initialEntries) {
      expect(e.topics.filter((t) => OUTCOME_TOPICS.includes(t)), e.id).toEqual([]);
    }
  });

  it('keeps future outcomes out of every field of initial entries except retrospective_note', () => {
    const hits: string[] = [];
    for (const e of initialEntries) {
      const fields: Record<string, string> = {
        original_zh: e.original_zh,
        gloss_en: e.gloss_en,
        credibility_note: e.credibility_note,
        'event_time.note': e.event_time.note,
        locator: e.locator,
      };
      for (const [field, value] of Object.entries(fields)) {
        for (const p of FUTURE_PATTERNS) if (p.test(value)) hits.push(`${e.id}.${field} ~ ${p}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('has resolvable, symmetric cross-references', () => {
    const ids = new Set(entries.map((e) => e.id));
    for (const e of entries) {
      for (const ref of [...e.derived_from, ...e.conflicts_with]) expect(ids.has(ref), `${e.id} -> ${ref}`).toBe(true);
      for (const ref of e.conflicts_with) {
        expect(entries.find((x) => x.id === ref)?.conflicts_with, `${ref} should list ${e.id}`).toContain(e.id);
      }
    }
  });
});
