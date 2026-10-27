import type { L10n, StateView } from '../../src/server/api-types.js';

export interface ConversationTopic {
  id: string;
  label: L10n;
  text: L10n;
}

/** Questions based only on the clerk's visible draft and siege outlook, never on private character state. */
export function characterTopics(id: string, state: Pick<StateView, 'document' | 'siegeWatch'>): ConversationTopic[] {
  const terms = state.document?.terms;
  const sang = id === 'sang_weihan';
  const liu = id === 'liu_zhiyuan';
  const topics: ConversationTopic[] = [];
  if (state.siegeWatch.alerts.length > 0) topics.push({
    id: 'siege', label: { zh: '解围时机', en: 'Time to relief' },
    text: {
      zh: '（附耳低语）眼前围城局势吃紧。若再等一轮，守城与求援各有何风险？还请指教下一步的轻重缓急。',
      en: '(quietly) The siege outlook is troubling. What risks would another round of waiting bring to our defense and our appeal for relief? What should come first?',
    },
  });
  if (terms && terms.cession !== 'none') topics.push({
    id: 'land', label: { zh: '割地后患', en: 'Cost of cession' },
    text: {
      zh: sang ? '（附耳低语）表中许以土地，是否确为求援所必需？若减轻割地条件，可有别法使契丹愿意出兵？' : '（附耳低语）表中许以土地，会留下哪些后患？若少割或不割，又该如何解眼前之围？',
      en: sang ? '(quietly) Is the promise of land in this draft essential to securing relief? Could lighter territorial terms still persuade the Khitan to send troops?' : '(quietly) What lasting harm could the land promised in this draft bring? How could we lift the siege while ceding less, or no land?',
    },
  });
  if (terms && (terms.immediate_silk > 0 || terms.annual_silk > 0)) topics.push({
    id: 'silk', label: { zh: '金帛与底线', en: 'Silk and limits' },
    text: {
      zh: '（附耳低语）表中的即付帛与岁帛，应如何取舍？既要让对方愿意出兵，也要留下河东可以承受的余地。',
      en: '(quietly) How should we balance the immediate and annual silk in this draft? We need terms that secure troops while remaining affordable for Hedong.',
    },
  });
  if (terms?.filial) topics.push({
    id: 'rites', label: { zh: '父礼与名分', en: 'Filial rites' },
    text: {
      zh: '（附耳低语）以父礼事契丹主，对求援究竟有何作用？可否只称臣而不行父礼？',
      en: '(quietly) What do filial rites contribute to securing relief? Could declaring vassalage suffice without serving the Khitan ruler as a father?',
    },
  });
  topics.push({
    id: 'counsel',
    label: { zh: sang ? '求援诚意' : liu ? '守城用兵' : '决策底线', en: sang ? 'A credible appeal' : liu ? 'Defending Jinyang' : 'Limits of consent' },
    text: {
      zh: sang ? '（附耳低语）依你之见，要让求援表章真正奏效，最不可少的条件是什么？还有哪些可以再商议？' : liu ? '（附耳低语）依你之见，眼下守城与用兵还有哪些可行之策？这些办法与向北求援应如何配合？' : '（附耳低语）救急固然要紧，所许之约也要长久承担。哪些条件可以商议，哪些底线应当守住？',
      en: sang ? '(quietly) In your judgment, which terms are essential for this appeal to succeed, and which could still be negotiated?' : liu ? '(quietly) What options remain for defending Jinyang and using our troops? How should these work alongside our appeal for northern relief?' : '(quietly) Relief is urgent, but our promises will last. Which terms can we negotiate, and which limits should we hold?',
    },
  });
  return topics;
}
