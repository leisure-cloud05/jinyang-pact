import { describe, expect, it } from 'vitest';
import { caseInitialState, toTraceSpec } from '../../src/content/loader.js';
import { simulateTrace } from '../../src/core/simulate.js';
import { config, configFor, fixture } from './helpers.js';

describe('reference traces of the fixture cases', () => {
  for (const id of ['FX1', 'FX3']) {
    for (const mode of ['full', 'no_judge'] as const) {
      it(`${id} reaches its expected terminal within the round budget (${mode})`, () => {
        const b = fixture();
        const trace = b.traces[id];
        const c = b.cases[id];
        if (!trace || !c) throw new Error(`missing ${id}`);
        const initial = caseInitialState(b, id);
        const run = simulateTrace(initial, configFor(id), toTraceSpec(trace), mode);
        expect(run.mismatches).toEqual([]);
        expect(run.terminal?.kind).toBe(trace.expected.terminal);
        expect(run.terminal?.round).toBe(trace.expected.round);
        expect(run.terminal?.round).toBeLessThanOrEqual(c.max_rounds);
        expect(c.valid_terminals).toContain(run.terminal?.kind);
        // Initial grain/pressure are consistent with the trace: the city does not fall on the way.
        expect(run.state.factions.hedong.resources.grain).toBeGreaterThan(0);
        expect(run.state.siege.pressure).toBeLessThan(config().params.fall_pressure_min);
      });
    }
  }

  it('FX3 raises the deadlock control pause in round 5 and regenerates the batch after urge_stop', () => {
    const run = simulateTrace(caseInitialState(fixture(), 'FX3'), config(), toTraceSpec(fixture().traces.FX3!), 'full');
    const r5 = run.batches.filter((b) => b.round === 5);
    expect(r5.map((b) => `${b.kind}:${b.generation}`)).toEqual(['character:0', 'player:0', 'character:1']);
    expect(r5[0]?.pauses.map((p) => p.category)).toEqual(['negotiation_deadlock']);
    const openedBy = run.state.negotiation['hedong-khitan'].segmentOpenedBy ?? '';
    expect(openedBy).toMatch(/^event:\d+$/);
    const reset = run.events.find((e) => `event:${e.version}` === openedBy);
    expect(reset).toMatchObject({ kind: 'deadlock_resolved', decisionId: 'r5-g0-d1' });
    expect(run.state.negotiation['hedong-khitan']).toMatchObject({ segment: 2, deadlockPending: false });
    const r3 = run.batches.find((b) => b.round === 3 && b.kind === 'character');
    expect(r3?.pauses.map((p) => p.category)).toEqual(['major_commitment']);
    // Hand-computed siege: grain 40 − 5·5 = 15; pressure 40 + 8·5 + 4 (Li, R3) = 84; morale 60 − 5 (R4) − 5 (R5) = 50.
    expect([run.state.factions.hedong.resources.grain, run.state.siege.pressure, run.state.siege.morale]).toEqual([15, 84, 50]);
  });

  it('a trace with a missing decision is reported, not silently executed', () => {
    const spec = toTraceSpec(fixture().traces.FX1!);
    const broken = { ...spec, rounds: spec.rounds.map((r) => (r.round === 1 ? { ...r, decisions: [] } : r)) };
    const run = simulateTrace(caseInitialState(fixture(), 'FX1'), config(), broken, 'full');
    expect(run.mismatches.some((m) => m.includes('no decision in the trace'))).toBe(true);
  });
});
