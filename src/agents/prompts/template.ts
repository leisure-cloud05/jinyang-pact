/**
 * Versioned prompt templates. A template is static text with `{{name}}` placeholders; its hash covers id,
 * version and text, so any wording change is visible in the freeze manifest (PLAN §13: prompt hashes frozen).
 * Rendering is strict: a missing variable or an unreplaced placeholder is a programming error.
 */
import { sha256Hex } from '../../core/hash.js';

export interface PromptTemplate {
  id: string;
  version: number;
  text: string;
  /** SHA-256 of `${id}\0v${version}\0${text}`. */
  hash: string;
}

export function templateHash(id: string, version: number, text: string): string {
  return sha256Hex(`${id}\u0000v${version}\u0000${text}`);
}

export function defineTemplate(id: string, version: number, text: string): PromptTemplate {
  return Object.freeze({ id, version, text, hash: templateHash(id, version, text) });
}

export class PromptRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptRenderError';
  }
}

const PLACEHOLDER = /\{\{([a-z_]+)\}\}/g;

export function placeholders(template: PromptTemplate): string[] {
  return [...new Set([...template.text.matchAll(PLACEHOLDER)].map((m) => m[1] as string))].sort();
}

/** Replaces every `{{name}}` in one pass (values are inserted verbatim and never re-scanned). */
export function render(template: PromptTemplate, vars: Readonly<Record<string, string | number>>): string {
  const missing = placeholders(template).filter((name) => !(name in vars));
  if (missing.length > 0) throw new PromptRenderError(`${template.id}: missing variables ${missing.join(', ')}`);
  return template.text.replace(PLACEHOLDER, (_m, name: string) => String(vars[name]));
}
