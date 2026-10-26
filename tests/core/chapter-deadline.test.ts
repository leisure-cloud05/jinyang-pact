import { describe, expect, it } from 'vitest';
import { runAdvance, runPrepare } from '../../src/core/system.js';
import { A, YELU, advance, batch, config, delivered, initial, mutate, prop } from './helpers.js';

describe('interactive chapter deadline', () => {
  const playConfig = () => ({ ...config(), chapterDeadlineRound: 6 });

  it('ends the last round at day 30 and pressure 88 even with grain remaining', () => {
    const before = mutate(initial(), (s) => {
      s.day = 25;
      s.round = 6;
      s.factions.hedong.resources.grain = 35;
      s.siege.pressure = 80;
    });
    const result = runAdvance(before, playConfig());
    expect(result.state.terminal).toMatchObject({
      kind: 'jinyang_falls', day: 30, round: 6,
      detail: { cause: 'missed_opportunity', escalation: 'full_war', besieger: 'tang', grain: 30, pressure: 88 },
    });
    expect(result.events.map((e) => e.kind)).toEqual(['advance', 'terminal']);
    expect(runPrepare(result.state, playConfig()).events).toEqual([]);
    expect(() => runAdvance(result.state, playConfig())).toThrow();
    expect(runAdvance(before, config()).state.terminal).toBeNull();
  });

  it('allows the whole final round for negotiation', () => {
    const before = mutate(initial(), (s) => { s.round = 5; s.day = 20; });
    expect(runAdvance(before, playConfig()).state.terminal).toBeNull();
    expect(runPrepare({ ...before, round: 6 }, playConfig()).state.terminal).toBeNull();
  });

  it('keeps natural siege failure as the cause when the city already falls', () => {
    const before = mutate(initial(), (s) => { s.round = 6; s.siege.pressure = 95; });
    expect(runAdvance(before, playConfig()).state.terminal?.detail.cause).toBe('pressure');
  });

  it('preserves a pact whose acceptance is known to Shi at the deadline', () => {
    let s = batch(delivered(), [prop(YELU, A.confirm('cmt:1', 'offer:1', 1))]).state;
    s = advance(s);
    // PREPARE delivers the acceptance; a known pact takes precedence over the diplomatic deadline.
    const result = runPrepare(s, { ...config(), chapterDeadlineRound: s.round - 1 });
    expect(result.state.terminal?.kind).toBe('pact_concluded');
  });
});
