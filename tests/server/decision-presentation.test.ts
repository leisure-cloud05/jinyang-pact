import { describe, expect, it } from 'vitest';
import type { ProposalBrief } from '../../src/server/api-types.js';
import { decisionFacts } from '../../web/src/decision-presentation.js';

const dispatch: ProposalBrief = {
  proposalId: 'p1', actor: 'shi_jingtang', actorName: { zh: '石敬瑭', en: 'Shi Jingtang' },
  type: 'dispatch_document', summary: { zh: '发出求援书', en: 'dispatches document A v2' },
  terms: null, termsUnknown: null, status: 'pending',
};

describe('dispatch decision presentation', () => {
  it('removes the repeated command while preserving the situation, questions and other actions', () => {
    const situation = { zh: '第0日：存粮60。', en: 'Day 0: grain 60.' };
    const command = { zh: '石敬瑭：dispatch document A v2 (vassal, filial)', en: 'Shi Jingtang: dispatch document A v2 (vassal, filial)' };
    const question = { zh: '石敬瑭问：是否发出？', en: 'Shi Jingtang asks: Shall we dispatch it?' };
    const other = { zh: '石敬瑭：confirm offer A', en: 'Shi Jingtang: confirm offer A' };
    const visibleFacts = [situation, command, question, other];
    expect(decisionFacts({ visibleFacts, proposals: [dispatch] })).toEqual([situation, question, other]);
    expect(visibleFacts).toHaveLength(4);
    expect(decisionFacts({ visibleFacts, proposals: [] })).toEqual(visibleFacts);
  });

  it('does not remove another actor’s fact or a quoted discussion of dispatch', () => {
    const other = { zh: '桑维翰：dispatch document B v1', en: 'Sang Weihan: dispatch document B v1' };
    const speech = { zh: '石敬瑭说：dispatch 应在明日。', en: 'Shi Jingtang says: dispatch should wait.' };
    expect(decisionFacts({ visibleFacts: [other, speech], proposals: [dispatch] })).toEqual([other, speech]);
  });
});
