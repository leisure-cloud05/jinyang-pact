import type { ConversationTopic } from './character-topics.js';

export interface CounselComposer {
  to: string[];
  text: string;
  mode: 'speak' | 'command';
  whisperTo: string;
  example: { characterId: string; topic: ConversationTopic } | null;
}

export type CounselAction =
  | { type: 'topic'; characterId: string; topic: ConversationTopic }
  | { type: 'mode'; mode: CounselComposer['mode'] }
  | { type: 'recipients'; to: string[] }
  | { type: 'whisper-target'; characterId: string }
  | { type: 'whisper-preset'; characterId: string; text: string }
  | { type: 'profile-character'; characterId: string }
  | { type: 'text'; text: string }
  | { type: 'close-example' }
  | { type: 'sent'; to?: string[] };

export function counselComposer(state: CounselComposer, action: CounselAction): CounselComposer {
  switch (action.type) {
    case 'topic':
      return { ...state, mode: 'speak', to: [action.characterId], whisperTo: action.characterId, example: { characterId: action.characterId, topic: action.topic } };
    case 'mode':
      return { ...state, mode: action.mode, example: action.mode === state.mode ? state.example : null };
    case 'recipients':
      return { ...state, to: action.to, example: null };
    case 'whisper-target':
      return { ...state, whisperTo: action.characterId, example: null };
    case 'whisper-preset':
      return { ...state, mode: 'speak', to: [action.characterId], text: action.text, example: null };
    case 'profile-character':
      return action.characterId === state.example?.characterId ? state : { ...state, example: null };
    case 'text':
      return { ...state, text: action.text };
    case 'close-example':
      return { ...state, example: null };
    case 'sent':
      return { ...state, text: '', to: action.to ?? state.to, example: null };
  }
}

export function visibleCounselExample(state: CounselComposer, presentIds: string[]): CounselComposer['example'] {
  return state.mode === 'speak' && state.to.length === 1 && state.to[0] === state.example?.characterId && presentIds.includes(state.to[0] ?? '')
    ? state.example
    : null;
}

export function dialogueInput(turn: string | null, state: CounselComposer) {
  return { kind: 'dialogue' as const, turn, to: state.to, text: state.text.trim() };
}
