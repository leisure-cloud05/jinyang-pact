# Demo script

Runs offline with the mock LLM (no key, no network). Preparation, once:

```powershell
npm run play:web:build
npm run play:server     # http://127.0.0.1:8787 (use a fresh --db for a clean session list)
```

For a live demonstration add `-- --live` (needs `.env`, see [Live Runbook](LIVE_RUNBOOK.md)); characters then speak with
the real model and the beats below still apply, but wording and exact turns vary.

## One-minute version

Setup before the audience arrives: **New session → C6 — Unavailable resources and unauthorized action → Full →
English → tick "Add the case's scripted clerk lines" → Begin.**

| time | do | the audience sees | takeaway |
|---|---|---|---|
| 0:00 | point at the Play tab | Jinyang, 936: the council (Shi Jingtang, Sang Weihan, Liu Zhiyuan) and the draft letter to the Khitan ruler | five language-model characters, one shared world |
| 0:10 | click **End turn**, then open **Inspector → Proposals** | Shi tried to dispatch version 1 promising 150,000 bolts of silk; status **rejected — H07: hedong lacks silk: needs 150000, available 60000** | the agent proposed, the harness disposed: an impossible promise never reached the Khitan |
| 0:25 | back to **Play**, click **End turn** | a modal: **Decision needed — Dispatch of the request**, with the exact terms that would be sent | a consequential action waits for the player; nothing is sent yet |
| 0:40 | choose **Amend the draft**, untick *serving the Khitan ruler with the rites due to a father*, **Decide** | the round regenerates; Shi now asks to dispatch version 4 without filial rites | the player changed the plan before it committed; stale proposals were discarded |
| 0:50 | **Decide: Endorse** | the fact header reports the dispatch and its arrival day; the prose describes only the atmosphere | the narrator reports only what was committed |

## Extended version (3–5 minutes)

Part 1 continues the C6 session above. Part 2 needs a fresh session in which the request has not been sent yet:
**New session → C1 — Cooperation with valid terms and authorization → Full → 中文** (Chinese narration) **→ Begin**.
Part 3 shows the play aids in a fresh **C3 — Stricter acceptable terms** session.

**Part 1, C6 (after the dispatch was endorsed)**

1. **Inspector → Events.** Each committed event lists the rules it passed; a dispatch, for example, lists H04, H07,
   H10–H13, G02 and G08. Every change to the world goes through one commit interface. *Takeaway: consistency is
   checked, not hoped for.*
2. **Inspector → Proposals.** The proposals generated before the amendment are marked *obsolete: the round was
   regenerated*. In round 2 Sang tries to revise the letter after it was sent and is rejected with **H11: document
   A is sent and immutable**. *Takeaway: decisions invalidate stale drafts; sent documents cannot change.*

**Part 2, C1**

3. **Speak to the council.** Type e.g. *契丹援兵之事，诸公以为当如何？* under *Speak to…*, click **Say**, then **End
   turn**, and once more **End turn** if no decision appears. A **Dispatch of the request** decision opens.
4. **Ask before deciding.** Choose **Ask**, pick who to ask (only characters in the room are listed), type e.g.
   *为何要割让雁门以北诸州？* and click **Decide: Ask**. The pause stays open, and the question and the
   character's in-character answer appear under *Your questions* inside the decision. *Takeaway: the player can
   question a character before deciding; the answer is built only from what the player is allowed to know.*
5. **Knowledge isolation.** Click **Hide to read the story**. The header shows **Director view (locked)**: the
   player sees only headquarters. Click it and confirm **Unlock and show**; the unlock is recorded with the session.
   The Khitan court and Luoyang, which act offstage, become visible, and so do the per-call details under
   **Usage**. *Takeaway: characters and player act on their own knowledge, not on the omniscient state.*
6. **Open the decision** again and choose **Decide: Endorse**. The fact header reports the dispatch and its arrival
   day.
7. **Timeline → Branch here** at the round in which the dispatch decision came up (round 1 if you spoke before the
   first **End turn**). In the new branch, repeat the council address and **End turn**, then choose **Withhold** at
   the dispatch pause. Use **Compare with another session** against the original: the comparison shows the shared
   prefix and the first divergence. *Takeaway: the same world with a different decision is a different story, and
   the difference is traceable.*
8. **Usage.** Logical calls, attempts, tokens, cost (reported vs estimated; an unknown cost is never shown as zero)
   and latency per role (mock: zero cost). While the director view is locked, offstage calls are hidden. After the
   unlock, or once the chapter has ended, the full record is shown. *Takeaway: every call is budgeted and logged.*

**Part 3, C3 (play aids)**

9. **Hourglass.** Beside the story: day, round, rounds left, the council's exchanges this round, and what the next
   five days do to grain, pressure and morale if nothing else changes. In a C5 session (low grain), withholding the
   request brings a mutiny warning by round 3 and **City in danger** by round 5, repeated above **End turn**.
   *Takeaway: every turn spends time, and the alerts never decide for the player.*
10. **Read the room.** Each person present has a bearing (Composed, Uneasy, Pressing) and what it rests on: the
    siege and the words you heard them say. *Takeaway: an impression from visible cues, never a hidden value.*
11. **Private counsel and examples.** Open **Sang Weihan**'s Character Profile and choose an **Openings for your
    next turn** topic. *Speak to…* selects Sang as the private listener and shows the original English line in an
    **Example — for reference only** card beside the input (above it on a narrow screen). Type your own words and
    click **Whisper to Sang Weihan**; the example is never inserted or sent. The log marks the line **private → Sang
    Weihan**. Close the example or change listener or mode to dismiss it. *Takeaway: only Sang hears the player's
    words; the example does not speak for the player.*
12. **Negotiation track.** Speak to Shi and Sang (e.g. *明公，表已誊毕，请用印遣使。*), **End turn** and endorse the
    dispatch. Shi's seal stamps onto the draft and his courier sets out for the Khitan court; on day 10 the Khitan
    counter-offer arrives at Jinyang, listing what it changed. *Takeaway: the cards follow what the clerk knows; a
    letter moves by the courier's schedule, and a reply appears only once it reaches headquarters.*
13. **Ending.** Play on until the chapter ends (in C3 the talks fail on day 25). A short silent ending plays: the
    map's last move, an illustration, then the ending card with the result. **Skip** shows the card at once,
    **Replay ending** plays it again, and **Watch the ending** below the story brings it back later. *Takeaway: the
    ending shows where the choices led, built from the chapter's own data.*
14. **Seal and send (C6).** In a fresh **C6** session, speak to Shi and Sang as in step 12 and click **End turn**;
    once Shi has approved the draft, click **Transmit…**. The request unrolls for a last review: both parties, the
    version, every term and its burden, with Shi's own approval beside his seal. **Back to edit** reopens the editor;
    **Confirm and seal** sends it, and only once the dispatch is recorded does the clerk's seal 遣 go down. The scroll
    rolls up and the draft keeps *sent by you · v2* with the seal. *Takeaway: the seal records the clerk's own act of
    sending, never anyone's consent.*

## If something goes wrong

- A stale tab after restarting the server: reload the page.
- The server refuses to start because the database is locked: another server process owns it; close it or pass
  `--db data/demo.sqlite`.
- Live mode is slow or a call fails: the session pauses with **retry / skip / stop**; choose **retry**, or switch
  to a mock session.
