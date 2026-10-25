/**
 * Prompt registry: every template with its version and content hash, plus one combined hash of the whole set
 * (for `runs/freeze.json`, PLAN §13). Any wording change changes the corresponding hash.
 */
import { sha256Hex } from '../../core/hash.js';
import {
  CHARACTER_ACTIONS_TEMPLATE,
  CHARACTER_REVISION,
  CHARACTER_SYSTEM_BASELINE,
  CHARACTER_SYSTEM_HARNESS,
  CHARACTER_USER,
} from './character.js';
import { JUDGE_SYSTEM, JUDGE_USER } from './judge.js';
import { MAPPER_SYSTEM, MAPPER_USER } from './mapper.js';
import { ANSWER_SYSTEM, ANSWER_USER } from './answer.js';
import { NARRATOR_SYSTEM, NARRATOR_USER } from './narrator.js';
import type { PromptTemplate } from './template.js';

export * from './template.js';
export * from './character.js';
export * from './judge.js';
export * from './narrator.js';
export * from './mapper.js';
export * from './answer.js';

export const PROMPT_TEMPLATES: readonly PromptTemplate[] = [
  CHARACTER_SYSTEM_HARNESS,
  CHARACTER_SYSTEM_BASELINE,
  CHARACTER_ACTIONS_TEMPLATE,
  CHARACTER_USER,
  CHARACTER_REVISION,
  JUDGE_SYSTEM,
  JUDGE_USER,
  NARRATOR_SYSTEM,
  NARRATOR_USER,
  MAPPER_SYSTEM,
  MAPPER_USER,
  ANSWER_SYSTEM,
  ANSWER_USER,
];

export interface PromptManifestEntry {
  id: string;
  version: number;
  hash: string;
}

export function promptManifest(): PromptManifestEntry[] {
  return [...PROMPT_TEMPLATES]
    .map((t) => ({ id: t.id, version: t.version, hash: t.hash }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** One hash over the whole manifest (ids, versions, hashes). */
export function promptSetHash(): string {
  return sha256Hex(promptManifest().map((e) => `${e.id}@${e.version}:${e.hash}`).join('\n'));
}
