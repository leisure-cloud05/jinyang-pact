# Historical source entries (`content/sources/`)

`zztj_280.yaml` holds **40 source entries** for the chapter "The Jinyang Pact" (936 CE): 25 from
*Zizhi Tongjian* 卷280 (the principal source, proposal ref. [3]) and 15 from three other standard histories.
Those 15 are used only where they add something or contradict ZZTJ. The schema follows PLAN.md §10.1.
Research notes built on these entries are in `content/notes/research_notes.md`.

## 1. Provenance

All texts were fetched on **2026-09-27** from Chinese Wikisource as raw wikitext
(`https://zh.wikisource.org/w/index.php?title=<page>&action=raw`, PowerShell `Invoke-WebRequest`, response
bytes decoded as UTF-8). Snapshots are kept unmodified in `content/notes/raw/`. Every `original_zh` was cut
programmatically from these snapshots; no Chinese text was retyped by hand.

| work | compiler, date | Wikisource page | snapshot | entries |
|---|---|---|---|---|
| 資治通鑑 *Zizhi Tongjian* (ZZTJ) | Sima Guang 司馬光, presented 1084 | [資治通鑑/卷280](https://zh.wikisource.org/wiki/資治通鑑/卷280) (後晉紀一, 天福元年) | `zztj_280.wikitext` | 25 |
| 舊五代史 *Jiu Wudai shi* (JWDS) | Xue Juzheng 薛居正 et al., 974; extant text is an 18th-c. reconstruction | [舊五代史/卷75](https://zh.wikisource.org/wiki/舊五代史/卷75) (晉高祖紀一), [卷137](https://zh.wikisource.org/wiki/舊五代史/卷137) (契丹) | `jwds_075`, `jwds_137` | 5 |
| 新五代史 *Xin Wudai shi* (XWDS) | Ouyang Xiu 歐陽修, c. 1053 (printed 1072) | [新五代史/卷10](https://zh.wikisource.org/wiki/新五代史/卷10) (漢本紀), [卷29](https://zh.wikisource.org/wiki/新五代史/卷29) (桑維翰), [卷72](https://zh.wikisource.org/wiki/新五代史/卷72) (契丹) | `xwds_010`, `xwds_029`, `xwds_072` | 5 |
| 遼史 *Liao shi* (LS) | Toqto'a 脫脫 et al., 1344 (from Liao-era records) | [遼史/卷3](https://zh.wikisource.org/wiki/遼史/卷3) (太宗上), [卷4](https://zh.wikisource.org/wiki/遼史/卷4) (太宗下) | `ls_003`, `ls_004` | 5 |

These volumes were also fetched and read for corroboration. They are cited in notes as "not excerpted":
JWDS 卷48 (末帝紀下), 卷76 (晉高祖紀二), 卷89 (桑維翰傳), 卷99 (漢高祖紀上); XWDS 卷08 (晉本紀; the page
is named `新五代史/卷08`); LS 卷71 (后妃傳).

**Caveats**
- Every Wikisource page is flagged `Textquality 50%`. Obvious transcription slips inside excerpts are kept
  **verbatim** and flagged in `credibility_note`. Examples: 引乃天意 (probably 此乃天意), 建雄節使, 將後三萬, 詐雲 (= 詐云),
  誕亡/豪末 (誕妄/毫末 in the ZZTJ quotation inside the JWDS 卷89 annotation), 萴剌/萴刺. The readings were not
  collated against a printed edition. Do that before quoting any excerpt in the report as definitive.
- The JWDS text carries Qing editors' annotations (`{{*|…}}`), which quote ZZTJ, 遼史, 契丹國志 and others.
  **No excerpt is taken from an annotation.** This is checked: every `original_zh` also occurs in the rendered main
  text with all templates except `{{YL|…}}` year labels removed.
- Characters are traditional as on Wikisource; the punctuation is modern and belongs to the transcription.

## 2. Licence

The classical texts are in the public domain (the authors died centuries ago). Their Wikisource transcriptions
are published under CC BY-SA 4.0. A faithful transcription of a public-domain text is generally not considered
a new work, but we attribute Wikisource and give the page URL for every entry. `gloss_en`, `credibility_note`,
the notes and all metadata are the project's own work. The raw snapshots are kept only so that the excerpts can be
checked.

## 3. How entries were selected

1. Coverage first. Every episode that the game or the evaluation refers to has at least one ZZTJ entry:
   - Li Congke's suspicion and the Tianping transfer (001, 005, 006)
   - Shi's refusal and its justification (007, 010)
   - the siege (006, 011, 016)
   - the Later Tang court debate on the peace/marriage deal (002–004)
   - Sang's draft terms (012) and Liu's objection (013)
   - the Khitan reply (014), the arrival and battle (017, 018), the investiture and cession (019, 020)
   - Zhao Dejun's rival bid and Sang's plea (021–023), Zhang Jingda's death (024), Li Congke's end (025)
2. Other works are added only when they add something ZZTJ lacks or contradict it:
   - the date and wording of the investiture patent (jwds-075-002, jwds-075-003)
   - envoy names and the Khitan-side motive (jwds-137-002, ls-003-001/002)
   - the timing of the Khitan response (ls-003-003)
   - the Liao "bulwark-vassal" framing (ls-003-004)
   - later implementation of the terms (xwds-072-003, ls-004-001)
   - the characters' prior knowledge (jwds-137-001, xwds-072-001/002)
   - persona sketches (xwds-010-001, xwds-029-001)
3. Excerpts are contiguous, verbatim and focused, usually 1–5 sentences. A few narrative units run longer (002, 004).
4. **A passage that mixes context known at the start with later outcomes is split.** For example, zztj280-012
   begins *after* 「石敬瑭遣間使求救於契丹，」, so the dispatch itself stays a player decision. 「敬瑭不從」 is kept out of
   Liu's objection (013) and opens the outcome entry 014.

## 4. Field semantics

| field | meaning |
|---|---|
| `id` | `zztj280-NNN` for ZZTJ; `<work>-<volume>-NNN` for the others (`jwds-075-001`, `xwds-072-002`, `ls-004-001`). |
| `work`, `volume`, `url` | work name (Chinese + romanisation), 卷 number (integer), Wikisource page. |
| `locator` | human-readable position: 卷, year, month and day as written in the text; notes where an excerpt starts mid-sentence. The texts date these events by the era 天福元年, which was only proclaimed in 十一月 936. Locators therefore use the cyclical year 丙申 (936), which is printed in the ZZTJ heading, and entries that are `initial` for anyone avoid later era names, dynastic section titles and temple names (e.g. no 晉書/漢本紀/太宗). |
| `original_zh` | verbatim excerpt (exact substring of the snapshot). Never paraphrased or corrected. |
| `gloss_en` | our faithful English paraphrase. Square brackets mark our clarifications, not source text. |
| `persons` | person ids. Main cast: `shi_jingtang`, `sang_weihan`, `liu_zhiyuan`, `yelu_deguang`, `li_congke`. Others: pinyin snake_case (e.g. `zhang_jingda`, `zhao_dejun`, `xue_wenyu`, `lu_qi`, `li_song`, `yang_guangyuan`, `empress_shulu`, `princess_jinguo` = Shi's wife, `yelu_bei` = 突欲/東丹王/李贊華, `li_siyuan` = Mingzong). |
| `event_time` | `{year, month\|null, leap, lunar: true, note}` (PLAN §12.1). `year` is the conventional Western year of the Chinese year: 丙申 = 936, so intercalary-month events that fall in Jan 937 on the Julian calendar still carry `year: 936`. `month` is the lunar month number, or `null` when the source gives none: undated character sketches (xwds-010-001, xwds-029-001, xwds-072-001), undated summaries (xwds-072-002, xwds-072-003) and jwds-137-002. `leap: true` marks the intercalary month: 閏十一月 ⇒ `month: 11, leap: true` (zztj280-021 to -025); all other entries have `leap: false`. `note` gives the sexagenary day, the day of the month and the Julian date. **`event_time.note` is character-visible**, so it follows the same no-future rule as `gloss_en`. |
| `location` | `jinyang_hq`, `khitan_court`, `luoyang_court`, or `other:<place>` (e.g. `other:jin_an_camp`, `other:khitan_camp_liulin` — the Khitan ruler's camp near Jinyang from 九月, which is **not** the game's `khitan_court` scene). |
| `topics` | controlled vocabulary: `li_congke_suspicion, tang_court_debate, peace_marriage_proposal, khitan_relations, tianping_transfer, hedong_council, revolt, legitimacy, siege, supplies, assistance_request, envoy, terms, vassal, filial, cession, annual_silk, gold_silk_gifts, khitan_response, dream_omen, mother_consultation, khitan_arrival, battle, investiture, rival_bid, persuasion, stone_oath, surrender, zhang_jingda_death, li_congke_end, implementation, persona, dating`. |
| `kind` | `record` (narrated event) or `speech` (reported words, including the patent text). No `commentary` entry was needed. |
| `learnable_by` | **Every entry lists all six holders** (five characters + `player`, the clerk in Shi's HQ) with `when: initial` or `when: never_initial`. See §5. |
| `derived_from` | this entry's wording depends on another entry (a later compiler copying an earlier text). Such pairs are **one** piece of evidence, not two. |
| `conflicts_with` | the accounts disagree on who, when, why or how much. The relation is symmetric; both accounts are preserved and neither is resolved. |
| `credibility` | 0–1 heuristic, **not a probability**. Roughly: ≥ 0.85 official acts and dates corroborated elsewhere; ~0.7 narrative records; ~0.6 reconstructed speeches, private scenes, single-source claims. `credibility_note` gives the reasons. |
| `retrospective_note` | optional. Hindsight remarks: later careers and dynasties, the fate of the request, compilation history, the deliberate cut of an excerpt. **Epilogue and inspector only; never serialized to characters.** |

Julian dates come from month-start days stated in the texts: 正月辛卯朔 (JWDS 卷48), 三月庚寅朔 and 六月戊午朔
(遼史 卷3), 四月己未朔 (JWDS 卷48), 十一月丙戌朔 (the investiture patent, JWDS 卷75) and 十二月乙酉朔 (ZZTJ).
The day cycle is (JDN + 49) mod 60. The results match two independent checks: JWDS 卷48 dates the battle to
"the 15th of the ninth month", which is 辛丑; and Li Congke's death falls on 11 Jan 937 (Julian). Dates are
approximate only in that month starts without an anchor are estimated. A sexagenary day inside a known month is exact.

## 5. `learnable_by` rules (source eligibility)

- **Scenario start** is the moment Shi's headquarters drafts the request (zztj280-012). Historically this falls
  in 六月 or early 七月 of 天福元年 (late June to late July 936; see the note on zztj280-012).
- `initial` means the holder could plausibly know **the whole excerpt** at that moment, because they took part,
  it was proclaimed publicly, or it was held in their own court's records. The rule is conservative: if only part
  of an excerpt could have reached a holder, that holder is `never_initial`. Partial knowledge belongs in
  character configs as an explicit game assumption.
- `never_initial` means the entry must not enter that holder's context. **Character contexts receive only
  entries marked `initial` for that holder.** Entries that are `never_initial` for everyone (20 of the 40) serve
  only the epilogue and historical comparison. They cover every outcome: the Khitan reply and relief, the battle,
  the investiture, the cession, Zhao Dejun's bid, Zhang Jingda's death, Li Congke's end, and the later practice.
- `player` (the clerk) is `initial` only for Hedong headquarters matters: public orders and edicts, the council,
  the siege, the draft terms, and colleagues' manner.
- **No future in metadata.** In any entry that is `initial` for *any* holder, the fields `original_zh`,
  `gloss_en`, `event_time.note`, `credibility_note` and `locator` must contain nothing that happened after the
  scenario start. That rules out:
  - the dispatch, the Khitan reply, relief, investiture or cession;
  - later titles (Gaozu, Taizong), later dynasties and eras (Later Jin, Han, 天福 as a Jin era, Liao, Song, Qing …);
  - later compilation dates.

  Such remarks go into `retrospective_note`. PLAN §9.2 serializes only `original_zh`, `gloss_en`, `event_time`,
  `location` and `persons` to characters; the stricter scope is a safety margin.
- An entry that is `initial` for anyone may not carry an outcome topic or outcome wording in `original_zh` (e.g. 表至契丹,
  即皇帝位, 十六州, 自焚, 石爛, 敬瑭不從, 遣間使). The repository test enforces both rules (§7).

## 6. Recorded history vs game assumption

- **Recorded history** is only what an entry's `original_zh` says, weighed by its `credibility`. The gloss is our
  reading of that text.
- **Speeches are literary reconstructions** by the historians. They show a person's position and manner, not
  their exact words. Characters may paraphrase them but must not cite them as verbatim quotations.
- **Everything else is a game assumption and must be labelled as one** in scenario and character files
  (`history_vs_assumption`, `assumption: true`). This covers:
  - all numbers for grain, morale, pressure, travel days, and troops available to the player;
  - reservation prices and minimum acceptable terms;
  - characters' inner motives beyond what the texts state;
  - the clerk's identity;
  - the wording of the request memorial, which has not survived in any fetched source;
  - every counterfactual branch.
- Where accounts conflict (`conflicts_with`), content must name the version it follows or present the disagreement.
  It must not silently merge them. Derived pairs (`derived_from`) must not be counted as independent corroboration.

## 7. Verification (repository test)

`tests/sources/verbatim.test.ts` (vitest, read-only, no network). Run it with `npx vitest run tests/sources`.
The test:

- parses the file with the repository's `yaml` package (`parseDocument`, `uniqueKeys`) and requires 0 errors,
  0 warnings, and 25–40 unique entries;
- checks the §12.1 field set, including the optional `retrospective_note`;
- maps each entry's `url` to its snapshot in `content/notes/raw/` and asserts that `original_zh` is an **exact substring**
  of the raw wikitext **and** of the rendered main text. The rendered text keeps `{{YL|…}}` year labels and drops
  every other template, including the Qing editors' `{{*|…}}` annotations;
- asserts the `event_time` schema: `month` is null or 1–12, `leap` is boolean, `lunar` is true, leap is true exactly for
  zztj280-021 to -025 (month 11), and the undated sketches have `month: null`;
- asserts that all six holders are listed and that no outcome topic is ever `initial`;
- enforces the no-future-metadata rule of §5 with a keyword and regex scan of the character-relevant fields of every
  initial entry. `retrospective_note` is exempt;
- asserts that references resolve and that conflicts are symmetric.

Result on 2026-09-28: **46/46 tests passed** (40/40 exact substrings).
