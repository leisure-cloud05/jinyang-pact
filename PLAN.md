# The Jinyang Pact — Master Implementation Plan

Status: **v3.4** (Codex-approved v3.1 + alignment with proposal v2, `docs/reference/proposal_text.md`; later amendments are listed in `docs/review_log.md`) · Owner: Commander · 2026-09-28

This plan turns the group proposal (`docs/reference/proposal_text.md`, figure
`docs/reference/proposal_fig1_architecture.png`) into an implementable specification.
Guiding principle: **Agent proposes, harness disposes.** Models express positions and propose actions;
only the Harness validates and commits world-state changes. Where this plan says "must", tests enforce it.

---

## 0. Ground rules

| Topic | Rule |
|---|---|
| Roles | Commander plans/integrates; Claude Opus workers implement; Codex (gpt-6-astra, xhigh) reviews this plan and **every** code change before commit. |
| API key | OpenRouter key lives only in `.env` (gitignored). No agent or tool opens, prints, logs or copies `.env`. Headers are never logged; all logs pass `redactSecrets`. |
| Live calls | Explicit opt-in only (`LLM_PROVIDER=openrouter` **and** `--live`). Development, tests and CI use the mock LLM. Live runs are executed by the user (§14); output folders come back to the Commander. |
| Tuning hygiene | Live prompt tuning uses only dev configs D1–D3 and pilot variants P1–P3. C1–C6 inputs, user policies, detectors and scoring are frozen (hashes in `runs/freeze.json`) **before** their first live exposure, which is the main experiment. Any post-exposure change is disclosed and all affected runs are re-run. |
| Honesty | No fabricated results. Mock runs are "pipeline validation", never findings. Human ratings come only from humans. Every first-repetition trajectory (including failures) goes into the human packets. Unimplemented items are disclosed. |
| Language | Code/UI/logs/report in English. Narrative and dialogue in Chinese (`zh`) by default, `NARRATIVE_LANG=en` switch. Content files carry `zh` and `en` fields where user-facing. |
| Scope | One chapter (936, Jinyang), five characters, one scenario, closed action set. No unrestricted historical simulation. |
| Platform | Windows 11, PowerShell 5.1, Node 24.19 (`node:sqlite`), Git 2.55. Agent shells refresh PATH first (see `CLAUDE.md`). |

---

## 1. Stack

- Node 24 + TypeScript 7 (strict, ESM, NodeNext; relative imports end in `.js`; `import type` for types), `tsx`, `vitest`.
- `node:sqlite` `DatabaseSync`: WAL, `foreign_keys=ON`, `busy_timeout=5000`. **One writer process per DB file**
  (lock file `<db>.lock` holding the pid; a second writer refuses to start). Transactions are short and
  synchronous — never `await` network I/O inside a transaction. Export/pack uses `VACUUM INTO` (never raw-copy a WAL DB).
- `zod` v4 (LLM-facing schemas model optional fields as `.nullable()`; converted by `toStrictJsonSchema`), `yaml`.
- Server: Fastify + SSE. Web: Vite + React + TS, plain CSS. Charts: SVG generated in Node, no native deps.
- New dependencies need a one-line justification in the WP report; `package-lock.json` is committed and frozen for the main run.

---

## 2. Repository layout

(Actual layout; module responsibilities are specified in the sections below.)

```
PLAN.md README.md STATUS.md AGENT_START_HERE.md CLAUDE.md AGENTS.md .env.example package.json tsconfig.json
content/       sources/ (40 entries + README)  scenario/jinyang.yaml  characters/<id>.yaml  cases/C1..C6_*.yaml
               dev/D1..D3_*.yaml  pilot/P1..P3_*.yaml  traces/<case>.trace.yaml  notes/ (research notes + raw
               Wikisource snapshots used by the verbatim test)  README.md
src/config/    env.ts                                  # .env/env loading, live opt-in
src/content/   schema.ts loader.ts                     # zod schemas, loader, cross-reference validation
src/core/      types ids terms obligations actions rules resolve reducer execute plan before knowledge pauses
               negotiation siege system terminal projection permissive simulate script feedback hash rng
src/store/     db migrations repo lock export usage
src/harness/   harness commit decisions system narration replay recovery branch context mutex
src/llm/       client core openrouter mock/ schemas parse budget prices usage redact sanitize types
src/agents/    context ledger character judge mapper narrator answer names call schemas samples util
               narration/ (fact header, checker, fallback)  prompts/  mock-personas/
src/engine/    session runtime lifecycle scheduler policy records runner types
src/server/    index app manager controller store history projection aliases guard idempotency sse views/ dev
src/eval/      runner engine-adapter detectors constraints metrics leak freeze report narration-listing svg
               humaneval agreement reconcile pack zip  oracle/ (independent re-implementation; see §13.3)
src/cli/       smoke play exp report reconcile pack humaneval
web/  tests/  runs/  data/
docs/          PROJECT_HANDOFF.md NEXT_STEPS.md TEAM_GUIDE.md KNOWN_ISSUES.md demo_script.md review_log.md
               report/ reference/ (proposal)
```

---

## 3. Domain model

### 3.1 Identifiers

- Characters (`CharId`): `shi_jingtang` 石敬瑭, `sang_weihan` 桑维翰, `liu_zhiyuan` 刘知远, `yelu_deguang` 耶律德光,
  `li_congke` 李从珂. Player actor `player` (clerk 书记 in Shi's HQ). `ActorId = CharId | 'player' | 'system'`.
- Factions: `hedong` (Shi, Sang, Liu, player), `khitan` (Yelü), `tang` (Li). Principals: Shi, Yelü, Li.
- Locations = scenes: `jinyang_hq`, `khitan_court`, `luoyang_court`.
- World-object ids are deterministic counters (`doc:1`, `cmt:2`, `offer:3`, `msg:4`, `k:5`, `rsv:6`, `auth:1`,
  `sug:2`). Session-scoped control ids (batch, proposal, pause, decision, request) never appear inside world state.

### 3.2 Terms and obligations

```ts
interface SecretClause { id: string; text: { zh: string; en: string }; canary: string; knownBy: ActorId[] }
interface TermSet {                       // fixed shape (LLM-friendly); applicability per principal pair in the catalog
  vassal: boolean;                        // 称臣 (payer = non-Khitan party)
  filial: boolean;                        // 以父礼事之
  cession: 'none' | 'yanmen_north' | 'sixteen_prefectures';   // trigger: on_victory (future)
  annual_silk: number;                    // bolts/yr, trigger: annual_after_confirm (future)
  immediate_silk: number;                 // bolts, trigger: on_confirm (reserved at consent, debited at confirm)
  aid_cavalry: number;                    // Khitan troops, trigger: on_confirm; exclusivity pool `khitan_stance`
  aid_arrival_days: number;               // promised arrival after confirmation
  neutrality: boolean;                    // Khitan pledge (tang↔khitan only); pool `khitan_stance`
  marriage_alliance: boolean;             // tang↔khitan only (payer tang)
  secret_clauses: SecretClause[];
}
```
`obligations.ts` derives typed obligations `{payer, kind, resource?, amount?, trigger, exclusivityKey?}` from a
TermSet and the principal pair. `burden(terms)` = catalog-weighted score (used for goals and evaluation).
Exclusivity: Khitan `aid_cavalry > 0` toward hedong and `neutrality` toward tang share pool `khitan_stance`;
at most one such obligation may be **reserved or confirmed** at any time.

### 3.3 WorldState (versioned; canonical-JSON SHA-256 hash)

```ts
interface WorldState {
  version: number; round: number; day: number; counters: Record<string, number>;
  characters: Record<CharId, { status: 'alive'|'dead'|'captured'; location: LocId; faction: FactionId }>;
  player: { location: LocId; goal: PlayerGoal; authorizations: Record<AuthId, Authorization> };
  factions: Record<FactionId, { resources: Record<ResourceKey, number>; reserved: Record<ResourceKey, number> }>;
  reservations: Record<RsvId, { faction; resource; amount; commitmentId; offerId; status: 'held'|'released'|'debited' }>;
  siege: { pressure: number; morale: number };
  documents: Record<DocId, Document>;
  suggestions: Record<SugId, Suggestion>;
  commitments: Record<CmtId, Commitment>;          // one per negotiation thread
  offers: Record<OfferId, Offer>;                  // immutable terms snapshots
  messages: Record<MsgId, Message>;                // immutable payload snapshots
  knowledge: Record<KnowId, KnowledgeItem>;        // structured, versioned assertions
  // staged consequential system outcomes are NOT world state: they are `system_outcome` batches (§8.3)
  flags: { assistanceAbandoned: boolean; mutinyOccurred: boolean; khitanArrivalDay: number|null };
  terminal: null | { kind: TerminalKind; day: number; round: number; detail: Record<string, unknown> };
}
interface Document { id; kind: 'assistance_request'; holder: CharId; accessibleBy: ActorId[]; version: number;
  terms: TermSet; note: string; status: 'draft'|'approved'|'sent'|'withdrawn';
  approval: null | { version: number; eventId: number; by: 'shi_jingtang' };
  timing: { mode: 'now'|'delay'|'hold'; notBeforeRound: number|null }; history: { version; by; round }[] }
interface Commitment { id; parties: [CharId, CharId]; pair: string; status: 'negotiating'|'confirmed'|'rejected'|'withdrawn';
  liveOfferId: OfferId; termsVersion: number; consents: Record<CharId, { termsVersion: number|null; evidence: string|null }>;
  secret: boolean; confirmedDay: number|null }
interface Offer { id; commitmentId; from: CharId; to: CharId; terms: TermSet; termsVersion: number;
  consentEvidence: string;                  // e.g. 'event:12' (Shi's approval) or the sender's action event
  sentDay; arrivalDay; messageId; status: 'in_transit'|'delivered'|'accepted'|'countered'|'rejected'|'withdrawn';
  withdrawal: null | { messageId; effectiveDay: number } }
interface Message { id; from: ActorId; to: ActorId; kind: 'offer'|'response'|'withdrawal'|'withdrawal_result'|'letter'|'intel';
  payload: Record<string, unknown>;         // immutable snapshot taken at send time
  sentDay; arrivalDay; sendSeq: number; status: 'in_transit'|'delivered' }
interface KnowledgeItem { id; holder: ActorId; subject: string; predicate: 'terms'|'status'|'content'|'value'|'claim';
  value: unknown; asOfDay: number;
  evidence: { kind: 'initial'|'source'|'message'|'observation'|'own_action'|'decision'; ref: string };
  credibility: number; visibility: 'private'|'faction'|'public' }
interface Authorization { id; grantee: CharId; categories: PauseCategory[]; limits: TermLimits;
  grantedRound: number; expiresRound: number|null; revoked: boolean }
```

- **Knowledge**: a holder's belief about `(subject, predicate)` is its latest assertion. Validation of
  knowledge-dependent actions (H08) uses these assertions, never the live world object. Observation rule: events
  at a location create assertions for characters present who have access (e.g. document revisions for
  `accessibleBy`). Messages create assertions from their **immutable payload** on delivery only.
- **Dialogue is not world state.** Utterances go to the `dialogue` table `{seq, sessionId, round, epoch,
  worldVersion, speaker, listeners[], text, kind: speech|advice|question|answer}`. Speech never creates verified
  knowledge; listeners' contexts show "X said …" as a claim. Dialogue while paused does not bump the world version.

### 3.4 Proposal envelope

```ts
interface Proposal { proposalId; sessionId; batchId; round; epoch; baseVersion; actor: ActorId;
  source: 'llm'|'player'|'policy'|'system'; seq: number;       // order inside the actor's output
  action: Action; rationale: string; cites: string[]; askPlayer: { question: string } | null;
  status: 'pending'|'committed'|'rejected'|'withheld'|'stale_epoch'|'obsolete'|'unapplied'|'format_error';
  rule: string|null; reason: string|null;       // full reason (logs/inspector)
  feedback: string|null }                       // redacted reason given back to the actor (§8.6)
```

---

## 4. Actions (closed set) and negotiation semantics

`P` = mandatory pause category when the actor is player-side (Shi, Sang, Liu, or the player). Default
permissions are in character configs; the table shows defaults.

| type | args | may perform | validation (beyond H01–H03) | effects | P |
|---|---|---|---|---|---|
| `speak` | `to[]`, `text` | alive chars, player | listeners co-located (H08) | dialogue row only | – |
| `send_letter` | `to`, `text` | shi, sang, yelu, li | recipient remote | `letter` message with immutable text; recipient sees it as a claim | – |
| `revise_document` | `docId, baseDocVersion, terms, note` | sang, shi, player | accessible; status draft/approved; `baseDocVersion == version`; terms valid for pair | version+1; status draft; approval cleared | – |
| `suggest_revision` | `target: {docId}\|{offerId}, terms (partial), reason` | hedong chars, player | target visible to actor | non-binding suggestion | – |
| `approve_document` | `docId, docVersion` | shi | `docVersion == version`; status draft | **atomically** `status = approved` and approval `{version, eventId}` (approve→dispatch in one batch is legal) | – |
| `set_dispatch_timing` | `docId, mode: now\|delay\|hold, rounds?` | shi, player | doc not sent | `timing` updated (`delay` ⇒ `notBeforeRound = round + rounds`, 1–3) | – |
| `dispatch_document` | `docId, docVersion` | shi, player | approval.version `== docVersion == version`; status approved; timing allows (`hold` blocks; `round ≥ notBeforeRound`); not sent (H12); pair offer cap (H13); Shi's reservations feasible (H07) | opens a hedong↔khitan commitment (thread) with an offer **from Shi** (consent evidence = approval event); holds Shi's reservations; `offer` message; doc sent | `dispatch_request` (any operator) |
| `propose_terms` | `to, terms` | principals | no negotiating thread between the pair (else use respond/withdraw); cap; reservations | new thread + offer + message | `major_commitment` |
| `respond_to_offer` | `offerId, response: counter\|reject, counterTerms?, reason` | recipient of the **live** offer | offer live and `delivered` and actor holds receipt evidence of that `termsVersion`; counter: cap, reservations | counter ⇒ old offer `countered`, new offer (termsVersion+1), consents reset to the counter-sender, reservations moved; reject ⇒ offer+thread rejected, all reservations released; `response` message | counter: `major_commitment`; reject: `strategic_turn` |
| `withdraw_offer` | `offerId` | sender of the live offer | per sender's knowledge the offer is live and unanswered | `withdrawal` message; effect at delivery (§4.1) | – |
| `confirm_commitment` | `commitmentId, offerId, termsVersion` | recipient of the live offer (the only party with pending consent) | thread `negotiating`; offer live, `delivered`, evidence held; `termsVersion == offer.termsVersion`; actor's reservations feasible; exclusivity (H07) | consent recorded ⇒ thread `confirmed`: debit held reservations, record future obligations, `khitanArrivalDay` (G09); `response` message | `major_commitment` |
| `allocate_resources` | `faction, resource, amount, purpose` | faction principal | amount > 0; `available − reserved ≥ amount`; purpose valid | debit; purpose effects (G04/G05) | – |
| `abandon_request` | `reason` | shi | not abandoned; no confirmed hedong↔khitan thread | withdrawal messages for live hedong offers; auto-reject a delivered Khitan counter awaiting Shi; doc withdrawn; flag | `strategic_turn` |
| `revoke_authorization` | `authId` | player | authorization active | revoked | – |
| `wait` | – | anyone | – | none | – |

The player never approves, proposes, responds, confirms, withdraws, allocates or abandons (H02). Consent is
given only by (a) sending an offer (sender's consent to its termsVersion; for dispatched documents this is
Shi's approval event, whoever transmits) or (b) `confirm_commitment` by the live offer's recipient. There is no
principal-to-delegate consent delegation. `Authorization` is only the player's standing permission for a
character's critical decisions to proceed without a pause.

**Player-initiated critical actions** (e.g. the player transmits an approved request) are themselves the user's
decision: they carry an implicit decision record `player_initiated` (satisfies H10) and open no pause in any mode.
The UI may show a confirmation dialog, which is not a system pause.

### 4.1 Negotiation state machine (per thread = commitment)

| from | event | condition | to |
|---|---|---|---|
| — | dispatch / propose | no negotiating thread for the pair; cap | thread `negotiating`, offer `in_transit` (or `delivered` if co-located) |
| offer `in_transit` | system delivery at `arrivalDay` | — | `delivered`; recipient gets `terms` assertion (snapshot) |
| offer `delivered` | recipient `confirm_commitment` | live, evidence, termsVersion match | offer `accepted`, thread `confirmed` |
| offer `delivered` | recipient counter | live, cap | offer `countered`; new live offer (reverse direction) |
| offer `delivered` | recipient reject | live | offer `rejected`, thread `rejected` |
| offer `in_transit`/`delivered` | sender withdraw | sender believes it unanswered | withdrawal message queued |
| withdrawal message | delivery | offer still `in_transit`/`delivered` (unanswered) | offer `withdrawn`, thread `withdrawn`, reservations released; `withdrawal_result {effective: true}` message back to the sender |
| withdrawal message | delivery | offer already answered | void (`withdrawal_late` event); the answer stands; `withdrawal_result {effective: false}` message back to the sender |

- Deliveries in one PREPARE are processed in `(arrivalDay, sendSeq)` order; an offer and its withdrawal arriving
  the same day ⇒ the offer is delivered then withdrawn before the recipient can act.
- Only the live offer can be answered; answered/withdrawn offers can never be confirmed (no resurrection).
  `confirm_commitment` on a closed thread fails H04.
- **Negotiation segments** (proposal v2: "automatic negotiation at each decision point is limited to two rounds.
  If no feasible agreement emerges, the system pauses for the user to adjust the goal"; G10/H13). World state keeps
  per principal pair `negotiation[pair] = { segment: n, segmentOpenedBy: 'first_offer' | <decisionId>,
  roundsInSegment, offersTotal, deadlockPending: boolean }`.
  - A **negotiation round** is any offer sent after the segment's opening offer: a counter-offer, or a new offer
    (new thread) after a rejection/withdrawal. Waiting consumes no round; waiting is bounded by the chapter's round
    budget and the siege rules.
  - Segment 1 of every pair (including the autonomous tang↔khitan pair) opens with the pair's first offer.
    A new segment opens **only** by a resolved `negotiation_deadlock` decision with option `adjust_goal`,
    `urge_accept` or `urge_stop` (the enumerated qualifying decisions; endorsing an ordinary counter never resets).
    The autonomous tang↔khitan pair therefore has a single segment.
  - Counting is exactly H13's: the opening offer of a segment (pair's first offer, or first offer after a
    qualifying reset) is not a round; every later offer in that segment is. Oracle tests cover replacement-thread
    sequences (e.g. Li's fourth successive offer after three rejections is rejected).
  - At most **2 rounds per segment**. After the second, the live offer may only be confirmed or rejected (both
    parties' contexts say so); a further offer/counter is rejected (H13) with feedback.
  - **Exhaustion checkpoint** (Harness modes; hedong↔khitan pair only, since only it has a user): raised as a
    `negotiation_deadlock` control pause at ASSESS of the first character batch in which the segment has used both
    rounds without agreement **and** it is Shi's side's move — Shi holds the delivered live offer and his proposal
    this round is not `confirm_commitment` of it, or Shi has learned that the thread was rejected/withdrawn — or a
    player-side party attempted an over-segment offer. If the counterparty is to move, no pause is raised: its
    confirm ends the negotiation with agreement; its rejection triggers the checkpoint once Shi learns of it.
  - Deadlock resolution is the atomic transition in §7 (regenerating decision). At the global cap of **5 offers
    per pair** no new segment can open; the deadlock pause then offers only `urge_accept` (if a live offer awaits
    Shi), `urge_stop` and `ask`.
  - Baseline enforces none of this (permissive); the oracle flags offers beyond two rounds in a segment and any
    segment restart without a qualifying decision.
- `abandon_request` after dispatch: withdrawals race with answers per the table; if Yelü accepted before a
  withdrawal arrived, the pact stands.

### 4.2 Reservations

Consent (sending an offer or confirming) holds the consenting payer's `on_confirm` obligations as reservations
(`immediate_silk` from hedong/tang; `aid_cavalry` from khitan) and checks the `khitan_stance` exclusivity pool.
Counter ⇒ the countered offer's reservations are released and the counter-sender's are held; reject / effective
withdrawal ⇒ release all of the thread's reservations; confirm ⇒ debit all held reservations of the confirmed
termsVersion atomically. Future obligations (`annual_silk`, `cession`, titles) are recorded, never debited in-chapter.

### 4.3 Permissive executor (baseline only)

Applies each action's natural effects with **no** H02–H14 checks and no reservation feasibility checks
(balances may go negative). If effects are inapplicable (referenced object missing, malformed args) the attempt
is recorded as `unapplied` — **not** a commit. On-behalf actions are applied to the named target (e.g. Sang
confirming a thread records the pending party's consent attributed to Sang), so the oracle can flag them.
Critical actions commit without a pause unless the agent set `askPlayer`.

---

## 5. Hard constraints (Harness-enforced; independently re-checked by the oracle)

| id | constraint |
|---|---|
| H01 | Action type in the closed set; args match the schema (valid JSON ≠ valid action). |
| H02 | Actor has permission for the type; the player never consents for a character. |
| H03 | Actor alive; world not terminal (terminal is checked **between actions** inside a batch). |
| H04 | Referenced objects exist and are live; object versions current (`baseDocVersion`, `docVersion`, `termsVersion`, live offer). |
| H05 | **Batch entry check**: `batch.epoch == session.epoch` **and** `world.version == batch.baseVersion` (checked atomically at commit start; intra-batch changes after entry are expected). |
| H06 | Idempotency: `(sessionId, requestId)` unique; a repeat with the same payload hash returns the stored result; a different payload under a used id is rejected. |
| H07 | Resources stay ≥ 0 and `available − reserved ≥ amount`; reservations match obligations; the `khitan_stance` pool backs at most one obligation. |
| H08 | Knowledge/communication: knowledge-dependent actions require receipt evidence (assertions); speech only to co-located listeners; nothing is known before `arrivalDay`. |
| H09 | A thread is confirmed only when both parties consented to the **same** termsVersion, each by itself (offer-sending or confirm). |
| H10 | Critical actions (§4 `P`) and staged consequential outcomes commit only after a resolved `endorse`/`delegate`/`let_it_happen` decision for that proposal/outcome in the same batch, a `player_initiated` decision (player's own action), or under an active matching Authorization. (Harness modes; baseline records H10 violations for the oracle.) |
| H11 | Only the approved current document version can be dispatched, and only when its timing allows; editing after approval voids approval; sent documents are immutable. |
| H12 | No duplicate dispatch of a document; no second answer to an answered offer. |
| H13 | Per principal pair: `roundsInSegment ≤ 2` and `offersTotal ≤ 5` (§4.1). Every committed offer (dispatch, `propose_terms`, counter) increments `offersTotal`; it increments `roundsInSegment` unless it is the segment's **opening offer** (the pair's first offer, or the first offer after a qualifying reset decision). Replacement threads after a rejection/withdrawal count as rounds. |
| H14 | Story time advances only in ADVANCE with no open pause and no uncommitted batch. |
| H15 | Model-generated outcome text is never written to world state. |
| H16 | The deterministic fact header is always correct. Model prose is checked on the rendered text (§9.4) for names/survival status, unit-bound quantities, claimed outcomes and undisclosed secrets; any hit ⇒ template fallback. Residual implicit contradictions in free prose are **measured** by human annotation, not guaranteed. |

Invalid `cites` are stripped and counted (`cite_error`), not a rejection.

---

## 6. Game rules (explicit, simplified assumptions; parameters in `content/scenario/jinyang.yaml`)

Game assumptions, not historical claims. Defaults below; content may tune values (never semantics).

- G01 Time: round 1 starts on day 0. Time advances only in ADVANCE: `day += 5`. No attrition before round 1.
- G02 Travel (days): Jinyang↔Khitan court 5; Jinyang↔Luoyang 5; Luoyang↔Khitan court 10.
  A message sent on day d arrives at `d + travel`; it is delivered in the PREPARE of the first round whose day ≥ arrival.
- G03 Supplies (ADVANCE): `grain = max(0, grain − 5)` (same clamp in live rules, projection and oracle; fixtures
  include a non-multiple-of-five grain value).
- G04 Pressure (ADVANCE): `pressure = min(100, pressure + 8)`. `allocate_resources(tang, reserve_troops, n, intensify_siege)`
  at commit: `pressure = min(100, pressure + 2·floor(n/5000))`, `reserve_troops −= n`.
- G05 Morale (ADVANCE): if `grain < 15 or pressure > 70` then `morale = max(0, morale − 5)`.
  `allocate_resources(hedong, silk, n, pay_troops)` at commit: `morale = min(100, morale + 3·floor(n/10000))`.
- G06 Mutiny (after the ADVANCE batch commits, if not fallen): if `grain ≤ 10 and morale ≤ 30 and !mutinyOccurred` and
  no open `system_outcome` batch ⇒ create a `system_outcome` batch (baseVersion = current) holding the system proposal
  `mutiny_outbreak`. Harness modes: mandatory `mutiny` pause on that batch; `let_it_happen` ⇒ commit: `morale = 0`,
  `pressure = min(100, pressure+20)`, `mutinyOccurred = true`, then terminal check (G07 may fire);
  `urge_payment` ⇒ the batch commits a `mutiny_averted_for_now` event (no effects) plus advice to Shi; conditions are
  re-evaluated at the next ADVANCE. Baseline: the outbreak commits immediately with no gate.
- G07 Fall: `grain ≤ 0 or pressure ≥ 100` ⇒ terminal `jinyang_falls`.
- G08 Tang intelligence: a dispatch on day d creates an `intel` message to Li arriving d+5: "an envoy left Jinyang
  northward" (no content; credibility 0.6).
- G09 Relief: confirming a hedong↔khitan thread with `aid_cavalry > 0` on day d sets
  `khitanArrivalDay = d + aid_arrival_days` (epilogue projection only).
- G10 Negotiation segments: opening offer + at most 2 rounds per segment; 5 offers per pair overall (H13, §4.1).
- G11 No-assistance projection: `projectSiege(state)` is a **pure forecast** (no commits, no pauses, no checkpoints):
  applies the **same five-day ADVANCE transition** (G03–G07) repeatedly with no relief and no further actions,
  assuming `let_it_happen` at a mutiny (stated in `assumptions`), and returns
  `{ fallDay, mutinyRiskDay, assumptions }`, stored in the terminal `detail` with `projected: true`. A test asserts
  forecast/live equivalence: running live ADVANCEs with no actions and `let_it_happen` gives the same fall day.
- G12 Terminal precedence, evaluated at the end of PREPARE, after each committed action, and after ADVANCE:
  `jinyang_falls` > `pact_concluded` > `no_assistance` > `talks_failed`. First satisfied wins; the world is then frozen.

Terminal kinds:
- `pact_concluded`: a hedong↔khitan thread is `confirmed` **and** Shi holds evidence of it (own confirm, or the
  response message delivered).
- Closure evidence for Shi is any of: a delivered rejection `response`, a delivered `withdrawal_result
  {effective:true}`, a delivered withdrawal by the counterparty of its own live offer, or `own_action` evidence
  when Shi himself rejected the live offer (directly or via
  `abandon_request`'s automatic rejection). Tests cover both local paths reaching a terminal without an acknowledgment.
- `no_assistance`: `assistanceAbandoned`, no hedong↔khitan thread `negotiating` or `confirmed`, and Shi holds
  closure evidence for every thread (or nothing was ever sent).
  Detail = G11 projection.
- `talks_failed`: not abandoned; ≥1 hedong↔khitan thread exists, all are `rejected`/`withdrawn`, Shi holds evidence of
  the latest closure (see closure evidence above), and either the global cap is reached or no new
  hedong offer was sent in the round in which Shi learned of the closure (checked at that round's ADVANCE).
- `jinyang_falls`: G07.

Execution status is separate from the world terminal (§8.4): `max_rounds`, `budget_exhausted`, `error` are **run
outcomes**, not world terminals. A world terminal that is not in the case's `valid_terminals` is classified as
`invalid_terminal:<kind>` and counts as not completed.

Death and allegiance: no in-chapter action or rule produces them (they appear only in the epilogue). The pause
categories and H10 handling exist in the rule engine and are unit-tested with synthetic test-only fixtures; the
report discloses that the cases do not exercise them.

---

## 7. Pauses and decisions

```ts
type PauseCategory =
  | 'dispatch_request'|'major_commitment'|'strategic_turn'|'mutiny'|'death'|'allegiance'|'negotiation_deadlock' // mandatory
  | 'internal_disagreement'|'goal_conflict'|'risky_delay'|'ambiguity'                                       // semantic (Judge)
  | 'prompt_request'                                                                                         // askPlayer (all modes)
  | 'user_requested'|'error_recovery';                                                                       // reported separately
interface Pause { id; sessionId; batchId: string|null;   // null only for user_requested / error_recovery
  round; epoch; kind: 'mandatory'|'semantic'|'prompt'|'control'|'user'|'error';
  category; proposalIds: string[]; visibleFacts: {zh; en}[]; question: {zh; en};
  options: DecisionOption[]; status: 'open'|'resolved'|'obsolete'; decisionId: string|null }
```

Every decision pause belongs to exactly one **batch** (§8.3): a `character` batch (critical/semantic/prompt pauses,
deadlock control pauses) or a `system_outcome` batch (mutiny). Resolving the last open pause of a batch triggers
`commitBatch` for that batch and then the phase-specific continuation (§10.1) — **unless** the decision is a
*regenerating decision* (below), which obsoletes the batch instead. `player` batches never pause.

**Pause plan** (Harness modes): `dryRun` computes which proposals would commit and which of those need a
decision. After every resolved decision (withhold, endorse, delegate, …) the dry run is **recomputed** over the
remaining proposals; newly required pauses are opened before committing (iterate until stable; bounded by the
number of proposals). A proposal that becomes invalid is simply rejected at commit.
**Control pauses** (`negotiation_deadlock`) are raised when a negotiation segment is exhausted and the live offer
awaits Shi, or from rejected over-segment counters of player-side parties; they are exempt from the "would commit"
filter.

Feasible options per category (UI and scripted policies may only choose these):

| category | options |
|---|---|
| dispatch_request | endorse · withhold · amend · delegate · ask |
| major_commitment | endorse · withhold · counter_draft · delegate · ask |
| strategic_turn | endorse · withhold · ask |
| mutiny (staged) | let_it_happen · urge_payment · ask |
| negotiation_deadlock | adjust_goal · urge_accept · urge_stop · ask |
| death / allegiance (synthetic) | endorse · withhold · ask |
| semantic, prompt_request | endorse · withhold · amend (if a document is involved) · counter_draft (if an offer is involved) · ask |
| user_requested | resume · ask |
| error_recovery | retry · skip_actor · stop |

Decision semantics:
- **endorse / let_it_happen** — proceed; the proposal/outcome is validated at commit.
- **withhold** — proposal marked `withheld`; actor receives the player's objection as `advice` dialogue; the rest of the batch proceeds.
- **amend** — a player `revise_document` commits immediately (own transaction) ⇒ world version changes ⇒ the batch
  and all its open pauses become `obsolete`, `epoch += 1`, and the round regenerates (GENERATE again). Editing never creates consent.
- **counter_draft** — non-binding advice to Shi carrying structured counter-terms (dialogue `advice`); the paused proposal is withheld.
- **delegate** — endorse + create an `Authorization` (grantee, categories, limits, expiry).
- **urge_payment** — advice to Shi; staged mutiny cancelled.
- **adjust_goal / urge_accept / urge_stop** (deadlock) — regenerating decision, see below.
- **ask** — dialogue while paused; does not change world version; the pause stays open. The question is
  addressed to a living character **present with the clerk** — by default the actor of a paused proposal if present,
  otherwise one the player chooses; offstage or dead characters cannot be asked, and an explicitly named
  unavailable addressee is refused (never silently replaced). That character **answers in character** in one speech-only call (role `answer`) whose context is
  **player-visible only** (same structural rule as the narrator, §9.4): the answerer's persona, public role and
  stance, the player's view, the pause's facts and dialogue the player heard — never secret clauses unknown to the
  player, private memories, private goals or offstage events, so the answer cannot disclose them. The question is
  redacted at ingestion and passed as delimited untrusted data, not instructions. The output schema
  is `{speech}` only: no actions, no world change. The answer is recorded as dialogue and is budgeted, logged,
  leakage-scanned and redacted like any call. A failed or over-budget answer call records a templated "no answer"
  line and leaves the pause open (no error_recovery pause). Scripted decision policies never choose `ask`, so the
  answer role does not affect C1–C6 metrics; it exists for interactive play and is frozen with the other prompts.
- **Ordinary decisions** (endorse, withhold, counter_draft, delegate, let_it_happen, urge_payment) are stored in the
  control tables; their world effects (authorization, staged outcome) are applied inside that batch's commit
  transaction, *after* the H05 entry check.
- **Regenerating decisions** (`amend`; deadlock `adjust_goal` / `urge_accept` / `urge_stop`) execute as **one atomic
  transition** in a single transaction: persist the decision → commit a `player` batch with its world effects
  (`amend`: the document revision; `adjust_goal`: new `player.goal` limits; every deadlock option: open a new
  negotiation segment unless the global cap is reached, recording the decision id as `segmentOpenedBy`) → record
  advice dialogue (urges) → mark the paused character batch and all its open pauses `obsolete` → `epoch += 1` →
  continuation = GENERATE (new character batch for the same round). The obsolete batch can never commit (H05).
- Judge REVISE: one revision call for that character, then the Judge re-assesses the revised proposal once; a
  second REVISE becomes PAUSE (`ambiguity`). Mandatory rules always apply to revised proposals.
- Pause facts and questions are built from the player's knowledge only.

---

## 8. Harness

### 8.1 API

```ts
class Harness {
  validate(state, proposal, ctx): ValidationResult;          // pure; rule id + full reason + redacted feedback
  classify(state, proposal): PauseCategory | null;           // mandatory categories
  dryRun(state, batch): DryRunResult;                        // which proposals would commit, which need pauses
  commitBatch(req: { sessionId; batchId; requestId }): CommitResult;          // §8.2, one transaction
  runSystemPrepare(sessionId, requestId): CommitResult;       // deliveries, withdrawals, intel, terminal
  runSystemAdvance(sessionId, requestId): CommitResult;       // day+5, G03–G07, staging, terminal
  applyPlayerAction(sessionId, proposal, requestId): CommitResult;
  openPause / resolvePause(sessionId, pauseId, decision, requestId);          // idempotent
  interrupt(sessionId, instruction, requestId): { epoch };   // epoch+1, abort in-flight calls, batch stale
  replay(sessionId, mode: 'patch'|'rederive'): ReplayReport;
  branch(sessionId, atVersion): { newSessionId };
  regenerateNarration(sessionId, eventIds, narrate): void;   // never re-executes actions
}
```

### 8.2 Commit protocol (`commitBatch`)

`BEGIN IMMEDIATE` → idempotency lookup `(sessionId, requestId)` (same payload hash ⇒ return stored result) →
**H05 entry check** → apply decision world-effects → for each non-withheld proposal in order (`commitPriority`
from config: principals `shi`, `yelu`, `li`, then `sang`, `liu`; then `seq`): validate against the evolving state,
apply effects (events with RFC-6902 `changes`, `facts`, `rulesApplied`), check terminal (G12) between actions;
invalid ⇒ `rejected` with rule/reason/feedback → write snapshots, proposal statuses, batch status, request record
→ `COMMIT`. Any exception ⇒ `ROLLBACK` and nothing is written. Every committed world change is an event; versions
increase by one per event.

### 8.3 Epochs and batches

**Every world write goes through a batch** `{batchId, sessionId, kind, round, epoch, baseVersion,
status: generating|assessed|paused|committed|stale|obsolete}` committed by `commitBatch` with the H05 entry check:

| kind | created | pauses | continuation after commit |
|---|---|---|---|
| `system_prepare` | round start | never | PLAYER |
| `player` | per player input (UI) or per round (script); also `amend` | never (player-initiated decisions) | SELECT (or regenerate if it obsoleted a paused batch) |
| `character` | GENERATE | critical / semantic / prompt / control | NARRATE → ADVANCE |
| `system_advance` | ADVANCE | never | G06 check → `system_outcome` or next round |
| `system_outcome` | G06 after ADVANCE | `mutiny` (Harness modes) | terminal check → next round |

`epochs {sessionId, epoch, startedAt, reason, instructionId}`. `interrupt` is accepted **only while a `character`
batch is open** (generating, assessed or paused); at any other time (e.g. during a `system_outcome` mutiny pause, or
between phases) the instruction is queued in `pending_instructions` and applied at the next PLAYER step, and the
epoch is unchanged. `interrupt` or `amend` ⇒ `epoch += 1`, the open
`character` batch becomes `stale`/`obsolete`, its open pauses `obsolete`, in-flight calls are aborted. A stale batch
can never commit even if the world version is unchanged (H05). Terminal conditions are checked after every
committed event, including decision effects.

### 8.4 Execution status, recovery, budget

`sessions.status ∈ {ready, generating, assessing, awaiting_decision, committing, narrating, suspended, finished,
stopped}` plus `phase`, `round`, `epoch`, RNG seed, frozen content/rule/prompt hashes, mode, lineage. On start:
`generating` with an incomplete batch ⇒ mark stale and regenerate; `assessed`/`paused` ⇒ restore pauses;
committed-but-unnarrated ⇒ `narration_pending`. Timeout or budget exhaustion ⇒ `suspended` with the batch and
pauses preserved (resume = retry; stop = run outcome `budget_exhausted`/`error`). H03 concerns the world terminal only.

### 8.5 Replay and branching

- `patch`: re-apply stored `changes` from the initial snapshot; compare every snapshot hash.
- `rederive` (mode-aware): Harness modes re-run validation/resolution on stored proposals, stored decisions and
  system steps (no LLM), requiring identical events, identical rejections (same rule ids) and final hash; baseline
  re-runs the permissive executor. Replay is computed for **all** runs, including incomplete/failed ones.
- `branch`: allowed only at **round-start versions** (recorded in `round_starts {sessionId, round, version,
  dialogueSeqCutoff, controlSeqCutoff}`; these are quiescent — no open batch or pause). New session with immutable
  lineage `{parentSessionId, parentRound, parentVersion}`; copies the snapshot, events ≤ version and dialogue rows
  with `seq ≤ dialogueSeqCutoff` (never by worldVersion, since dialogue does not bump it); control
  records stay in the parent and the audit export of a child includes the parent's prefix by reference; epoch
  restarts at 0; the child resumes at PREPARE of that round.

### 8.6 Feedback redaction

A rejection whose failing check depends on facts the actor does not know (per its assertions) returns a generic
feedback ("could not be carried out as proposed") to the actor; the full reason is kept for logs/inspector.

---

## 9. Agents (LLM roles)

Output JSON validated by zod. OpenRouter `response_format = { type: 'json_schema', json_schema: { name, strict: true, schema } }`
with `provider: { require_parameters: true }`; one repair retry; then `format_error` ⇒ treated as `wait`.

Concrete limits (defaults; frozen for the main run): per-attempt timeout 60 s; HTTP retries 2 (backoff 1 s, 2 s,
±20 % jitter) on 408/409/429/5xx/network; 1 repair retry; `max_tokens` character 700, judge 500, narrator 900,
mapper 300; max input size character 32,000 chars (the context builder trims prompts to about 24,000 — oldest dialogue, then lower-priority sources, then oldest beliefs — so the remainder is headroom for text that cannot be trimmed, such as model-written document notes), judge 16,000, narrator 12,000, mapper 8,000; per-run budget
160 calls and US$0.50 with atomic worst-case reservation for parallel calls; run wall-clock limit 30 min
(the web server may set a longer explicit wall limit).
**Cost record contract**: one `llm_calls` row per logical call and one `llm_attempts` row per attempt
`{callId, attemptNo, kind: first|http_retry|repair, status, latencyMs, generationId|null, inputTokens, outputTokens,
costUsd|null, costSource: reported|estimated|none, reconciled: boolean}`; logical-call totals are derived from the
attempts (a billed malformed response and its billed repair are two attempts with two generation ids).
Reports sum `reported` and `estimated` separately; `none` is shown as unknown. Optional user-run
`npm run reconcile -- <dir> --live` fills `reconciled` costs from OpenRouter generation records.

### 9.1 Roles

| role | when | input | output |
|---|---|---|---|
| Character | every scheduled char in an interaction step | §9.2 authorized context plus pending items | `{ speech, private_rationale, actions: [{type, args, rationale, cites}] (0–3, sequential), ask_player: {question}|null, interaction: {addressed, requests, wait_for}|null }` |
| Judge | full mode; once per round with player-side proposals (+ ≤1 re-assessment after REVISE) | player goal & authorizations, player-visible facts, player-side proposals, open disagreements (suggestions, objections) | `{ items: [{ proposalId, verdict: CONTINUE|PAUSE|REVISE, category, reason, question }] }` |
| Narrator | per scene with committed, disclosed events | fact list for that scene, canonical names/status/numbers, style guide, language | `{ prose, mentioned_facts[] }` (metadata advisory only) |
| Mapper | free-text player commands (UI only) | player permissions, current draft, text | `{ kind: action|dialogue|clarify|unsupported, ... }` |

### 9.2 Authorized context (character)

Persona config; own knowledge assertions; authorized dialogue selected by the current item and topic; documents
accessible to it (secret clauses only if in their `knownBy`); live offers/threads **as the character's assertions
describe them**; unresolved rejection **feedback** (redacted, regardless of age); advice addressed to it; source entries whose
`learnable_by` contains `{holder: <char>, when: initial}` (never `never_initial` entries — those are epilogue-only);
source entries are serialized with **only** `id` (citation key), `original_zh`, `gloss_en`, `event_time` (without its authoring `note`), `location`, `persons` (never
`credibility_note`, `retrospective_note`, `derived_from`, `conflicts_with`), and a test inspects the actual
serialized context for future-outcome leakage.
Deterministic truncation order when over the per-role cap: older dialogue, then lower-priority sources.

### 9.3 Mock personas (`src/agents/mock-personas/`)

Deterministic, context-driven: Sang drafts generous terms; Liu objects to filial/cession and suggests gifts; Shi
approves and dispatches (multi-action) and answers counters within his tolerance; Yelü confirms iff terms meet his
reservation, else counters or rejects; Li presses the siege or counter-bids (C4). Judge mock pauses on open
objections/goal conflicts; narrator mock uses templates. A seeded **misbehaviour injector** (on-behalf consent,
answer before delivery, overdraft, duplicate dispatch, stale versions, fabricated cites, prose contradicting state)
exercises validation. Seeds derive from `hash(case, rep, actor, round, epoch, callTag)`.

### 9.4 Narration and consistency (H16)

Displayed narration = **deterministic fact header** (template rendering of the committed facts for that scene) +
model prose. **Division of labour (checker v9):** the header is the only place outcomes, identities and quantities
are stated; the prose is atmosphere only (setting, mood, gesture, weather, the council's tension). The prose prompt
says so explicitly. The checker inspects the **rendered prose itself**, independent of `mentioned_facts`, and any
hit ⇒ displayed prose replaced by the template prose (fallback): (a) any character name/alias/title/honorific
(incl. the player); (b) any numeral, ordinal, fraction or magnitude word anywhere, whatever its value — the only
exemptions are a closed list of lexicalized words with no quantitative reading (一切 一直 一起 一样 唯一 一旦 统一;
no one/someone/anyone/everyone/one another), and not when followed by a unit or classifier; (c) outcome vocabulary — agreement/acceptance/refusal/
withdrawal, dispatch/arrival/delivery, cession/transfer, mutiny, fall/surrender/conquest, death/capture/execution
and their common paraphrases, pact/alliance/neutrality (zh + en lexicons) — regardless of negation, subject or
supporting facts; (d) treaty-term, resource and spoils vocabulary; (e) canaries and secret-clause text not
disclosed to the scene. Raw prose, displayed text and check results are all stored.

**What is guaranteed and what is measured.** *Secrecy* is enforced **structurally**: the narrator's input for a
scene never contains undisclosed secret-clause text, ids, canaries or key terms (tested by replaying C1–C6 reference
traces; the test is shown non-vacuous by injection), so the narrator cannot leak a secret; a generated sentence
that happens to resemble one is an invention, not a leak. *Header correctness* is guaranteed (deterministic).
The lexical checker is a **conservative guard, not a semantic proof**: a paraphrase built only from permitted
atmosphere words can still imply an invented event. As the proposal (§3.3) states, such implicit contradictions
are **measured, not guaranteed**: (i) the human raters' per-paragraph contradiction and leakage marks (§13.4) and (ii) the report's
per-run fallback rate and a listing of every displayed prose paragraph for the 36 main runs in the audit bundle.
Newly found bypasses are fixed at the mechanism level (a class of construction, not a single synonym) with a
regression test; the checker is frozen with the other prompts before C1–C6 are run live (§0, §14).

---

## 10. Engine and modes

### 10.1 Round lifecycle

```
Round r (day d):
 1 PREPARE    system_prepare batch: deliveries in (arrivalDay, sendSeq) order, effective withdrawals + results, intel;
              terminal check; record round_starts(r, version) before it
 2 PLAYER     player batch: scripted/UI inputs validated and committed; player-initiated critical actions carry a
              player_initiated decision (no pause); dialogue recorded
 3 SELECT     shared deterministic scene scheduler (§10.3) in every mode; activation reasons logged per step
 4 GENERATE   character batch (r, epoch e, step s, baseVersion v): contexts → parallel calls → proposals stored (pending)
 5 CHECK      schema, cites
 6 ASSESS     Harness modes: dryRun ⇒ mandatory pauses for proposals that would commit + control pauses for
              player-side over-cap attempts; full: Judge (+REVISE loop); all modes: askPlayer ⇒ prompt pause
 7 DECIDE     open pauses ⇒ awaiting_decision; resolved via UI or scripted policy; pause plan recomputed after each
              decision; amend ⇒ player batch ⇒ character batch obsolete ⇒ back to 4
 8 COMMIT     commitBatch(character batch) (baseline: permissive executor, isolated DB)
 9 NARRATE    per scene: header + prose + checker/fallback; failure ⇒ narration_pending (regenerable);
              materialize committed interaction items, then repeat 3–9 if another item is immediately ready
10 ADVANCE    if no immediately actionable interaction item remains, or the round's interaction-step cap is spent,
              system_advance batch (day += 5; G03–G05; G07); then G06 ⇒ optional
              system_outcome batch (mutiny pause in Harness modes; resolved before round r+1 starts); r += 1
Interrupt during 4–6 ⇒ epoch+1, abort calls, batch stale, restart at 2 with the new instruction.
Same-round resumption: once pauses are resolved the round continues at 8; no round is consumed by a pause.
```

### 10.2 Modes (formal configurations share the **same deterministic scene scheduler**, §10.3)

| mode | Judge | validation + mandatory/control pauses | system outcomes (mutiny) | player-initiated actions | prompt pauses | narration header+checker |
|---|---|---|---|---|---|---|
| `baseline` (prompt-only commit) | no | **no** — permissive executor in an isolated DB | commit immediately, no gate | applied permissively (player_initiated record kept) | yes (rules stated in prompts) | yes (shared scaffolding) |
| `no_judge` (ablation) | no | yes | staged + mutiny pause | validated; player_initiated | yes | yes |
| `full` | yes | yes | staged + mutiny pause | validated; player_initiated | yes | yes |

Checkpoints are detected identically in every mode from proposals and state transitions (§13.1), so baseline
system outcomes that were never gated still count as checkpoint instances.

Shared scaffolding in all modes (documented in the report): authorized context builder, action vocabulary,
narration pipeline, scheduling. The comparison therefore isolates **commit enforcement** (baseline vs no_judge)
and the **Judge** (no_judge vs full); it does not claim to measure context isolation.

### 10.3 Scene scheduler (all modes, formal runs and play)

Deterministic rule (never an LLM decision), identical in every mode. The first step uses the scene schedule below
with pending items first; later steps select only newly ready pending owners, oldest item first, and keep capped
items for a future step or round. Candidates by priority tier:
1. **pending offer responders** — characters holding a delivered live offer awaiting their answer (always
   included; at most one per principal pair, so at most 3);
1b. **other delivery recipients** — recipients of letters/responses/intel delivered this round or earlier and not
   yet acted on (carry-forward), ordered by oldest undelivered-to-context delivery, then the fixed order;
2. characters addressed by the player this round;
3. agenda owners at the player's scene (`agendaTriggers`, e.g. Sang while the draft is open, Liu when terms include
   filial/cession, Shi when a decision is his);
4. periodic activations (Li every 2 rounds).
Fill tier by tier (1, 1b, 2, 3, 4), ties broken by the fixed order `shi, sang, liu, yelu, li`, up to **4 active
characters**; tier 1 is always included. Recipients skipped because of the cap carry forward and gain precedence in
tier 1b next round (a test fixture has five simultaneous candidates). Every activation is
logged with its reason and tier. Reference traces run through this actual scheduler. All five characters are in the
cast of every configuration ("five-character baseline").

Comparability: the rule is identical across modes, but trajectories diverge (e.g. a baseline dispatch that the
Harness would reject activates Yelü), so active sets are **not matched**; comparisons are reported as
whole-trajectory effects, with activation exposure (calls per character per mode) reported alongside.
The proposal's efficiency question is answered from execution logs (calls, tokens, cost, latency per role) plus a
**cost sensitivity analysis over the number of active characters k = 2…5**, recomputed from measured mean tokens
per character, Judge and narrator call (proposal Table 2 form); k = 5 exceeds the scheduler cap and is labelled an
extrapolation.

---

### 10.4 Interaction loop (engine.v2, web play)

One world round may contain up to **4 committed character interaction steps**. SELECT is keyed by round, epoch
**and step**, with a fresh character batch for each step. A committed question creates a recipient item; its
committed answer reactivates the asker in the same time window. Independent characters in one step may run in
parallel, but a reply is visible only to a later step after the preceding batch commits. Same-place dialogue
does not advance day; remote letters and offers still arrive only through PREPARE at their scheduled day.

The engine persists items for player speech, delivered messages, failed proposals and explicit character requests.
Each item records owner, source, topic, order, whether it was supplied and addressed, and whether it is open,
seen, waiting, resolved or obsolete. Selection and malformed output do not close it. Explicit `interaction`
metadata lists addressed item IDs, requests to present characters and structured waiting conditions. Ordinary speech
does not summon every listener. Invalid metadata creates actor-visible feedback and a bounded retry. The model
chooses all substantive decisions. The Harness retains the same mode-specific enforcement and is the only writer
of world state. A wait for an absent non-participant is invalid; Yelü's habitual reference to his mother is
expressive, since this chapter has no consultation event.

The four-step cap and the separate call/cost/wall limits make interaction denser and potentially more expensive
than v1. Extra steps can complete local discussions before a siege ADVANCE, but do not delay an eventual five-day
ADVANCE when the queue is empty or the cap is spent. Unresolved items carry into the next round. Development
defaults are 160 calls, US$0.50, 30 minutes, and four steps per round; web play uses a longer wall limit. An explicit
web budget extension is logged before resuming a suspended session. Exhausting a total budget records a run stop
and unresolved item list, never a world terminal. Frozen v1 results and `main-live-01` remain separate;
`engine.v2` refuses to resume v1 sessions, and any new live evaluation requires a new freeze and
result directory. These changes were informed by exposed formal cases, so later tuning uses D/P configurations
and any new formal results must be interpreted separately.

## 11. Server and UI

REST + SSE: `/api/sessions`, `/api/sessions/:id/{state,events,proposals,pauses,dialogue,narration,usage,audit}`;
`POST /api/sessions/:id/{input,interrupt,decision,advance,save,branch,replay,regenerate-narration}`; every POST carries
`requestId`. One server process owns the play DB. Panels: Story (scene narration, day/scene header, zh/en) ·
Council (co-located characters, talk box, mapper clarifications) · Draft (terms editor, version, approval/consent
badges, timing) · Decision modal (visible facts, question, category-specific options) · Inspector (events with
rules/changes/originating proposals; rejected/withheld/stale proposals with reasons; state diff; replay; branch) ·
Timeline (retrospective review, director view of all scenes, branch comparison with first divergence) · Usage.

---

## 12. Content specifications

### 12.1 Sources (`content/sources/zztj_280.yaml`)
Entries: `id, work, volume, locator, url, original_zh (verbatim), gloss_en, persons, event_time, location, topics,
kind, learnable_by [{holder: CharId|'player', when: initial|never_initial}], derived_from, conflicts_with,
credibility, credibility_note`. `event_time = {year, month|null, leap: boolean, lunar: true, note}` (e.g. 閏十一月 ⇒
month 11, leap true; undated persona sketches ⇒ month null). 25–40 entries; a repository test asserts every
`original_zh` is an exact substring of its raw snapshot in `content/notes/raw/`. The terms catalog's
`yanmen_north` level (partial cession) is a **game design choice**: historically "Lulong + north of Yanmen" is the
sixteen-prefecture area; the catalog documents this.

### 12.2 Scenario (`content/scenario/jinyang.yaml`)
Title; start note; all G parameters; travel matrix; locations; factions (principal, initial resources with
`assumption: true`); terms catalog (key, zh/en label, type/range/step, burden weight, applicable pairs, source refs);
initial world (characters, siege, resources, `doc:1` initial draft with terms, `accessibleBy`, secret-clause
`knownBy`, timing); initial knowledge assertions; player identity and permissions; epilogue (historical comparison
with source refs; `never_initial` sources allowed here only).

### 12.3 Characters (`content/characters/<id>.yaml`)
`id, name, title, faction, location, principal, permissions[], commitPriority, goals[], private_memory[], voice,
initial_knowledge[], agendaTriggers[], periodicActivation, reservation (Yelü/Li persona preferences; never enforced
by the Harness), tolerance (Shi: what he accepts without pressure), source_refs[], history_vs_assumption`.

### 12.4 Cases, reference traces, dev and pilot configs

Case file: `id, purpose, initial_overrides, player_goal {text, limits}, script [{round, inputs:[dialogue|action]}],
decision_policy [{match:{category, within_limits?, actor?, action_type?}, choose: <feasible option>, advice?}],
expected_checkpoints, constraints [{id, ...}], valid_terminals, max_rounds: 6`.
**Trajectory-robust scripts.** Scripted player inputs must not assume the reference trajectory happened:
- each script input may carry a `when` condition evaluated at the PLAYER step against the **player's** knowledge
  only — `always` · `player_received {kind: offer|response|letter|withdrawal_result|intel, from?: CharId}` ·
  `player_not_received {…}` · `doc_status {docId, status}` · `round_at_least n` — and inputs whose condition is false
  are skipped (logged);
- action args may use the placeholder `"$current"` for `baseDocVersion` / `docVersion`, resolved to the version the
  player can currently see;
- initial state may contain **pre-start messages/offers in transit** (e.g. an envoy already on the road), declared in
  `initial_overrides.in_transit` and validated like committed offers (reservations, caps, visibility);
- **Probes vs live behaviour**: a scripted action whose purpose is to test enforcement (e.g. an overdraft dispatch)
  is marked `probe: true`. Probes are **prohibited in the evaluation cases C1–C6** (the loader rejects them), because
  a probe committed permissively in baseline would change every later state, context and outcome of that
  trajectory. Probes live only in programmatic tests and dev configs (D1–D3), where their effects are reported in a
  separate "injected probe" table and never enter main-experiment metrics;
- decision-policy `amend` payloads also accept `"$current"`, resolved to the player-visible current document
  version at decision time;
- case constraints on checkpoints are **conditional**: "if a mutiny checkpoint instance occurs, it must be decided
  before its outcome (Harness modes)"; whether the condition was exercised is reported as exposure, not pass/fail.
- constraint names distinguish `actual_pause_before_commit` from `user_control_before_commit` (pause ∪
  authorization ∪ player-initiated), matching §13.2.

Every case ships a **reference trace** (`content/traces/<case>.trace.yaml`): a legal per-round sequence of
proposals/decisions that reaches a valid terminal within 6 rounds under G01–G12. A test replays each trace with
the scripted mock and asserts the terminal, round count and that initial grain/pressure are consistent with it.

Cases: **C1** valid cooperation · **C2** timing change (delay/advance; arrival and pressure effects) · **C3** stricter
acceptable terms (Yelü's reservation above the player's limits ⇒ counters within a negotiation segment, deadlock pause for the user to adjust the goal, justified acceptance or
refusal) · **C4** conflicting commitments (secret clause with canary + Li's competing neutrality/marriage bid;
`khitan_stance` exclusivity; information isolation) · **C5** decision not to seek assistance (low grain exercises
the mutiny pause; `no_assistance` projection) · **C6** unavailable resources / unauthorized action (overdraft gift
and on-behalf consent/dispatch attempts are rejected, then a valid path reaches a terminal).
Dev: **D1** internal deliberation, **D2** one external response cycle, **D3** pause/resume with interrupt, duplicate
request and narration failure. Pilot variants **P1–P3**: different initial drafts/resources, used for live tuning only.

Reference timing (C1): R1 Shi approves+dispatches (pause, endorse) → R2 Yelü receives and confirms → R3 PREPARE
delivers the response ⇒ `pact_concluded`. (C3): R1 dispatch → R2 Yelü counters → R3 Shi counters (pause) →
R4 Yelü may only confirm or reject (segment exhausted) → R5 Shi learns: confirm ⇒ `pact_concluded`; reject ⇒
exhaustion checkpoint (deadlock pause; the C3 policy chooses `urge_stop`) ⇒ no new offer ⇒ `talks_failed` at R5's
ADVANCE. Both cases fit in 6 rounds with one round of slack; the frozen C3 trace follows this path (a restarted
segment after R5 could push Shi's notification to R7 and is therefore not the reference path).

---

## 13. Evaluation

Main design: `baseline`, `no_judge`, `full` × C1–C6 × 2 repetitions = **36 runs**, ≤ 6 rounds, same scene scheduler
in every mode; shared model, seeds per (case, rep), budgets. **Case-based evaluation** (proposal v2): conclusions
are limited to this chapter and these six cases; analysis is descriptive (raw counts, denominators, matched case
comparisons), with no significance testing. Acceptance additionally requires every programmatic hard-rule test to
pass; any failed check and its effect is documented in the report. Programmatic tests (duplicate request,
obsolete draft, narration failure after commit) are reported separately from end-to-end narrative runs. Frozen: model slug, provider settings,
reasoning/sampling params, prompt/schema/rule/content hashes, `package-lock.json` (`runs/freeze.json`).
**Freeze scope:** a hash over every file a run executes or reads — `content/**`, `src/{core,harness,store,llm,agents,
engine,content,config}/**`, the eval runner/engine adapter, detectors and case constraints, `package-lock.json` —
plus the **effective runtime settings** (provider, model slug, prices, token caps, timeouts, retries, budgets,
language, modes, reps, seeds, max rounds). Reporting-only code (metrics, report, figures, agreement, pack) is not
frozen, so a reporting bug can be fixed without re-running. Any live run whose case id is in C1–C6 requires plan
`main` and a matching freeze (whatever `--plan` or `--cases` says); dev/pilot plans accept only D1–D3/P1–P3. An
output directory records its provenance (provider, freeze hash, plan) and a run directory with different
provenance is refused, never resumed; report labelling (mock banner) is derived from each run's own recorded
provider, and a mixed set is refused.

### 13.1 Checkpoints (annotation, independent of the Judge)

`eval/detectors.ts` marks a *checkpoint instance* when a consequential outcome would or did occur. Eligibility uses
the oracle's **action-validity** checks (H01–H04, H07–H09, H11–H13) and deliberately **excludes H05, H06, H10 and
H14** (epoch, idempotency, pause/authorization, time), so a critical proposal is never excluded because a pause
was missed. Instances: (a) a critical-type proposal (§4 `P`) that was committed or was eligible at its batch
state; (b) a system consequential outcome reconstructed from **state transitions** using G06's full preconditions
and G12 precedence (after an ADVANCE: world not terminal/fallen, `grain ≤ 10 and morale ≤ 30`, no prior mutiny,
first such ADVANCE since the last resolution), independent of staged/control records — negative fixture: grain 5,
morale 30 ⇒ ADVANCE causes fall ⇒ no mutiny instance; (c) semantic types:
`internal_disagreement` (Shi approves/dispatches while an advisor objection/suggestion on that doc version is open),
`goal_conflict` (player-side terms beyond `player_goal.limits`), `risky_delay` (delay/hold while grain ≤ 15 or
pressure ≥ 70); (d) `negotiation_deadlock` exhaustion instances, detected independently from the offer log with the
§4.1 definitions (segment rounds used, no agreement, Shi's side to move or a player-side over-segment attempt).
Instance key = `(type, objectId, objectVersion)`; repeats of the same key count once. Invalid critical
proposals that could not commit are **not** instances; they are reported separately.

### 13.2 Measures (denominators always reported; zero denominators ⇒ n/a)

| measure | definition |
|---|---|
| Invalid commit rate | applied committed action events violating ≥1 H-rule (oracle) ÷ applied committed action events; baseline `unapplied` attempts reported separately |
| Rejection rate | proposals rejected by validation ÷ **all** proposals generated (Harness modes; pending, obsolete, stale and malformed ones included in the denominator), with a status breakdown (committed / rejected / obsolete / stale / malformed / withheld / pending) reported alongside |
| Critical-pause recall (Table 1) | checkpoint instances with an **actual pause** resolved before the outcome committed ÷ **all** checkpoint instances. Reported alongside: authorization coverage (instances covered by a prior matching Authorization ÷ all), player-initiated share, and user-control rate (pause ∪ authorization ∪ player-initiated) |
| Pause precision | primary: pauses labelled necessary by human annotators ÷ all system-triggered decision pauses (mandatory + semantic + prompt, including later-obsoleted ones) in the 18 human-eval trajectories. The denominator is enumerated from the packet key, not from submitted labels. A pause counts as necessary iff a strict majority of the raters say yes. Ties and unlabelled pauses count as not necessary, which makes this a conservative lower bound. Label coverage and per-rater precision are reported alongside. Secondary (all 36 runs): detector-matched pauses ÷ the same denominator, labelled "automatic proxy" |
| Completion rate | runs ending in a valid world terminal within budget and max rounds ÷ runs |
| Replay consistency | runs whose `rederive` reproduces all events and the final hash ÷ **all** runs (patch replay reported too) |
| Case pass | all case constraints satisfied (per case × config) |
| Leakage | canary/secret-content hits in outputs of non-holders (automatic lower bound) + human leakage annotations |
| Narration | checker hits, fallback count; human contradiction annotations |
| Quality (human) | blind 1–5: character consistency, causal plausibility, perceived user control |
| Efficiency | calls, input/output tokens, reported cost (unreconciled ⇒ unknown), median and p95 latency per call/round/run; retries, repairs, aborted attempts; cost sensitivity over k = 2…5 active characters from measured per-role means |

### 13.3 Oracle and audit bundle

- Each run exports an **audit bundle** (`runs/<id>/<run>/audit/`): session.json (config, freeze hashes, lineage),
  snapshots, events, batches, proposals, epochs, requests (with payload hashes), pauses, decisions, dialogue,
  narrations (raw, header, displayed, checker results), llm_calls — all JSONL.
- `src/eval/oracle/**` re-implements H01–H16 and G01–G12 from this document. It must not import
  `src/harness/**`, `src/core/{rules,resolve,pauses,knowledge,terminal,projection,obligations}.ts` (types and the
  content loader only); a test scans imports. Validated by hand-computed fixture traces and **mutation tests** (dead
  actor acts; decision record removed before a critical commit; duplicate dispatch; delivery moved earlier; overdraft;
  termsVersion mismatch; consent by non-party; stale-epoch commit; day advanced while paused; false death in prose;
  secret disclosed to the wrong scene) — each must be flagged with the right rule id.

### 13.4 Human evaluation

18 trajectories (rep 1 of each case × config, failures included). Blind packets (random ids, identical formatting,
no mode labels): player-visible transcript (headers, prose, dialogue, pause prompts and player inputs) + offstage
appendix. Items: 1–5 ratings (character consistency, causal plausibility, perceived user control); per pause
"necessary?"; per committed critical outcome without a pause "should the player have been asked?"; leakage and
contradiction marks. ≥ 2 independent raters; CSV sheets; analysis: per-config mean/median/SD, matched per-case
comparison, weighted Cohen's κ and Krippendorff's α (ordinal), disagreement list (|Δ| ≥ 2). Optional LLM-as-judge
ratings are labelled supplementary. Small-sample honesty: counts with denominators, no significance claims.

---

## 14. Live-run workflow (user-operated)

1. `copy .env.example .env`; fill `OPENROUTER_API_KEY` (models default to `deepseek/deepseek-v4-flash`).
2. **Gate**: `npm run live:smoke -- --live` exercises the real agent schemas/prompts on fixed sample contexts →
   `runs/smoke-<ts>/`. The user sends it back (`npm run pack -- <dir>`); integration is not "live-ready" until this passes.
3. Pilot on D1–D3 + P1–P3 only: `npm run exp -- --plan pilot --live` (18 runs) → `npm run report` → Commander
   tunes prompts → repeat. **Gate before the pilot**: every smoke role parses against its schema (repairs counted),
   costs are reported, no `config` (input-cap) error. **Pilot exit criteria**, on the latest pilot iteration, read
   from its report: (a) `format_failure_rate` ≤ 5 % — logical calls of any role whose final status after the repair
   retry is `parse`, `schema`, `truncated` or `filtered`, over all logical calls made (n/a if none; this catches
   Judge replies that silently default to CONTINUE, which `format_errors` — malformed proposals — does not); (b) no run outcome `error` or `budget_exhausted` (world
   terminals and `max_rounds` are fine; D1 ends at `max_rounds` by design) and no `error_recovery_pauses`;
   (c) replay (rederive) 100 %; (d) `leak_hits` = 0 — D1–D3/P1–P3 hold no secret clauses, so this checks only that
   no canary appears and is reported as "secret isolation not exercised"; secret isolation is exercised by C4
   (and by the offline tests), never tuned on; (e) `narration_fallback_rate` recorded per mode, with a
   target ≤ 50 % (above it, tune the narrator prompt). **Tuning scope**: prompt text (`src/agents/prompts/*`) and
   per-role sampling/token settings only; rules, the narration checker, the scheduler, budgets, case/dev/pilot
   content and evaluation code change only to fix a demonstrated bug, with a regression test, review and a
   `docs/review_log.md` row. **At most three pilot iterations**: if a criterion still fails after the third, freeze
   the best iteration and disclose the failing criterion in the report (§18) and `docs/KNOWN_ISSUES.md`.
4. Freeze: `npm run exp -- --freeze` (writes `runs/freeze.json`; main refuses to run on hash mismatch).
5. Main: `npm run exp -- --plan main --live` (36 runs) → `npm run report -- <dir>` → pack → send.
6. Human eval: `npm run humaneval:packets -- <dir>` → raters → `npm run humaneval:agreement -- ratings/`.
7. Demo: `npm run play` (mock or live).
Packs exclude `.env`, contain no headers/keys (tested with synthetic keys, paths with spaces).

---

## 15. Work packages

| WP | owner | depends | deliverable | acceptance |
|---|---|---|---|---|
| A | Opus | plan v2 | `src/content` schemas+loader (fixtures), `src/core`, `src/store`, `src/harness` (incl. permissive executor, replay, branch, recovery); tests for every H/G rule, idempotency, epochs, batch entry, obsolete pauses, narration regeneration, recovery, reservations, negotiation races | typecheck + tests green; Codex no blocker/major |
| B1 | Opus | – | sources + notes (running) | substring verification; Codex |
| B2 | Opus | A schemas, B1 | scenario, characters, C1–C6, traces, D1–D3, P1–P3, content README | loader validates; traces pass with the scripted mock |
| C1 | Opus | – | LLM client infra (running) | tests green; Codex |
| C2 | Opus | A, C1 | agents: context builder, prompts, Judge, narrator + checker, mapper, mock personas; smoke with real schemas | unit tests; dry smoke |
| D | Opus | A, B2, C2 | engine (lifecycle, modes, scheduler, decisions, interrupts, budget, save/load/branch) + offline e2e over D1–D3, C1–C6 × 3 modes, reference traces | deterministic e2e green |
| E | Opus | D | server + web UI + `npm run play` | API tests + browser smoke |
| F | Opus | D | eval: runner, policy, audit export, independent oracle (+mutation tests), detectors, metrics, reports, human-eval packets, agreement, pack/freeze CLIs; mock pipeline validation | full mock pipeline produces all tables/figures |
| G | Commander + user | E, F | live gate → pilot → tuning → freeze → main | results from the user |

**Mapping to the proposal's schedule (Table 3) and team.** The proposal's six-week plan and five work areas map to
these packages: Week 1 sources, character configs, states/actions (B1, B2, A-core) · Week 2 Harness, transactions,
versioning, interruption; rule tests pass without model calls (A) · Week 3 Character Agents, Judge, Narrator;
internal deliberation and one external cycle (C1, C2, D) · Week 4 interface, branches, saving, retrospective review
(D, E) · Week 5 **freeze** of character configurations, prompts, rules and cases (`runs/freeze.json`), baseline and
ablation runs with execution and cost records (F, G) · Week 6 human evaluation, failure analysis, report and video
(G, H). Work areas and their designated leads (names supplied by the group): sources & scenario design (B1, B2);
Harness & storage (A); model integration (C1, C2, D); interface & demonstration (E); testing & reporting (F, H).
The proposal's workload estimate (80–120 person-hours, 16–24 per member) is the group's planning figure and is
reported as such; this build compresses implementation, and the report states which parts were AI-assisted.
| H | Opus | G | report (docx), README, demo script, figures (real results only); contribution statement mapping the five work areas to the five members' designated leads (names supplied by the user) | Codex checks claims against logs |

---

## 16. Review protocol (Codex)

Plan and every change are reviewed. The Commander stages a WP's paths (`git add <paths>`) and runs
`codex exec` (gpt-6-astra, xhigh, read-only) on `git diff --cached` against this plan; findings carry severity,
file:line, failure scenario and fix. Blockers/majors are fixed and re-reviewed (same Codex session via
`codex exec resume`) before commit; minors are fixed or deferred in `docs/review_log.md`, which is the record; raw review outputs are kept outside
the repository (those up to commit `fcb56f9` remain in the git history).

---

## 17. Risks and mitigations

| risk | mitigation |
|---|---|
| Live JSON/schema non-compliance | strict json_schema + require_parameters; zod; repair; `format_error` metric; live smoke gate |
| No live tuning by the Commander | rich per-call logs; pilot on dev/pilot configs only; conservative prompts |
| Evaluation circularity | independent oracle + mutation tests; detectors use the oracle; human necessity labels for precision |
| Confounded baseline | identical scheduling/context/narration across configs; documented shared scaffolding |
| Case exposure during tuning | tuning restricted to D/P configs; freeze hashes enforced |
| Cost overrun | per-session budgets with atomic reservations; caps; flash model |
| Historical inaccuracy | provenance; history vs assumption labels; conflicting accounts preserved; future facts never in character contexts |
| Windows/SQLite | one writer per DB, busy_timeout, VACUUM INTO exports, path tests with spaces |

---

## 18. Deviations and disclosures (for the report)

- Provider: OpenRouter-hosted `deepseek/deepseek-v4-flash` (not DeepSeek's own API); costs from OpenRouter usage records.
- All three formal configurations use the same deterministic scene scheduler; efficiency is analysed from logs plus a k = 2…5 cost sensitivity analysis (no separate scheduling experiment, per proposal v2).
- Baseline = prompt-only **commit** (permissive executor, isolated DB) with shared scaffolding (context builder, action vocabulary, narration pipeline).
- Time compression (5-day rounds) and all resource numbers are game assumptions.
- Death/allegiance pauses exist in the mechanism but are not exercised by the chapter's cases.
- Pause precision uses human necessity labels on 18 trajectories (automatic proxy on all 36).
- Narration is scene-scoped with deterministic fact headers.
