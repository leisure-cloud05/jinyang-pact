import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ContentError,
  buildCoreConfig,
  buildInitialState,
  caseCoreConfig,
  caseInitialState,
  effectiveCharacter,
  loadSources,
  validateContent,
  type ContentBundle,
} from '../../src/content/loader.js';
import { CaseSchema, InitialOverridesSchema, ScenarioSchema, SourceEntrySchema, preferenceFor } from '../../src/content/schema.js';
import { runPrepare } from '../../src/core/system.js';
import { latestBelief } from '../../src/core/knowledge.js';
import { hashState } from '../../src/core/hash.js';
import { CHAR_IDS, LOC_IDS } from '../../src/core/types.js';
import { REPO_ROOT, fixture } from '../core/helpers.js';

function cloneBundle(): ContentBundle {
  return structuredClone(fixture());
}

describe('content loader (fixtures)', () => {
  it('loads every section of the fixture content', () => {
    const b = fixture();
    expect(Object.keys(b.characters).sort()).toEqual([...CHAR_IDS].sort());
    expect(Object.keys(b.cases).sort()).toEqual(['FX1', 'FX3']);
    expect(Object.keys(b.traces).sort()).toEqual(['FX1', 'FX3']);
    expect(Object.keys(b.dev)).toEqual(['D1']);
    expect(Object.keys(b.pilot)).toEqual(['P1']);
    expect(Object.keys(b.sources)).toHaveLength(3);
    expect(b.scenario.parameters.segment_round_cap).toBe(2);
    expect(b.scenario.parameters.morale_high_pressure).toBe(70); // default applied
    expect(b.dev.D1?.faults).toHaveLength(2);
  });

  it('derives a symmetric travel matrix and the rules configuration', () => {
    const c = buildCoreConfig(fixture());
    for (const a of LOC_IDS) for (const b of LOC_IDS) expect(c.travel[a][b]).toBe(c.travel[b][a]);
    expect(c.travel.luoyang_court.khitan_court).toBe(10);
    expect(c.factions.hedong.principal).toBe('shi_jingtang');
    expect(c.correspondence.shi_jingtang).toEqual(['sang_weihan', 'liu_zhiyuan', 'player']);
    expect(c.catalog.secretClauses.sc_private_tribute?.knownBy).toEqual(['shi_jingtang', 'sang_weihan']);
    expect(c.characters.yelu_deguang.commitPriority).toBe(2);
  });

  it('accepts optional archival metadata on source entries but requires the §12.1 event_time', () => {
    const b = fixture();
    expect(b.sources['fx-src-002']?.derived_from).toEqual(['fx-src-001']);
    expect(b.sources['fx-src-003']?.derived_from).toEqual([]);
    const entry = { ...structuredClone(b.sources['fx-src-001']), event_time: { year: 936, month: 1, lunar: true } };
    expect(SourceEntrySchema.safeParse(entry).success).toBe(false); // leap missing
  });
});

describe('content loader (real sources)', () => {
  it('loads and validates content/sources/zztj_280.yaml', () => {
    const sources = loadSources(path.join(REPO_ROOT, 'content', 'sources', 'zztj_280.yaml'));
    const entries = Object.values(sources);
    expect(entries.length).toBeGreaterThanOrEqual(25);
    expect(entries.length).toBeLessThanOrEqual(40);
    for (const e of entries) {
      expect(e.original_zh.length).toBeGreaterThan(0);
      expect(typeof e.event_time.leap).toBe('boolean');
      expect(e.learnable_by.length).toBeGreaterThan(0);
    }
  });
});

describe('cross-reference validation', () => {
  it('passes on the fixtures', () => {
    expect(validateContent(fixture())).toEqual([]);
  });

  it('reports unknown source refs', () => {
    const b = cloneBundle();
    b.characters.shi_jingtang.source_refs = ['nope-001'];
    expect(validateContent(b)).toContain('characters/shi_jingtang.source_refs: unknown source ref nope-001');
  });

  it('rejects initial knowledge from a source that is not initially learnable by the holder', () => {
    const b = cloneBundle();
    b.characters.yelu_deguang.initial_knowledge = [
      { subject: 'x', predicate: 'claim', value: 1, credibility: 1, visibility: 'private', source_ref: 'fx-src-001' },
    ];
    expect(validateContent(b).some((i) => i.includes('not learnable initially by yelu_deguang'))).toBe(true);
  });

  it('forbids consent actions in the player permissions and principal-only actions for non-principals', () => {
    const b = cloneBundle();
    b.scenario.player.permissions = [...b.scenario.player.permissions, 'confirm_commitment'];
    b.characters.sang_weihan.permissions = [...b.characters.sang_weihan.permissions, 'approve_document'];
    const issues = validateContent(b);
    expect(issues).toContain('scenario.player.permissions: the player may never confirm_commitment');
    expect(issues).toContain('characters/sang_weihan: approve_document is principal-only');
  });

  it('rejects decision policies that choose an infeasible option for the category', () => {
    const b = cloneBundle();
    const fx1 = b.cases.FX1;
    if (!fx1) throw new Error('FX1 missing');
    fx1.decision_policy.push({
      match: { category: 'dispatch_request' },
      choose: 'let_it_happen',
      advice: null,
      authorization: null,
      goal_limits: null,
      counter_terms: null,
      amend: null,
    });
    fx1.decision_policy.push({
      match: { category: 'negotiation_deadlock' },
      choose: 'adjust_goal',
      advice: null,
      authorization: null,
      goal_limits: null,
      counter_terms: null,
      amend: null,
    });
    const issues = validateContent(b);
    expect(issues.some((i) => i.includes('let_it_happen is not a feasible option for dispatch_request'))).toBe(true);
    expect(issues.some((i) => i.includes('adjust_goal needs goal_limits'))).toBe(true);
  });

  it('rejects terms that are not applicable to the document pair and unknown clauses', () => {
    const b = cloneBundle();
    const doc = b.scenario.initial_world.documents[0];
    if (!doc) throw new Error('doc missing');
    doc.terms.neutrality = true;
    doc.terms.secret_clauses = ['sc_missing'];
    const issues = validateContent(b);
    expect(issues.some((i) => i.includes('unknown secret clauses sc_missing'))).toBe(true);
    doc.terms.secret_clauses = [];
    expect(validateContent(b).some((i) => i.includes('neutrality is not applicable to hedong-khitan'))).toBe(true);
  });

  it('checks the catalog: fixed type semantics, payer per pair, every key once', () => {
    const b = cloneBundle();
    const aid = b.scenario.terms_catalog.terms.find((t) => t.key === 'aid_cavalry');
    if (!aid) throw new Error('aid missing');
    aid.type = 'boolean';
    aid.applicable_pairs = ['hedong-khitan', 'hedong-tang'];
    b.scenario.terms_catalog.terms = b.scenario.terms_catalog.terms.filter((t) => t.key !== 'marriage_alliance');
    const issues = validateContent(b);
    expect(issues).toContain('scenario.terms_catalog.aid_cavalry: type must be integer');
    expect(issues).toContain('scenario.terms_catalog.aid_cavalry: no payer in hedong-tang for this term');
    expect(issues).toContain('scenario.terms_catalog: marriage_alliance must appear exactly once (found 0)');
  });

  it('checks traces: known case, decision refs and feasible options', () => {
    const b = cloneBundle();
    const trace = b.traces.FX1;
    const round = trace?.rounds[0];
    if (!trace || !round) throw new Error('trace missing');
    round.decisions.push({ ref: 'ghost', category: null, choose: 'endorse', advice: null, authorization: null, goal_limits: null, amend: null });
    round.decisions.push({ ref: 'dispatch', category: 'dispatch_request', choose: 'urge_stop', advice: null, authorization: null, goal_limits: null, amend: null });
    const issues = validateContent(b);
    expect(issues.some((i) => i.includes('unknown ref ghost'))).toBe(true);
    expect(issues.some((i) => i.includes('urge_stop is not feasible for dispatch_request'))).toBe(true);
  });

  it('rejects asymmetric source conflicts', () => {
    const b = cloneBundle();
    const s3 = b.sources['fx-src-003'];
    if (!s3) throw new Error('source missing');
    s3.conflicts_with = [];
    expect(validateContent(b)).toContain('sources.fx-src-002: conflict with fx-src-003 is not symmetric');
  });

  it('schemas are strict about unknown keys', () => {
    const scenario = structuredClone(fixture().scenario) as unknown as Record<string, unknown>;
    scenario.surprise = true;
    expect(ScenarioSchema.safeParse(scenario).success).toBe(false);
    const c = { ...(structuredClone(fixture().cases.FX1) as unknown as Record<string, unknown>), extra: 1 };
    expect(CaseSchema.safeParse(c).success).toBe(false);
  });
});

describe('buildInitialState', () => {
  it('is version 0, round 1, day 0 and deterministic', () => {
    const a = buildInitialState(fixture());
    const b = buildInitialState(fixture());
    expect(a.version).toBe(0);
    expect(a.round).toBe(1);
    expect(a.day).toBe(0);
    expect(hashState(a)).toBe(hashState(b));
    expect(a.factions.hedong.resources).toEqual({ grain: 40, silk: 120000, cavalry: 0, reserve_troops: 0 });
    expect(a.documents['doc:1']?.version).toBe(1);
    expect(a.counters).toMatchObject({ doc: 1, cmt: 0, offer: 0, msg: 0, sendSeq: 0 });
    const ids = Object.keys(a.knowledge);
    expect(ids).toEqual(ids.map((_, i) => `k:${i + 1}`));
    expect(a.counters.k).toBe(ids.length);
    expect(a.negotiation['hedong-khitan']).toEqual({
      segment: 0,
      segmentOpenedBy: null,
      roundsInSegment: 0,
      offersTotal: 0,
      deadlockPending: false,
      segmentStartOffersTotal: 0,
    });
  });

  it('gives document observers their initial view with unknown secret clauses filtered', () => {
    const s = caseInitialState(fixture(), 'FX3');
    const doc = s.documents['doc:1'];
    expect(doc?.terms.secret_clauses.map((c) => c.id)).toEqual(['sc_private_tribute']);
    expect(doc?.terms.filial).toBe(true);
    const views = Object.values(s.knowledge).filter((k) => k.subject === 'doc:1');
    expect(views.map((k) => k.holder).sort()).toEqual(['liu_zhiyuan', 'player', 'sang_weihan', 'shi_jingtang']);
    const liu = views.find((k) => k.holder === 'liu_zhiyuan');
    expect(JSON.stringify(liu?.value)).not.toContain('JYP-CANARY');
    const sang = views.find((k) => k.holder === 'sang_weihan');
    expect(JSON.stringify(sang?.value)).toContain('JYP-CANARY-7F3A');
  });

  it('applies case overrides (resources, siege, document terms and timing, goal)', () => {
    const s = caseInitialState(fixture(), 'P1');
    expect(s.factions.hedong.resources.grain).toBe(33);
    expect(s.siege).toEqual({ pressure: 40, morale: 45 });
    expect(s.documents['doc:1']?.terms.immediate_silk).toBe(30000);
    expect(s.documents['doc:1']?.timing).toEqual({ mode: 'delay', notBeforeRound: 2 });
    expect(s.player.goal.text.en).toBe('Hold the city.');
  });

  it('rejects overrides that make the document invalid', () => {
    expect(() =>
      buildInitialState(fixture(), { initial_overrides: { documents: [{ id: 'doc:1', terms: { marriage_alliance: true } }] } }),
    ).toThrow(ContentError);
  });
});

describe('case-level content extensions (WP-B2 requests)', () => {
  it('a case sets clause holders (knownBy) and adds case-only clauses; other cases are unaffected', () => {
    const b = fixture();
    const fx3 = caseCoreConfig(b, 'FX3').catalog.secretClauses;
    const fx1 = caseCoreConfig(b, 'FX1').catalog.secretClauses;
    expect(buildCoreConfig(b).catalog.secretClauses.sc_border_hostage?.knownBy).toEqual([]);
    expect(fx1.sc_border_hostage?.knownBy).toEqual([]);
    expect(fx3.sc_border_hostage?.knownBy).toEqual(['shi_jingtang']);
    expect(fx3.sc_border_hostage?.canary).toBe('JYP-CANARY-C3D5'); // other fields inherited
    expect(fx3.sc_fx3_only?.knownBy).toEqual(['shi_jingtang', 'sang_weihan']);
    expect(fx1.sc_fx3_only).toBeUndefined();
  });

  it('initial document views follow the case-level holders', () => {
    const fx3 = b3();
    const overrides = {
      ...fx3.initial_overrides,
      documents: [{ id: 'doc:1', terms: { secret_clauses: ['sc_border_hostage', 'sc_fx3_only'] } }],
    };
    const s = buildInitialState(fixture(), { initial_overrides: overrides });
    const view = (holder: string) => JSON.stringify(Object.values(s.knowledge).find((k) => k.holder === holder && k.subject === 'doc:1')?.value);
    expect(view('shi_jingtang')).toContain('JYP-CANARY-C3D5');
    expect(view('shi_jingtang')).toContain('JYP-CANARY-D4E6');
    expect(view('sang_weihan')).not.toContain('JYP-CANARY-C3D5');
    expect(view('sang_weihan')).toContain('JYP-CANARY-D4E6');
    expect(view('player')).not.toContain('JYP-CANARY');
    // Without the case library the clause is unknown to everyone.
    const plain = buildInitialState(fixture(), { initial_overrides: { documents: overrides.documents.slice(0, 0) } });
    expect(JSON.stringify(plain.knowledge)).not.toContain('JYP-CANARY-C3D5');
  });

  it('cases override persona fields; the older list form still sets world fields', () => {
    const yelu = effectiveCharacter(fixture(), fixture().cases.FX3 ?? null, 'yelu_deguang');
    expect(yelu.goals[0]?.en).toBe('Obtain the Sixteen Prefectures.');
    expect(yelu.reservation).toMatchObject({ filial: true, cession_min: 'sixteen_prefectures' });
    expect(yelu.voice).toEqual(fixture().characters.yelu_deguang.voice);
    expect(effectiveCharacter(fixture(), fixture().cases.FX1 ?? null, 'yelu_deguang').goals).toEqual(fixture().characters.yelu_deguang.goals);
    expect(caseInitialState(fixture(), 'P1').characters.li_congke.location).toBe('luoyang_court');
  });

  it('private_memory items and resource notes carry validated source refs', () => {
    expect(fixture().characters.shi_jingtang.private_memory[0]?.source_refs).toEqual(['fx-src-001']);
    expect(fixture().scenario.factions.find((f) => f.id === 'hedong')?.resources.grain).toMatchObject({ amount: 40 });
    expect(caseInitialState(fixture(), 'FX1').factions.hedong.resources.grain).toBe(40);
    const b = structuredClone(fixture());
    b.characters.yelu_deguang.private_memory = [{ zh: '记', en: 'memory', source_refs: ['fx-src-001'] }];
    const hedong = b.scenario.factions.find((f) => f.id === 'hedong');
    if (hedong) hedong.resources.silk = { amount: 5, assumption: true, source_refs: ['nope'] };
    const fx3 = b.cases.FX3;
    if (fx3) {
      fx3.initial_overrides.secret_clauses = [{ id: 'sc_new', knownBy: ['shi_jingtang'] }];
      fx3.initial_overrides.characters = { liu_zhiyuan: { private_memory: [{ zh: '记', en: 'm', source_refs: ['fx-src-002'] }] } };
    }
    const issues = validateContent(b);
    expect(issues).toContain('characters/yelu_deguang.private_memory[0]: source fx-src-001 is not learnable initially by yelu_deguang');
    expect(issues).toContain('scenario.factions.hedong.resources.silk: unknown source ref nope');
    expect(issues).toContain('cases/FX3.initial_overrides.secret_clauses.sc_new: a case-only clause needs text, canary and applicable_pairs');
    expect(issues).toContain('cases/FX3.initial_overrides.characters.liu_zhiyuan.private_memory[0]: source fx-src-002 is not learnable initially by liu_zhiyuan');
  });
});

function b3() {
  const c = fixture().cases.FX3;
  if (!c) throw new Error('FX3 missing');
  return c;
}

describe('trajectory-robust scripts and pre-start messages (PLAN §12.4)', () => {
  it('builds in-transit offers and letters like committed sends', () => {
    const s = caseInitialState(fixture(), 'D1');
    expect(s.version).toBe(0);
    expect(s.commitments['cmt:1']).toMatchObject({ status: 'negotiating', parties: ['yelu_deguang', 'shi_jingtang'], openedDay: 0 });
    expect(s.offers['offer:1']).toMatchObject({ from: 'yelu_deguang', to: 'shi_jingtang', status: 'in_transit', sentDay: 0, arrivalDay: 5, consentEvidence: 'pre-start' });
    expect(s.negotiation['hedong-khitan']).toMatchObject({ segment: 1, segmentOpenedBy: 'first_offer', offersTotal: 1 });
    expect(s.factions.khitan.reserved.cavalry).toBe(20000); // Yelü's aid is reserved at consent
    expect(latestBelief(s, 'yelu_deguang', 'offer:1', 'status')).toMatchObject({ value: 'sent', evidence: { kind: 'initial', ref: 'pre-start' } });
    expect(latestBelief(s, 'shi_jingtang', 'offer:1', 'terms')).toBeNull(); // nothing known before arrival
    const letter = Object.values(s.messages).find((m) => m.kind === 'letter');
    expect(letter).toMatchObject({ from: 'li_congke', to: 'shi_jingtang', sentDay: -5, arrivalDay: 0, status: 'in_transit' });
    // Round 1 PREPARE (day 0) delivers the letter only; the offer arrives in round 2.
    const config = buildCoreConfig(fixture());
    const r1 = runPrepare(s, config).state;
    expect(r1.messages[letter!.id]?.status).toBe('delivered');
    expect(r1.offers['offer:1']?.status).toBe('in_transit');
  });

  it('validates in-transit offers like committed ones', () => {
    const parse = (entries: Record<string, unknown>[]) => InitialOverridesSchema.parse({ in_transit: entries });
    const bad = (entry: Record<string, unknown>) => () => buildInitialState(fixture(), { initial_overrides: parse([entry]) });
    expect(bad({ kind: 'offer', from: 'sang_weihan', to: 'yelu_deguang', terms: {}, note: '', arrival_day: 5 })).toThrow(/between principals/);
    expect(bad({ kind: 'offer', from: 'yelu_deguang', to: 'shi_jingtang', terms: { aid_cavalry: 55000, aid_arrival_days: 10 }, note: '', arrival_day: 5 })).toThrow(/lacks cavalry/);
    expect(bad({ kind: 'offer', from: 'yelu_deguang', to: 'shi_jingtang', terms: { neutrality: true }, note: '', arrival_day: 5 })).toThrow(/not applicable/);
    expect(bad({ kind: 'letter', from: 'li_congke', to: 'shi_jingtang', text: 'x', sent_day: 5, arrival_day: 10 })).toThrow(/after the chapter start/);
    const twice = { kind: 'offer', from: 'yelu_deguang', to: 'shi_jingtang', terms: { vassal: true }, note: '', arrival_day: 5 };
    expect(() => buildInitialState(fixture(), { initial_overrides: parse([twice, twice]) })).toThrow(/negotiating thread/);
  });

  it('validates script conditions and "$current" actions', () => {
    const b = structuredClone(fixture());
    const fx1 = b.cases.FX1!;
    expect(validateContent(fixture())).toEqual([]); // FX1 already uses when / "$current" / probe
    fx1.script.push({ round: 2, inputs: [{ action: A_bad, when: { doc_status: { docId: 'doc:7', status: 'sent' } } }] });
    const issues = validateContent(b);
    expect(issues.some((i) => i.includes('unknown document doc:7'))).toBe(true);
    expect(issues.some((i) => i.includes('invalid action'))).toBe(true);
  });

  it('reservations may be scoped per principal pair', () => {
    const yelu = fixture().characters.yelu_deguang.reservation;
    expect(preferenceFor(yelu, 'hedong-khitan')).toMatchObject({ filial: true, cession_min: 'yanmen_north', annual_silk_min: 200000 });
    expect(preferenceFor(yelu, 'khitan-tang')).toMatchObject({ marriage_alliance: true, filial: null });
    expect(preferenceFor(yelu, 'hedong-tang')).toBeNull();
    const li = fixture().characters.li_congke.reservation;
    expect(li?.by_pair).toBeNull();
    expect(preferenceFor(li, 'khitan-tang')).toMatchObject({ neutrality: true });
    expect(preferenceFor(li, 'hedong-tang')).toMatchObject({ neutrality: true }); // flat form: every pair
  });
});

const A_bad = { type: 'revise_document', args: { docId: 'doc:1', baseDocVersion: '$later', terms: {}, note: '' } };

describe('review 15: merged-catalog canaries and probes', () => {
  it('#11 rejects two clauses of one case sharing a canary (case-only clauses included)', () => {
    const b = structuredClone(fixture());
    const fx3 = b.cases.FX3!;
    fx3.initial_overrides.secret_clauses = [
      ...(fx3.initial_overrides.secret_clauses ?? []),
      { id: 'sc_twin', text: { zh: '甲', en: 'a' }, canary: 'JYP-CANARY-D4E6', knownBy: ['yelu_deguang'], applicable_pairs: ['hedong-khitan'] },
    ];
    expect(validateContent(b).some((i) => i.includes('sc_fx3_only and sc_twin share the canary JYP-CANARY-D4E6'))).toBe(true);
  });

  it('§12.4 probes are rejected in evaluation cases but allowed in dev configs', () => {
    expect(fixture().dev.D1?.script[0]?.inputs[0]).toMatchObject({ probe: true }); // dev: fine
    const b = structuredClone(fixture());
    const fx1 = b.cases.FX1!;
    fx1.script.push({ round: 2, inputs: [{ action: { type: 'wait', args: {} }, probe: true }] });
    expect(validateContent(b).some((i) => i.includes('probe inputs are not allowed in evaluation cases'))).toBe(true);
  });
});

describe('review 18: pre-start messages obey G02 and H08', () => {
  const parse = (entries: Record<string, unknown>[]) => InitialOverridesSchema.parse({ in_transit: entries });
  const build = (entry: Record<string, unknown>) => () => buildInitialState(fixture(), { initial_overrides: parse([entry]) });
  const offer = { kind: 'offer', from: 'yelu_deguang', to: 'shi_jingtang', terms: { vassal: true, aid_cavalry: 20000, aid_arrival_days: 15 }, note: '' };

  it('#4 requires sent_day ≤ 0 and arrival_day = sent_day + travel', () => {
    expect(build({ ...offer, sent_day: 0, arrival_day: 0 })).toThrow(/must be sent_day \+ travel \(0 \+ 5\)/);
    expect(build({ ...offer, sent_day: 10, arrival_day: 15 })).toThrow(/after the chapter start/);
    expect(build({ ...offer, sent_day: -5, arrival_day: 0 })).not.toThrow();
    const s = buildInitialState(fixture(), { initial_overrides: parse([{ ...offer, sent_day: -5, arrival_day: 0 }]) });
    expect(s.offers['offer:1']).toMatchObject({ sentDay: -5, arrivalDay: 0 });
    // Nothing is created when an entry is rejected.
    expect(() => buildInitialState(fixture(), { initial_overrides: parse([{ ...offer, sent_day: 0, arrival_day: 0 }]) })).toThrow();
  });

  it('#5 a sender may only include secret clauses it knows (H08)', () => {
    const withClause = { ...offer, arrival_day: 5, terms: { ...offer.terms, secret_clauses: ['sc_private_tribute'] } };
    expect(build(withClause)).toThrow(/yelu_deguang does not know secret clause\(s\) sc_private_tribute \(H08\)/);
    const shi = { kind: 'offer', from: 'shi_jingtang', to: 'yelu_deguang', terms: { vassal: true, immediate_silk: 50000, aid_cavalry: 20000, aid_arrival_days: 15, secret_clauses: ['sc_private_tribute'] }, note: '', arrival_day: 5 };
    expect(build(shi)).not.toThrow(); // Shi knows the clause (knownBy)
  });
});
