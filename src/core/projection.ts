/**
 * G11 no-assistance projection: a pure forecast (no commits, pauses or checkpoints). It applies the same five-day
 * ADVANCE transition as the live rules, repeatedly, with no relief and no further actions, assuming
 * `let_it_happen` whenever the mutiny condition holds, and reports when Jinyang would fall.
 */
import { siegeAdvance, siegeFallCause, siegeMutinyCondition, siegeMutinyOutbreak, siegeNumbers } from './siege.js';
import type { CoreConfig, JsonValue, WorldState } from './types.js';

export interface SiegeProjection {
  projected: true;
  fallDay: number | null;
  fallRound: number | null;
  fallCause: 'grain' | 'pressure' | null;
  mutinyRiskDay: number | null;
  assumptions: string[];
}

export const PROJECTION_ASSUMPTIONS: readonly string[] = [
  'no relief arrives and no further actions are taken',
  'each step is the live five-day ADVANCE transition (G03-G05, G07)',
  'a mutiny is allowed to happen (let_it_happen) as soon as its condition holds (G06)',
];

export function projectSiege(state: WorldState, config: CoreConfig): SiegeProjection {
  const p = config.params;
  let n = siegeNumbers(state);
  let mutinyRiskDay: number | null = null;
  const result = (fallCause: 'grain' | 'pressure' | null): SiegeProjection => ({
    projected: true,
    fallDay: fallCause ? n.day : null,
    fallRound: fallCause ? n.round : null,
    fallCause,
    mutinyRiskDay,
    assumptions: [...PROJECTION_ASSUMPTIONS],
  });

  const already = siegeFallCause(n, p);
  if (already) return result(already);
  for (let step = 0; step < p.projection_max_steps; step++) {
    n = siegeAdvance(n, p).next;
    const cause = siegeFallCause(n, p);
    if (cause) return result(cause);
    if (siegeMutinyCondition(n, p)) {
      if (mutinyRiskDay === null) mutinyRiskDay = n.day;
      n = siegeMutinyOutbreak(n, p);
      const afterMutiny = siegeFallCause(n, p);
      if (afterMutiny) return result(afterMutiny);
    }
  }
  return result(null);
}

export function projectionDetail(projection: SiegeProjection): Record<string, JsonValue> {
  return {
    projected: true,
    fallDay: projection.fallDay,
    fallRound: projection.fallRound,
    fallCause: projection.fallCause,
    mutinyRiskDay: projection.mutinyRiskDay,
    assumptions: [...projection.assumptions],
  };
}
