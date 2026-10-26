/**
 * Read the room (察言观色): the clerk's impression rests on the hourglass alerts and on lines the clerk heard, never
 * on anything the play view does not carry. The Chinese lines are the offline personas' own.
 */
import { describe, expect, it } from 'vitest';
import type { DialogueRowView, SiegeAlertView, SiegeWatchView } from '../../src/server/api-types.js';
import { lineBearing, readRoom, siegeBearing } from '../../web/src/demeanor.js';

function watch(round: number, alerts: Array<Pick<SiegeAlertView, 'level' | 'code'>> = []): SiegeWatchView {
  return {
    round,
    maxRounds: 6,
    roundsLeft: 7 - round,
    day: (round - 1) * 5,
    roundDays: 5,
    now: { grain: 60, pressure: 40, morale: 60 },
    next: null,
    limits: { pressureCap: 100, moraleCap: 100, moraleLowGrain: 15, moraleHighPressure: 70, mutinyGrainMax: 10, mutinyMoraleMax: 30, fallGrainMax: 0, fallPressureMin: 100 },
    alerts: alerts.map((a) => ({ ...a, text: { zh: '', en: '' } })),
  };
}

let seq = 0;
function row(speaker: string, round: number, text: string, listeners: string[] = ['shi_jingtang', 'player']): DialogueRowView {
  seq += 1;
  return { seq, round, speaker, speakerName: { zh: speaker, en: speaker }, listeners, listenerNames: [], kind: 'speech', text, inherited: false, payload: null };
}

describe('what a line suggests', () => {
  it('reads the offline personas’ lines', () => {
    expect(lineBearing('主公，表已具，辞意恳切，宜速用印遣使，迟则生变。')).toEqual({ bearing: 'pressing', cues: ['迟则', '速'] });
    expect(lineBearing('此表可行。即日用印，遣使北上。')).toEqual({ bearing: 'pressing', cues: ['即日'] });
    expect(lineBearing('明公，称臣可矣，以父事之太过。厚以金帛赂之，不必许以土田。')).toEqual({ bearing: 'uneasy', cues: ['太过'] });
    expect(lineBearing('主公，表辞宜厚：称臣、父礼、许以边州，另奉厚礼，则契丹必朝呼夕至。')).toEqual({ bearing: 'composed', cues: [] });
  });

  it('does not count a negated cue', () => {
    expect(lineBearing('此事不必急，徐图之。').bearing).toBe('composed');
    expect(lineBearing('城中无忧。').bearing).toBe('composed');
    expect(lineBearing('此议无不可。').bearing).toBe('composed');
  });

  it('reads English lines too', () => {
    expect(lineBearing('We must send the envoy at once.')).toEqual({ bearing: 'pressing', cues: ['at once'] });
    expect(lineBearing('I fear the Khitan will ask too much.')).toEqual({ bearing: 'uneasy', cues: ['fear', 'too much'] });
    expect(lineBearing('The terms are sound.').bearing).toBe('composed');
  });
});

describe('the clerk’s impression of a person present', () => {
  it('weighs the siege by the hourglass alerts', () => {
    expect(siegeBearing(watch(5, [{ level: 'critical', code: 'fall_next' }])).bearing).toBe('pressing');
    expect(siegeBearing(watch(3, [{ level: 'warning', code: 'mutiny_next' }, { level: 'notice', code: 'morale_falls' }])).bearing).toBe('uneasy');
    expect(siegeBearing(watch(2, [{ level: 'notice', code: 'morale_falls' }])).bearing).toBe('uneasy');
    expect(siegeBearing(watch(6, [{ level: 'notice', code: 'last_round' }]))).toEqual({ bearing: 'composed', reason: null });
  });

  it('takes the more troubled of the siege and the last line heard, naming what it rests on', () => {
    const calm = readRoom('shi_jingtang', [row('shi_jingtang', 3, '此表可行。即日用印，遣使北上。')], watch(3));
    expect(calm.bearing).toBe('pressing');
    expect(calm.reasons).toEqual(['Presses for speed (“即日”, round 3).']);
    const crisis = readRoom('sang_weihan', [row('sang_weihan', 5, '主公，表辞宜厚，则契丹必朝呼夕至。')], watch(5, [{ level: 'critical', code: 'fall_next' }]));
    expect(crisis.bearing).toBe('pressing');
    expect(crisis.reasons).toEqual(['The city could fall when this round ends.', 'Spoke evenly in round 5.']);
  });

  it('uses only the latest line of this round or the last', () => {
    const rows = [row('liu_zhiyuan', 1, '以父事之太过。'), row('liu_zhiyuan', 3, '谨遵将令。'), row('liu_zhiyuan', 4, '恐军心不稳。')];
    expect(readRoom('liu_zhiyuan', rows, watch(4)).heard).toMatchObject({ round: 4, cues: ['恐'] });
    expect(readRoom('liu_zhiyuan', rows.slice(0, 2), watch(4)).heard).toMatchObject({ round: 3, cues: [] });
    const stale = readRoom('liu_zhiyuan', rows.slice(0, 1), watch(4));
    expect(stale).toEqual({ bearing: 'composed', reasons: ['You have not heard them speak this round or the last.'], heard: null });
  });

  it('ignores lines the clerk did not hear (as the director view lists them)', () => {
    const rows = [row('shi_jingtang', 2, '即日用印。', ['sang_weihan']), row('shi_jingtang', 2, '且看来书。')];
    expect(readRoom('shi_jingtang', rows, watch(2)).bearing).toBe('composed');
  });
});
