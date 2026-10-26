/**
 * Hourglass and city-defence alerts (play UI). The forecast is the engine's own five-day transition and the alerts
 * fire at the rules' thresholds. Hand-computed with the scenario defaults: 5-day rounds, grain −5, pressure +8,
 * morale −5 while grain < 15 or pressure > 70, mutiny at grain ≤ 10 and morale ≤ 30, fall at grain ≤ 0 or
 * pressure ≥ 100. Through the API the view carries only what the clerk sees (the same numbers as `world`).
 */
import { describe, expect, it } from 'vitest';
import type { StateView } from '../../src/server/api-types.js';
import { caseCoreConfig } from '../../src/content/loader.js';
import { siegeAdvance, type SiegeNumbers } from '../../src/core/siege.js';
import { siegeWatch } from '../../src/server/views/siege-watch.js';
import { content } from '../engine/helpers.js';
import { createSession, makeApp, playToEnd, state } from './helpers.js';

const p = caseCoreConfig(content(), 'C1').params;
const at = (o: Partial<SiegeNumbers>): SiegeNumbers => ({ day: 0, round: 1, grain: 60, pressure: 40, morale: 60, mutinyOccurred: false, ...o });
const open = { maxRounds: 6, ended: false };
const codes = (w: ReturnType<typeof siegeWatch>): string[] => w.alerts.map((a) => `${a.level}:${a.code}`);

describe('siegeWatch (pure)', () => {
  it('forecasts the round exactly as the engine ADVANCE does, with no alert in a calm siege', () => {
    const now = at({});
    const w = siegeWatch(now, p, open);
    expect(w).toMatchObject({ round: 1, maxRounds: 6, roundsLeft: 6, day: 0, roundDays: 5, now: { grain: 60, pressure: 40, morale: 60 } });
    expect(w.next).toEqual({ day: 5, round: 2, grain: 55, pressure: 48, morale: 60, moraleDrops: false, falls: null, mutinyRisk: false });
    const engine = siegeAdvance(now, p).next;
    expect(w.next).toMatchObject({ day: engine.day, round: engine.round, grain: engine.grain, pressure: engine.pressure, morale: engine.morale });
    expect(w.alerts).toEqual([]);
  });

  it('notes falling morale once grain drops below 15 days or pressure passes 70', () => {
    const lowGrain = siegeWatch(at({ grain: 18 }), p, open);
    expect(lowGrain.next).toMatchObject({ grain: 13, morale: 55, moraleDrops: true });
    expect(codes(lowGrain)).toEqual(['notice:morale_falls']);
    expect(lowGrain.alerts[0]?.text.en).toContain('Morale drops by 5');
    const highPressure = siegeWatch(at({ pressure: 66 }), p, open);
    expect(highPressure.next).toMatchObject({ pressure: 74, morale: 55 });
    expect(codes(highPressure)).toEqual(['notice:morale_falls']);
  });

  it('warns of a mutiny when grain and morale will both be low after the round (C5, round 3)', () => {
    const w = siegeWatch(at({ day: 10, round: 3, grain: 12, pressure: 66, morale: 35 }), p, open);
    expect(w.next).toEqual({ day: 15, round: 4, grain: 7, pressure: 74, morale: 30, moraleDrops: true, falls: null, mutinyRisk: true });
    expect(codes(w)).toEqual(['warning:mutiny_next', 'notice:morale_falls']);
    expect(w.alerts[0]?.text.zh).toContain('哗变');
  });

  it('raises only the critical alert when the city would fall at the end of the round', () => {
    const grain = siegeWatch(at({ grain: 5, morale: 20 }), p, open);
    expect(grain.next).toMatchObject({ grain: 0, falls: 'grain', mutinyRisk: false });
    expect(codes(grain)).toEqual(['critical:fall_next']);
    const pressure = siegeWatch(at({ pressure: 95 }), p, open);
    expect(pressure.next).toMatchObject({ pressure: 100, falls: 'pressure' });
    expect(codes(pressure)).toEqual(['critical:fall_next']);
    expect(pressure.alerts[0]?.text.en).toContain('reaches 100');
  });

  it('does not warn of a mutiny that already happened, nor of morale that cannot fall', () => {
    expect(codes(siegeWatch(at({ grain: 12, pressure: 66, morale: 35, mutinyOccurred: true }), p, open))).toEqual(['notice:morale_falls']);
    const empty = siegeWatch(at({ grain: 14, morale: 0, mutinyOccurred: true }), p, open);
    expect(empty.next).toMatchObject({ morale: 0, moraleDrops: false });
    expect(empty.alerts).toEqual([]);
  });

  it('marks the last round, and stops forecasting once the chapter has ended', () => {
    const last = siegeWatch(at({ day: 25, round: 6 }), p, open);
    expect(last.roundsLeft).toBe(1);
    expect(codes(last)).toEqual(['critical:last_round']);
    const ended = siegeWatch(at({ day: 30, round: 7, grain: 2 }), p, { maxRounds: 6, ended: true });
    expect(ended).toMatchObject({ roundsLeft: 0, next: null, alerts: [] });
  });
});

describe('siege watch in the state view', () => {
  it('carries the clock and forecast built from the numbers the clerk sees (C5: low grain)', async () => {
    const { app } = await makeApp();
    const id = await createSession(app, 'C5');
    const player = (await state(app, id)).json;
    expect(player.siegeWatch.now).toEqual({ grain: player.world.resources.grain, pressure: player.world.siege.pressure, morale: player.world.siege.morale });
    expect(player.siegeWatch).toMatchObject({ round: 1, maxRounds: 6, day: 0, roundDays: 5, now: { grain: 22, pressure: 50, morale: 40 }, next: { day: 5, round: 2, grain: 17, pressure: 58, morale: 40 }, alerts: [] });
    // No hidden input: the director's view of the same moment gives the same outlook.
    const director = await createSession(app, 'C5', { director: true });
    expect((await state(app, director, 'director')).json.siegeWatch).toEqual(player.siegeWatch);
  });

  it('stays consistent with the world through a whole chapter and stops forecasting at the end', async () => {
    const { app } = await makeApp();
    const id = await createSession(app, 'C5');
    let seen = 0;
    const control = await playToEnd(app, id, {
      each: (s: StateView) => {
        const w = s.siegeWatch;
        expect(w.now).toEqual({ grain: s.world.resources.grain, pressure: s.world.siege.pressure, morale: s.world.siege.morale });
        expect(w.day).toBe(s.world.day);
        if (w.next) {
          const engine = siegeAdvance({ day: w.day, round: w.round, ...w.now, mutinyOccurred: false }, p).next;
          expect([w.next.day, w.next.grain, w.next.pressure, w.next.morale]).toEqual([engine.day, engine.grain, engine.pressure, engine.morale]);
          expect(w.alerts.some((a) => a.code === 'fall_next')).toBe(w.next.falls !== null);
          seen += 1;
        }
      },
    });
    expect(control.state).toBe('finished');
    expect(seen).toBeGreaterThan(0);
    const end = (await state(app, id)).json.siegeWatch;
    expect(end).toMatchObject({ roundsLeft: 0, next: null, alerts: [] });
  });
});
