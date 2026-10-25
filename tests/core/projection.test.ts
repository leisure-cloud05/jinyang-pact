import { describe, expect, it } from 'vitest';
import { executeBatch } from '../../src/core/execute.js';
import { projectSiege } from '../../src/core/projection.js';
import { MUTINY_OUTBREAK, mutinyDue, runAdvance } from '../../src/core/system.js';
import type { WorldState } from '../../src/core/types.js';
import { config, initial, mutate } from './helpers.js';

/** Live ADVANCEs with no actions, answering every mutiny with let_it_happen. */
function liveFallDay(start: WorldState): { day: number | null; mutinyDay: number | null } {
  let s = start;
  let mutinyDay: number | null = null;
  for (let i = 0; i < 100 && !s.terminal; i++) {
    s = runAdvance(s, config()).state;
    if (!s.terminal && mutinyDue(s, config())) {
      mutinyDay ??= s.day;
      s = executeBatch(
        s,
        {
          kind: 'system_outcome',
          proposals: [{ proposalId: `m${i}`, actor: 'system', seq: 1, action: MUTINY_OUTBREAK, askPlayer: null }],
          decisions: [{ decisionId: `d${i}`, category: 'mutiny', option: 'let_it_happen', proposalIds: [`m${i}`] }],
        },
        { config: config(), mode: 'full' },
      ).state;
    }
  }
  return { day: s.terminal?.kind === 'jinyang_falls' ? s.day : null, mutinyDay };
}

function siege(grain: number, pressure: number, morale: number): WorldState {
  return mutate(initial(), (x) => {
    x.factions.hedong.resources.grain = grain;
    x.siege.pressure = pressure;
    x.siege.morale = morale;
  });
}

describe('G11 no-assistance projection', () => {
  it('forecasts the fall from the initial fixture state (hand-computed: day 40, grain exhausted)', () => {
    const p = projectSiege(initial(), config());
    expect(p).toMatchObject({ projected: true, fallDay: 40, fallRound: 9, fallCause: 'grain', mutinyRiskDay: null });
    expect(p.assumptions.join(' ')).toContain('let_it_happen');
  });

  it('includes a mutiny under the let_it_happen assumption (hand-computed)', () => {
    // grain 15, pressure 40, morale 35: day 5 grain 10, morale 30 → mutiny: morale 0, pressure 68;
    // day 10 grain 5, pressure 76; day 15 grain 0 → fall.
    const p = projectSiege(siege(15, 40, 35), config());
    expect(p).toMatchObject({ fallDay: 15, mutinyRiskDay: 5, fallCause: 'grain' });
  });

  it('is pure: the state is not modified and no version is consumed', () => {
    const s = initial();
    const before = JSON.stringify(s);
    projectSiege(s, config());
    expect(JSON.stringify(s)).toBe(before);
  });

  it.each([
    [40, 40, 60],
    [15, 40, 35],
    [33, 52, 31],
    [12, 90, 50],
    [3, 40, 60],
    [60, 20, 25],
  ])('forecast equals the live ADVANCE sequence (grain %i, pressure %i, morale %i)', (grain, pressure, morale) => {
    const s = siege(grain, pressure, morale);
    const forecast = projectSiege(s, config());
    const live = liveFallDay(s);
    expect(forecast.fallDay).toBe(live.day);
    expect(forecast.mutinyRiskDay).toBe(live.mutinyDay);
  });
});
