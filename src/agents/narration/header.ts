/**
 * Deterministic fact header (PLAN §9.4, H16): a template rendering of a scene's committed facts, in zh or en,
 * carrying every quantity. It is always correct because it is derived only from the committed facts; model prose
 * (which must not contain quantities) is shown under it. Secret-clause text never appears: only the number of
 * sealed articles.
 */
import type { NarrationFact } from '../../core/types.js';
import { actorName, loc, locationName, RESOURCE_LABELS, type AgentNames } from '../names.js';
import type { Lang } from '../types.js';
import { groupThousands } from '../util.js';
import { bool, factTerms, num, str, type FactTerms } from './facts.js';

export const HEADER_VERSION = 'header.v1';

function n(value: number, lang: Lang): string {
  return lang === 'zh' ? String(value) : groupThousands(value);
}

/** Non-default terms in reading order (zh or en). */
export function renderTerms(t: FactTerms, names: AgentNames, lang: Lang): string {
  const parts: string[] = [];
  const zh = lang === 'zh';
  if (t.vassal) parts.push(zh ? '称臣' : 'vassalage');
  if (t.filial) parts.push(zh ? '以父礼事之' : 'filial rites');
  if (t.cession !== 'none') parts.push(zh ? `割地：${names.cession[t.cession].zh}` : `cession: ${names.cession[t.cession].en}`);
  if (t.annual_silk > 0) parts.push(zh ? `岁帛${n(t.annual_silk, lang)}匹` : `annual silk ${n(t.annual_silk, lang)} bolts`);
  if (t.immediate_silk > 0) parts.push(zh ? `即付之帛${n(t.immediate_silk, lang)}匹` : `immediate silk ${n(t.immediate_silk, lang)} bolts`);
  if (t.aid_cavalry > 0) parts.push(zh ? `援骑${n(t.aid_cavalry, lang)}` : `relief cavalry ${n(t.aid_cavalry, lang)}`);
  if (t.aid_arrival_days > 0) {
    parts.push(zh ? `成约后${t.aid_arrival_days}日援军到达` : `relief to arrive ${t.aid_arrival_days} days after confirmation`);
  }
  if (t.neutrality) parts.push(zh ? '契丹中立' : 'Khitan neutrality');
  if (t.marriage_alliance) parts.push(zh ? '和亲' : 'marriage alliance');
  if (t.secret_clause_ids.length > 0) {
    parts.push(zh ? `另附密约${t.secret_clause_ids.length}条（封缄）` : `${t.secret_clause_ids.length} sealed secret article(s)`);
  }
  if (parts.length === 0) return zh ? '（无条件）' : '(no terms)';
  return parts.join(zh ? '；' : '; ');
}

const TIMING: Record<string, { zh: string; en: string }> = {
  now: { zh: '即发', en: 'send now' },
  delay: { zh: '暂缓', en: 'delay' },
  hold: { zh: '扣留', en: 'hold' },
};

const TERMINAL: Record<string, { zh: string; en: string }> = {
  pact_concluded: { zh: '结局：盟约成立', en: 'Ending: the pact is concluded' },
  jinyang_falls: { zh: '结局：晋阳陷落', en: 'Ending: Jinyang falls' },
  no_assistance: { zh: '结局：不求外援', en: 'Ending: no foreign assistance' },
  talks_failed: { zh: '结局：和议不成', en: 'Ending: the talks failed' },
};

/** One header line for one fact. Unknown kinds render generically (never throws). */
export function renderFactLine(fact: NarrationFact, names: AgentNames, lang: Lang): string {
  const d = fact.data;
  const zh = lang === 'zh';
  const who = (id: string | null): string => (id ? actorName(names, id, lang) : zh ? '某人' : 'someone');
  const actor = who(fact.actor);
  const terms = (key = 'terms'): string => {
    const t = factTerms(d[key]);
    return t ? renderTerms(t, names, lang) : '';
  };
  const doc = (id: string | null): string => (zh ? `表文（${id ?? '?'}）` : `the request letter (${id ?? '?'})`);
  const day = (key: string): string => {
    const v = num(d, key);
    return v === null ? '?' : String(v);
  };
  switch (fact.kind) {
    case 'document_revised':
      return zh
        ? `${actor}改定${doc(str(d, 'docId'))}，今为第${day('version')}版${bool(d, 'approvalVoided') ? '（原准印作废）' : ''}：${terms()}。`
        : `${actor} revised ${doc(str(d, 'docId'))} to version ${day('version')}${bool(d, 'approvalVoided') ? ' (the earlier approval is void)' : ''}: ${terms()}.`;
    case 'suggestion_made':
      return zh
        ? `${actor}就${str(d, 'targetId')}（第${day('targetVersion')}版）提出修改建议（不具约束力）。`
        : `${actor} suggested changes to ${str(d, 'targetId')} (version ${day('targetVersion')}); non-binding.`;
    case 'document_approved':
      return zh ? `${actor}用印批准${doc(str(d, 'docId'))}第${day('version')}版。` : `${actor} approved ${doc(str(d, 'docId'))} version ${day('version')}.`;
    case 'dispatch_timing_set': {
      const mode = TIMING[str(d, 'mode') ?? ''] ?? { zh: str(d, 'mode') ?? '?', en: str(d, 'mode') ?? '?' };
      const nb = num(d, 'notBeforeRound');
      return zh
        ? `${actor}定${doc(str(d, 'docId'))}发遣之时：${mode.zh}${nb !== null ? `（第${nb}回合之前不发）` : ''}。`
        : `${actor} set the dispatch timing of ${doc(str(d, 'docId'))}: ${mode.en}${nb !== null ? ` (not before round ${nb})` : ''}.`;
    }
    case 'document_dispatched':
      return zh
        ? `${actor}遣使将${doc(str(d, 'docId'))}第${day('docVersion')}版送往${who(str(d, 'to'))}（${str(d, 'offerId')}），预计第${day('arrivalDay')}日送达。`
        : `${actor} dispatched ${doc(str(d, 'docId'))} version ${day('docVersion')} to ${who(str(d, 'to'))} (${str(d, 'offerId')}); expected to arrive on day ${day('arrivalDay')}.`;
    case 'terms_proposed':
      return zh
        ? `${who(str(d, 'from'))}向${who(str(d, 'to'))}提出条件（${str(d, 'offerId')}），预计第${day('arrivalDay')}日送达：${terms()}。`
        : `${who(str(d, 'from'))} proposed terms to ${who(str(d, 'to'))} (${str(d, 'offerId')}), arriving on day ${day('arrivalDay')}: ${terms()}.`;
    case 'offer_countered':
      return zh
        ? `${who(str(d, 'by'))}还价（${str(d, 'counterOfferId')}，条款第${day('termsVersion')}版），预计第${day('arrivalDay')}日送达${who(str(d, 'to'))}：${terms()}。`
        : `${who(str(d, 'by'))} countered (${str(d, 'counterOfferId')}, terms version ${day('termsVersion')}), arriving at ${who(str(d, 'to'))} on day ${day('arrivalDay')}: ${terms()}.`;
    case 'offer_rejected':
      return zh
        ? `${who(str(d, 'by'))}拒绝${who(str(d, 'to'))}之约（${str(d, 'offerId')}）。`
        : `${who(str(d, 'by'))} rejected ${who(str(d, 'to'))}'s offer (${str(d, 'offerId')}).`;
    case 'withdrawal_sent':
      return zh
        ? `${actor}遣使追回${str(d, 'offerId')}，预计第${day('arrivalDay')}日送达${who(str(d, 'to'))}。`
        : `${actor} sent a withdrawal of ${str(d, 'offerId')}, arriving at ${who(str(d, 'to'))} on day ${day('arrivalDay')}.`;
    case 'offer_delivered':
      return zh
        ? `${who(str(d, 'from'))}之约（${str(d, 'offerId')}）送达${who(str(d, 'to'))}：${terms()}。`
        : `${who(str(d, 'from'))}'s offer (${str(d, 'offerId')}) reached ${who(str(d, 'to'))}: ${terms()}.`;
    case 'response_delivered': {
      const r = str(d, 'response');
      const what = zh
        ? r === 'accept'
          ? '允其所请'
          : r === 'reject'
            ? '拒其所请'
            : `还价（${str(d, 'counterOfferId')}）：${terms('counterTerms')}`
        : r === 'accept'
          ? 'accepted'
          : r === 'reject'
            ? 'rejected'
            : `countered (${str(d, 'counterOfferId')}): ${terms('counterTerms')}`;
      return zh
        ? `${who(str(d, 'from'))}就${str(d, 'offerId')}之回书送达${who(str(d, 'to'))}：${what}。`
        : `${who(str(d, 'from'))}'s answer on ${str(d, 'offerId')} reached ${who(str(d, 'to'))}: ${what}.`;
    }
    case 'withdrawal_effective':
      return zh
        ? `追回${str(d, 'offerId')}之书送达${who(str(d, 'to'))}，该约作废。`
        : `The withdrawal of ${str(d, 'offerId')} reached ${who(str(d, 'to'))}; the offer is void.`;
    case 'withdrawal_late':
      return zh
        ? `追回${str(d, 'offerId')}之书送达${who(str(d, 'to'))}，然该约已有答复，追回无效。`
        : `The withdrawal of ${str(d, 'offerId')} reached ${who(str(d, 'to'))} too late: the offer had already been answered.`;
    case 'withdrawal_result_delivered':
      return zh
        ? `${who(str(d, 'to'))}得报：追回${str(d, 'offerId')}${bool(d, 'effective') ? '已生效' : '已迟，未生效'}。`
        : `${who(str(d, 'to'))} learned that the withdrawal of ${str(d, 'offerId')} was ${bool(d, 'effective') ? 'effective' : 'too late'}.`;
    case 'letter_delivered':
      return zh ? `${who(str(d, 'from'))}之书送达${who(str(d, 'to'))}。` : `${who(str(d, 'from'))}'s letter reached ${who(str(d, 'to'))}.`;
    case 'intel_delivered':
      return zh ? `探报送达${who(str(d, 'to'))}。` : `An intelligence report reached ${who(str(d, 'to'))}.`;
    case 'commitment_confirmed': {
      const arrival = num(d, 'khitanArrivalDay');
      return zh
        ? `${who(str(d, 'by'))}允${who(str(d, 'to'))}之约（${str(d, 'offerId')}，条款第${day('termsVersion')}版），成约：${terms()}${arrival !== null ? `；援军预计第${arrival}日到达` : ''}。`
        : `${who(str(d, 'by'))} accepted ${who(str(d, 'to'))}'s offer (${str(d, 'offerId')}, terms version ${day('termsVersion')}): ${terms()}${arrival !== null ? `; relief expected on day ${arrival}` : ''}.`;
    }
    case 'resources_allocated': {
      const res = str(d, 'resource') ?? '';
      const label = (RESOURCE_LABELS as Record<string, (typeof RESOURCE_LABELS)['silk'] | undefined>)[res];
      const amount = num(d, 'amount') ?? 0;
      const purpose = str(d, 'purpose');
      const effect =
        num(d, 'morale') !== null
          ? zh
            ? `，士气${num(d, 'morale')}`
            : `; morale ${num(d, 'morale')}`
          : num(d, 'pressure') !== null
            ? zh
              ? `，围城压力${num(d, 'pressure')}`
              : `; siege pressure ${num(d, 'pressure')}`
            : '';
      const why = purpose === 'pay_troops' ? (zh ? '犒军' : 'to pay the troops') : purpose === 'intensify_siege' ? (zh ? '增兵攻城' : 'to press the siege') : purpose ?? '';
      return zh
        ? `${actor}拨${label ? label.zh : res}${n(amount, lang)}${label ? label.unitZh : ''}${why}${effect}。`
        : `${actor} committed ${n(amount, lang)} ${label ? label.unitEn : res} ${why}${effect}.`;
    }
    case 'assistance_abandoned':
      return zh ? `${who(str(d, 'by'))}罢求援之议。` : `${who(str(d, 'by'))} abandoned the request for assistance.`;
    case 'authorization_revoked':
      return zh ? `书记收回授权${str(d, 'authId')}。` : `The clerk revoked authorization ${str(d, 'authId')}.`;
    case 'authorization_granted': {
      const exp = num(d, 'expiresRound');
      return zh
        ? `书记授权${who(str(d, 'grantee'))}（${str(d, 'authId')}）${exp !== null ? `，至第${exp}回合` : ''}。`
        : `The clerk authorized ${who(str(d, 'grantee'))} (${str(d, 'authId')})${exp !== null ? ` until round ${exp}` : ''}.`;
    }
    case 'letter_sent':
      return zh
        ? `${actor}致书${who(str(d, 'to'))}，预计第${day('arrivalDay')}日送达。`
        : `${actor} sent a letter to ${who(str(d, 'to'))}, arriving on day ${day('arrivalDay')}.`;
    case 'mutiny_outbreak':
      return zh
        ? `城中兵变：士气${day('morale')}，围城压力${day('pressure')}。`
        : `Mutiny in the city: morale ${day('morale')}, siege pressure ${day('pressure')}.`;
    case 'mutiny_averted_for_now':
      return zh ? '军心浮动，经劝谕犒赏，兵变暂未发作。' : 'Unrest among the troops; after the plea to pay them, no mutiny broke out for now.';
    case 'character_death':
      return zh ? `${who(str(d, 'charId'))}身故。` : `${who(str(d, 'charId'))} died.`;
    case 'allegiance_change': {
      const f = str(d, 'faction');
      const fname = f && f in names.factions ? loc(names.factions[f as keyof typeof names.factions], lang) : f ?? '?';
      return zh ? `${who(str(d, 'charId'))}改属${fname}。` : `${who(str(d, 'charId'))} changed allegiance to ${fname}.`;
    }
    case 'goal_adjusted':
      return zh ? '书记调整了求援之限。' : 'The clerk adjusted the goal limits.';
    case 'deadlock_resolved':
      return zh
        ? `书记裁断僵局${bool(d, 'segmentOpened') ? `，议和重开（第${day('segment')}段）` : '（议和轮次已尽）'}。`
        : `The clerk resolved the deadlock${bool(d, 'segmentOpened') ? `; negotiation segment ${day('segment')} opens` : ' (no offers left)'}.`;
    case 'time_advanced':
      return zh
        ? `自第${day('fromDay')}日至第${day('toDay')}日：存粮${day('grain')}日，围城压力${day('pressure')}，士气${day('morale')}。`
        : `Day ${day('fromDay')} to day ${day('toDay')}: grain ${day('grain')} days, siege pressure ${day('pressure')}, morale ${day('morale')}.`;
    case 'terminal': {
      if (str(d, 'terminal') === 'jinyang_falls' && str(d, 'cause') === 'missed_opportunity') {
        return zh
          ? '结局：错过时机，全面战争，晋阳城破。求援期限已尽，仍未达成有效盟约；后唐围城军发动全面攻城，晋阳失守。'
          : 'Ending: the opportunity missed, all-out war, Jinyang falls. The deadline for securing relief passed without an effective pact; the Later Tang besiegers launched a full assault and took the city.';
      }
      const t = TERMINAL[str(d, 'terminal') ?? ''] ?? { zh: `结局：${str(d, 'terminal')}`, en: `Ending: ${str(d, 'terminal')}` };
      const fall = num(d, 'fallDay');
      const arrival = num(d, 'khitanArrivalDay');
      const extra = zh
        ? `${arrival !== null ? `（援军预计第${arrival}日到达）` : ''}${fall !== null ? `（推演：无援则第${fall}日城破）` : ''}`
        : `${arrival !== null ? ` (relief expected on day ${arrival})` : ''}${fall !== null ? ` (projection without relief: the city falls on day ${fall})` : ''}`;
      return `${zh ? t.zh : t.en}${extra}${zh ? '。' : '.'}`;
    }
    default:
      return zh ? `（${fact.kind}）` : `(${fact.kind})`;
  }
}

/** The whole header: a scene/day line, then one line per fact (in order). */
export function renderFactHeader(
  facts: readonly NarrationFact[],
  names: AgentNames,
  lang: Lang,
  opts: { scene?: string | null; day?: number | null } = {},
): string {
  const scene = opts.scene ?? facts[0]?.scene ?? null;
  const zh = lang === 'zh';
  const head = zh
    ? `【${scene ? locationName(names, scene, lang) : '—'}${opts.day !== undefined && opts.day !== null ? ` · 第${opts.day}日` : ''}】`
    : `[${scene ? locationName(names, scene, lang) : '—'}${opts.day !== undefined && opts.day !== null ? ` · day ${opts.day}` : ''}]`;
  return [head, ...facts.map((f) => `· ${renderFactLine(f, names, lang)}`)].join('\n');
}
