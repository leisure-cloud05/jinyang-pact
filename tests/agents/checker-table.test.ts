/**
 * Table-driven checker cases (checker.v7, PLAN §9.4): prose is atmosphere only, enforced structurally — any
 * character name/title, any numeral, any outcome word (incl. death paraphrases) and any treaty-term/resource word is
 * a hit, whatever the scene's facts. Every false negative found by the reviews (review 19–26 in docs/review_log.md) is a hit here.
 */
import { describe, expect, it } from 'vitest';
import { buildNames } from '../../src/agents/names.js';
import { checkProse, fallbackLines, undisclosedSecrets, type CheckKind } from '../../src/agents/narration/index.js';
import type { NarrationFact } from '../../src/core/types.js';
import { advance, commitEndorsed, content, driver, factsOf } from './helpers.js';

function c1Confirmation(): NarrationFact[] {
  const d = driver('C1');
  commitEndorsed(d, [
    { actor: 'shi_jingtang', action: { type: 'approve_document', args: { docId: 'doc:1', docVersion: 1 } } },
    { actor: 'shi_jingtang', action: { type: 'dispatch_document', args: { docId: 'doc:1', docVersion: 1 } } },
  ]);
  advance(d);
  const r = commitEndorsed(d, [{ actor: 'yelu_deguang', action: { type: 'confirm_commitment', args: { commitmentId: 'cmt:1', offerId: 'offer:1', termsVersion: 1 } } }]);
  return factsOf(r.events, 'khitan_court');
}

const CONFIRMED = c1Confirmation(); // includes a 50,000-bolt gift and 30,000 relief cavalry
const OUTBREAK: NarrationFact = { scene: 'jinyang_hq', kind: 'mutiny_outbreak', actor: 'system', audience: ['player'], data: { morale: 0, pressure: 90 } };
const LETTER: NarrationFact = { scene: 'khitan_court', kind: 'letter_delivered', actor: null, audience: ['yelu_deguang'], data: { messageId: 'msg:5', from: 'sang_weihan', to: 'yelu_deguang' } };
const SCENES = { none: [] as NarrationFact[], confirmed: CONFIRMED, outbreak: [OUTBREAK], letter: [LETTER] };

type Row = [scene: keyof typeof SCENES, prose: string, expected: 'pass' | CheckKind];

/** Outcome statements (all hits, including ones the facts support). */
const OUTCOMES: Row[] = [
  ['confirmed', 'The terms were accepted.', 'outcome'],
  ['confirmed', 'It is not true that the terms were accepted.', 'outcome'],
  ['confirmed', 'The Tang court accepted the terms.', 'outcome'],
  ['confirmed', '契丹大喜，允之。', 'outcome'],
  ['confirmed', '其约未尝允之。', 'outcome'],
  ['letter', 'A letter arrived.', 'outcome'],
  ['letter', '有书信送达牙帐。', 'outcome'],
  ['confirmed', '约事捷之日割雁门以北诸州。', 'outcome'],
  ['confirmed', 'The prefectures were handed over.', 'outcome'],
  ['outbreak', 'The troops mutinied.', 'outcome'],
  ['outbreak', '城中军士哗变。', 'outcome'],
  ['none', 'The city fell before dawn.', 'outcome'],
  ['none', '城陷。', 'outcome'],
  ['none', '两国结盟。', 'outcome'],
  ['none', 'The envoy was sent north at once.', 'outcome'],
  ['none', 'He breathed his last at dawn.', 'outcome'], // v7 regression: death paraphrase
  ['none', 'He passed away in the night.', 'outcome'],
  ['none', '帐中有人气绝。', 'outcome'],
  ['none', '其人归天。', 'outcome'],
];

/** Names, aliases, titles and honorifics (all hits). */
const NAMES: Row[] = [
  ['confirmed', 'Yelü Deguang agreed.', 'name'],
  ['confirmed', 'Yelu Deguang never accepted the terms.', 'name'],
  ['confirmed', 'The offer was accepted by Shi Jingtang.', 'name'],
  ['none', 'Shi Jingtang breathed his last.', 'name'], // v7 regression (also an outcome)
  ['none', '石敬瑭，已被杀。', 'name'],
  ['none', '石敬瑭并未身亡。', 'name'],
  ['none', '契丹主立于帐前。', 'name'],
  ['none', '石郎默然。', 'name'],
  ['none', '唐主怒而拂袖。', 'name'],
  ['none', '河东节度使凭栏远望。', 'name'],
  ['none', '陛下默然良久。', 'name'],
  ['none', '主公且宽心。', 'name'],
  ['none', 'My lord stood by the window.', 'name'],
  ['none', 'Liu stood by the gate.', 'name'],
];

/** Numerals: every one is a hit, including correct values (v7 regression: 50,000 bolts). */
const NUMERALS: Row[] = [
  ['confirmed', '另附帛五万匹。', 'quantity'],
  ['confirmed', 'A gift of 50,000 bolts lay ready.', 'quantity'],
  ['confirmed', '援骑三万列阵帐外。', 'quantity'],
  ['none', '城中尚有千万匹帛。', 'quantity'],
  ['none', '城中尚有五石粮。', 'quantity'],
  ['none', '库存帛叁萬匹。', 'quantity'],
  ['none', '围城已历三年。', 'quantity'],
  ['none', 'Two riders waited by the gate.', 'quantity'],
  ['none', '三军默然。', 'quantity'],
];

/** Treaty-term / resource vocabulary, incl. the v7 secret paraphrase. */
const TERMS: Row[] = [
  ['none', '唐室府库金帛由河东与契丹平分。', 'terms'], // v7 regression: secret paraphrase
  ['none', '称臣之议，满座哗然。', 'terms'],
  ['none', '以父事之，众人侧目。', 'terms'],
  ['none', 'The treasury lay open.', 'terms'],
  ['none', 'Tribute and silk filled the carts.', 'terms'],
  ['none', 'Talk of a vassal oath hung in the air.', 'terms'],
];

/** v8 regressions (review 27 in docs/review_log.md): numerals before nouns, places/polities, spoils, execution, control changes. */
const V8: Row[] = [
  ['none', '城中有千万户百姓。', 'quantity'],
  ['none', '城中有三万户。', 'quantity'],
  ['none', '城外两千家闭门。', 'quantity'],
  ['none', '城下数万人屏息。', 'quantity'], // 数 + 万 + noun: a vague magnitude is still a quantity
  ['none', '城外几千家灯火。', 'quantity'],
  ['none', 'Thousands of lanterns burned.', 'quantity'],
  ['none', 'A dozen lanterns burned.', 'quantity'],
  ['none', '洛阳财货将由河东与契丹均分。', 'place'], // C4 secret paraphrase: places …
  ['none', '洛阳财货将由河东与契丹均分。', 'terms'], // … and spoils/division words
  ['none', 'The wealth of Luoyang will be divided between Hedong and the Khitan.', 'place'],
  ['none', 'The wealth of Luoyang will be divided between Hedong and the Khitan.', 'terms'],
  ['none', 'The riches of the capital were to be shared out.', 'terms'],
  ['none', '晋阳城头寒风凛冽。', 'place'],
  ['none', 'Cold wind swept the walls of Jinyang.', 'place'],
  ['none', 'He was hanged at dawn.', 'outcome'],
  ['none', 'They strangled him in the night.', 'outcome'],
  ['none', 'He was put to death before the gate.', 'outcome'],
  ['none', '其人缢于堂下。', 'outcome'],
  ['none', '城头易帜。', 'outcome'],
  ['none', '守将开城。', 'outcome'],
  ['none', '敌军入城。', 'outcome'],
  ['none', 'The gates were opened at dawn.', 'outcome'],
  ['none', 'The banners on the walls were changed.', 'outcome'],
  ['none', 'Enemy riders seized the walls.', 'outcome'],
  ['none', 'The city was occupied.', 'outcome'],
];

/** v9 regressions (review 29 in docs/review_log.md): the closed numeral rule. */
const V9: Row[] = [
  ['none', '已经过了一时辰。', 'quantity'],
  ['none', '守城已逾四周。', 'quantity'],
  ['none', 'Millions of refugees crowded the road.', 'quantity'],
  ['none', '半数将士默然。', 'quantity'],
  ['none', 'Half the garrison stood on the walls.', 'quantity'],
  ['none', 'On the third day the wind rose.', 'quantity'],
  ['none', 'A score of riders waited by the gate.', 'quantity'],
  ['none', '万籁俱寂。', 'quantity'],
  ['none', '道路两旁寒风呼啸。', 'quantity'],
  ['none', '城中一片寂静。', 'quantity'],
  ['none', '万一有急，众人一心。', 'quantity'],
  ['none', '一起一个人影。', 'quantity'], // an exempt 一-word followed by a classifier is still a hit
  ['none', 'A couple of lanterns burned.', 'quantity'],
  ['none', 'Tens of lanterns burned.', 'quantity'],
  ['none', 'He was the first to speak.', 'quantity'],
  ['none', 'Only one lantern burned.', 'quantity'],
  ['none', '半夜风起，半空云低。', 'pass'],
  ['none', 'Someone coughed; everyone waited, and no one spoke.', 'pass'],
];

/** v10 regressions (review 31 in docs/review_log.md): Unicode numerics, fractions and multiples. */
const V10: Row[] = [
  ['none', 'A quarter of the garrison remained.', 'quantity'],
  ['none', 'Only ¼ of the defenders remained.', 'quantity'],
  ['none', 'The camp held ½ its former inhabitants.', 'quantity'],
  ['none', 'A third of the lamps had gone out.', 'quantity'],
  ['none', 'Two thirds of the lamps had gone out.', 'quantity'],
  ['none', 'The watch was doubled on the walls.', 'quantity'],
  ['none', 'The price of rice rose threefold.', 'quantity'],
  ['none', 'Ninety percent of the lamps were dark.', 'quantity'],
  ['none', 'Half the lamps were dark, some 50% of them.', 'quantity'],
  ['none', 'The watch changed at the Ⅳ bell.', 'quantity'],
  ['none', '城中灯火灭其三分之一。', 'quantity'],
  ['none', '城中灯火灭其三成。', 'quantity'],
  ['none', '夜寒两倍于昨。', 'quantity'],
  ['none', '一切如常，一直无声。', 'pass'], // lexicalized 一 still exempt
];

/** Atmosphere-only prose: must pass. */
const ATMOSPHERE: Row[] = [
  ['none', '秋风卷过城头，幕府中烛影摇动。', 'pass'],
  ['none', '秋风卷过城头，幕府中烛影摇动，众人屏息，各怀心事。', 'pass'],
  ['none', '夜色沉沉，城上刁斗声声。', 'pass'],
  ['none', '帐中炉火微明，众人默然良久。', 'pass'],
  ['none', '雨打檐角，案上灯花轻爆。', 'pass'],
  ['none', '北风凛冽，旌旗猎猎作响。', 'pass'],
  ['none', '城外营火点点，如星罗布。', 'pass'],
  ['none', '堂上香烟袅袅，周遭寂然。', 'pass'],
  ['none', '天色阴沉，城中死寂。', 'pass'],
  ['none', '秋气肃杀，草木渐黄。', 'pass'],
  ['none', '破晓时分，城头寒霜未消。', 'pass'],
  ['none', '城头军士誓死守城。', 'pass'],
  ['none', '众人各怀心事，堂中寂寂。', 'pass'],
  ['none', '风声阵阵，落叶片片，道旁寒鸦寂寂。', 'pass'],
  ['none', '一切如常，众人一直默然。', 'pass'],
  ['none', '驿道寂寂，尘土微扬。', 'pass'],
  ['none', '子夜时分，檐下寒鸦啼叫。', 'pass'],
  ['none', 'Autumn wind swept over the walls; in the hall the candles guttered and no one spoke.', 'pass'],
  ['none', 'Rain drummed on the eaves, and the lamps burned low.', 'pass'],
  ['none', 'The north wind snapped at the banners outside the great tent.', 'pass'],
  ['none', 'Smoke from the siege camps hung over the plain.', 'pass'],
  ['none', 'In the palace the halls were hushed, and incense curled in the still air.', 'pass'],
  ['none', 'Frost whitened the parapets at dawn.', 'pass'],
  ['none', 'The council sat in silence while the candles burned.', 'pass'],
  ['none', 'Each man kept his own counsel.', 'pass'],
  ['none', 'No one spoke for a long while.', 'pass'],
  ['none', 'The steppe wind carried the smell of horses and smoke.', 'pass'],
  ['none', 'Lanterns swayed in the courtyard, and the guards looked at one another.', 'pass'],
];

const ROWS: Row[] = [...OUTCOMES, ...NAMES, ...NUMERALS, ...TERMS, ...V8, ...V9, ...V10, ...ATMOSPHERE];

describe('checker.v10 table', () => {
  it('covers the reviews\' false negatives and at least 20 atmosphere-only passes', () => {
    expect(ATMOSPHERE.filter(([, , e]) => e === 'pass').length).toBeGreaterThanOrEqual(20);
    expect(ROWS.length).toBeGreaterThanOrEqual(110);
  });

  const names = buildNames(content());
  it.each(ROWS)('[%s] %s → %s', (scene, prose, expected) => {
    const result = checkProse({ prose, facts: SCENES[scene], names });
    if (expected === 'pass') expect(result.hits).toEqual([]);
    else expect(result.counts[expected], JSON.stringify(result.hits)).toBeGreaterThan(0);
  });

  it('every fallback template line passes the checker on its own', () => {
    for (const line of fallbackLines()) {
      for (const text of [line.zh, line.en]) expect(checkProse({ prose: text, facts: [], names }).hits, text).toEqual([]);
    }
  });

  it('the secret paraphrase is caught even without the clause list', () => {
    const d = driver('C4');
    const secrets = undisclosedSecrets(d.config, d.state, []);
    const r = checkProse({ prose: '唐室府库金帛由河东与契丹平分。', facts: [], names, secrets });
    expect(r.ok).toBe(false);
  });
});
