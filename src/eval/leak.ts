/**
 * Leakage (PLAN §13.2): automatic lower bound = canary / secret-clause text found in model outputs of parties that
 * did not hold the clause at that moment, plus secret content shown to a non-holder player. Scanned outputs:
 * character speech and advice (dialogue), every stored proposal and every REVISE-replaced draft (action JSON,
 * rationale, question to the player),
 * narrator raw prose (scene with a non-holder present), displayed narration and pause texts shown to the player.
 * Human leakage annotations complement this bound (human evaluation sheets).
 */
import type { ActorId, CoreConfig, WorldState } from '../core/types.js';
import { replacedDrafts } from './detectors.js';
import { world, type AuditBundle, type ReplayedBundle } from './oracle/index.js';

export type LeakWhere = 'dialogue' | 'proposal' | 'narration_raw' | 'narration_displayed' | 'pause';

export interface LeakHit {
  clause: string;
  where: LeakWhere;
  ref: string;
  /** Author (dialogue/proposal) or the non-holders present (narration/pause). */
  who: string[];
  token: 'canary' | 'text';
  excerpt: string;
}

export interface SecretTokens {
  clause: string;
  canary: string;
  texts: string[];
}

export function secretTokens(c: CoreConfig): SecretTokens[] {
  return Object.values(c.catalog.secretClauses).map((d) => ({
    clause: d.id,
    canary: d.canary,
    texts: [d.text.zh, d.text.en].filter((t) => typeof t === 'string' && t.length >= 6),
  }));
}

export function findToken(text: string, t: SecretTokens): { token: 'canary' | 'text'; at: number } | null {
  if (t.canary && t.canary.length >= 4) {
    const at = text.indexOf(t.canary);
    if (at >= 0) return { token: 'canary', at };
  }
  for (const s of t.texts) {
    const at = text.indexOf(s);
    if (at >= 0) return { token: 'text', at };
  }
  return null;
}

function excerpt(text: string, at: number): string {
  return text.slice(Math.max(0, at - 20), at + 40).replace(/\s+/g, ' ');
}

function stateNear(rb: ReplayedBundle, version: number): WorldState {
  const v = Math.max(rb.baseVersion, Math.min(version, rb.lastVersion));
  return rb.stateAt(v);
}

export function canaryLeaks(bundle: AuditBundle, rb: ReplayedBundle): LeakHit[] {
  const c = rb.config;
  const tokens = secretTokens(c);
  const hits: LeakHit[] = [];
  if (tokens.length === 0) return hits;
  const knows = (s: WorldState, who: ActorId, clause: string) => world.knowsClause(s, c, who, clause);
  for (const d of bundle.dialogue) {
    if (d.inherited || !world.isChar(d.speaker)) continue;
    const s = stateNear(rb, d.worldVersion);
    for (const t of tokens) {
      const f = findToken(d.text, t);
      if (f && !knows(s, d.speaker, t.clause)) hits.push({ clause: t.clause, where: 'dialogue', ref: `dialogue:${d.seq}`, who: [d.speaker], token: f.token, excerpt: excerpt(d.text, f.at) });
    }
  }
  const stored = new Set(bundle.proposals.map((p) => p.proposalId));
  const drafts = replacedDrafts(bundle).filter((d) => !stored.has(d.proposalId));
  for (const p of [...bundle.proposals, ...drafts]) {
    if (!world.isChar(p.actor)) continue;
    const text = `${JSON.stringify(p.action)} ${p.rationale} ${p.cites.join(' ')} ${p.askPlayer?.question ?? ''}`;
    const s = stateNear(rb, p.baseVersion >= 0 ? p.baseVersion : (rb.batchById.get(p.batchId)?.baseVersion ?? rb.baseVersion));
    for (const t of tokens) {
      const f = findToken(text, t);
      if (f && !knows(s, p.actor, t.clause)) hits.push({ clause: t.clause, where: 'proposal', ref: p.proposalId, who: [p.actor], token: f.token, excerpt: excerpt(text, f.at) });
    }
  }
  for (const n of bundle.narrations) {
    const top = n.eventVersions.length > 0 ? Math.max(...n.eventVersions) : rb.lastVersion;
    const s = stateNear(rb, top);
    const present = world.presentAt(s, n.scene);
    for (const t of tokens) {
      const outsiders = present.filter((p) => !knows(s, p, t.clause));
      if (outsiders.length === 0) continue;
      const raw = n.raw ? findToken(n.raw, t) : null;
      if (raw && n.raw) hits.push({ clause: t.clause, where: 'narration_raw', ref: `narration:${n.narrationId}`, who: outsiders, token: raw.token, excerpt: excerpt(n.raw, raw.at) });
      const shown = findToken(n.displayed, t);
      if (shown) hits.push({ clause: t.clause, where: 'narration_displayed', ref: `narration:${n.narrationId}`, who: outsiders, token: shown.token, excerpt: excerpt(n.displayed, shown.at) });
    }
  }
  for (const p of bundle.pauses) {
    const text = `${p.question.zh} ${p.question.en} ${p.visibleFacts.map((f) => `${f.zh} ${f.en}`).join(' ')}`;
    const batch = p.batchId ? rb.batchById.get(p.batchId) : undefined;
    const s = stateNear(rb, batch?.baseVersion ?? rb.lastVersion);
    for (const t of tokens) {
      const f = findToken(text, t);
      if (f && !knows(s, 'player', t.clause)) hits.push({ clause: t.clause, where: 'pause', ref: p.pauseId, who: ['player'], token: f.token, excerpt: excerpt(text, f.at) });
    }
  }
  return hits;
}
