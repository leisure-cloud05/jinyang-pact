import type { L10n, PauseView } from '../../src/server/api-types.js';

/** A dispatch is represented by its labelled card and table, not a second command string. */
export function decisionFacts(pause: Pick<PauseView, 'visibleFacts' | 'proposals'>): L10n[] {
  const dispatches = pause.proposals.filter((proposal) => proposal.type === 'dispatch_document');
  return pause.visibleFacts.filter((fact) => !dispatches.some((proposal) =>
    fact.en.startsWith(`${proposal.actorName.en}: dispatch `)
    || fact.zh.startsWith(`${proposal.actorName.zh}：dispatch `),
  ));
}
