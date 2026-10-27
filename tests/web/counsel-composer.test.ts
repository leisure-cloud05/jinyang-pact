import { describe, expect, it } from 'vitest';
import { counselComposer, dialogueInput, visibleCounselExample, type CounselAction, type CounselComposer } from '../../web/src/counsel-composer.js';
import type { ConversationTopic } from '../../web/src/character-topics.js';

const topic: ConversationTopic = {
  id: 'land', label: { en: 'Cost of cession', zh: '割地后患' },
  text: { en: '(quietly) What lasting harm could the land bring?', zh: '割地有何后患？' },
};
const initial: CounselComposer = { to: ['sang_weihan', 'liu_zhiyuan'], text: 'My own words', mode: 'speak', whisperTo: '', example: null };

describe('profile topic examples in Speak', () => {
  it('has no example before a topic is selected', () => {
    expect(visibleCounselExample(initial, initial.to)).toBeNull();
  });

  it('selects a private listener and shows the English example without replacing the player’s words', () => {
    const selected = counselComposer(initial, { type: 'topic', characterId: 'liu_zhiyuan', topic });
    expect(selected).toMatchObject({ mode: 'speak', to: ['liu_zhiyuan'], whisperTo: 'liu_zhiyuan', text: 'My own words' });
    expect(visibleCounselExample(selected, ['sang_weihan', 'liu_zhiyuan'])).toEqual({ characterId: 'liu_zhiyuan', topic });
    expect(dialogueInput('turn-2', selected)).toEqual({ kind: 'dialogue', turn: 'turn-2', to: ['liu_zhiyuan'], text: 'My own words' });
  });

  it('switches topics without changing drafted text, then dismisses the example', () => {
    const selected = counselComposer(initial, { type: 'topic', characterId: 'liu_zhiyuan', topic });
    const nextTopic = { ...topic, id: 'silk', label: { en: 'Silk and limits', zh: '金帛与底线' } };
    const switched = counselComposer(selected, { type: 'topic', characterId: 'liu_zhiyuan', topic: nextTopic });
    expect(switched.text).toBe(initial.text);
    expect(switched.example?.topic.id).toBe('silk');
    const closed = counselComposer(switched, { type: 'close-example' });
    expect(closed.text).toBe(initial.text);
    expect(visibleCounselExample(closed, ['liu_zhiyuan'])).toBeNull();
  });

  it('clears the example on character, recipient and mode changes while retaining the draft', () => {
    const selected = counselComposer(initial, { type: 'topic', characterId: 'liu_zhiyuan', topic });
    const actions: CounselAction[] = [
      { type: 'profile-character', characterId: 'sang_weihan' },
      { type: 'recipients', to: ['sang_weihan'] },
      { type: 'whisper-target', characterId: 'sang_weihan' },
      { type: 'mode', mode: 'command' },
    ];
    for (const action of actions) {
      const changed = counselComposer(selected, action);
      expect(changed.example).toBeNull();
      expect(changed.text).toBe(initial.text);
    }
    expect(visibleCounselExample(selected, ['sang_weihan'])).toBeNull();
  });

  it('sends only player text to the chosen listener and clears the example after success', () => {
    const selected = counselComposer({ ...initial, text: '  Help us decide.  ' }, { type: 'topic', characterId: 'liu_zhiyuan', topic });
    expect(dialogueInput('turn-3', selected)).toEqual({ kind: 'dialogue', turn: 'turn-3', to: ['liu_zhiyuan'], text: 'Help us decide.' });
    const sent = counselComposer(selected, { type: 'sent', to: ['sang_weihan', 'liu_zhiyuan'] });
    expect(sent).toMatchObject({ text: '', example: null, to: ['sang_weihan', 'liu_zhiyuan'] });
  });
});
