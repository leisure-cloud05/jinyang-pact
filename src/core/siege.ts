/**
 * The five-day siege transition (G03–G07) as pure arithmetic on a few numbers. Shared by the live ADVANCE
 * (system.ts) and the no-assistance forecast (projection.ts) so both use exactly the same transition (G11).
 */
import { BESIEGED_FACTION, type GameParams, type WorldState } from './types.js';

export interface SiegeNumbers {
  day: number;
  round: number;
  grain: number;
  pressure: number;
  morale: number;
  mutinyOccurred: boolean;
}

export function siegeNumbers(state: WorldState): SiegeNumbers {
  return {
    day: state.day,
    round: state.round,
    grain: state.factions[BESIEGED_FACTION].resources.grain,
    pressure: state.siege.pressure,
    morale: state.siege.morale,
    mutinyOccurred: state.flags.mutinyOccurred,
  };
}

export interface AdvanceStep {
  next: SiegeNumbers;
  moraleDecayed: boolean;
}

/**
 * One ADVANCE: day += round_days, round += 1; G03 grain = max(0, grain − 5); G04 pressure = min(cap, pressure + 8);
 * G05 morale decays by 5 (floor 0) if, after G03/G04, grain < 15 or pressure > 70.
 */
export function siegeAdvance(n: SiegeNumbers, p: GameParams): AdvanceStep {
  const grain = Math.max(0, n.grain - p.grain_per_advance);
  const pressure = Math.min(p.pressure_cap, n.pressure + p.pressure_per_advance);
  const moraleDecayed = grain < p.morale_low_grain || pressure > p.morale_high_pressure;
  const morale = moraleDecayed ? Math.max(0, n.morale - p.morale_decay) : n.morale;
  return {
    next: { ...n, day: n.day + p.round_days, round: n.round + 1, grain, pressure, morale },
    moraleDecayed,
  };
}

/** G07: which condition makes Jinyang fall, if any. */
export function siegeFallCause(n: Pick<SiegeNumbers, 'grain' | 'pressure'>, p: GameParams): 'grain' | 'pressure' | null {
  if (n.grain <= p.fall_grain_max) return 'grain';
  if (n.pressure >= p.fall_pressure_min) return 'pressure';
  return null;
}

/** G06 precondition on the numbers (the caller also requires a non-terminal world and no open outcome batch). */
export function siegeMutinyCondition(n: SiegeNumbers, p: GameParams): boolean {
  return !n.mutinyOccurred && n.grain <= p.mutiny_grain_max && n.morale <= p.mutiny_morale_max;
}

/** G06 outbreak (let_it_happen): morale = 0, pressure = min(cap, pressure + 20), mutinyOccurred = true. */
export function siegeMutinyOutbreak(n: SiegeNumbers, p: GameParams): SiegeNumbers {
  return {
    ...n,
    morale: 0,
    pressure: Math.min(p.pressure_cap, n.pressure + p.mutiny_pressure_add),
    mutinyOccurred: true,
  };
}
