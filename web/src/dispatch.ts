/**
 * Dispatch ceremony (敲印, play UI): the clerk's final confirmation before the request goes out. The filled-in document
 * unrolls for review; the clerk's own seal goes down only once the server has committed the dispatch, then the scroll
 * rolls up. The seal records the clerk's act of sending: Shi Jingtang's approval stays his own (his 印), and a
 * concluded pact keeps 盟.
 */
import type { InputOutcome, Lang } from '../../src/server/api-types.js';

/** The clerk's dispatch seal: 遣, to send an envoy. */
export const DISPATCH_GLYPH = '遣';

/** After the server commits (ms): the seal goes down with its ember glow, stays to be read, then the scroll rolls up. */
export const SEAL_TIMELINE = { stamp: 800, hold: 500, roll: 600 } as const;

export interface DispatchProblem {
  /** What the player is told. */
  text: string;
  /** The draft changed under the player: its terms must be reviewed again before sealing. */
  review: boolean;
}

/** Why a dispatch did not go out. A stale version (H04) asks for a fresh review; otherwise the server's reason is kept. */
export function dispatchProblem(o: Pick<InputOutcome, 'status' | 'rule' | 'feedback'>, lang: Lang): DispatchProblem {
  const zh = lang === 'zh';
  if (o.rule === 'H04') return { review: true, text: zh ? '表章已经改动。请重新核对条款，再行落印。' : 'The draft has changed. Review its terms again before you seal it.' };
  if (o.rule === 'H12') return { review: false, text: zh ? '这份表章已经发出。' : 'This request has already been sent.' };
  const why = `${o.status}${o.rule ? ` (${o.rule})` : ''}${o.feedback ? `: ${o.feedback}` : ''}`;
  return { review: false, text: zh ? `未能发出 — ${why}` : `It did not go out — ${why}` };
}
