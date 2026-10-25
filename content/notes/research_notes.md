# Research notes — The Jinyang Pact (936)

Working notes for scenario, character and case authors (WP B). Every claim cites a source-entry id from
`content/sources/zztj_280.yaml`. Facts we read but did not excerpt are marked *(not excerpted)* with their
location in `content/notes/raw/`. Dates are lunar (天福元年 = 清泰三年 = 丙申 = 936); approximate Julian dates
were computed as described in `content/sources/README.md` §4. "Initial" always means *knowable at the scenario
start* in the sense of README §5.

**Scenario start.** Shi Jingtang's headquarters is drafting the request for Khitan help (zztj280-012). ZZTJ files
this under 七月 without a day. The Liao annals have the plea arriving at the Khitan court on 七月丙申, about
30 Jul 936 (ls-003-002). JWDS 卷75 places Sang's mission straight after the siege began *(not excerpted)*.
**Recommended start: early 七月 (July 936), with the siege about six weeks old.**

These notes are for authors and the epilogue, not for characters. Character contexts receive only the
character-safe fields of entries marked `initial` for them. In those entries, hindsight such as later careers,
dynasties and the fate of the request is kept in `retrospective_note` (README §5).

---

## 1. Timeline of 936

| lunar date | ≈ Julian | event | entries | initial? |
|---|---|---|---|---|
| 926 七月 (background) | 926 | Abaoji: "Hedong's lord was my brother, the Henan emperor my son" | jwds-137-001 | Shi, Sang, Yelü, Li |
| c. 929–936 | — | Khitan envoys seek return of captured generals; Tang beheads the envoys | xwds-072-002 | Yelü, Li |
| 934 四月 | 934 | Li Congke takes the throne; the exiled Khitan prince Yelü Bei urges a punitive war | ls-003-001 | Yelü |
| 正月癸丑 | 18 Feb | Li Congke's drunken jibe to Shi's wife at the Qianchun banquet | zztj280-001 | Hedong, Li |
| 三月 (before 丁巳) | Mar–Apr | Lü Qi and Li Song's peace-and-subsidy plan; Xue Wenyu objects; Li rebukes the planners; Lü Qi demoted 丁巳 (22 Apr) | zztj280-002, -003, -004 | Li |
| 五月庚寅 | 25 May | Xue: "Hedong will rebel whether moved or not" | zztj280-005 | Li |
| 五月辛卯 / 甲午 | 26 / 29 May | Shi transferred to Tianping; Zhang Jingda sent to hurry him | zztj280-006 | Hedong, Li |
| 五月 (甲午–戊戌) | 29 May–2 Jun | Hedong council: Shi's conditional defiance; Liu urges revolt; Sang proposes the Khitan | zztj280-007, -008, -009; jwds-075-001 | Hedong |
| 五月戊戌 / 壬寅 | 2 / 6 Jun | revolt reported; Shi's memorial ("the emperor is an adopted son") and Li's retort; Shi stripped of offices | zztj280-010 | Hedong, Li |
| 五月丙午 | 10 Jun | Zhang Jingda commands against Taiyuan, Yang Guangyuan his deputy | *(not excerpted; ZZTJ 卷280)* | — |
| 五月戊申 | 12 Jun | siege camp at Jin'an, about 30,000 men; An Shenxin defects to Shi | zztj280-011 | Hedong, Li |
| 七月戊子 | 22 Jul | Shi's sons Chongyin and Chongyi executed in Luoyang | *(not excerpted; ZZTJ 卷280; JWDS 卷48 has 己丑)* | uncertain; see §7 |
| **六月–early 七月** | **late Jun–Jul** | **Scenario start: Sang drafts the request; Liu objects** | zztj280-012, -013 | draft: Hedong; objection: Liu only |
| 七月丙申 | 30 Jul | plea reaches the Khitan (envoys Zhao Ying, then Sang); Zhao Dejun's envoy also present; Deguang consults his mother and agrees | ls-003-002; zztj280-014; jwds-137-002 | no |
| 八月己未 / 庚午 | 22 Aug / 2 Sep | Khitan announce the campaign date; Deguang sets out | ls-003-003 | no |
| 八月 | Aug–Sep | Li learns of the promise and presses the siege; summer floods ruin the siege works; Jinyang's grain runs low; Liu commands the defence | zztj280-016, -015 | no |
| 九月 | late Sep | 50,000 Khitan horse (claimed 300,000) come south | zztj280-017 | no |
| 九月辛丑 | 3 Oct | battle outside Jinyang: Tang infantry routed; Shi meets Deguang that night | zztj280-018 | no |
| 十月丁卯 | 29 Oct | Deguang (Liao account): "be my bulwark-vassal for generations" | ls-003-004 | no |
| 十一月丁酉 | 28 Nov | investiture as Emperor of Jin; the patent says "I look on you as a son"; sixteen prefectures and 300,000 bolts a year | zztj280-019, -020; jwds-075-002, -003 | no |
| 閏十一月 (early) | Dec | Zhao Dejun's secret rival bid; Sang's plea; the stone oath | zztj280-021, -022, -023 | no |
| 閏十一月甲子 | 25 Dec | Yang Guangyuan kills Zhang Jingda; Jin'an surrenders | zztj280-024 | no |
| 閏十一月辛巳 | 11 Jan 937 | Li Congke burns himself to death; Shi enters Luoyang | zztj280-025 | no |
| 938 十一月 | 938 | the sixteen prefectures handed over with maps and registers | ls-004-001 | no |
| after 936 | — | memorials as subject, 300,000 bolts a year, then "son emperor" etiquette | xwds-072-003 | no |

**Historical tempo (for tuning G02/G09).** Plea received about 30 Jul, reply sent 22 Aug, march begun 2 Sep,
battle 3 Oct (ls-003-002, ls-003-003, zztj280-018). That is roughly 65 days from receipt to relief, and about
31 days of marching. The game's "confirmation + 15 days" and 5-day travel are compressions. Label them as game
assumptions.

---

## 2. Characters

### 2.1 Shi Jingtang 石敬瑭 (`shi_jingtang`)
- **Role in 936.** He is Military Governor of Hedong at Jinyang and the son-in-law of Emperor Mingzong
  (zztj280-001, -009). He was ordered to Tianping and refused (zztj280-006, -007). He was declared a rebel and
  besieged (zztj280-010, -011). By the end of the year he is emperor of the new Jin by Khitan investiture (zztj280-019).
- **Position on the Khitan terms.**
  - He had Sang draft vassalage, filial rites and a cession (zztj280-012). Historically he rejected Liu's objection
    (zztj280-014, never initial).
  - JWDS has Shi himself raise the northern alliance first: 北構強敵 (jwds-075-001, which conflicts with zztj280-009).
  - At the investiture he offered "north of Yanmen and the land of Youzhou" plus 300,000 bolts a year as a gift
    (jwds-075-003).
- **Knowable at start:** zztj280-001, -006 to -012; jwds-075-001; jwds-137-001; xwds-010-001; xwds-029-001.
- **Speaking-style cues (grounded):**
  - conditional, wait-and-see reasoning: 「若其寬我，我當事之；若加兵於我，我則改圖耳」 (zztj280-007);
  - casts himself as wronged and blames the court: 「今我無異志，朝廷自啟禍機」 (jwds-075-001);
  - argues legitimacy through Mingzong's line (zztj280-010);
  - tolerates plain-spoken dissent: 「以其樸直，不責也」 (zztj280-008);
  - later, ceremonious modesty — 「辭讓數四」 (zztj280-019) — and battlefield caution: 「南軍甚厚，不可輕」
    *(ZZTJ 九月辛丑, not excerpted)*.
- **Design assumptions (not history):**
  - his private weighting of survival against ambition. XWDS's annotator claims he "would have made himself
    emperor anyway" *(xwds_008, not excerpted; a moral judgement)*;
  - the proposal's "Shi wants a prompt response";
  - any numeric limits he would accept;
  - his emotional state about his family in Luoyang (the timing is uncertain, see §7).

### 2.2 Sang Weihan 桑維翰 (`sang_weihan`)
- **Role in 936.** Secretary (掌書記) of the Hedong command, a *jinshi* from Luoyang (zztj280-009, xwds-029-001),
  and drafter of the request (zztj280-012). Later he was envoy at the Khitan camp (zztj280-022, -023) and
  chancellor *(not excerpted)*.
- **Position.**
  - He urges Shi to "open your heart, humble yourself and serve" the Khitan ruler, promising help "in the evening if
    called in the morning" (zztj280-009).
  - His draft offers subject status, filial rites and a cession (zztj280-012).
  - At the camp he argues from good faith (信義) and from the future wealth of the Central Plain:
    「將竭中國之財以奉大國」 (zztj280-022, -023).
  - His later memorial of 941 defends appeasement as "small loss, great gain" *(jwds_089, not excerpted)*.
- **Knowable at start:** as Shi's list, including jwds-137-001; he is the drafter of zztj280-012.
- **Style cues:**
  - legitimacy and interest in one breath;
  - vivid images: 蛟龍不可縱之深淵, 朝呼夕至 (zztj280-009);
  - reframes the opponent's worry: 「今大國已扼其喉，安能嚙人乎」 (zztj280-023);
  - persistence and emotional pressure: 「跪於帳前，自旦至暮，涕泣爭之」 (zztj280-023);
  - self-confident ambition: 「七尺之身，不如一尺之面」 (xwds-029-001).
- **Design assumptions:**
  - that he chose generous terms *in order to* guarantee success. The proposal's "considers how an agreement can
    be secured" is our gloss;
  - any rivalry with Liu (none recorded for 936 in the fetched texts);
  - the wording of his memorial (lost).

### 2.3 Liu Zhiyuan 劉知遠 (`liu_zhiyuan`)
- **Role in 936.** Chief of the Headquarters Guard (都押牙) at the council (zztj280-008). From 八月 he is
  Commander of Cavalry and Infantry, holding the walls (zztj280-015). A long-time comrade who had saved Shi in
  934 *(jwds_099, not excerpted)*.
- **Position.**
  - He urges armed defiance: 「若稱兵傳檄，帝業可成」 (zztj280-008).
  - He accepts vassalage but calls filial rites "too much", prefers "generous gold and silk" and **no land**,
    warning of long-term harm (zztj280-013).
  - JWDS and XWDS record only that he supported the plan (jwds-075-001's context; xwds_010 *(not excerpted)*), so
    **the objection is single-source (ZZTJ)**.
  - Later he says holding the city is "very easy" and advises sending envoys everywhere (zztj280-015, never initial).
- **Knowable at start:** as Shi's list minus jwds-137-001, plus his own objection zztj280-013.
- **Style cues:**
  - grave and taciturn (嚴重寡言, xwds-010-001);
  - blunt military images: 「自投虎口」 (zztj280-008);
  - short cost-benefit arguments and warnings about the future (zztj280-013);
  - even-handed discipline (zztj280-015);
  - ruthless with prisoners (zztj280-018).
- **Design assumptions:**
  - specific gift amounts he would propose;
  - how hard he pushes after being overruled;
  - any knowledge of his own future (he later founded the Later Han — **must never leak**).

### 2.4 Yelü Deguang 耶律德光 (`yelu_deguang`)
- **Role in 936.** Khitan emperor (Taizong), Abaoji's second son. In summer he is at his northern court or camp.
  He receives the plea (ls-003-002), marches in 八月 (ls-003-003), wins the battle (zztj280-018) and invests Shi
  (zztj280-019).
- **Position.**
  - He accepts eagerly and frames it as Heaven's will or a dream (zztj280-014, derived from jwds-137-002), or as
    punishment of a regicide (ls-003-002).
  - He frames the outcome as a hereditary bulwark-vassal (ls-003-004) and a father–son bond (jwds-075-002).
  - He was tempted by Zhao Dejun's better-placed bid for strategic reasons (zztj280-021) but kept his pledge:
    「吾非有渝前約也，但兵家權謀不得不爾」…「此石爛，可改矣」 (zztj280-023).
  - The sources show him receiving roughly what was offered: the same territorial scope (jwds-075-003), plus annual
    silk.
- **Knowable at start:** xwds-072-001 (consults his mother), xwds-072-002 (Tang rebuffs and executes Khitan
  envoys), ls-003-001 (Li Congke's usurpation; Bei's appeal), jwds-137-001 (his father's brother/son rhetoric
  toward the Tang house).
- **Style cues:**
  - Heaven, dreams and omens: 「此天意也」 (zztj280-014), 「殆天意也」 (ls-003-004);
  - consults his mother before state decisions (xwds-072-001);
  - strategic realism in homely images, such as the rat-catcher (zztj280-023);
  - mordant humour and open respect for loyalty, even an enemy's (zztj280-024);
  - paternal or hierarchical address (jwds-075-002).
- **Design assumptions:**
  - his `reservation` (minimum terms): no source shows him bargaining up the initial offer;
  - whether he knew of the Hedong revolt before the letter. Plausible via the frontier, but unrecorded, so if used
    give it low credibility;
  - the dream itself (a reported statement, not a fact);
  - his mother's influence on any specific decision.

### 2.5 Li Congke 李從珂 (`li_congke`)
- **Role in 936.** Later Tang emperor (r. 934–936) and Mingzong's adopted son (zztj280-010). The Liao call him a
  regicide (ls-003-001). He orders Shi moved (zztj280-006), besieges Jinyang (zztj280-011) and dies at Luoyang
  (zztj280-025).
- **Position on the Khitan.**
  - He first welcomed Lü Qi and Li Song's plan: return the captives, pay about 100,000 strings of cash a year, and a
    drafted 《遺契丹書》 (zztj280-002).
  - He then reversed on the humiliation and princess-marriage argument (zztj280-003) and raged at "casting my
    daughter into the desert" and "shipping soldiers' pay to the caitiffs" (zztj280-004).
  - The Tang side had executed Khitan envoys (xwds-072-002).
- **Knowable at start:** zztj280-001 to -006, -010, -011; xwds-072-002; jwds-137-001.
- **Style cues:**
  - sarcastic rhetorical questions (zztj280-001, -010);
  - explosive anger that subsides into magnanimity: 「各賜卮酒罷之」 (zztj280-004);
  - swayed by flattery or prophecy and then decisive: 「成敗吾決行之」 (zztj280-005);
  - later, despair: 「石郎使我心膽墮地」 *(ZZTJ 九月, not excerpted)*.
- **Design assumptions:**
  - a Tang **counter-bid** to the Khitan (case C4) is counterfactual, though grounded: the plan and draft letter
    existed (zztj280-002) and were dropped;
  - his intelligence on Hedong's envoy (G08) is a game rule;
  - troop and pressure numbers.

### 2.6 Player — clerk in Shi's headquarters (`player`)
- **Knowable at start:** zztj280-001 and -006 to -012; jwds-075-001; xwds-010-001; xwds-029-001. These are Hedong
  headquarters matters and the draft terms, which the clerk helps to copy.
- **Not knowable at start:** Tang court secrets, the Khitan side, and Liu's objection until he voices it.
- **Assumption.** The clerk identity is invented; no source mentions such a person.

---

## 3. The terms: request vs final agreement

| term (game key) | Hedong draft (zztj280-012) | Liu's alternative (zztj280-013) | Tang alternative (zztj280-002) | agreed at investiture (11/936) | later practice |
|---|---|---|---|---|---|
| vassal 稱臣 | yes | acceptable | — | Shi made emperor by the Khitan ruler; "bulwark-vassal for generations" (ls-003-004) | memorials as subject; later a letter as "son emperor" instead of subject (xwds-072-003) |
| filial 父禮 | yes | "goes too far" | (a princess marriage feared, zztj280-003) | patent: 「余視爾若子，爾待予猶父也」 (jwds-075-002) | 「兒皇帝」, family etiquette (xwds-072-003) |
| cession | Lulong circuit + prefectures north of Yanmen, "on the day of success" | none | none | sixteen prefectures (zztj280-020) = "north of Yanmen and Youzhou" (jwds-075-003) — **same scope as the draft** | maps and registers handed over in 938 (ls-004-001); Yunzhou held out for months *(xwds_029, not excerpted)* |
| annual_silk | not in ZZTJ's summary of the draft | — | ritual gifts worth about 100,000 strings a year | 300,000 bolts a year (zztj280-020, jwds-075-003) | delivered (絹 300,000; xwds-072-003) |
| immediate gift | — | "generous gold and silk" | return of captives | — | — (Zhao Dejun's rival bid used 「厚以金帛」, zztj280-021) |

**Takeaways for the terms catalog**
- The historical endpoint maps to `vassal: true, filial: true, cession: sixteen_prefectures, annual_silk: 300000`.
- `yanmen_north` is not a separate historical option. The draft's "Lulong + north of Yanmen" is the sixteen
  prefectures, so any split between `yanmen_north` and `sixteen_prefectures` is a game design choice. Say so in
  the catalog.
- Annual silk appears only at the investiture. Whether Deguang demanded it or Shi offered it is unclear; JWDS frames
  it as Shi's offer (jwds-075-003).

---

## 4. Conflicting and divergent accounts (all preserved)

1. **Who proposed the Khitan alliance.** ZZTJ says Sang (zztj280-009). JWDS says Shi: 「北構強敵」 (jwds-075-001),
   and XWDS 卷8 agrees *(not excerpted)*. The two entries are marked as conflicting. ZZTJ's version of Shi's speech
   is derived from the JWDS speech (zztj280-007 `derived_from` jwds-075-001).
2. **Envoy.** ZZTJ has an unnamed 「間使」, deliberately outside the excerpt (see zztj280-012's note). JWDS has
   He Fu (jwds-137-002). The Liao annals have Zhao Ying, then Sang (ls-003-002). Several envoys may have gone.
3. **Deguang's motive.** A dream and Heaven's will (zztj280-014, derived from jwds-137-002; XWDS adds a shaman's
   divination *(xwds_072, not excerpted)*), versus punishing a regicide (ls-003-002).
4. **Timing of the request.** ZZTJ narrates it after 七月丙辰 (about 19 Aug). The Liao annals have it received on
   七月丙申 (about 30 Jul) (ls-003-002). JWDS puts it straight after the siege began.
5. **Zhao Dejun's approach.** Already in 七月 (ls-003-002) versus reported in 閏十一月 (zztj280-021).
6. **Investiture.** 十一月丁酉 in ZZTJ, the JWDS patent (jwds-075-002), XWDS 卷8 and the Liao annals, against 閏月丁卯
   in JWDS 卷48 *(not excerpted)*. The altar is at Liulin (zztj280-019) or at Jinyang (ls-003-004); the offer is in
   十一月 or 十月.
7. **When the cession happened.** Declared on the investiture day (zztj280-020) versus the registers handed over in
   938 (ls-004-001). Marked as conflicting, and **treated as promise vs execution**.
8. **Father–son bond: when?**
   - offered in the request (zztj280-012);
   - "discussed" at the first meeting *(jwds_075 「因論父子之義」; XWDS 卷8/72 「約為父子」 — not excerpted)*;
   - stated in the patent (jwds-075-002);
   - pledged again at the farewell feast *(ls_003 閏月壬申, not excerpted)*.

   These are complementary rather than contradictory.
9. **Zhang Jingda's killer.** Yang Guangyuan alone (zztj280-024; JWDS 卷48) versus Yang and An Shenqi
   *(ls_003, not excerpted)*.
10. **Battle.** Date 辛丑 (ZZTJ, JWDS) versus 庚子 (Liao annals). Deaths about 10,000 infantry (zztj280-018) versus
    "tens of thousands" *(Liao annals)*.
11. **Liu's stance.** Only ZZTJ has the objection (zztj280-013); JWDS and XWDS show him simply supporting the plan.
12. Sang's face: "long" (xwds-029-001) versus "broad" *(jwds_089)*. Trivial, but it shows how anecdotes drift.

## 5. Transcription issues inside excerpts (kept verbatim)

| entry | issue |
|---|---|
| zztj280-002 | 萴剌/萴刺 inconsistency; closing 」 missing after 「以供之」 |
| zztj280-006 | 建雄節使 (for 建雄節度使) |
| zztj280-009 | 引乃天意 (probably 此乃天意) |
| zztj280-011 | 將後三萬 (probably 將兵三萬) |
| zztj280-021 | 詐雲 (= 詐云) |
| zztj280-022 | 誕亡/豪末 (誕妄/毫末 in the ZZTJ quotation inside the JWDS 卷89 annotation) |
| jwds-075-002 | heading year 天顯九年 (for 天顯十一年; heading outside the excerpt) |

Outside the excerpts the ZZTJ page has further slips, such as 唐王 for 唐主, 贏疾 for 羸疾, 涉兵在北都, 晉陷寨,
悄孤 for 飛狐, 大驚核 and 先循. There is also an unresolved placeholder 「A081」. These are the reason the page is
flagged 50%.

## 6. Keeping the six evaluation cases (PLAN §10.4) grounded

- **C1 — valid cooperation.**
  - Grounding: the draft terms (zztj280-012) and the eager acceptance (zztj280-014, ls-003-002).
  - The `dispatch_request` checkpoint is historically meaningful because the drafting was contested (zztj280-013).
  - Player limits such as `cession: yanmen_north, annual_silk_max: 300000` lie inside the historical envelope (§3).
  - The relief timing (G09) is compressed relative to history; see the tempo note in §1.
- **C2 — timing change.**
  - The historical timing is itself uncertain (conflict 4).
  - The reply promised help "at mid-autumn" (仲秋 = month 8; zztj280-014). The expedition **departed in month 8**
    (八月庚午, about 2 Sep; ls-003-003) and **reached Jinyang in month 9** (zztj280-017; battle 九月辛丑, about 3 Oct,
    zztj280-018).
  - The sources do not say whether this counted as timely. Do not use them to validate an arrival deadline.
  - Tang pressure rose once Li learned of the promise (zztj280-016). This grounds G08: Li learns *that* help was
    coming, not the terms.
  - Early siege works failed in the summer floods (zztj280-016), which could justify slow early pressure growth.
    Say so if used.
- **C3 — stricter acceptable terms.**
  - No source shows Deguang demanding more than was offered, so a reservation above the player's limits is
    **counterfactual**.
  - It is plausible given his openness to a better-placed bidder (zztj280-021) and his "military expediency" remark
    (zztj280-023).
  - A justified refusal can draw on Liu's argument (zztj280-013) and on the Tang court's "humiliation" argument
    (zztj280-003, -004).
- **C4 — conflicting secret commitments.**
  - The historical model is Zhao Dejun's secret letter (zztj280-021). Its clause 「仍許石氏常鎮河東」 is a natural
    template for a secret clause with canary tokens.
  - A Li Congke counter-bid can reuse the Lü Qi plan and the drafted letter (zztj280-002). Label it counterfactual.
  - Information isolation is historically apt. Zhao Yanshou deceived his own emperor about the letters
    (zztj280-021), and Li learned only of the promise (zztj280-016).
- **C5 — not seeking assistance.**
  - For holding out: Liu's confidence (zztj280-015; later evidence, persona only) and Shi's 「積粟甚多」
    (jwds-075-001).
  - Against: 「晉陽城中日窘，糧儲浸乏」 (zztj280-016). The Tang besiegers themselves starved in their own siege camp
    by 閏十一月 *(JWDS 卷48, not excerpted)*.
  - History offers **no** no-assistance counterfactual. G11's projection is a pure game rule. Say so in the epilogue.
- **C6 — unavailable resources or unauthorized action.**
  - The sources separate drafting from deciding: Sang drafts at Shi's order (zztj280-012); Liu advises and Shi
    decides (zztj280-013, -014).
  - The Khitan decision is taken only after the ruler consults his mother (xwds-072-001, ls-003-002).
  - Advisers acting "on Shi's behalf" therefore have no historical warrant.
  - Resource numbers are assumptions; the Tang side's own funding worry (zztj280-002, Zhang Yanlang) can colour
    the dialogue.

## 7. Open questions for the Commander / WP B authors

1. **Start date.** Early 七月 is recommended. If the start is after 七月戊子 (22 Jul), Shi's sons' execution in
   Luoyang could be initial knowledge for Hedong. We left it unexcerpted and not initial because the timing is
   uncertain. It can be a labelled assumption in Shi's private memory.
2. *Resolved (PLAN §12.1 v3.4):* `event_time` now carries `leap`. 閏十一月 ⇒ `month: 11, leap: true`
   (zztj280-021 to -025). Undated sketches and summaries have `month: null`.
3. *Resolved (PLAN §12.1 v3.4):* the terms catalog documents `yanmen_north` as a game design choice. Historically,
   "Lulong + north of Yanmen" is the sixteen-prefecture area (§3).
4. **Collation.** Wikisource quality is 50%. Before the report quotes Chinese text, check the quoted excerpts
   against a printed edition.
5. **PLAN §2** lists a top-level `content/README.md`. This package wrote `content/sources/README.md` as instructed.
   The top-level README can link to it.
