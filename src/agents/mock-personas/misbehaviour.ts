/**
 * Seeded misbehaviour injector (PLAN §9.3): turns a persona's correct output into a typical model error so the
 * pipeline's validation, gating and checking are exercised. Rate 0 by default. The seed of every decision is
 * `seedFrom(case, rep, actor, round, epoch, callTag)`, so a (case, rep) replays identically regardless of call
 * order. Kinds:
 * - on_behalf_consent: approving/confirming for someone else (H02/H09);
 * - answer_before_delivery: answering an offer the actor has not received (guessed ids; H04/H08);
 * - overdraft: spending more than the faction's available stock (H07);
 * - duplicate_dispatch: dispatching an already-sent document, or twice in one output (H11/H12);
 * - stale_version: acting on an outdated document/terms version (H04);
 * - fabricated_cites: citing ids that are not in the context (stripped and counted);
 * - contradicting_prose (narrator): prose that kills a living character, invents an arrival or a wrong quantity.
 */
import { createRng, seedFrom } from '../../core/rng.js';
import type { CharacterMeta } from '../character.js';
import type { NarratorMeta } from '../narrator.js';
import type { CharacterActionItem, CharacterOutput, NarratorOutput } from '../schemas.js';
import type { CallIdentity } from '../types.js';
import { available, awaitingOffers } from './terms.js';

export const MISBEHAVIOUR_KINDS = [
  'on_behalf_consent',
  'answer_before_delivery',
  'overdraft',
  'duplicate_dispatch',
  'stale_version',
  'fabricated_cites',
  'contradicting_prose',
] as const;
export type MisbehaviourKind = (typeof MISBEHAVIOUR_KINDS)[number];

export const CHARACTER_MISBEHAVIOURS: readonly MisbehaviourKind[] = MISBEHAVIOUR_KINDS.filter((k) => k !== 'contradicting_prose');

export interface InjectionRecord {
  role: 'character' | 'narrator';
  actor: string;
  round: number;
  epoch: number;
  callTag: string | null;
  kind: MisbehaviourKind;
  seed: number;
}

export interface MisbehaviourOptions {
  /** Probability per call that one misbehaviour is injected (default 0). */
  rate: number;
  /** Kinds that may be injected (default: all). */
  kinds?: readonly MisbehaviourKind[];
  /** Receives one record per injection. */
  log?: InjectionRecord[];
}

export function misbehaviourSeed(identity: CallIdentity, actor: string): number {
  return seedFrom(identity.caseId ?? '-', identity.rep ?? 0, actor, identity.round, identity.epoch ?? 0, identity.callTag ?? '-');
}

export const FABRICATED_CITES = ['zztj280-999', 'k:99999'];

function push(out: CharacterOutput, item: CharacterActionItem): CharacterOutput {
  const actions = out.actions.length >= 3 ? [...out.actions.slice(0, 2), item] : [...out.actions, item];
  return { ...out, actions };
}

function applyCharacter(kind: MisbehaviourKind, meta: CharacterMeta, out: CharacterOutput): CharacterOutput {
  const ctx = meta.context;
  const doc = ctx.documents.find((d) => d.basis === 'observed') ?? null;
  const offers = ctx.negotiations.flatMap((n) => n.threads.flatMap((t) => t.offers));
  const rationale = 'injected misbehaviour';
  switch (kind) {
    case 'on_behalf_consent': {
      const others = offers.find((o) => o.awaitingAnswerFrom !== null && o.awaitingAnswerFrom !== ctx.self.id);
      const mine = offers.find((o) => o.from === ctx.self.id && (o.status === 'sent' || o.status === 'delivered'));
      const target = others ?? mine;
      if (target) {
        return push(out, {
          type: 'confirm_commitment',
          args: { commitmentId: target.commitmentId, offerId: target.offerId, termsVersion: target.termsVersion },
          rationale,
          cites: [],
        });
      }
      // A principal sealing his own draft is legitimate: he gets an answer to an offer that was never delivered.
      if (ctx.self.principal) {
        return push(out, { type: 'confirm_commitment', args: { commitmentId: `cmt:${offers.length + 1}`, offerId: `offer:${offers.length + 1}`, termsVersion: 1 }, rationale, cites: [] });
      }
      return push(out, { type: 'approve_document', args: { docId: doc?.docId ?? 'doc:1', docVersion: doc?.version ?? 1 }, rationale, cites: [] });
    }
    case 'answer_before_delivery': {
      const known = offers.length;
      return push(out, {
        type: 'confirm_commitment',
        args: { commitmentId: `cmt:${known + 1}`, offerId: `offer:${known + 1}`, termsVersion: 1 },
        rationale,
        cites: [],
      });
    }
    case 'overdraft': {
      const faction = ctx.resources.faction;
      if (faction === 'tang') {
        return push(out, {
          type: 'allocate_resources',
          args: { faction, resource: 'reserve_troops', amount: available(ctx, 'reserve_troops') + 5000, purpose: 'intensify_siege' },
          rationale,
          cites: [],
        });
      }
      const resource = faction === 'khitan' ? 'cavalry' : 'silk';
      return push(out, {
        type: 'allocate_resources',
        args: { faction, resource, amount: available(ctx, resource) + 100_000, purpose: 'pay_troops' },
        rationale,
        cites: [],
      });
    }
    case 'duplicate_dispatch': {
      const existing = out.actions.find((a) => a.type === 'dispatch_document');
      if (existing) return push(out, { ...existing, rationale });
      // Never a legitimate dispatch: a sent document again (H12), else a version that does not exist (H04/H11).
      const version = doc ? (doc.status === 'sent' ? doc.version : doc.version + 1) : 1;
      return push(out, { type: 'dispatch_document', args: { docId: doc?.docId ?? 'doc:1', docVersion: version }, rationale, cites: [] });
    }
    case 'stale_version': {
      const awaiting = awaitingOffers(ctx)[0];
      if (awaiting) {
        const o = awaiting.offer;
        return push(out, {
          type: 'confirm_commitment',
          args: { commitmentId: o.commitmentId, offerId: o.offerId, termsVersion: o.termsVersion + 1 },
          rationale,
          cites: [],
        });
      }
      const version = doc ? (doc.version > 1 ? doc.version - 1 : doc.version + 1) : 2;
      return push(out, { type: 'approve_document', args: { docId: doc?.docId ?? 'doc:1', docVersion: version }, rationale, cites: [] });
    }
    case 'fabricated_cites': {
      if (out.actions.length === 0) return push(out, { type: 'wait', args: {}, rationale, cites: [...FABRICATED_CITES] });
      return { ...out, actions: out.actions.map((a) => ({ ...a, cites: [...a.cites, ...FABRICATED_CITES] })) };
    }
    case 'contradicting_prose':
      return out;
  }
}

/** Possibly injects one misbehaviour into a persona's character output (deterministic per call identity). */
export function injectCharacter(meta: CharacterMeta, out: CharacterOutput, opts: MisbehaviourOptions | undefined): CharacterOutput {
  if (!opts || opts.rate <= 0) return out;
  const seed = misbehaviourSeed(meta.identity, meta.context.self.id);
  const rng = createRng(seed);
  if (!rng.chance(opts.rate)) return out;
  const kinds = (opts.kinds ?? MISBEHAVIOUR_KINDS).filter((k) => CHARACTER_MISBEHAVIOURS.includes(k));
  if (kinds.length === 0) return out;
  const kind = rng.pick(kinds);
  opts.log?.push({
    role: 'character',
    actor: meta.context.self.id,
    round: meta.identity.round,
    epoch: meta.identity.epoch ?? 0,
    callTag: meta.identity.callTag ?? null,
    kind,
    seed,
  });
  return applyCharacter(kind, meta, out);
}

const CONTRADICTIONS = {
  zh: ['耶律德光已死于军中。', '援军已至城下。', '另奉帛九万九千匹为礼。'],
  en: ['Yelü Deguang died in his camp.', 'The relief cavalry arrived beneath the walls.', 'A gift of 99,000 bolts was added.'],
} as const;

/** Possibly appends a contradiction to narrator prose (deterministic per call identity). */
export function injectNarrator(meta: NarratorMeta, out: NarratorOutput, opts: MisbehaviourOptions | undefined): NarratorOutput {
  if (!opts || opts.rate <= 0) return out;
  if (opts.kinds && !opts.kinds.includes('contradicting_prose')) return out;
  const seed = misbehaviourSeed(meta.identity, 'narrator');
  const rng = createRng(seed);
  if (!rng.chance(opts.rate)) return out;
  opts.log?.push({
    role: 'narrator',
    actor: 'narrator',
    round: meta.identity.round,
    epoch: meta.identity.epoch ?? 0,
    callTag: meta.identity.callTag ?? null,
    kind: 'contradicting_prose',
    seed,
  });
  const lines = CONTRADICTIONS[meta.lang];
  return { ...out, prose: `${out.prose}${meta.lang === 'zh' ? '' : ' '}${rng.pick(lines)}` };
}
