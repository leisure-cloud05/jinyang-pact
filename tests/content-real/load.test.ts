/**
 * WP-B2: the real chapter content loads through src/content/loader.ts and satisfies the content rules of PLAN §4,
 * §6, §8.2, §9.2, §10.3 and §12 that the loader itself does not check (history vs assumption, no post-start facts
 * in anything a character sees, canary isolation, reachability of the case set-ups).
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildInitialState, caseInitialState } from '../../src/content/loader.js';
import { GameParamsSchema, preferenceFor, resourceAmount } from '../../src/content/schema.js';
import { hashValue } from '../../src/core/hash.js';
import { FEASIBLE_OPTIONS } from '../../src/core/pauses.js';
import { projectSiege } from '../../src/core/projection.js';
import { expandTermArgs, withinLimits } from '../../src/core/terms.js';
import { clauseFromCatalog } from '../../src/core/knowledge.js';
import { NO_LIMITS } from '../../src/core/terms.js';
import { CHAR_IDS, SCALAR_TERM_KEYS, type CharId, type PauseCategory, type TermLimits, type TermSet } from '../../src/core/types.js';
import type { TermSetArgs } from '../../src/core/actions.js';
import {
  CASE_IDS,
  CONTENT_ROOT,
  DEV_IDS,
  PILOT_IDS,
  TRACE_IDS,
  configOf,
  content,
  coreConfig,
  isInitialFor,
  caseConfig,
} from './helpers.js';

/** PLAN §4 default permissions ("may perform" column). */
const PLAN_PERMISSIONS: Record<CharId | 'player', string[]> = {
  shi_jingtang: [
    'speak', 'send_letter', 'revise_document', 'suggest_revision', 'approve_document', 'set_dispatch_timing',
    'dispatch_document', 'propose_terms', 'respond_to_offer', 'withdraw_offer', 'confirm_commitment',
    'allocate_resources', 'abandon_request', 'wait',
  ],
  sang_weihan: ['speak', 'send_letter', 'revise_document', 'suggest_revision', 'wait'],
  liu_zhiyuan: ['speak', 'suggest_revision', 'wait'],
  yelu_deguang: ['speak', 'send_letter', 'propose_terms', 'respond_to_offer', 'withdraw_offer', 'confirm_commitment', 'allocate_resources', 'wait'],
  li_congke: ['speak', 'send_letter', 'propose_terms', 'respond_to_offer', 'withdraw_offer', 'confirm_commitment', 'allocate_resources', 'wait'],
  player: ['speak', 'revise_document', 'suggest_revision', 'set_dispatch_timing', 'dispatch_document', 'revoke_authorization', 'wait'],
};

/** PLAN §8.2: principals shi, yelu, li, then sang, liu. */
const PLAN_PRIORITY: Record<CharId, number> = { shi_jingtang: 1, yelu_deguang: 2, li_congke: 3, sang_weihan: 4, liu_zhiyuan: 5 };

/**
 * Post-start wording that must never appear in a character file (outcomes, later titles, dynasties and eras).
 * The character files are the persona config serialized into character contexts (§9.2).
 */
const FUTURE_WORDS = [
  '十六州', '儿皇帝', '兒皇帝', '后晋', '後晉', '晋高祖', '晉高祖', '高祖', '太宗', '天福', '会同', '會同', '辽', '遼',
  '即皇帝位', '册', '冊', '石烂', '石爛', '自焚', '柳林', '仲秋', '赵德钧', '趙德鈞', '杨光远', '楊光遠', '后汉', '後漢',
  '三十万匹', '三十萬匹', 'Later Jin', 'Great Jin', 'Later Han', 'Gaozu', 'Taizong', 'Liao', 'investiture', 'invested',
  'son emperor', 'sixteen prefectures', 'Sixteen Prefectures', 'Zhao Dejun', 'Yang Guangyuan', 'mid-autumn', '300,000',
];

/** Categories a run can raise in the chapter's cases (death/allegiance are synthetic-only, §6). */
const POLICY_CATEGORIES: PauseCategory[] = [
  'dispatch_request', 'major_commitment', 'strategic_turn', 'mutiny', 'negotiation_deadlock', 'internal_disagreement',
  'goal_conflict', 'risky_delay', 'ambiguity', 'prompt_request', 'error_recovery',
];

function yamlText(rel: string): string {
  return readFileSync(path.join(CONTENT_ROOT, rel), 'utf8');
}

function filesIn(dir: string): string[] {
  return readdirSync(path.join(CONTENT_ROOT, dir)).filter((f) => f.endsWith('.yaml')).map((f) => `${dir}/${f}`);
}

function termsOf(args: TermSetArgs): TermSet {
  const expanded = expandTermArgs(args, (id) => clauseFromCatalog(coreConfig(), id));
  if (!expanded.ok) throw new Error(`unknown clauses ${expanded.unknownClauseIds.join(', ')}`);
  return expanded.terms;
}

function limits(partial: Partial<TermLimits>): TermLimits {
  return { ...NO_LIMITS, ...partial };
}

describe('real content: loading', () => {
  it('loads every section through the loader with cross-reference validation', () => {
    const b = content();
    expect(Object.keys(b.characters).sort()).toEqual([...CHAR_IDS].sort());
    expect(Object.keys(b.cases).sort()).toEqual([...CASE_IDS]);
    expect(Object.keys(b.dev).sort()).toEqual([...DEV_IDS]);
    expect(Object.keys(b.pilot).sort()).toEqual([...PILOT_IDS]);
    expect(Object.keys(b.traces).sort()).toEqual([...TRACE_IDS].sort());
    expect(Object.keys(b.sources)).toHaveLength(40);
  });

  it('states every G parameter explicitly, with the PLAN §6 defaults', () => {
    const text = yamlText('scenario/jinyang.yaml');
    const defaults = GameParamsSchema.parse({});
    for (const key of Object.keys(defaults)) expect(text).toMatch(new RegExp(`^\\s+${key}:`, 'm'));
    expect(content().scenario.parameters).toEqual(defaults);
  });

  it('has the G02 travel matrix and all three scenes', () => {
    const c = coreConfig();
    expect(c.travel.jinyang_hq.khitan_court).toBe(5);
    expect(c.travel.jinyang_hq.luoyang_court).toBe(5);
    expect(c.travel.luoyang_court.khitan_court).toBe(10);
  });

  it('marks every faction resource set as a labelled game assumption', () => {
    for (const f of content().scenario.factions) {
      expect(f.assumption).toBe(true);
      expect(f.assumption_note?.zh.length ?? 0).toBeGreaterThan(5);
      expect(f.assumption_note?.en.length ?? 0).toBeGreaterThan(5);
      // Every resource carries its own labelled assumption with a rationale in both languages.
      for (const [key, seed] of Object.entries(f.resources)) {
        expect(typeof seed, `${f.id}.${key}`).toBe('object');
        if (seed === undefined || typeof seed === 'number') continue;
        expect(seed.assumption, `${f.id}.${key}`).toBe(true);
        expect(seed.assumption_note?.zh.length ?? 0).toBeGreaterThan(10);
        expect(seed.assumption_note?.en.length ?? 0).toBeGreaterThan(20);
        expect(resourceAmount(seed)).toBeGreaterThan(0);
      }
    }
    const s = buildInitialState(content());
    expect(s.factions.hedong.resources).toMatchObject({ grain: 60, silk: 200000 });
    expect(s.factions.khitan.resources.cavalry).toBe(60000);
    expect(s.factions.tang.resources).toMatchObject({ reserve_troops: 25000, silk: 300000 });
    expect(s.siege).toEqual({ pressure: 40, morale: 60 });
  });

  it('documents yanmen_north as a game-design partial level and covers every term key', () => {
    const catalog = content().scenario.terms_catalog.terms;
    expect(catalog.map((t) => t.key).sort()).toEqual([...SCALAR_TERM_KEYS].sort());
    const cession = catalog.find((t) => t.key === 'cession');
    expect(cession?.note?.en).toMatch(/game-design partial level/i);
    expect(cession?.value_labels?.yanmen_north).toBeDefined();
  });

  it('mirrors the recorded draft (zztj280-012) in doc:1 for the three recorded terms', () => {
    const doc = buildInitialState(content()).documents['doc:1'];
    expect(doc?.terms).toMatchObject({ vassal: true, filial: true, cession: 'sixteen_prefectures', annual_silk: 0 });
    expect(doc?.accessibleBy).toEqual(['shi_jingtang', 'sang_weihan', 'liu_zhiyuan', 'player']);
    expect(coreConfig().correspondence.shi_jingtang).toEqual(['sang_weihan', 'player']);
  });
});

describe('real content: characters (PLAN §4, §8.2, §10.3, §12.3)', () => {
  it('uses exactly the PLAN §4 default permissions and the §8.2 commit priorities', () => {
    const b = content();
    for (const id of CHAR_IDS) {
      expect([...b.characters[id].permissions].sort()).toEqual([...PLAN_PERMISSIONS[id]].sort());
      expect(b.characters[id].commitPriority).toBe(PLAN_PRIORITY[id]);
    }
    expect([...b.scenario.player.permissions].sort()).toEqual([...PLAN_PERMISSIONS.player].sort());
  });

  it('activates Li every second round and gives Yelü/Li reservations and Shi a tolerance', () => {
    const c = content().characters;
    expect(c.li_congke.periodicActivation?.every_rounds).toBe(2);
    for (const id of ['shi_jingtang', 'sang_weihan', 'liu_zhiyuan', 'yelu_deguang'] as const) expect(c[id].periodicActivation).toBeNull();
    expect(c.yelu_deguang.reservation).not.toBeNull();
    expect(c.li_congke.reservation).not.toBeNull();
    expect(c.shi_jingtang.tolerance).not.toBeNull();
  });

  it('cites only sources that are `initial` for the character itself', () => {
    for (const id of CHAR_IDS) {
      const c = content().characters[id];
      const refs = [
        ...c.source_refs,
        ...c.history_vs_assumption.flatMap((h) => h.source_refs),
        ...c.initial_knowledge.flatMap((k) => (k.source_ref ? [k.source_ref] : [])),
      ];
      for (const ref of refs) expect(isInitialFor(ref, id), `${id} cites ${ref}`).toBe(true);
      expect(c.history_vs_assumption.some((h) => h.basis === 'history')).toBe(true);
      expect(c.history_vs_assumption.some((h) => h.basis === 'assumption')).toBe(true);
    }
  });

  it('contains no post-start facts, outcome wording or non-initial source ids in any character file', () => {
    for (const id of CHAR_IDS) {
      const text = yamlText(`characters/${id}.yaml`);
      for (const word of FUTURE_WORDS) expect(text.includes(word), `${id} mentions "${word}"`).toBe(false);
      for (const ref of text.match(/\b(?:zztj280|jwds-\d{3}|xwds-\d{3}|ls-\d{3})-\d{3}\b/g) ?? []) {
        expect(isInitialFor(ref, id), `${id} mentions ${ref}`).toBe(true);
      }
    }
  });

  it('applies the same rules to case-level persona overrides (they are character-visible too)', () => {
    for (const id of [...CASE_IDS, ...DEV_IDS, ...PILOT_IDS]) {
      const overrides = configOf(id).initial_overrides.characters;
      if (!overrides || Array.isArray(overrides)) continue;
      for (const [charId, o] of Object.entries(overrides)) {
        const text = JSON.stringify(o);
        for (const word of FUTURE_WORDS) expect(text.includes(word), `${id}/${charId} mentions "${word}"`).toBe(false);
        for (const ref of text.match(/\b(?:zztj280|jwds-\d{3}|xwds-\d{3}|ls-\d{3})-\d{3}\b/g) ?? []) {
          expect(isInitialFor(ref, charId), `${id}/${charId} mentions ${ref}`).toBe(true);
        }
      }
    }
  });

  it('keeps Hedong-internal knowledge (the draft and its terms) out of Yelü and Li', () => {
    const hedongOnly = ['草表', '以父礼事之', '卢龙', 'Lulong', '称臣于契丹', 'memorial to the Khitan', 'Sang Weihan'];
    for (const id of ['yelu_deguang', 'li_congke'] as const) {
      const text = yamlText(`characters/${id}.yaml`);
      for (const word of hedongOnly) expect(text.includes(word), `${id}: ${word}`).toBe(false);
    }
    // Li never hears of Yanmen at all; Yelü's reservation names it as his own minimum (persona preference, not
    // knowledge of the draft).
    expect(yamlText('characters/li_congke.yaml')).not.toMatch(/雁门|Yanmen/);
    expect(preferenceFor(content().characters.yelu_deguang.reservation, 'hedong-khitan')?.cession_min).toBe('yanmen_north');
  });
});

describe('real content: scenario visibility and epilogue', () => {
  it('cites never_initial sources only in the epilogue, and cites every outcome there', () => {
    const s = content().scenario;
    for (const ref of s.player.source_refs) expect(isInitialFor(ref, 'player')).toBe(true);
    const epilogueRefs = s.epilogue.historical_comparison.flatMap((h) => h.source_refs);
    const neverInitial = Object.values(content().sources).filter((e) => e.learnable_by.every((l) => l.when === 'never_initial'));
    for (const e of neverInitial) expect(epilogueRefs, `epilogue misses ${e.id}`).toContain(e.id);
    const text = yamlText('scenario/jinyang.yaml');
    const beforeEpilogue = text.slice(0, text.indexOf('\nepilogue:'));
    for (const e of neverInitial) expect(beforeEpilogue.includes(e.id), `${e.id} cited outside the epilogue`).toBe(false);
  });

  it('keeps the C4 canary and clause text away from every file except the scenario catalog and C4', () => {
    const clause = content().scenario.terms_catalog.secret_clauses.find((c) => c.id === 'sc_treasury_share');
    expect(clause?.knownBy).toEqual([]); // nobody a priori; C4 sets its holders per case
    expect(caseConfig('C4').catalog.secretClauses.sc_treasury_share?.knownBy).toEqual(['shi_jingtang', 'sang_weihan']);
    const canary = clause?.canary ?? '';
    expect(clause?.text.zh).toContain(canary);
    expect(clause?.text.en).toContain(canary);
    const files = ['characters', 'cases', 'dev', 'pilot', 'traces'].flatMap(filesIn);
    for (const file of files) {
      const allowed = file === 'cases/C4_conflicting_commitments.yaml';
      expect(yamlText(file).includes(canary) && !allowed, `${file} contains the canary`).toBe(false);
      expect(yamlText(file).includes('唐室府库'), `${file} contains the clause text`).toBe(false);
    }
    for (const id of [...CASE_IDS, ...DEV_IDS, ...PILOT_IDS].filter((x) => x !== 'C4')) {
      const doc = caseInitialState(content(), id).documents['doc:1'];
      expect(doc?.terms.secret_clauses, id).toEqual([]);
    }
  });
});

describe('real content: cases, dev and pilot configs (PLAN §7, §12.4)', () => {
  it('gives every config a total first-match policy over the chapter categories, feasible options only', () => {
    for (const id of [...CASE_IDS, ...DEV_IDS, ...PILOT_IDS]) {
      const c = configOf(id);
      for (const rule of c.decision_policy) expect(FEASIBLE_OPTIONS[rule.match.category], id).toContain(rule.choose);
      for (const category of POLICY_CATEGORIES) {
        const rules = c.decision_policy.filter((r) => r.match.category === category && !r.match.actor && !r.match.action_type);
        const total = rules.some((r) => r.match.within_limits === undefined) ||
          (rules.some((r) => r.match.within_limits === true) && rules.some((r) => r.match.within_limits === false));
        expect(total, `${id}: ${category} not covered`).toBe(true);
      }
    }
  });

  it('bounds every case by 6 rounds and gives it a reference trace whose terminal is valid', () => {
    for (const id of CASE_IDS) {
      const c = configOf(id);
      expect(c.max_rounds).toBe(6);
      const trace = content().traces[id];
      expect(trace?.expected.terminal).not.toBeNull();
      expect(c.valid_terminals).toContain(trace?.expected.terminal);
      expect(c.constraints.length).toBeGreaterThan(0);
      expect(c.expected_checkpoints.length).toBeGreaterThan(0);
    }
  });

  it('sets up the cases so that each reference path is reachable (Yelü reservation vs drafts and goals)', () => {
    const b = content();
    const reservation = preferenceFor(b.characters.yelu_deguang.reservation, 'hedong-khitan') as TermLimits;
    // Both C4 bids are acceptable in principle: Hedong's to Yelü's hedong↔khitan floor, Tang's to his khitan↔tang
    // preference and to Li's own reservation — so the exclusive choice between them is real.
    const tangBid = caseInitialState(b, 'C4').offers['offer:1'];
    expect(b.cases.C4?.initial_overrides.in_transit?.[0]?.from).toBe('li_congke');
    const yeluTang = preferenceFor(b.characters.yelu_deguang.reservation, 'khitan-tang') as TermLimits;
    const liTang = preferenceFor(b.characters.li_congke.reservation, 'khitan-tang') as TermLimits;
    expect(withinLimits(tangBid?.terms as TermSet, yeluTang, caseConfig('C4').catalog, 'khitan-tang').ok).toBe(true);
    expect(withinLimits(tangBid?.terms as TermSet, liTang, caseConfig('C4').catalog, 'khitan-tang').ok).toBe(true);
    expect(tangBid?.arrivalDay).toBeLessThanOrEqual(coreConfig().travel.jinyang_hq.khitan_court);
    const draft = (id: string) => caseInitialState(b, id).documents['doc:1']?.terms as TermSet;
    const pair = 'hedong-khitan' as const;
    for (const id of ['C1', 'C2', 'C4']) expect(withinLimits(draft(id), reservation, coreConfig().catalog, pair).ok, id).toBe(true);
    // C3: the draft is below Yelü's floor, and no package within the player's limits reaches it (no land).
    expect(withinLimits(draft('C3'), reservation, coreConfig().catalog, pair).ok).toBe(false);
    expect(configOf('C3').player_goal.limits.cession_max).toBe('none');
    expect(reservation.cession_min).toBe('yanmen_north');
    // C6: the opening draft overdraws the treasury; the scripted revision fits it and meets Yelü's floor.
    expect(caseInitialState(b, 'C6').factions.hedong.resources.silk).toBeLessThan(draft('C6').immediate_silk);
    const revise = configOf('C6').script.find((r) => r.round === 2)?.inputs.find((i) => 'action' in i);
    const revised = termsOf((revise as { action: { args: { terms: TermSetArgs } } }).action.args.terms);
    expect(revised.immediate_silk).toBeLessThanOrEqual(caseInitialState(b, 'C6').factions.hedong.resources.silk);
    expect(withinLimits(revised, reservation, coreConfig().catalog, pair).ok).toBe(true);
    // Drafts are within each case's own goal where the reference path dispatches them at once.
    for (const id of ['C1', 'C2', 'C3', 'C4']) {
      expect(withinLimits(draft(id), limits(configOf(id).player_goal.limits), coreConfig().catalog, pair).ok, id).toBe(true);
    }
  });

  it('starts C5 with low, non-multiple-of-five grain so that the mutiny comes before any fall', () => {
    const s = caseInitialState(content(), 'C5');
    const grain = s.factions.hedong.resources.grain;
    expect(grain % 5).not.toBe(0);
    const p = projectSiege(s, coreConfig());
    expect(p.mutinyRiskDay).not.toBeNull();
    expect(p.fallDay).not.toBeNull();
    expect(p.mutinyRiskDay as number).toBeLessThan(p.fallDay as number);
  });

  it('keeps initial grain/pressure consistent with each reference terminal (no earlier fall)', () => {
    for (const id of TRACE_IDS) {
      const s = caseInitialState(content(), id);
      expect(s.factions.hedong.resources.grain).toBeGreaterThan(0);
      expect(s.siege.pressure).toBeLessThan(coreConfig().params.fall_pressure_min);
      const trace = content().traces[id];
      const round = trace?.expected.round ?? configOf(id).max_rounds;
      const fall = projectSiege(s, coreConfig()).fallDay;
      if (trace?.expected.terminal !== 'jinyang_falls' && fall !== null) {
        expect(fall, id).toBeGreaterThan((round - 1) * coreConfig().params.round_days);
      }
    }
  });

  it('gives dev and pilot configs initial states that differ from every frozen case', () => {
    const key = (id: string) => {
      const s = caseInitialState(content(), id);
      return hashValue({ documents: s.documents, factions: s.factions, siege: s.siege });
    };
    const cases = new Set(CASE_IDS.map(key));
    expect(cases.size).toBe(CASE_IDS.length);
    for (const id of [...DEV_IDS, ...PILOT_IDS]) expect(cases.has(key(id)), `${id} equals a case`).toBe(false);
    const pilots = new Set(PILOT_IDS.map(key));
    expect(pilots.size).toBe(PILOT_IDS.length);
  });
});
