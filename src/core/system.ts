/**
 * System steps (PLAN §6, §10.1) as pure state transitions returning committed events:
 * - PREPARE: deliver due messages in (arrivalDay, sendSeq) order (effective/late withdrawals and their results,
 *   intel), then the terminal check;
 * - ADVANCE: day += 5 and G03–G05 in one event, then the terminal check (G07 and talks_failed at ADVANCE);
 * - G06: mutiny condition after ADVANCE, the outbreak outcome (let_it_happen) and `mutiny_averted_for_now`.
 * H14 (no open pause / uncommitted batch) is enforced by the harness before calling `runAdvance`.
 */
import { deliveryEffect } from './resolve.js';
import { commitEffect, Draft, type CommitMeta } from './reducer.js';
import { siegeAdvance, siegeMutinyCondition, siegeNumbers } from './siege.js';
import { terminalEffect, type TerminalPhase } from './terminal.js';
import { presentAt } from './knowledge.js';
import type { SystemAction } from './actions.js';
import {
  BESIEGED_FACTION,
  type CoreConfig,
  type EffectDraft,
  type Message,
  type WorldEvent,
  type WorldState,
} from './types.js';

export interface StepResult {
  state: WorldState;
  events: WorldEvent[];
}

/** Commits an effect, then checks G12 terminals and commits the terminal event if one now holds. */
export function commitWithTerminal(
  state: WorldState,
  config: CoreConfig,
  effect: EffectDraft,
  phase: TerminalPhase,
  meta: CommitMeta = {},
): StepResult {
  const first = commitEffect(state, effect, meta);
  const events = [first.event];
  let next = first.state;
  const terminal = terminalEffect(next, config, phase);
  if (terminal) {
    const t = commitEffect(next, terminal, meta);
    next = t.state;
    events.push(t.event);
  }
  return { state: next, events };
}

/** Checks G12 terminals without a preceding effect (e.g. end of PREPARE). */
export function checkTerminal(state: WorldState, config: CoreConfig, phase: TerminalPhase): StepResult {
  const terminal = terminalEffect(state, config, phase);
  if (!terminal) return { state, events: [] };
  const t = commitEffect(state, terminal);
  return { state: t.state, events: [t.event] };
}

/** Messages due for delivery today, in (arrivalDay, sendSeq) order. */
export function dueMessages(state: WorldState): Message[] {
  return Object.values(state.messages)
    .filter((m) => m.status === 'in_transit' && m.arrivalDay <= state.day)
    .sort((a, b) => a.arrivalDay - b.arrivalDay || a.sendSeq - b.sendSeq);
}

/** PREPARE: all due deliveries (one event each), then the terminal check. A terminal world is frozen. */
export function runPrepare(state: WorldState, config: CoreConfig): StepResult {
  if (state.terminal) return { state, events: [] };
  let current = state;
  const events: WorldEvent[] = [];
  for (let guard = 0; guard < 10_000; guard++) {
    const next = dueMessages(current)[0];
    if (!next) break;
    const committed = commitEffect(current, deliveryEffect(current, config, next.id));
    current = committed.state;
    events.push(committed.event);
  }
  const terminal = checkTerminal(current, config, 'prepare');
  return { state: terminal.state, events: [...events, ...terminal.events] };
}

/** The ADVANCE event: day += round_days, round += 1, G03 grain clamp, G04 pressure, G05 morale. */
export function advanceEffect(state: WorldState, config: CoreConfig): EffectDraft {
  const d = new Draft(state);
  const before = siegeNumbers(state);
  const { next, moraleDecayed } = siegeAdvance(before, config.params);
  d.set(['day'], next.day);
  d.set(['round'], next.round);
  d.set(['factions', BESIEGED_FACTION, 'resources', 'grain'], next.grain);
  d.set(['siege', 'pressure'], next.pressure);
  d.set(['siege', 'morale'], next.morale);
  const scene = state.characters[config.factions[BESIEGED_FACTION].principal].location;
  d.fact({
    scene,
    kind: 'time_advanced',
    actor: null,
    audience: presentAt(state, scene),
    data: {
      fromDay: before.day,
      toDay: next.day,
      grain: next.grain,
      pressure: next.pressure,
      morale: next.morale,
      moraleDecayed,
    },
  });
  d.rule('G01', 'G03', 'G04', 'G05', 'H14');
  return d.build('advance', 'system');
}

/** ADVANCE with the terminal check (G07; talks_failed is evaluated with phase `advance`). */
export function runAdvance(state: WorldState, config: CoreConfig): StepResult {
  if (state.terminal) throw new Error(`cannot advance a terminal world (${state.terminal.kind})`);
  return commitWithTerminal(state, config, advanceEffect(state, config), 'advance');
}

/**
 * G06 condition after the ADVANCE batch committed: world not terminal (not fallen), grain ≤ 10, morale ≤ 30, no
 * prior mutiny. The harness additionally requires that no `system_outcome` batch is open.
 */
export function mutinyDue(state: WorldState, config: CoreConfig): boolean {
  return state.terminal === null && siegeMutinyCondition(siegeNumbers(state), config.params);
}

export const MUTINY_OUTBREAK: SystemAction = { type: 'mutiny_outbreak', args: {} };

/** `urge_payment`: the staged outbreak is cancelled; an event with no world effect records it. */
export function mutinyAvertedEffect(state: WorldState, config: CoreConfig): EffectDraft {
  const d = new Draft(state);
  const scene = state.characters[config.factions[BESIEGED_FACTION].principal].location;
  d.fact({ scene, kind: 'mutiny_averted_for_now', actor: 'player', audience: presentAt(state, scene), data: {} });
  d.rule('G06', 'H10');
  return d.build('mutiny_averted_for_now', 'player');
}
