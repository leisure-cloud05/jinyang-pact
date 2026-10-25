/**
 * Player-vantage protection (PLAN §3.3, §9.2, C4): what the player cannot know never leaves the server in a player
 * view. Two layers:
 * 1. `sanitizeForPlayer` — structural: every `secret_clauses` list keeps only clauses the player knows (as
 *    `{id, text}`), and `canary` / `knownBy` keys are dropped. View builders apply it to any term-bearing value.
 * 2. `LeakGuard` — textual assertion on the final response: the canaries and texts of secret clauses the player does
 *    not know, and the free text of correspondence between other factions (e.g. Luoyang's letter to the Khitan),
 *    are replaced by a seal mark wherever they occur. Hits are counted and reported (header `x-jinyang-leak-guard`);
 *    tests require zero hits, so the guard is a backstop, never the mechanism.
 */
import { knowsClause } from '../core/knowledge.js';
import { own } from '../core/ids.js';
import type { CoreConfig, WorldState } from '../core/types.js';

export const SEAL = '〔封〕';

const MIN_NEEDLE = 6;

/** Texts the player must not see in this session (latest state: knowledge only grows). */
export function playerNeedles(state: WorldState, config: CoreConfig): string[] {
  const needles = new Set<string>();
  for (const clause of Object.values(config.catalog.secretClauses)) {
    if (knowsClause(state, config, 'player', clause.id)) continue;
    for (const t of [clause.canary, clause.text.zh, clause.text.en]) if (t && t.trim().length >= 2) needles.add(t);
  }
  for (const clause of Object.values(state.documents).flatMap((d) => d.terms.secret_clauses)) {
    if (knowsClause(state, config, 'player', clause.id)) continue;
    for (const t of [clause.canary, clause.text.zh, clause.text.en]) if (t && t.trim().length >= 2) needles.add(t);
  }
  const playerFaction = config.player.faction;
  const factionOf = (actor: string): string | null => {
    if (actor === 'player') return playerFaction;
    const c = own(state.characters as Record<string, { faction: string }>, actor);
    return c ? c.faction : null;
  };
  for (const m of Object.values(state.messages)) {
    if (factionOf(m.from) === playerFaction || factionOf(m.to) === playerFaction) continue;
    const payload = m.payload as unknown as Record<string, unknown>;
    for (const key of ['text', 'note', 'reason']) {
      const v = payload[key];
      if (typeof v === 'string' && v.trim().length >= MIN_NEEDLE) needles.add(v.trim());
    }
  }
  return [...needles].sort((a, b) => b.length - a.length);
}

export class LeakGuard {
  readonly needles: readonly string[];
  hits = 0;

  constructor(needles: readonly string[]) {
    this.needles = needles;
  }

  private scrub(text: string): string {
    let out = text;
    for (const n of this.needles) {
      if (!out.includes(n)) continue;
      this.hits += out.split(n).length - 1;
      out = out.split(n).join(SEAL);
    }
    return out;
  }

  /** Deep copy of `value` with every needle occurrence (in keys and string values) sealed. */
  apply<T>(value: T): T {
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') return this.scrub(v);
      if (Array.isArray(v)) return v.map(walk);
      if (v !== null && typeof v === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, item] of Object.entries(v)) out[this.scrub(k)] = walk(item);
        return out;
      }
      return v;
    };
    return walk(value) as T;
  }
}

/** Secret-clause entry as the player may see it (known clauses only), or null. */
function clauseForPlayer(entry: unknown, state: WorldState, config: CoreConfig): { id: string; text: { zh: string; en: string } } | string | null {
  const id = typeof entry === 'string' ? entry : entry !== null && typeof entry === 'object' ? (entry as { id?: unknown }).id : null;
  if (typeof id !== 'string' || !knowsClause(state, config, 'player', id)) return null;
  if (typeof entry === 'string') return entry;
  const def = own(config.catalog.secretClauses, id);
  const text = (entry as { text?: { zh?: string; en?: string } }).text ?? def?.text;
  return { id, text: { zh: text?.zh ?? '', en: text?.en ?? '' } };
}

/**
 * Structural sanitation of any term-bearing value for the player: unknown secret clauses removed from every
 * `secret_clauses` / `secret_clause_ids` list, `canary` and `knownBy` keys dropped.
 */
export function sanitizeForPlayer<T>(value: T, state: WorldState, config: CoreConfig): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v === null || typeof v !== 'object') return v;
    const out: Record<string, unknown> = {};
    for (const [k, item] of Object.entries(v)) {
      if (k === 'canary' || k === 'knownBy') continue;
      if ((k === 'secret_clauses' || k === 'secret_clause_ids') && Array.isArray(item)) {
        out[k] = item.map((e) => clauseForPlayer(e, state, config)).filter((e) => e !== null);
        continue;
      }
      out[k] = walk(item);
    }
    return out;
  };
  return walk(value) as T;
}
