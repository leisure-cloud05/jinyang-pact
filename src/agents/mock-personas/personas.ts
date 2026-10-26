/**
 * Deterministic character personas for the mock LLM (PLAN §9.3). Each reads only the structured context the real
 * prompt was built from (`CharacterMeta.context`) and returns a schema-valid `CharacterOutput`:
 * - Sang drafts generous terms (vassalage, filial rites, at least the prefectures north of Yanmen, a silk gift)
 *   and urges sealing and sending;
 * - Liu objects to filial rites / cession and suggests gifts of silk instead;
 * - Shi approves and dispatches in one output (multi-action) when timing allows, answers offers within his
 *   tolerance (confirm), counters above it while the segment allows, otherwise rejects;
 * - Yelü confirms iff an offer meets his (pair-scoped) reservation, else counters toward it while the segment
 *   allows, else rejects; relief and neutrality exclude each other in one output;
 * - Li counter-bids for Khitan neutrality when he holds the intelligence AND the case's policy belief
 *   (`khitan_policy`, C4), otherwise presses the siege with reserve troops.
 * Revision requests (Judge REVISE) make a persona drop the flagged action types.
 */
import { TermSetArgsSchema, type TermSetArgs } from '../../core/actions.js';
import type { CharId, PairId } from '../../core/types.js';
import type { CharacterMeta } from '../character.js';
import type { AdviceView, CharacterContext, DocumentContextView } from '../context.js';
import type { CharacterActionItem, CharacterOutput } from '../schemas.js';
import {
  available,
  awaitingOffers,
  burdenOf,
  cessionRank,
  clampToCatalog,
  isApplicable,
  preferenceFor,
  preferenceViolations,
  toArgs,
  type AwaitingOffer,
} from './terms.js';

type Say = { zh: string; en: string };

function say(ctx: CharacterContext, s: Say): string {
  return ctx.lang === 'zh' ? s.zh : s.en;
}

function cite(ctx: CharacterContext, meta: CharacterMeta, ...wanted: string[]): string[] {
  return wanted.filter((w) => meta.citeKeys.includes(w));
}

function openDraft(ctx: CharacterContext): DocumentContextView | undefined {
  return ctx.documents.find((d) => d.basis === 'observed' && (d.status === 'draft' || d.status === 'approved'));
}

function timingAllows(ctx: CharacterContext, doc: DocumentContextView): boolean {
  if (doc.timing.mode === 'hold') return false;
  if (doc.timing.mode === 'delay') return doc.timing.notBeforeRound !== null && ctx.time.round >= doc.timing.notBeforeRound;
  return true;
}

function sameTerms(a: TermSetArgs, b: TermSetArgs): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function output(speech: string, rationale: string, actions: CharacterActionItem[], ask: string | null = null): CharacterOutput {
  return { speech, private_rationale: rationale, actions: actions.slice(0, 3), ask_player: ask ? { question: ask } : null, interaction: null };
}

function wait(rationale: string): CharacterActionItem {
  return { type: 'wait', args: {}, rationale, cites: [] };
}

// ---------------------------------------------------------------------------------------------------------------
// Hedong
// ---------------------------------------------------------------------------------------------------------------

function sang(meta: CharacterMeta): CharacterOutput {
  const ctx = meta.context;
  const doc = openDraft(ctx);
  if (doc && doc.status === 'draft') {
    const current = toArgs(doc.terms);
    const gift = Math.min(Math.max(current.immediate_silk, 50_000), clampToCatalog(ctx, 'immediate_silk', available(ctx, 'silk')));
    const target: TermSetArgs = {
      ...current,
      vassal: true,
      filial: true,
      cession: cessionRank(current.cession) >= cessionRank('yanmen_north') ? current.cession : 'yanmen_north',
      immediate_silk: gift,
    };
    if (!sameTerms(current, target)) {
      return output(
        say(ctx, { zh: '主公，表辞宜厚：称臣、父礼、许以边州，另奉厚礼，则契丹必朝呼夕至。', en: 'My lord, the terms must be generous: vassalage, filial rites, the frontier prefectures and a rich gift — then the Khitan will come by evening if called in the morning.' }),
        'Generous terms make the Khitan answer certain.',
        [
          {
            type: 'revise_document',
            args: {
              docId: doc.docId,
              baseDocVersion: doc.version,
              terms: target,
              note:
                target.cession === 'sixteen_prefectures'
                  ? say(ctx, { zh: '桑维翰润色：称臣，父礼，割卢龙一道及雁门以北诸州，另奉帛为礼。', en: 'Polished by Sang Weihan: vassalage, filial rites, the Lulong circuit and the prefectures north of Yanmen, and a gift of silk.' })
                  : say(ctx, { zh: '桑维翰润色：称臣，父礼，割雁门以北诸州，另奉帛为礼。', en: 'Polished by Sang Weihan: vassalage, filial rites, the prefectures north of Yanmen, and a gift of silk.' }),
            },
            rationale: 'Raise the draft to terms the Khitan ruler will accept.',
            cites: cite(ctx, meta, 'zztj280-009', 'zztj280-012', doc.docId),
          },
        ],
      );
    }
  }
  if (doc) {
    return output(
      say(ctx, { zh: '主公，表已具，辞意恳切，宜速用印遣使，迟则生变。', en: 'My lord, the memorial is ready and heartfelt; seal it and send the envoy at once — delay invites trouble.' }),
      'The draft is good; urge Shi to seal and send it.',
      [{ type: 'wait', args: {}, rationale: 'Drafting is done; the decision is Shi\'s.', cites: cite(ctx, meta, 'zztj280-009', doc.docId) }],
    );
  }
  const shiAwaits = ctx.negotiations.flatMap((n) => n.threads.flatMap((t) => t.offers)).find((o) => o.awaitingAnswerFrom === 'shi_jingtang');
  if (shiAwaits) {
    return output(
      say(ctx, { zh: '主公，契丹所索虽重，然援兵不可失。宜权衡而允之。', en: 'My lord, the Khitan ask much, but we cannot lose their help. Weigh it and accept.' }),
      'Relief matters more than the price.',
      [wait('Advising only; answering is Shi\'s.')],
    );
  }
  return output('', 'Nothing to draft or advise now.', [wait('Waiting for news.')]);
}

function liu(meta: CharacterMeta): CharacterOutput {
  const ctx = meta.context;
  const doc = openDraft(ctx);
  if (doc && (doc.terms.filial || doc.terms.cession !== 'none')) {
    const gift = clampToCatalog(ctx, 'immediate_silk', Math.min(doc.terms.immediate_silk + 100_000, available(ctx, 'silk')));
    return output(
      say(ctx, { zh: '明公，称臣可矣，以父事之太过。厚以金帛赂之，不必许以土田。', en: 'My lord, calling yourself his subject is acceptable; serving him as a father goes too far. Pay him generously in silk — no need to promise land.' }),
      'Filial rites and land are a lasting harm; gifts suffice.',
      [
        {
          type: 'suggest_revision',
          args: {
            target: { kind: 'document', id: doc.docId },
            terms: {
              vassal: null,
              filial: false,
              cession: 'none',
              annual_silk: null,
              immediate_silk: gift > doc.terms.immediate_silk ? gift : null,
              aid_cavalry: null,
              aid_arrival_days: null,
              neutrality: null,
              marriage_alliance: null,
              secret_clauses: null,
            },
            reason: say(ctx, { zh: '父礼、割地，恐异日为中国大患；宁厚赂金帛。', en: 'Filial rites and ceding land may one day be a great calamity; pay in silk instead.' }),
          },
          rationale: 'Object to filial rites and cession; propose gifts.',
          cites: cite(ctx, meta, 'zztj280-013', doc.docId),
        },
      ],
    );
  }
  const shiAwaits = ctx.negotiations.flatMap((n) => n.threads.flatMap((t) => t.offers)).find((o) => o.awaitingAnswerFrom === 'shi_jingtang');
  if (shiAwaits && (shiAwaits.terms.filial || shiAwaits.terms.cession !== 'none')) {
    return output(
      say(ctx, { zh: '明公，许地则后患无穷。', en: 'My lord, promise land and the harm will never end.' }),
      'Warn against land.',
      [wait('Advising only.')],
    );
  }
  return output('', 'Keep watch on the walls.', [wait('Nothing to object to.')]);
}

function answerOffer(
  ctx: CharacterContext,
  meta: CharacterMeta,
  a: AwaitingOffer,
  kind: 'reservation' | 'tolerance',
  adjust: (t: TermSetArgs) => TermSetArgs | null,
  lines: { confirm: Say; counter: Say; reject: Say },
): CharacterActionItem {
  const o = a.offer;
  const terms = toArgs(o.terms);
  const limits = preferenceFor(ctx, kind, a.pair);
  const violations = limits ? preferenceViolations(terms, o.terms.burden, limits) : [];
  const cites = cite(ctx, meta, o.offerId, o.commitmentId);
  if (violations.length === 0) {
    return {
      type: 'confirm_commitment',
      args: { commitmentId: o.commitmentId, offerId: o.offerId, termsVersion: o.termsVersion },
      rationale: `The terms meet my ${kind}.`,
      cites,
    };
  }
  const counter = a.onlyConfirmOrReject ? null : adjust(terms);
  if (counter && !sameTerms(counter, terms)) {
    return {
      type: 'respond_to_offer',
      args: { offerId: o.offerId, response: 'counter', counterTerms: counter, reason: say(ctx, lines.counter) },
      rationale: `Short of my ${kind} (${violations.join('; ')}); counter.`,
      cites,
    };
  }
  return {
    type: 'respond_to_offer',
    args: { offerId: o.offerId, response: 'reject', counterTerms: null, reason: say(ctx, lines.reject) },
    rationale: `Short of my ${kind} (${violations.join('; ')}) and no counter possible; reject.`,
    cites,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The player's advice (what the prompt shows under ADVICE ADDRESSED TO YOU)
// ---------------------------------------------------------------------------------------------------------------

export type AdviceKind = 'counter_draft' | 'adjust_goal' | 'urge_accept' | 'urge_stop' | 'urge_payment' | 'objection';

/** Reads an advice row as the model would: counter-terms / goal payloads, else its wording. Deterministic. */
export function adviceKind(a: AdviceView): AdviceKind {
  const p = a.payload;
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    if (p.counterTerms && typeof p.counterTerms === 'object') return 'counter_draft';
    if ('goalLimits' in p) return 'adjust_goal';
  }
  const t = a.text.toLowerCase();
  if (/罢议|罢兵|停议|止议|勿再议|不必再议|stop negotiating|stop the talks|end the talks|break off/.test(t)) return 'urge_stop';
  if (/犒军|犒赏|pay the troops/.test(t)) return 'urge_payment';
  if (/允之|可允|应允|从之|接受|accept the terms|urges you to accept|accept them/.test(t)) return 'urge_accept';
  return 'objection';
}

const ADVICE_PRIORITY: readonly AdviceKind[] = ['counter_draft', 'urge_stop', 'urge_accept', 'objection', 'adjust_goal', 'urge_payment'];

/**
 * The player's advice on this offer: rows since the offer reached the character, from the latest round with advice;
 * the most specific kind wins (counter-terms over an urge over a plain objection).
 */
function adviceOnOffer(ctx: CharacterContext, a: AwaitingOffer): AdviceView | null {
  const receivedRound = Math.floor(a.offer.asOfDay / Math.max(1, ctx.time.roundDays)) + 1;
  const relevant = ctx.advice.filter((x) => x.from === 'player' && x.round >= receivedRound);
  const lastRound = relevant.reduce((m, x) => Math.max(m, x.round), -1);
  const latest = relevant.filter((x) => x.round === lastRound);
  for (const kind of ADVICE_PRIORITY) {
    const hit = [...latest].reverse().find((x) => adviceKind(x) === kind);
    if (hit) return hit;
  }
  return null;
}

/**
 * Shi follows the clerk's advice on the live offer: counter-terms ⇒ counter with them (reject once only
 * confirm/reject remain); urge to accept ⇒ confirm; urge to stop ⇒ reject; a plain objection ⇒ counter with his own
 * previous terms (reject once the segment is exhausted). Other advice leaves him to his own judgement.
 */
function followAdvice(ctx: CharacterContext, meta: CharacterMeta, a: AwaitingOffer): CharacterOutput | null {
  const advice = adviceOnOffer(ctx, a);
  if (!advice) return null;
  const kind = adviceKind(advice);
  const o = a.offer;
  const cites = cite(ctx, meta, o.offerId, o.commitmentId, advice.ref);
  const reject = (why: Say): CharacterOutput =>
    output(say(ctx, { zh: '此约不可从。', en: 'These terms cannot be accepted.' }), `Following the clerk's advice (${kind}).`, [
      { type: 'respond_to_offer', args: { offerId: o.offerId, response: 'reject', counterTerms: null, reason: say(ctx, why) }, rationale: 'The clerk advised against these terms.', cites },
    ]);
  const counter = (terms: TermSetArgs): CharacterOutput =>
    output(say(ctx, { zh: '依书记之议，还价答之。', en: "On the clerk's advice, we answer with our own terms." }), `Following the clerk's advice (${kind}).`, [
      {
        type: 'respond_to_offer',
        args: { offerId: o.offerId, response: 'counter', counterTerms: terms, reason: say(ctx, { zh: '所索过重，愿以此为约。', en: 'You ask too much; let these be the terms.' }) },
        rationale: 'Counter with the terms the clerk advised.',
        cites,
      },
    ]);
  switch (kind) {
    case 'counter_draft': {
      const parsed = TermSetArgsSchema.safeParse((advice.payload as { counterTerms?: unknown }).counterTerms);
      if (!parsed.success) return null;
      if (a.onlyConfirmOrReject) return reject({ zh: '所索过重，不能从。', en: 'Too much; I cannot agree.' });
      return counter(parsed.data);
    }
    case 'urge_accept':
      return output(say(ctx, { zh: '依书记之议，允之。', en: "On the clerk's advice, we accept." }), 'The clerk urged acceptance.', [
        { type: 'confirm_commitment', args: { commitmentId: o.commitmentId, offerId: o.offerId, termsVersion: o.termsVersion }, rationale: 'Accept as urged.', cites },
      ]);
    case 'urge_stop':
      return reject({ zh: '罢议，据城自守。', en: 'We end the talks and hold the city.' });
    case 'objection': {
      const thread = ctx.negotiations.flatMap((n) => n.threads).find((t) => t.commitmentId === o.commitmentId);
      const mine = thread?.offers.filter((x) => x.from === ctx.self.id) ?? [];
      const previous = mine[mine.length - 1];
      if (!a.onlyConfirmOrReject && previous) return counter(toArgs(previous.terms));
      return reject({ zh: '所索过重，不能从。', en: 'Too much; I cannot agree.' });
    }
    default:
      return null;
  }
}

function shi(meta: CharacterMeta): CharacterOutput {
  const ctx = meta.context;
  const offers = awaitingOffers(ctx);
  const first = offers[0];
  if (first) {
    const advised = followAdvice(ctx, meta, first);
    if (advised) return advised;
    const limits = preferenceFor(ctx, 'tolerance', first.pair) ?? {};
    const action = answerOffer(
      ctx,
      meta,
      first,
      'tolerance',
      (t) => ({
        ...t,
        annual_silk: limits.annual_silk_max !== undefined && limits.annual_silk_max !== null ? Math.min(t.annual_silk, limits.annual_silk_max) : t.annual_silk,
        immediate_silk:
          limits.immediate_silk_max !== undefined && limits.immediate_silk_max !== null ? Math.min(t.immediate_silk, limits.immediate_silk_max) : t.immediate_silk,
        cession: limits.cession_max && cessionRank(t.cession) > cessionRank(limits.cession_max) ? limits.cession_max : t.cession,
      }),
      {
        confirm: { zh: '可。', en: 'Agreed.' },
        counter: { zh: '所索过重，愿以此为约。', en: 'You ask too much; let these be the terms.' },
        reject: { zh: '所索太过，不能从。', en: 'Too much; I cannot agree.' },
      },
    );
    const speech =
      action.type === 'confirm_commitment'
        ? say(ctx, { zh: '契丹之约，可允。', en: 'We accept the Khitan terms.' })
        : action.type === 'respond_to_offer' && action.args.response === 'counter'
          ? say(ctx, { zh: '所索过重，当还价。', en: 'They ask too much; we counter.' })
          : say(ctx, { zh: '此约不可从。', en: 'These terms cannot be accepted.' });
    return output(speech, 'Answer the offer within what I can bear.', [action]);
  }
  const doc = openDraft(ctx);
  const actions: CharacterActionItem[] = [];
  let speech = '';
  if (doc) {
    const cites = cite(ctx, meta, doc.docId, 'zztj280-012');
    const approvedCurrent = doc.status === 'approved' && doc.approvedVersion === doc.version;
    if (!approvedCurrent) {
      actions.push({ type: 'approve_document', args: { docId: doc.docId, docVersion: doc.version }, rationale: 'The draft is acceptable; seal it.', cites });
    }
    if (timingAllows(ctx, doc)) {
      actions.push({ type: 'dispatch_document', args: { docId: doc.docId, docVersion: doc.version }, rationale: 'Send the envoy without delay.', cites });
      speech = say(ctx, { zh: '此表可行。即日用印，遣使北上。', en: 'This will do. Seal it today and send the envoy north.' });
    } else {
      speech = say(ctx, { zh: '表已用印，且待时而发。', en: 'The memorial is sealed; it goes out when the time comes.' });
    }
  }
  const morale = ctx.siege?.morale;
  if (morale !== undefined && morale < 35 && available(ctx, 'silk') >= 50_000 && actions.length < 3) {
    actions.push({
      type: 'allocate_resources',
      args: { faction: ctx.resources.faction, resource: 'silk', amount: 50_000, purpose: 'pay_troops' },
      rationale: 'Steady the troops with silk.',
      cites: [],
    });
    speech = speech || say(ctx, { zh: '发库帛犒军，以安众心。', en: 'Pay the troops from the store to steady them.' });
  }
  if (actions.length === 0) return output('', 'Nothing requires my decision yet.', [wait('Waiting for an answer.')]);
  return output(speech, 'Act on the request while Jinyang can still hold.', actions);
}

// ---------------------------------------------------------------------------------------------------------------
// Khitan and Tang
// ---------------------------------------------------------------------------------------------------------------

function raiseToReservation(ctx: CharacterContext, base: AwaitingOffer): TermSetArgs | null {
  const limits = preferenceFor(ctx, 'reservation', base.pair);
  if (!limits) return null;
  const pair = base.pair;
  const next: TermSetArgs = toArgs(base.offer.terms);
  for (const key of ['vassal', 'filial', 'neutrality', 'marriage_alliance'] as const) {
    const req = limits[key];
    if (req !== undefined && req !== null && next[key] !== req) {
      if (!isApplicable(ctx, key, pair)) return null;
      next[key] = req;
    }
  }
  if (limits.cession_min && cessionRank(next.cession) < cessionRank(limits.cession_min)) {
    if (!isApplicable(ctx, 'cession', pair)) return null;
    next.cession = limits.cession_min;
  }
  for (const key of ['annual_silk', 'immediate_silk', 'aid_cavalry', 'aid_arrival_days'] as const) {
    const min = limits[`${key}_min`];
    const max = limits[`${key}_max`];
    if (max !== undefined && max !== null && next[key] > max) next[key] = max;
    if (min !== undefined && min !== null && next[key] < min) {
      if (!isApplicable(ctx, key, pair)) return null;
      next[key] = min;
    }
  }
  if (limits.burden_min !== undefined && limits.burden_min !== null && isApplicable(ctx, 'annual_silk', pair)) {
    let guard = 0;
    while (burdenOf(ctx, base.offer.terms, next, pair) < limits.burden_min && guard < 50) {
      const raised = clampToCatalog(ctx, 'annual_silk', next.annual_silk + 100_000);
      if (raised === next.annual_silk) break;
      next.annual_silk = raised;
      guard += 1;
    }
  }
  return preferenceViolations(next, burdenOf(ctx, base.offer.terms, next, pair), limits).length === 0 ? next : null;
}

const STANCE: Record<PairId, 'relief' | 'neutrality' | null> = {
  'hedong-khitan': 'relief',
  'khitan-tang': 'neutrality',
  'hedong-tang': null,
};

function yelu(meta: CharacterMeta): CharacterOutput {
  const ctx = meta.context;
  const offers = awaitingOffers(ctx);
  if (offers.length === 0) {
    return output('', ctx.messages.length > 0 ? 'Weigh the letters; nothing to answer yet.' : 'Nothing has come; wait.', [wait('No offer to answer.')]);
  }
  const actions: CharacterActionItem[] = [];
  let claimed: 'relief' | 'neutrality' | null = null;
  for (const a of offers) {
    const stance = STANCE[a.pair];
    const claims = stance === 'relief' ? a.offer.terms.aid_cavalry > 0 : stance === 'neutrality' ? a.offer.terms.neutrality : false;
    if (claimed && claims && claimed !== stance) {
      actions.push({
        type: 'respond_to_offer',
        args: { offerId: a.offer.offerId, response: 'reject', counterTerms: null, reason: say(ctx, { zh: '已许他方，不可两从。', en: 'I have given my word elsewhere; I cannot serve both.' }) },
        rationale: 'Relief and neutrality exclude each other.',
        cites: cite(ctx, meta, a.offer.offerId),
      });
      continue;
    }
    const action = answerOffer(ctx, meta, a, 'reservation', () => raiseToReservation(ctx, a), {
      confirm: { zh: '可。', en: 'Agreed.' },
      counter: { zh: '所许太薄，何以酬大国之师？须依此数。', en: 'Too little to reward a great state\'s army; these are my terms.' },
      reject: { zh: '无地则无兵。所许不足，不能从。', en: 'No land, no horsemen. What you offer is not enough.' },
    });
    if (action.type === 'confirm_commitment' && claims) claimed = stance;
    actions.push(action);
  }
  return output('', 'Take what serves the Khitan best.', actions);
}

function li(meta: CharacterMeta): CharacterOutput {
  const ctx = meta.context;
  const offers = awaitingOffers(ctx);
  if (offers[0]) {
    const a = offers[0];
    const action = answerOffer(ctx, meta, a, 'reservation', () => null, {
      confirm: { zh: '可。', en: 'Agreed.' },
      counter: { zh: '', en: '' },
      reject: { zh: '虏所求无厌，朕不能从。', en: 'The caitiffs\' demands are endless; We cannot agree.' },
    });
    return output('', 'Answer the Khitan within what We can bear.', [action]);
  }
  const heardEnvoy = ctx.messages.some((m) => m.kind === 'intel');
  const policy = ctx.beliefs.some((b) => b.subject === 'khitan_policy');
  const tangKhitan = ctx.negotiations.find((n) => n.pair === 'khitan-tang');
  if (heardEnvoy && policy && tangKhitan && tangKhitan.offersKnown === 0 && ctx.self.permissions.includes('propose_terms')) {
    const silk = available(ctx, 'silk');
    const terms: TermSetArgs = {
      vassal: false,
      filial: false,
      cession: 'none',
      annual_silk: silk >= 150_000 ? 100_000 : 0,
      immediate_silk: silk >= 150_000 ? 50_000 : 0,
      aid_cavalry: 0,
      aid_arrival_days: 0,
      neutrality: true,
      marriage_alliance: true,
      secret_clauses: [],
    };
    const limits = preferenceFor(ctx, 'reservation', 'khitan-tang');
    if (limits && preferenceViolations(terms, burdenOf(ctx, { ...terms, secret_articles: [], burden: null }, terms, 'khitan-tang'), limits).length > 0) {
      terms.marriage_alliance = false;
    }
    return output(
      '',
      'Outbid Hedong for Khitan neutrality before the envoy is answered.',
      [
        {
          type: 'propose_terms',
          args: {
            to: 'yelu_deguang' as CharId,
            terms,
            note: say(ctx, { zh: '大唐天子致书契丹主：愿归俘将，岁遗金帛，请勿助河东之叛。', en: 'The Son of Heaven of Tang to the Khitan ruler: We will return your captives and send yearly gifts; do not aid the Hedong rebel.' }),
          },
          rationale: 'Buy Khitan neutrality.',
          cites: cite(ctx, meta, 'zztj280-002'),
        },
      ],
    );
  }
  const troops = available(ctx, 'reserve_troops');
  if (troops >= 5000 && ctx.self.permissions.includes('allocate_resources')) {
    return output(
      '',
      'Press the siege harder.',
      [
        {
          type: 'allocate_resources',
          args: { faction: ctx.resources.faction, resource: 'reserve_troops', amount: 5000, purpose: 'intensify_siege' },
          rationale: 'More troops against Jinyang.',
          cites: cite(ctx, meta, 'zztj280-011'),
        },
      ],
    );
  }
  return output('', 'Nothing more to commit.', [wait('Waiting.')]);
}

const PERSONAS: Record<CharId, (meta: CharacterMeta) => CharacterOutput> = {
  shi_jingtang: shi,
  sang_weihan: sang,
  liu_zhiyuan: liu,
  yelu_deguang: yelu,
  li_congke: li,
};

function objectRef(type: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const target = a.target as { id?: unknown } | undefined;
  return `${type}|${String(a.docId ?? a.offerId ?? target?.id ?? a.to ?? a.resource ?? '')}`;
}

/**
 * Deterministic interaction behaviour of the mock personas (PLAN §9.3, §10.4): a question put to the persona is
 * answered (a short generic line, recorded as `answered`); an action identical in kind and object to one that was
 * rejected or withheld (an open feedback item) is not repeated (`declined`). Everything else stays unaddressed.
 */
function interactionAware(meta: CharacterMeta, out: CharacterOutput): CharacterOutput {
  const view = meta.context.interaction;
  if (!view) return out;
  const addressed: NonNullable<CharacterOutput['interaction']>['addressed'] = [];
  let actions = out.actions;
  for (const it of view.items) {
    if (it.kind !== 'feedback' || !it.attempted || it.attempted.status === 'format_error') continue;
    const key = objectRef(it.attempted.type, it.attempted.args);
    const kept = actions.filter((a) => objectRef(a.type, a.args) !== key);
    if (kept.length !== actions.length || it.now) {
      addressed.push({ item: it.id, how: 'declined', note: 'not repeating the failed action' });
      actions = kept;
    }
  }
  let speech = out.speech;
  for (const it of view.items) {
    if (it.kind !== 'request' || addressed.length >= 8) continue;
    if (!speech) speech = say(meta.context, { zh: '承问，愚以为此事宜慎，当依实情而定。', en: 'You ask my view: this needs care and must follow the facts.' });
    addressed.push({ item: it.id, how: 'answered', note: 'answered in speech' });
  }
  if (addressed.length === 0) return out;
  return {
    ...out,
    speech,
    actions: actions.length > 0 ? actions : [wait('Not repeating a failed action.')],
    interaction: { addressed, requests: [], wait_for: null },
  };
}

/** The persona's turn for a character call (revision requests drop the flagged action types). */
export function personaTurn(meta: CharacterMeta): CharacterOutput {
  const out = interactionAware(meta, PERSONAS[meta.context.self.id](meta));
  if (!meta.revision || meta.revision.length === 0) return out;
  const flagged = new Set(
    meta.revision.map((r) => (typeof r.action === 'object' && r.action !== null ? String((r.action as { type?: unknown }).type) : '')),
  );
  const kept = out.actions.filter((a) => !flagged.has(a.type));
  return {
    ...out,
    speech: out.speech,
    private_rationale: `${out.private_rationale} Revised after review: dropped ${[...flagged].join(', ')}.`,
    actions: kept.length > 0 ? kept : [wait('Reconsidering after the review.')],
  };
}
