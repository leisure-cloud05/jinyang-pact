/** Narration pipeline pieces (PLAN §9.4): facts, header, fallback prose, checker, secret disclosure. */
import { knowsClause } from '../../core/knowledge.js';
import type { CoreConfig, NarrationFact, WorldState } from '../../core/types.js';
import type { SecretSpec } from './checker.js';
import { termsOfFact } from './facts.js';

export * from './facts.js';
export * from './header.js';
export * from './fallback.js';
export * from './checker.js';

/**
 * Clause ids disclosed to a scene: carried by one of its facts (terms / counterTerms) whose whole audience knows
 * the clause. The player never knows a clause it was not given, so a scene the player attends never discloses one.
 */
export function disclosedClauseIds(config: CoreConfig, state: WorldState, facts: readonly NarrationFact[]): Set<string> {
  const out = new Set<string>();
  for (const f of facts) {
    if (f.audience.length === 0) continue;
    for (const t of termsOfFact(f)) {
      for (const id of t.secret_clause_ids) {
        if (f.audience.every((a) => knowsClause(state, config, a, id))) out.add(id);
      }
    }
  }
  return out;
}

/** Catalog clauses whose canary and text must not appear in this scene's prose. */
export function undisclosedSecrets(config: CoreConfig, state: WorldState, facts: readonly NarrationFact[]): SecretSpec[] {
  const disclosed = disclosedClauseIds(config, state, facts);
  return Object.values(config.catalog.secretClauses)
    .filter((c) => !disclosed.has(c.id))
    .map((c) => ({ id: c.id, canary: c.canary, text: { zh: c.text.zh, en: c.text.en } }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Secret specs of every clause a given viewer does not know (e.g. the player, for Judge questions). */
export function secretsUnknownTo(config: CoreConfig, state: WorldState, viewer: Parameters<typeof knowsClause>[2]): SecretSpec[] {
  return Object.values(config.catalog.secretClauses)
    .filter((c) => !knowsClause(state, config, viewer, c.id))
    .map((c) => ({ id: c.id, canary: c.canary, text: { zh: c.text.zh, en: c.text.en } }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
