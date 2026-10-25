/**
 * Who may be asked at a pause (PLAN §7): only living characters present with the clerk. A paused proposal of an
 * offstage character (e.g. Li Congke's `ask_player` from Luoyang) does not make him askable.
 */
import { describe, expect, it } from 'vitest';
import { caseInitialState } from '../../src/content/loader.js';
import { askableCharacters } from '../../src/engine/lifecycle.js';
import type { Runtime } from '../../src/engine/runtime.js';
import { content } from '../content-real/helpers.js';

const rt = {} as Runtime;

describe('askable characters', () => {
  it('excludes an offstage paused actor and lists present characters, paused ones first', () => {
    const state = caseInitialState(content(), 'C1');
    const remote = askableCharacters(rt, state, ['li_congke']);
    expect(remote).not.toContain('li_congke');
    expect(remote).not.toContain('yelu_deguang');
    expect(remote.length).toBeGreaterThan(0);
    const local = askableCharacters(rt, state, ['sang_weihan']);
    expect(local[0]).toBe('sang_weihan');
  });

  it('excludes a dead character even when present', () => {
    const state = caseInitialState(content(), 'C1');
    const dead = { ...state, characters: { ...state.characters, sang_weihan: { ...state.characters.sang_weihan, status: 'dead' as const } } };
    expect(askableCharacters(rt, dead, ['sang_weihan'])).not.toContain('sang_weihan');
  });
});
