/**
 * Hourglass and city-defence alerts (play UI): the round clock and what the coming ADVANCE does to the siege if
 * nothing else changes, with alerts at the rules' own thresholds. The forecast calls the core siege transition
 * (src/core/siege.ts), the same arithmetic as the engine's ADVANCE, so it cannot drift from the rules. Inputs are what
 * the clerk sees at headquarters (Hedong's grain, siege pressure and morale) and the public game parameters. Pure.
 */
import { siegeAdvance, siegeFallCause, siegeMutinyCondition, type SiegeNumbers } from '../../core/siege.js';
import type { GameParams } from '../../core/types.js';
import type { SiegeAlertView, SiegeWatchView } from '../api-types.js';

const SEVERITY: Record<SiegeAlertView['level'], number> = { critical: 0, warning: 1, notice: 2 };

export function siegeWatch(now: SiegeNumbers, p: GameParams, opts: { maxRounds: number; ended: boolean }): SiegeWatchView {
  const alerts: SiegeAlertView[] = [];
  let next: SiegeWatchView['next'] = null;
  if (!opts.ended) {
    const step = siegeAdvance(now, p);
    const after = step.next;
    const falls = siegeFallCause(after, p);
    // G06 is checked after ADVANCE only while the city stands.
    const mutinyRisk = falls === null && siegeMutinyCondition(after, p);
    next = {
      day: after.day,
      round: after.round,
      grain: after.grain,
      pressure: after.pressure,
      morale: after.morale,
      moraleDrops: step.moraleDecayed && after.morale < now.morale,
      falls,
      mutinyRisk,
    };
    if (falls === 'grain') {
      alerts.push({
        level: 'critical',
        code: 'fall_next',
        text: {
          zh: `粮将耗尽：本回合结束（${p.round_days} 日后）若无转机，晋阳陷落。`,
          en: `The grain runs out: if nothing changes before this round ends (${p.round_days} days), Jinyang falls.`,
        },
      });
    } else if (falls === 'pressure') {
      alerts.push({
        level: 'critical',
        code: 'fall_next',
        text: {
          zh: `围城压力将达 ${after.pressure}：本回合结束时若无转机，晋阳陷落。`,
          en: `Siege pressure reaches ${after.pressure} when this round ends: if nothing changes, Jinyang falls.`,
        },
      });
    }
    if (mutinyRisk) {
      alerts.push({
        level: 'warning',
        code: 'mutiny_next',
        text: {
          zh: `本回合结束后粮余 ${after.grain} 日、士气 ${after.morale}：守军可能哗变（粮 ≤ ${p.mutiny_grain_max} 且士气 ≤ ${p.mutiny_morale_max}）。`,
          en: `When this round ends grain will be ${after.grain} days and morale ${after.morale}: the garrison may mutiny (grain ≤ ${p.mutiny_grain_max} and morale ≤ ${p.mutiny_morale_max}).`,
        },
      });
    }
    if (falls === null && next.moraleDrops) {
      const drop = now.morale - after.morale;
      alerts.push({
        level: 'notice',
        code: 'morale_falls',
        text: {
          zh: `本回合结束时士气将降 ${drop}（粮少于 ${p.morale_low_grain} 日或围城压力高于 ${p.morale_high_pressure} 时，士气逐回合下降）。`,
          en: `Morale drops by ${drop} when this round ends (it falls every round while grain is below ${p.morale_low_grain} days or pressure above ${p.morale_high_pressure}).`,
        },
      });
    }
    if (now.round >= opts.maxRounds) {
      alerts.push({ level: 'critical', code: 'last_round', text: {
        zh: '求援的最后时机：本回合结束仍未达成有效盟约，将触发“错过时机、全面战争、晋阳城破”。后唐围城军将发动全面攻城，不再等待围城压力升至 100。',
        en: 'Last chance to secure relief: without an effective pact by the end of this round, the opportunity is lost. The Later Tang besiegers launch a full assault and Jinyang falls, even if siege pressure is below 100.',
      } });
    }
  }
  alerts.sort((a, b) => SEVERITY[a.level] - SEVERITY[b.level]);
  return {
    round: now.round,
    maxRounds: opts.maxRounds,
    roundsLeft: opts.ended ? 0 : Math.max(0, opts.maxRounds - now.round + 1),
    day: now.day,
    roundDays: p.round_days,
    now: { grain: now.grain, pressure: now.pressure, morale: now.morale },
    next,
    limits: {
      pressureCap: p.pressure_cap,
      moraleCap: p.morale_cap,
      moraleLowGrain: p.morale_low_grain,
      moraleHighPressure: p.morale_high_pressure,
      mutinyGrainMax: p.mutiny_grain_max,
      mutinyMoraleMax: p.mutiny_morale_max,
      fallGrainMax: p.fall_grain_max,
      fallPressureMin: p.fall_pressure_min,
    },
    alerts,
  };
}
