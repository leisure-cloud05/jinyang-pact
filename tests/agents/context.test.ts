/**
 * Authorized character context over the REAL content (PLAN §9.2): no never_initial sources, no hindsight notes,
 * no other factions' secrets, canaries only for holders and only where the clause appears, Hedong-internal
 * material kept from Yelü and Li, and nothing known before delivery.
 */
import { describe, expect, it } from 'vitest';
import { buildCharacterContext, relevantPairs, serializeCharacterContext } from '../../src/agents/context.js';
import { CHAR_IDS, type CharId } from '../../src/core/types.js';
import { advance, cfg, commitEndorsed, content, driver, initialOf, personas } from './helpers.js';

const CONFIGS = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'D1', 'D2', 'D3', 'P1', 'P2', 'P3'] as const;
const CANARY = '玄鸾十七号密押';
/** Outcome wording that must never reach a character (subset of tests/content-real FUTURE_WORDS). */
const FUTURE_WORDS = [
  '十六州', '儿皇帝', '兒皇帝', '后晋', '後晉', '晋高祖', '晉高祖', '天福', '会同', '會同', '即皇帝位', '石烂', '石爛', '自焚',
  '柳林', '仲秋', '赵德钧', '趙德鈞', '杨光远', '楊光遠', 'Later Jin', 'Great Jin', 'Later Han', 'Gaozu', 'Liao', 'investiture',
  'son emperor', 'sixteen prefectures', 'Sixteen Prefectures', 'Zhao Dejun', 'Yang Guangyuan', 'mid-autumn',
];

function ctxText(caseId: string, charId: CharId, lang: 'zh' | 'en', state = initialOf(caseId)): string {
  return buildCharacterContext({
    content: content(),
    config: cfg(caseId),
    state,
    charId,
    lang,
    persona: personas(caseId)[charId],
    maxChars: 1_000_000,
  }).text;
}

function sourcesSection(text: string): Record<string, unknown>[] {
  const start = text.indexOf('=== HISTORICAL SOURCES YOU KNOW');
  const body = text.slice(start).split('\n').slice(1);
  return body.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('character context: source isolation (real content)', () => {
  it('contains only initial sources, only character-safe fields, and no hindsight notes', () => {
    const sources = Object.values(content().sources);
    for (const caseId of CONFIGS) {
      for (const id of CHAR_IDS) {
        for (const lang of ['zh', 'en'] as const) {
          const text = ctxText(caseId, id, lang);
          for (const e of sources) {
            const initial = e.learnable_by.some((l) => l.holder === id && l.when === 'initial');
            if (!initial) {
              expect(text, `${caseId}/${id}/${lang} mentions ${e.id}`).not.toContain(e.id);
              expect(text, `${caseId}/${id}: text of ${e.id}`).not.toContain(e.original_zh.slice(0, 24));
            }
            const notes = [e.credibility_note, String((e as Record<string, unknown>).retrospective_note ?? '')];
            for (const note of notes) if (note.trim().length > 30) expect(text).not.toContain(note.trim().slice(0, 30));
            if (e.event_time.note.trim().length > 20) expect(text).not.toContain(e.event_time.note.trim().slice(0, 20));
          }
          for (const key of ['credibility_note', 'retrospective_note', 'derived_from', 'conflicts_with', 'learnable_by']) {
            expect(text).not.toContain(`"${key}"`);
          }
          for (const word of FUTURE_WORDS) expect(text, `${caseId}/${id}/${lang}: "${word}"`).not.toContain(word);
          for (const row of sourcesSection(text)) {
            expect(Object.keys(row).sort()).toEqual(['event_time', 'gloss_en', 'id', 'location', 'original_zh', 'persons']);
            expect(Object.keys(row.event_time as object).sort()).toEqual(['leap', 'month', 'year']);
          }
        }
      }
    }
  });

  it('never shows the epilogue, the player goal or authoring meta notes', () => {
    const s = content().scenario;
    for (const caseId of CONFIGS) {
      for (const id of CHAR_IDS) {
        const text = ctxText(caseId, id, 'en') + ctxText(caseId, id, 'zh');
        for (const h of s.epilogue.historical_comparison) expect(text).not.toContain(h.text.en.slice(0, 40));
        expect(text).not.toContain('never enforced by the Harness');
        expect(text).not.toContain('Harness 不强制');
        const c = content().cases[caseId] ?? content().dev[caseId] ?? content().pilot[caseId];
        if (c) expect(text).not.toContain(c.player_goal.text.en.slice(0, 40));
      }
    }
  });

  it('keeps Hedong-internal material (start note, draft, its terms) from Yelü and Li', () => {
    const note = content().scenario.start_note;
    for (const caseId of CONFIGS) {
      for (const id of ['yelu_deguang', 'li_congke'] as const) {
        const text = ctxText(caseId, id, 'zh') + ctxText(caseId, id, 'en');
        expect(text).not.toContain(note.zh.slice(0, 30));
        expect(text).not.toContain(note.en.slice(0, 40));
        expect(text).not.toContain('"doc:1"');
        expect(text).not.toContain('草表');
        expect(text).not.toContain(CANARY);
      }
      expect(ctxText(caseId, 'li_congke', 'en')).not.toMatch(/Yanmen|雁门/);
      for (const id of ['shi_jingtang', 'sang_weihan', 'liu_zhiyuan'] as const) {
        expect(ctxText(caseId, id, 'zh')).toContain(note.zh.slice(0, 30));
      }
    }
  });
});

describe('character context: secret clause and delivery', () => {
  it('shows the C4 secret article only to its holders, only inside the document', () => {
    expect(ctxText('C4', 'shi_jingtang', 'zh')).toContain(CANARY);
    expect(ctxText('C4', 'sang_weihan', 'en')).toContain(CANARY);
    for (const id of ['liu_zhiyuan', 'yelu_deguang', 'li_congke'] as const) expect(ctxText('C4', id, 'zh')).not.toContain(CANARY);
    // The catalog makes Shi and Sang a-priori holders in every config: no document carries it ⇒ no mention.
    for (const caseId of ['C1', 'C2', 'C3', 'C5', 'C6', 'D1'] as const) {
      for (const id of CHAR_IDS) expect(ctxText(caseId, id, 'zh'), `${caseId}/${id}`).not.toContain(CANARY);
    }
  });

  it('shows the offer to Yelü only after delivery; Li learns only that an envoy left', () => {
    const d = driver('C4');
    const p = personas('C4');
    commitEndorsed(d, [
      { actor: 'shi_jingtang', action: { type: 'approve_document', args: { docId: 'doc:1', docVersion: 1 } } },
      { actor: 'shi_jingtang', action: { type: 'dispatch_document', args: { docId: 'doc:1', docVersion: 1 } } },
    ]);
    const build = (id: CharId) =>
      buildCharacterContext({ content: content(), config: d.config, state: d.state, charId: id, lang: 'zh', persona: p[id], maxChars: 1_000_000 });
    const hedongOffer = d.state.documents['doc:1']?.sentOfferId as string;
    expect(hedongOffer).toMatch(/^offer:\d+$/);
    const before = build('yelu_deguang');
    expect(before.text).not.toContain(`"${hedongOffer}"`);
    expect(before.text).not.toContain(CANARY);
    expect(before.context.negotiations.flatMap((n) => n.threads)).toHaveLength(0);
    expect(build('li_congke').context.messages).toHaveLength(0);
    expect(build('li_congke').text).not.toContain(`"${hedongOffer}"`);
    // Sang (correspondence reader, knownBy) sees the sent offer; Liu does not see the secret article at all.
    expect(build('sang_weihan').text).toContain(`"${hedongOffer}"`);
    expect(build('liu_zhiyuan').text).not.toContain(CANARY);

    advance(d); // day 5: offers and intel delivered in PREPARE
    const after = build('yelu_deguang');
    const awaiting = after.context.negotiations.flatMap((n) => n.threads.flatMap((t) => t.offers)).filter((o) => o.awaitingMyAnswer);
    expect(awaiting.map((o) => o.offerId)).toContain(hedongOffer);
    expect(after.text).toContain(CANARY); // he received terms containing the article
    const li = build('li_congke');
    expect(li.context.messages.map((m) => m.kind)).toEqual(['intel']);
    expect(li.text).not.toContain(CANARY);
    expect(li.text).not.toContain(`"${hedongOffer}"`);
    expect(li.text).not.toMatch(/Yanmen|雁门|称臣/);
    // Hedong never learns of the Tang–Khitan thread.
    for (const id of ['shi_jingtang', 'sang_weihan', 'liu_zhiyuan'] as const) {
      expect(build(id).context.negotiations.some((n) => n.pair === 'khitan-tang')).toBe(false);
    }
    expect(build('liu_zhiyuan').text).not.toContain(CANARY);
  });

  it('derives the negotiation segment from the offers the character knows (exhausted ⇒ confirm/reject only)', () => {
    const d = driver('C3');
    commitEndorsed(d, [
      { actor: 'shi_jingtang', action: { type: 'approve_document', args: { docId: 'doc:1', docVersion: 1 } } },
      { actor: 'shi_jingtang', action: { type: 'dispatch_document', args: { docId: 'doc:1', docVersion: 1 } } },
    ]);
    advance(d);
    const counter = (to: 'khitan' | 'hedong', offerId: string, cession: 'none' | 'yanmen_north') => ({
      type: 'respond_to_offer',
      args: {
        offerId,
        response: 'counter',
        reason: '—',
        counterTerms: {
          vassal: true, filial: false, cession, annual_silk: 200000, immediate_silk: 100000, aid_cavalry: 30000,
          aid_arrival_days: 20, neutrality: false, marriage_alliance: false, secret_clauses: [],
        },
      },
      to,
    });
    const c1 = counter('hedong', 'offer:1', 'yanmen_north');
    commitEndorsed(d, [{ actor: 'yelu_deguang', action: { type: c1.type, args: c1.args } }]);
    advance(d);
    const c2 = counter('khitan', 'offer:2', 'none');
    commitEndorsed(d, [{ actor: 'shi_jingtang', action: { type: c2.type, args: c2.args } }]);
    advance(d);
    const yelu = buildCharacterContext({ content: content(), config: d.config, state: d.state, charId: 'yelu_deguang', lang: 'en', maxChars: 1_000_000 });
    const n = yelu.context.negotiations.find((x) => x.pair === 'hedong-khitan');
    expect(n).toMatchObject({ segment: 1, roundsUsed: 2, roundsRemaining: 0, onlyConfirmOrReject: true, offersKnown: 3 });
    expect(n?.threads[0]?.offers.find((o) => o.awaitingMyAnswer)?.offerId).toBe('offer:3');
  });

  it('shows dialogue only to its listeners (and the speaker), advice separately', () => {
    const state = initialOf('C1');
    const dialogue = [
      { seq: 1, round: 1, epoch: 0, worldVersion: 0, speaker: 'player' as const, listeners: ['shi_jingtang' as const], text: 'FOR-SHI-ONLY', kind: 'speech' as const },
      { seq: 2, round: 1, epoch: 0, worldVersion: 0, speaker: 'player' as const, listeners: ['sang_weihan' as const], text: 'ADVICE-TO-SANG', kind: 'advice' as const },
    ];
    const text = (id: CharId) => buildCharacterContext({ content: content(), config: cfg('C1'), state, charId: id, lang: 'en', dialogue, maxChars: 1_000_000 }).text;
    expect(text('shi_jingtang')).toContain('FOR-SHI-ONLY');
    expect(text('sang_weihan')).not.toContain('FOR-SHI-ONLY');
    expect(text('sang_weihan')).toContain('ADVICE-TO-SANG');
    expect(text('liu_zhiyuan')).not.toMatch(/FOR-SHI-ONLY|ADVICE-TO-SANG/);
    const sang = buildCharacterContext({ content: content(), config: cfg('C1'), state, charId: 'sang_weihan', lang: 'en', dialogue, maxChars: 1_000_000 });
    expect(sang.context.advice.map((a) => a.text)).toEqual(['ADVICE-TO-SANG']);
    expect(sang.citeKeys).toContain('dialogue:2');
  });

  it('gives pair-scoped preferences (Yelü: reservation for his pairs; Shi: tolerance for Hedong–Khitan)', () => {
    const state = initialOf('C4');
    const yelu = buildCharacterContext({ content: content(), config: cfg('C4'), state, charId: 'yelu_deguang', lang: 'en', persona: personas('C4').yelu_deguang });
    expect(yelu.context.self.preferences.map((p) => p.pair).sort()).toEqual(relevantPairs(cfg('C4'), 'khitan').filter((p) => yelu.context.self.preferences.some((x) => x.pair === p)).sort());
    expect(yelu.context.self.preferences.find((p) => p.pair === 'hedong-khitan')?.limits.cession_min).toBe('yanmen_north');
    const shi = buildCharacterContext({ content: content(), config: cfg('C1'), state: initialOf('C1'), charId: 'shi_jingtang', lang: 'en' });
    expect(shi.context.self.preferences).toEqual([expect.objectContaining({ kind: 'tolerance', pair: 'hedong-khitan' })]);
  });
});

describe('character context: deterministic truncation', () => {
  const rows = Array.from({ length: 60 }, (_v, i) => ({
    seq: i + 1,
    round: 1,
    epoch: 0,
    worldVersion: 0,
    speaker: 'player' as const,
    listeners: ['shi_jingtang' as const],
    text: `row-${String(i + 1).padStart(2, '0')} ${'言'.repeat(120)}`,
    kind: 'speech' as const,
  }));

  it('drops the oldest dialogue first, then the lowest-priority sources, and respects the budget', () => {
    const base = { content: content(), config: cfg('C1'), state: initialOf('C1'), charId: 'shi_jingtang' as const, lang: 'zh' as const, dialogue: rows, maxDialogue: 60 };
    const full = buildCharacterContext({ ...base, maxChars: 1_000_000 });
    const budget = full.text.length - 3_000;
    const a = buildCharacterContext({ ...base, maxChars: budget });
    expect(a.text.length).toBeLessThanOrEqual(budget);
    expect(a.truncation.dialogueDropped).toBeGreaterThan(0);
    expect(a.truncation.sourcesDropped).toBe(0);
    const kept = a.context.dialogue.map((d) => d.seq);
    expect(kept[kept.length - 1]).toBe(60);
    expect(kept[0]).toBe(60 - kept.length + 1); // a suffix: oldest removed first

    const withoutDialogue = buildCharacterContext({ ...base, dialogue: [], maxChars: 1_000_000 });
    const tight = buildCharacterContext({ ...base, maxChars: withoutDialogue.text.length - 1_500 });
    expect(tight.context.dialogue).toHaveLength(0);
    expect(tight.truncation.sourcesDropped).toBeGreaterThan(0);
    const order = full.context.sources.map((s) => s.id);
    expect(tight.context.sources.map((s) => s.id)).toEqual(order.slice(0, tight.context.sources.length));
    expect(tight.text.length).toBeLessThanOrEqual(withoutDialogue.text.length - 1_500);

    const again = buildCharacterContext({ ...base, maxChars: budget });
    expect(again.text).toBe(a.text);
    expect(again.hash).toBe(a.hash);
    expect(serializeCharacterContext(a.context)).toBe(a.text);
  });

  it('keeps its own and the initial knowledge sources ahead of other sources', () => {
    for (const id of CHAR_IDS) {
      const persona = personas('C1')[id];
      const built = buildCharacterContext({ content: content(), config: cfg('C1'), state: initialOf('C1'), charId: id, lang: 'en', persona, maxChars: 1_000_000 });
      const tier = (sid: string): number =>
        persona.initial_knowledge.some((k) => k.source_ref === sid) || persona.private_memory.some((m) => (m.source_refs ?? []).includes(sid))
          ? 0
          : persona.source_refs.includes(sid)
            ? 1
            : 2;
      const tiers = built.context.sources.map((s) => tier(s.id));
      expect(tiers, id).toEqual([...tiers].sort((a, b) => a - b));
      expect(tiers.length).toBeGreaterThan(0);
    }
  });
});
