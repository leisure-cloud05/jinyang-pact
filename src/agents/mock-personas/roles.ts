/**
 * Mock Judge, narrator and mapper (PLAN §9.3). Like the personas they read only the structured `meta` their
 * prompts were built from.
 * - Judge: PAUSE on an open objection (internal_disagreement), terms beyond the goal (goal_conflict) or a delay
 *   while the city is in danger (risky_delay); otherwise CONTINUE. Optionally REVISE goal conflicts once.
 * - Narrator: the deterministic template prose for the facts.
 * - Mapper: keyword rules (dispatch / delay / hold / silk amounts / addressing a present character / consenting
 *   for someone ⇒ unsupported), else clarify.
 */
import { parseChineseNumeral } from '../narration/checker.js';
import type { AnswerMeta } from '../answer.js';
import type { JudgeMeta } from '../judge.js';
import type { MapperMeta } from '../mapper.js';
import type { NarratorMeta } from '../narrator.js';
import type { AnswerOutput, JudgeOutput, MapperOutput, NarratorOutput, SemanticCategory } from '../schemas.js';
import { toArgs } from './terms.js';

export interface JudgeMockOptions {
  /** First assessment answers REVISE (instead of PAUSE) for goal conflicts on revisable proposals. */
  reviseGoalConflicts?: boolean;
}

const QUESTIONS: Record<SemanticCategory, { zh: string; en: string }> = {
  internal_disagreement: { zh: '幕中尚有异议，是否仍照此行事？', en: 'An adviser still objects. Let this go ahead?' },
  goal_conflict: { zh: '此举超出你所定之限，是否照行？', en: 'This goes beyond the limits you set. Let it go ahead?' },
  risky_delay: { zh: '城中危急，仍要延缓发遣吗？', en: 'The city is in danger. Delay the request anyway?' },
  ambiguity: { zh: '此举用意未明，是否照行？', en: 'The intent is unclear. Let it go ahead?' },
};

export function judgeMock(meta: JudgeMeta, opts: JudgeMockOptions = {}): JudgeOutput {
  const lang = meta.lang;
  return {
    items: meta.context.proposals.map((p) => {
      let category: SemanticCategory | null = null;
      let reason = 'No reason for the player to decide.';
      if (p.hints.openObjection) {
        category = 'internal_disagreement';
        reason = 'An adviser has an open suggestion on this document/offer version.';
      } else if (p.goalCheck && !p.goalCheck.withinGoal) {
        category = 'goal_conflict';
        reason = `Beyond the goal: ${p.goalCheck.violations.join('; ')}.`;
      } else if (p.hints.riskyDelay) {
        category = 'risky_delay';
        reason = 'Delay while grain is low or pressure is high.';
      }
      if (category === null) return { proposal_id: p.proposal_id, verdict: 'CONTINUE' as const, category: null, reason, question: null };
      const revise = opts.reviseGoalConflicts === true && !meta.reassessment && category === 'goal_conflict' && p.type === 'revise_document';
      return {
        proposal_id: p.proposal_id,
        verdict: revise ? ('REVISE' as const) : ('PAUSE' as const),
        category,
        reason,
        question: revise ? null : QUESTIONS[category][lang],
      };
    }),
  };
}

export function narratorMock(meta: NarratorMeta): NarratorOutput {
  return { prose: meta.templateProse, mentioned_facts: meta.facts.map((_f, i) => i) };
}

function parseAmount(text: string): number | null {
  const arabic = /(\d[\d,]*(?:\.\d+)?)\s*(万)?/.exec(text);
  if (arabic?.[1]) return Math.round(Number(arabic[1].replace(/,/g, '')) * (arabic[2] ? 10_000 : 1));
  const zh = /([零〇一二两三四五六七八九十百千万]+)/.exec(text);
  if (zh?.[1] && zh[1].length > 1) {
    const v = parseChineseNumeral(zh[1]);
    return Number.isFinite(v) ? v : null;
  }
  return null;
}

export function mapperMock(meta: MapperMeta): MapperOutput {
  const text = meta.text;
  const lower = text.toLowerCase();
  const zh = meta.lang === 'zh';
  const doc = meta.context.documents.find((d) => d.status === 'draft' || d.status === 'approved') ?? meta.context.documents[0];
  const none = { action: null, dialogue: null, question: null, reason: null };
  if (/(替|代|代为|以.*之名).*(允|许|约|批|准)|on (his|shi's|shi jingtang's) behalf|accept .*for|confirm .*for/i.test(text)) {
    return { kind: 'unsupported', ...none, reason: zh ? '书记不能代人允约或用印。' : 'The clerk cannot consent or seal for anyone.' };
  }
  const amount = parseAmount(text);
  if (doc && amount !== null && /(岁帛|每年|annual|yearly|即付|礼|gift|immediate)/i.test(text)) {
    const key = /(即付|礼|gift|immediate)/i.test(text) ? 'immediate_silk' : 'annual_silk';
    const terms = { ...toArgs(doc.terms), [key]: amount };
    return {
      kind: 'action',
      ...none,
      action: { type: 'revise_document', args: { docId: doc.docId, baseDocVersion: doc.version, terms, note: doc.note } },
    };
  }
  if (doc && /(扣|留中|hold)/i.test(text)) {
    return { kind: 'action', ...none, action: { type: 'set_dispatch_timing', args: { docId: doc.docId, mode: 'hold', rounds: null } } };
  }
  if (doc && /(缓|延|delay|later)/i.test(text)) {
    return { kind: 'action', ...none, action: { type: 'set_dispatch_timing', args: { docId: doc.docId, mode: 'delay', rounds: 1 } } };
  }
  if (doc && /(遣使|发出|发遣|送出|dispatch|send (it|the))/i.test(lower)) {
    if (doc.status === 'approved' && doc.approvedVersion === doc.version) {
      return { kind: 'action', ...none, action: { type: 'dispatch_document', args: { docId: doc.docId, docVersion: doc.version } } };
    }
    return { kind: 'clarify', ...none, question: zh ? '表尚未用印，需明公先行批准。要先请明公用印吗？' : 'The draft is not approved yet. Ask Shi to seal it first?' };
  }
  const addressed = meta.context.present.filter((p) => text.includes(p.name));
  if (addressed.length > 0) {
    return { kind: 'dialogue', ...none, dialogue: { to: addressed.map((p) => p.id), text } };
  }
  return { kind: 'clarify', ...none, question: zh ? '请说明要改动什么，或要对谁说。' : 'What should be changed, or whom are you addressing?' };
}

const ANSWERS: Record<string, { draft: { zh: string; en: string }; other: { zh: string; en: string } }> = {
  shi_jingtang: {
    draft: { zh: '书记所问，吾已思之。表中所许，皆为解晋阳之围；成败在此，吾自当之。', en: 'I have weighed your question, clerk. What the memorial offers is the price of lifting the siege; I will answer for it.' },
    other: { zh: '城中之事，吾自有分寸，书记但据实录之。', en: 'I know what the city needs, clerk; record faithfully what is decided.' },
  },
  sang_weihan: {
    draft: { zh: '契丹贪利，许之以厚，则援兵朝发夕至；迟则唐兵日增，城危矣。', en: 'The Khitan love gain: offer generously and their horsemen will come; delay, and the Tang host only grows.' },
    other: { zh: '事机在速，愿明公勿疑。', en: 'Everything turns on speed; my lord should not hesitate.' },
  },
  liu_zhiyuan: {
    draft: { zh: '称臣犹可；以父事之、割让土田，恐为后世大患，宁厚以金帛。', en: 'Calling ourselves his subjects is acceptable; serving him as a father or ceding land may haunt us for generations. Pay in silk instead.' },
    other: { zh: '城守尚可支持，唯军心不可不察。', en: 'The walls can hold for now, but the soldiers\' mood must be watched.' },
  },
  yelu_deguang: {
    draft: { zh: '大国之兵，非厚礼不动。', en: 'A great state does not move its army for small gifts.' },
    other: { zh: '且待来使，再议不迟。', en: 'Let the envoys come; then we will talk.' },
  },
  li_congke: {
    draft: { zh: '朕之事，岂与河东之吏言之？', en: 'Why should We discuss Our affairs with a clerk of Hedong?' },
    other: { zh: '晋阳旦夕可下。', en: 'Jinyang will fall any day now.' },
  },
};

/**
 * Mock in-character answer (PLAN §7 "ask"): a fixed line in the character's voice, chosen by whether a draft is
 * before him. Deterministic and secret-free by construction (no clause text, codes or numbers).
 */
export function answerMock(meta: AnswerMeta): AnswerOutput {
  const lines = ANSWERS[meta.context.self.id] ?? ANSWERS.shi_jingtang;
  const hasDraft = meta.context.situation.documents.some((d) => d.status === 'draft' || d.status === 'approved') || meta.facts.length > 1;
  const line = hasDraft ? lines!.draft : lines!.other;
  return { speech: meta.lang === 'zh' ? line.zh : line.en };
}
