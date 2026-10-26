/** Fact header, fallback prose, narration checker (PLAN §9.4, H16) and the narrator agent. */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildNames } from '../../src/agents/names.js';
import {
  NARRATION_FACT_KINDS,
  checkProse,
  fallbackProse,
  parseChineseNumeral,
  parseEnglishNumberWords,
  renderFactHeader,
  renderFactLine,
  undisclosedSecrets,
} from '../../src/agents/narration/index.js';
import { checkSceneProse, narrateScene } from '../../src/agents/narrator.js';
import { registerMockPersonas } from '../../src/agents/mock-personas/index.js';
import type { JsonValue, NarrationFact } from '../../src/core/types.js';
import { advance, commitEndorsed, content, driver, factsOf, newMock } from './helpers.js';

const names = () => buildNames(content());
const TERMS = {
  vassal: true, filial: true, cession: 'yanmen_north', annual_silk: 100000, immediate_silk: 50000, aid_cavalry: 30000,
  aid_arrival_days: 15, neutrality: false, marriage_alliance: false, secret_clause_ids: ['sc_treasury_share'],
};

const SAMPLE_DATA: Record<(typeof NARRATION_FACT_KINDS)[number], Record<string, JsonValue>> = {
  document_revised: { docId: 'doc:1', version: 2, approvalVoided: true, terms: TERMS },
  suggestion_made: { suggestionId: 'sug:1', targetKind: 'document', targetId: 'doc:1', targetVersion: 2 },
  document_approved: { docId: 'doc:1', version: 2 },
  dispatch_timing_set: { docId: 'doc:1', mode: 'delay', notBeforeRound: 3 },
  document_dispatched: { docId: 'doc:1', docVersion: 2, offerId: 'offer:1', commitmentId: 'cmt:1', from: 'shi_jingtang', to: 'yelu_deguang', arrivalDay: 5 },
  terms_proposed: { offerId: 'offer:2', commitmentId: 'cmt:2', from: 'li_congke', to: 'yelu_deguang', arrivalDay: 15, terms: { ...TERMS, neutrality: true, secret_clause_ids: [] } },
  offer_countered: { offerId: 'offer:1', counterOfferId: 'offer:3', commitmentId: 'cmt:1', by: 'yelu_deguang', to: 'shi_jingtang', termsVersion: 2, arrivalDay: 10, terms: TERMS },
  offer_rejected: { offerId: 'offer:2', commitmentId: 'cmt:2', by: 'yelu_deguang', to: 'li_congke' },
  withdrawal_sent: { offerId: 'offer:1', commitmentId: 'cmt:1', to: 'yelu_deguang', arrivalDay: 10 },
  offer_delivered: { offerId: 'offer:1', commitmentId: 'cmt:1', from: 'shi_jingtang', to: 'yelu_deguang', terms: TERMS },
  response_delivered: { offerId: 'offer:1', commitmentId: 'cmt:1', response: 'counter', from: 'yelu_deguang', to: 'shi_jingtang', counterOfferId: 'offer:3', counterTerms: TERMS },
  withdrawal_effective: { offerId: 'offer:1', commitmentId: 'cmt:1', from: 'shi_jingtang', to: 'yelu_deguang' },
  withdrawal_late: { offerId: 'offer:1', commitmentId: 'cmt:1', from: 'shi_jingtang', to: 'yelu_deguang' },
  withdrawal_result_delivered: { offerId: 'offer:1', commitmentId: 'cmt:1', effective: true, to: 'shi_jingtang' },
  letter_delivered: { messageId: 'msg:4', from: 'sang_weihan', to: 'yelu_deguang' },
  intel_delivered: { messageId: 'msg:2', to: 'li_congke', topic: 'envoy_departed' },
  commitment_confirmed: { commitmentId: 'cmt:1', offerId: 'offer:1', termsVersion: 1, by: 'yelu_deguang', to: 'shi_jingtang', khitanArrivalDay: 20, terms: TERMS },
  resources_allocated: { faction: 'hedong', resource: 'silk', amount: 50000, purpose: 'pay_troops', morale: 45 },
  assistance_abandoned: { by: 'shi_jingtang' },
  authorization_revoked: { authId: 'auth:1' },
  authorization_granted: { authId: 'auth:1', grantee: 'shi_jingtang', categories: ['major_commitment'], expiresRound: 6 },
  letter_sent: { messageId: 'msg:4', to: 'yelu_deguang', arrivalDay: 10 },
  mutiny_outbreak: { morale: 0, pressure: 90 },
  mutiny_averted_for_now: {},
  character_death: { charId: 'liu_zhiyuan' },
  allegiance_change: { charId: 'liu_zhiyuan', faction: 'tang' },
  goal_adjusted: {},
  deadlock_resolved: { pair: 'hedong-khitan', segmentOpened: true, segment: 2, decisionId: 'event:14' },
  time_advanced: { fromDay: 5, toDay: 10, grain: 50, pressure: 56, morale: 60, moraleDecayed: false },
  terminal: { terminal: 'no_assistance', phase: 'advance', projected: true, fallDay: 25, fallRound: 6, fallCause: 'grain', mutinyRiskDay: null, assumptions: [] },
};

function fact(kind: (typeof NARRATION_FACT_KINDS)[number], actor: NarrationFact['actor'] = 'shi_jingtang'): NarrationFact {
  return { scene: 'jinyang_hq', kind, actor, audience: ['shi_jingtang', 'player'], data: SAMPLE_DATA[kind] };
}

describe('fact header', () => {
  it('covers every fact kind core emits', () => {
    const dir = fileURLToPath(new URL('../../src/core/', import.meta.url));
    const emitted = new Set<string>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(`${dir}${file}`, 'utf8');
      for (const m of src.matchAll(/\bfact\(d,([^{]*)\{/g)) {
        for (const k of (m[1] ?? '').matchAll(/'([a-z]+_[a-z_]+)'/g)) emitted.add(k[1] as string);
      }
      for (const m of src.matchAll(/d\.fact\(\{[\s\S]{0,120}?kind:\s*'([a-z_]+)'/g)) emitted.add(m[1] as string);
    }
    expect(emitted.size).toBeGreaterThan(20);
    for (const kind of emitted) expect(NARRATION_FACT_KINDS, `header misses ${kind}`).toContain(kind);
  });

  it('renders every kind in zh and en with its quantities and never the secret text', () => {
    const n = names();
    for (const kind of NARRATION_FACT_KINDS) {
      for (const lang of ['zh', 'en'] as const) {
        const line = renderFactLine(fact(kind), n, lang);
        expect(line.length, `${kind}/${lang}`).toBeGreaterThan(3);
        expect(line).not.toMatch(/undefined|null|\bNaN\b|\[object/);
        expect(line).not.toContain('玄鸾');
        expect(line).not.toMatch(lang === 'zh' ? /^（/ : /^\(/); // not the generic fallback
      }
    }
    const zh = renderFactLine(fact('commitment_confirmed'), n, 'zh');
    expect(zh).toContain('100000');
    expect(zh).toContain('30000');
    expect(zh).toContain('第20日');
    expect(zh).toContain('密约1条');
    const en = renderFactLine(fact('time_advanced'), n, 'en');
    expect(en).toBe('Day 5 to day 10: grain 50 days, siege pressure 56, morale 60.');
    expect(renderFactLine(fact('resources_allocated'), n, 'en')).toContain('50,000 bolts');
    const header = renderFactHeader([fact('document_approved'), fact('document_dispatched')], n, 'zh', { day: 0 });
    expect(header.split('\n')[0]).toBe('【晋阳帅府 · 第0日】');
    expect(header.split('\n')).toHaveLength(3);
  });

  it('renders unknown kinds generically instead of failing', () => {
    expect(renderFactLine({ scene: 'jinyang_hq', kind: 'something_new', actor: null, audience: [], data: {} }, names(), 'en')).toBe('(something_new)');
  });
});

describe('numeral parsing', () => {
  it('parses Chinese and English numerals', () => {
    expect(parseChineseNumeral('三十万')).toBe(300_000);
    expect(parseChineseNumeral('二十万')).toBe(200_000);
    expect(parseChineseNumeral('五万')).toBe(50_000);
    expect(parseChineseNumeral('一万五千')).toBe(15_000);
    expect(parseChineseNumeral('十五')).toBe(15);
    expect(parseChineseNumeral('六十')).toBe(60);
    expect(parseChineseNumeral('一百零五')).toBe(105);
    expect(parseChineseNumeral('廿')).toBe(20);
    expect(parseEnglishNumberWords(['thirty', 'thousand'])).toBe(30_000);
    expect(parseEnglishNumberWords(['one', 'hundred', 'and', 'twenty'].filter((w) => w !== 'and'))).toBe(120);
  });
});

describe('narration checker (v7: atmosphere only)', () => {
  const n = names();
  const facts: NarrationFact[] = [
    { scene: 'jinyang_hq', kind: 'time_advanced', actor: null, audience: ['shi_jingtang', 'player'], data: { fromDay: 0, toDay: 5, grain: 100, pressure: 48, morale: 60, moraleDecayed: false } },
  ];
  const check = (prose: string, extra: Partial<Parameters<typeof checkProse>[0]> = {}) => checkProse({ prose, facts, names: n, ...extra });

  it('flags every numeral, even a correct one (the header carries quantities)', () => {
    expect(check('城中尚有一百日之粮。').counts.quantity).toBe(1);
    expect(check("The city had 100 days' grain left.").counts.quantity).toBe(1);
    expect(check('围城压力已高四十八。').counts.quantity).toBe(1);
    expect(check('万一有急，众人一心，一时无事。').counts.quantity).toBeGreaterThan(0); // v9: no numeral idioms
    expect(check('众人各怀心事，堂中寂寂。').ok).toBe(true);
    expect(check('No one spoke; they looked at one another.').ok).toBe(true);
    expect(check('Two riders waited.').counts.quantity).toBe(1);
  });

  it('flags every character name, alias, title and honorific', () => {
    expect(check('耶律德光立于帐前。').counts.name).toBe(1);
    expect(check('契丹主立于帐前。').counts.name).toBe(1);
    expect(check('Liu Zhiyuan stood by the gate.').counts.name).toBe(1);
    expect(check('陛下默然。').counts.name).toBe(1);
    expect(check('My lord stood by the window.').counts.name).toBe(1);
  });

  it('flags every outcome word, even when the facts contain that outcome, and death paraphrases', () => {
    const confirmed: NarrationFact = { scene: 'khitan_court', kind: 'commitment_confirmed', actor: 'yelu_deguang', audience: ['yelu_deguang'], data: SAMPLE_DATA.commitment_confirmed };
    expect(checkProse({ prose: '允之，约遂成。', facts: [confirmed], names: n }).counts.outcome).toBeGreaterThan(0);
    expect(check('The envoy arrived at dusk.').counts.outcome).toBe(1);
    expect(check('He breathed his last at dawn.').counts.outcome).toBe(1);
    expect(check('帐中一人气绝。').counts.outcome).toBeGreaterThan(0);
    expect(check('The relief cavalry arrived beneath the walls.').ok).toBe(false);
  });

  it('flags treaty-term and resource words', () => {
    expect(check('库中存帛如山。').counts.terms).toBe(1);
    expect(check('The treasury lay open.').counts.terms).toBe(1);
    expect(check('子夜时分，城头寂然。').ok).toBe(true);
  });

  it('flags canaries and text of undisclosed secret clauses', () => {
    const d = driver('C4');
    const secrets = undisclosedSecrets(d.config, d.state, facts);
    expect(secrets.map((s) => s.id)).toContain('sc_treasury_share');
    expect(check('另有密押玄鸾十七号密押。', { secrets }).counts.secret).toBe(1);
    expect(check('事成入洛之日，唐室府库所藏金帛，两家中分之。', { secrets }).counts.secret).toBe(1);
    expect(check('唐室府库金帛由河东与契丹平分。', { secrets }).ok).toBe(false); // paraphrase: terms words
    expect(check('the gold and silk of the Tang treasuries shall be shared equally', { secrets }).counts.secret).toBe(1);
  });

  it('passes the template fallback for real committed facts (C1 round 1 and the confirmation), zh and en', () => {
    const d = driver('C1');
    const r1 = commitEndorsed(d, [
      { actor: 'shi_jingtang', action: { type: 'approve_document', args: { docId: 'doc:1', docVersion: 1 } } },
      { actor: 'shi_jingtang', action: { type: 'dispatch_document', args: { docId: 'doc:1', docVersion: 1 } } },
    ]);
    const deliveries = advance(d);
    const r2 = commitEndorsed(d, [{ actor: 'yelu_deguang', action: { type: 'confirm_commitment', args: { commitmentId: 'cmt:1', offerId: 'offer:1', termsVersion: 1 } } }]);
    const all = [...r1.events, ...deliveries, ...r2.events];
    for (const scene of ['jinyang_hq', 'khitan_court']) {
      const sceneFacts = factsOf(all, scene);
      expect(sceneFacts.length).toBeGreaterThan(0);
      for (const lang of ['zh', 'en'] as const) {
        const prose = fallbackProse(sceneFacts, n, lang, scene);
        const result = checkSceneProse(prose, { config: d.config, state: d.state, facts: sceneFacts, names: n });
        expect(result.hits, `${scene}/${lang}: ${prose}`).toEqual([]);
      }
    }
  });
});

describe('narrator agent', () => {
  async function sceneOfC1() {
    const d = driver('C1');
    const r = commitEndorsed(d, [
      { actor: 'shi_jingtang', action: { type: 'approve_document', args: { docId: 'doc:1', docVersion: 1 } } },
      { actor: 'shi_jingtang', action: { type: 'dispatch_document', args: { docId: 'doc:1', docVersion: 1 } } },
    ]);
    return { d, facts: factsOf(r.events, 'jinyang_hq') };
  }

  it('displays header + model prose when the checker passes (mock narrator)', async () => {
    const { mock } = newMock();
    registerMockPersonas(mock);
    const { d, facts } = await sceneOfC1();
    const r = await narrateScene({ client: mock, content: content(), config: d.config, state: d.state, scene: 'jinyang_hq', facts, lang: 'zh', identity: { round: 1 } });
    expect(r.status).toBe('ok');
    expect(r.displayed.startsWith(r.header)).toBe(true);
    expect(r.header).toContain('第5日送达'); // quantities live in the header
    expect(r.displayedProse).toBe(r.prose);
    expect(r.check.checker?.ok).toBe(true);
  });

  it('falls back to template prose for false prose, with empty and with correct metadata', async () => {
    const { d, facts } = await sceneOfC1();
    for (const mentioned of [[], [0, 1]]) {
      const { mock } = newMock();
      mock.register('narrator', () => ({ prose: '石敬瑭遣使北去。契丹主大喜，允之，援军三万即日至晋阳。', mentioned_facts: mentioned }));
      const r = await narrateScene({ client: mock, content: content(), config: d.config, state: d.state, scene: 'jinyang_hq', facts, lang: 'zh', identity: { round: 1 } });
      expect(r.status).toBe('fallback');
      expect(r.check.fallbackReason).toBe('checker');
      expect(r.check.checker?.counts.outcome).toBeGreaterThan(0);
      expect(r.check.checker?.counts.quantity).toBeGreaterThan(0);
      expect(r.prose).toContain('援军三万'); // raw prose is kept for the record
      expect(r.displayedProse).not.toContain('援军');
      expect(r.displayed).toBe(`${r.header}\n\n${r.displayedProse}`);
    }
  });

  it('format errors fall back; transport errors are reported as failed (regenerable)', async () => {
    const { d, facts } = await sceneOfC1();
    const { mock } = newMock();
    registerMockPersonas(mock);
    mock.injectFaults(['invalid_json', 'invalid_json'], { role: 'narrator' });
    const bad = await narrateScene({ client: mock, content: content(), config: d.config, state: d.state, scene: 'jinyang_hq', facts, lang: 'en', identity: { round: 1 } });
    expect(bad.status).toBe('fallback');
    expect(bad.check.fallbackReason).toBe('format_error');
    mock.injectFaults(['http_400'], { role: 'narrator' });
    const failed = await narrateScene({ client: mock, content: content(), config: d.config, state: d.state, scene: 'jinyang_hq', facts, lang: 'en', identity: { round: 1 } });
    expect(failed.status).toBe('failed');
    expect(failed.displayed).toContain(failed.header);
  });

  it('falls back for wrong-language prose even when all factual checks pass', async () => {
    const { d, facts } = await sceneOfC1();
    for (const [lang, prose] of [['en', '烛影微摇，窗外风声渐紧。'], ['zh', 'The curtains stirred in the wind.']] as const) {
      const { mock } = newMock();
      mock.register('narrator', () => ({ prose, mentioned_facts: [] }));
      const result = await narrateScene({ client: mock, content: content(), config: d.config, state: d.state, scene: 'jinyang_hq', facts, lang, identity: { round: 1 } });
      expect(result.check.checker?.ok).toBe(true);
      expect(result.status).toBe('fallback');
      expect(result.check.fallbackReason).toBe('language_mismatch');
      expect(result.prose).toBe(prose);
      expect(result.displayedProse).not.toBe(prose);
      expect(result.displayedProse).toBe(fallbackProse(facts, names(), lang, 'jinyang_hq'));
      const instruction = result.messages.find((m) => m.role === 'user')?.content ?? '';
      if (lang === 'en') {
        expect(instruction).toContain('English only');
        expect(instruction).not.toContain('For Chinese prose');
      }
    }
  });

  it('keeps valid English model prose instead of replacing it with a template', async () => {
    const { d, facts } = await sceneOfC1();
    const { mock } = newMock();
    const prose = 'The curtains stirred in the wind.';
    mock.register('narrator', () => ({ prose, mentioned_facts: [] }));
    const result = await narrateScene({ client: mock, content: content(), config: d.config, state: d.state, scene: 'jinyang_hq', facts, lang: 'en', identity: { round: 1 } });
    expect(result.status).toBe('ok');
    expect(result.displayedProse).toBe(prose);
    expect(result.check.fallbackReason).toBeNull();
  });

  it('never gives the narrator secret text, and scrubs an injected canary', async () => {
    const d = driver('C4');
    const r = commitEndorsed(d, [
      { actor: 'shi_jingtang', action: { type: 'approve_document', args: { docId: 'doc:1', docVersion: 1 } } },
      { actor: 'shi_jingtang', action: { type: 'dispatch_document', args: { docId: 'doc:1', docVersion: 1 } } },
    ]);
    const facts = factsOf(r.events, 'jinyang_hq');
    const { mock } = newMock();
    let prompt = '';
    mock.register('narrator', (req) => {
      prompt = req.messages.map((m) => m.content).join('\n');
      return { prose: '石敬瑭用印，另附密约，押以玄鸾十七号密押。', mentioned_facts: [0] };
    });
    const out = await narrateScene({ client: mock, content: content(), config: d.config, state: d.state, scene: 'jinyang_hq', facts, lang: 'zh', identity: { round: 1 } });
    expect(prompt).not.toContain('玄鸾');
    expect(prompt).not.toContain('府库');
    expect(out.status).toBe('fallback');
    expect(out.check.checker?.counts.secret).toBe(1);
    expect(out.displayed).not.toContain('玄鸾');
  });
});
