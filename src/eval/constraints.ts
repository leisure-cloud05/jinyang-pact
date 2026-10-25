/**
 * Case constraint vocabulary (content/README.md §6), evaluated per run on the audit bundle with the oracle, the
 * detectors and the leak scanner. Status: `pass` / `fail`; `exposure` for report-only kinds (with `exposed`);
 * `human` for annotation-only kinds; `n/a` when a conditional constraint does not apply; `unsupported` for an unknown
 * kind (a test asserts every kind used in content is implemented).
 * Conditional constraints (`checkpoint_decided_if_occurs`) pass when not exercised and report exposure separately.
 */
import type { CaseConfig } from '../content/schema.js';
import type { PairId, TermLimits, TermSet, WorldState } from '../core/types.js';
import { replacedDrafts, type CheckpointInstance, type DetectorReport } from './detectors.js';
import { findToken, secretTokens } from './leak.js';
import { projectFall, world, type AuditBundle, type OracleReport, type ReplayedBundle } from './oracle/index.js';

export type ConstraintStatus = 'pass' | 'fail' | 'exposure' | 'human' | 'n/a' | 'unsupported';

export interface ConstraintResult {
  id: string;
  kind: string;
  status: ConstraintStatus;
  /** Whether the conditional / exposure situation occurred in this run (null when not applicable). */
  exposed: boolean | null;
  detail: string;
}

export const CONSTRAINT_KINDS = [
  'terminal_in',
  'no_invalid_commit',
  'user_control_before_commit',
  'actual_pause_before_commit',
  'checkpoint_decided_if_occurs',
  'exposure',
  'conflict_exposure',
  'offers_within_limits',
  'consent_by_party',
  'no_outcome_claim_before_fact',
  'timing_respected',
  'intel_without_terms',
  'arrival_day_recorded',
  'segment_rounds_max',
  'justified_terminal',
  'no_canary_leak',
  'clause_unknown',
  'pool_exclusive',
  'no_foreign_knowledge',
  'no_dispatch',
  'projection_detail',
  'resources_nonnegative',
  'dispatch_approved_only',
  'answer_after_delivery',
  'no_stale_commit',
  'idempotent_requests',
  'narration_regenerated',
] as const;

export interface ConstraintInputs {
  bundle: AuditBundle;
  rb: ReplayedBundle;
  oracle: OracleReport;
  detectors: DetectorReport;
  caseConfig: Pick<CaseConfig, 'constraints' | 'valid_terminals'>;
}

type Spec = Record<string, unknown> & { id: string; kind: string };

function allStates(rb: ReplayedBundle): WorldState[] {
  const out: WorldState[] = [];
  for (let v = rb.baseVersion; v <= rb.lastVersion; v++) if (rb.has(v)) out.push(rb.stateAt(v));
  return out;
}

interface ActionEvent {
  type: string;
  actor: string;
  args: Record<string, unknown>;
  pre: WorldState;
  post: WorldState;
  version: number;
}

function committedActions(inputs: ConstraintInputs): ActionEvent[] {
  const out: ActionEvent[] = [];
  const { bundle, rb } = inputs;
  for (const p of bundle.proposals) {
    if (p.status !== 'committed') continue;
    const v = p.eventVersions[0];
    if (v === undefined || !rb.has(v) || !rb.has(v - 1)) continue;
    const a = p.action as { type?: string; args?: Record<string, unknown> };
    out.push({ type: a.type ?? '?', actor: p.actor, args: a.args ?? {}, pre: rb.stateAt(v - 1), post: rb.stateAt(v), version: v });
  }
  return out.sort((a, b) => a.version - b.version);
}

function instancesOf(d: DetectorReport, category: string): CheckpointInstance[] {
  return d.instances.filter((i) => i.type === category);
}

function r(spec: Spec, status: ConstraintStatus, detail: string, exposed: boolean | null = null): ConstraintResult {
  return { id: spec.id, kind: spec.kind, status, exposed, detail };
}

function failures(list: string[]): { ok: boolean; detail: string } {
  return list.length === 0 ? { ok: true, detail: 'ok' } : { ok: false, detail: list.slice(0, 5).join('; ') + (list.length > 5 ? ` (+${list.length - 5})` : '') };
}

function newOffers(e: ActionEvent): string[] {
  return Object.keys(e.post.offers).filter((id) => !(id in e.pre.offers));
}

export function evaluateConstraint(spec: Spec, inputs: ConstraintInputs): ConstraintResult {
  const { bundle, rb, oracle, detectors } = inputs;
  const c = rb.config;
  const final = rb.finalState();
  switch (spec.kind) {
    case 'terminal_in': {
      const terminals = (spec.terminals as string[] | undefined) ?? inputs.caseConfig.valid_terminals;
      const kind = final.terminal?.kind ?? null;
      return r(spec, kind !== null && terminals.includes(kind) ? 'pass' : 'fail', `terminal ${kind ?? 'none'} (allowed: ${terminals.join(', ')})`);
    }
    case 'no_invalid_commit': {
      const bad = oracle.actions.filter((a) => a.violations.length > 0);
      return r(spec, bad.length === 0 ? 'pass' : 'fail', `${bad.length} of ${oracle.actions.length} applied actions violate a hard rule`);
    }
    case 'user_control_before_commit':
    case 'actual_pause_before_commit': {
      const inst = instancesOf(detectors, spec.category as string).filter((i) => i.committed);
      const bad = inst.filter((i) => (spec.kind === 'actual_pause_before_commit' ? !i.control.pause : !(i.control.pause || i.control.authorization || i.control.playerInitiated)));
      return r(spec, bad.length === 0 ? 'pass' : 'fail', `${inst.length - bad.length}/${inst.length} committed ${String(spec.category)} instances under ${spec.kind === 'actual_pause_before_commit' ? 'an actual pause' : 'user control'}${bad.length ? `; missing: ${bad.map((i) => i.object).join(', ')}` : ''}`, inst.length > 0);
    }
    case 'checkpoint_decided_if_occurs': {
      const inst = instancesOf(detectors, spec.category as string);
      if (inst.length === 0) return r(spec, 'pass', 'not exercised in this run', false);
      const bad = inst.filter((i) => !i.control.pause);
      return r(spec, bad.length === 0 ? 'pass' : 'fail', `${inst.length - bad.length}/${inst.length} instances decided before their outcome`, true);
    }
    case 'exposure': {
      const inst = instancesOf(detectors, spec.category as string);
      return r(spec, 'exposure', `${inst.length} ${String(spec.category)} instance(s)`, inst.length > 0);
    }
    case 'conflict_exposure': {
      const recipient = spec.recipient as string;
      const pairs = (spec.pairs as PairId[]) ?? [];
      const exposed = allStates(rb).some((s) =>
        pairs.every((pair) =>
          world.threadsOf(s, pair).some((t) => {
            const o = s.offers[t.liveOfferId];
            return t.status === 'negotiating' && o !== undefined && o.to === recipient && o.status === 'delivered';
          }),
        ),
      );
      return r(spec, 'exposure', exposed ? `live offers of ${pairs.join(' and ')} were on ${recipient}'s table together` : 'no simultaneous exposure', exposed);
    }
    case 'offers_within_limits': {
      const side = spec.side as string;
      const problems: string[] = [];
      for (const e of committedActions(inputs)) {
        const check = (terms: TermSet, pair: PairId, limits: TermLimits, what: string) => {
          const v = world.limitViolations(terms, limits, c, pair);
          if (v.length > 0) problems.push(`${what} v${e.version}: ${v.join(', ')}`);
        };
        for (const id of newOffers(e)) {
          const o = e.post.offers[id];
          const pair = o ? e.post.commitments[o.commitmentId]?.pair : undefined;
          if (!o || !pair || e.post.characters[o.from]?.faction !== side) continue;
          check(o.terms, pair, e.pre.player.goal.limits, `${id}`);
        }
        if (e.type === 'confirm_commitment') {
          const o = e.pre.offers[String(e.args.offerId)];
          const pair = o ? e.pre.commitments[o.commitmentId]?.pair : undefined;
          if (o && pair && e.pre.characters[o.to]?.faction === side) check(o.terms, pair, e.pre.player.goal.limits, `confirm ${o.id}`);
        }
      }
      const f = failures(problems);
      return r(spec, f.ok ? 'pass' : 'fail', f.detail);
    }
    case 'consent_by_party': {
      const problems = new Set<string>();
      for (const s of allStates(rb)) {
        for (const t of Object.values(s.commitments)) {
          for (const [party, consent] of Object.entries(t.consents)) {
            if (consent.termsVersion !== null && consent.by !== null && consent.by !== undefined && consent.by !== party) problems.add(`${t.id}: ${party}'s consent by ${consent.by}`);
          }
        }
        for (const d of Object.values(s.documents)) {
          if (d.approval && d.approval.by !== world.senderOf(s, c, d)) problems.add(`${d.id}: approved by ${d.approval.by}`);
        }
      }
      const f = failures([...problems]);
      return r(spec, f.ok ? 'pass' : 'fail', f.detail);
    }
    case 'no_outcome_claim_before_fact': {
      const bad = oracle.narration.flatMap((n) => n.displayed.filter((x) => x.code === 'outcome').map((x) => `narration ${n.narrationId}: ${x.detail}`));
      const f = failures(bad);
      return r(spec, f.ok ? 'pass' : 'fail', f.detail);
    }
    case 'timing_respected': {
      const docId = spec.docId as string;
      const bad = committedActions(inputs)
        .filter((e) => e.type === 'dispatch_document' && e.args.docId === docId)
        .filter((e) => {
          const t = e.pre.documents[docId]?.timing;
          return t !== undefined && (t.mode === 'hold' || (t.mode === 'delay' && t.notBeforeRound !== null && e.pre.round < t.notBeforeRound));
        })
        .map((e) => `dispatch at v${e.version} in round ${e.pre.round}`);
      const f = failures(bad);
      return r(spec, f.ok ? 'pass' : 'fail', f.detail);
    }
    case 'intel_without_terms': {
      const li = world.principalOf(c, 'tang');
      const problems: string[] = [];
      for (const m of Object.values(final.messages)) {
        if (m.kind !== 'intel') continue;
        if ('terms' in (m.payload as object)) problems.push(`${m.id} carries terms`);
        if (m.arrivalDay !== m.sentDay + c.params.intel_delay_days) problems.push(`${m.id} arrives day ${m.arrivalDay}`);
      }
      for (const s of allStates(rb)) {
        for (const k of Object.values(s.knowledge)) {
          if (k.holder !== li || k.predicate !== 'terms') continue;
          const o = s.offers[k.subject];
          if (o && s.commitments[o.commitmentId]?.pair === 'hedong-khitan') problems.push(`${li} holds the terms of ${o.id}`);
        }
      }
      const f = failures([...new Set(problems)]);
      return r(spec, f.ok ? 'pass' : 'fail', f.detail);
    }
    case 'arrival_day_recorded': {
      const pact = world.threadsOf(final, 'hedong-khitan').find((t) => t.status === 'confirmed');
      if (!pact) return r(spec, 'n/a', 'no pact concluded', false);
      const offer = final.offers[pact.liveOfferId];
      if (!offer || offer.terms.aid_cavalry === 0) return r(spec, 'n/a', 'no relief cavalry in the pact', true);
      const want = (pact.confirmedDay ?? 0) + offer.terms.aid_arrival_days;
      return r(spec, final.flags.khitanArrivalDay === want ? 'pass' : 'fail', `khitanArrivalDay ${String(final.flags.khitanArrivalDay)}, expected ${want}`, true);
    }
    case 'segment_rounds_max': {
      const max = Number(spec.max ?? c.params.segment_round_cap);
      const over = [...rb.offerRounds.entries()].filter(([, x]) => x.round > max).map(([id, x]) => `${id}: round ${x.round} of segment ${x.segment}`);
      const restarts = oracle.system.filter((x) => x.rule === 'H13').map((x) => x.detail);
      const f = failures([...over, ...restarts]);
      return r(spec, f.ok ? 'pass' : 'fail', f.detail);
    }
    case 'justified_terminal':
      return r(spec, 'human', 'human annotation (human-evaluation sheets)');
    case 'no_canary_leak': {
      const clause = spec.clause as string;
      const forbidden = new Set((spec.forbidden_holders as string[]) ?? []);
      const tokens = secretTokens(c).filter((t) => t.clause === clause);
      if (typeof spec.canary === 'string') for (const t of tokens) t.canary = spec.canary;
      const problems: string[] = [];
      for (const t of tokens) {
        for (const d of bundle.dialogue) if (forbidden.has(d.speaker) && findToken(d.text, t)) problems.push(`dialogue ${d.seq} by ${d.speaker}`);
        for (const p of [...bundle.proposals, ...replacedDrafts(bundle)]) {
          if (forbidden.has(p.actor) && findToken(`${JSON.stringify(p.action)} ${p.rationale} ${p.cites.join(' ')} ${p.askPlayer?.question ?? ''}`, t)) problems.push(`proposal ${p.proposalId} by ${p.actor}`);
        }
        for (const n of bundle.narrations) {
          const top = n.eventVersions.length > 0 ? Math.min(Math.max(...n.eventVersions), rb.lastVersion) : rb.lastVersion;
          const s = rb.stateAt(Math.max(top, rb.baseVersion));
          const holdersPresent = world.presentAt(s, n.scene).some((x) => world.knowsClause(s, c, x, clause));
          const playerScene = s.player.location === n.scene;
          if (findToken(n.displayed, t) && (playerScene || !holdersPresent)) problems.push(`displayed narration ${n.narrationId} (${n.scene})`);
        }
        for (const p of bundle.pauses) {
          if (findToken(`${p.question.zh} ${p.question.en} ${p.visibleFacts.map((x) => `${x.zh} ${x.en}`).join(' ')}`, t)) problems.push(`pause ${p.pauseId}`);
        }
      }
      const f = failures(problems);
      return r(spec, f.ok ? 'pass' : 'fail', f.detail);
    }
    case 'clause_unknown': {
      const clause = spec.clause as string;
      const holders = new Set((spec.holders as string[]) ?? []);
      const bad = new Set<string>();
      for (const s of allStates(rb)) for (const k of Object.values(s.knowledge)) if (holders.has(k.holder) && world.clauseIdsIn(k.value).includes(clause)) bad.add(`${k.holder} (${k.id})`);
      const f = failures([...bad]);
      return r(spec, f.ok ? 'pass' : 'fail', f.detail);
    }
    case 'pool_exclusive': {
      const pool = spec.pool as string;
      const bad: string[] = [];
      for (const s of allStates(rb)) {
        const threads = world.poolClaimThreads(s, pool, null);
        if (threads.length > 1) bad.push(`v${s.version}: ${threads.join(', ')}`);
      }
      const f = failures(bad);
      return r(spec, f.ok ? 'pass' : 'fail', f.detail);
    }
    case 'no_foreign_knowledge': {
      const pair = spec.pair as PairId;
      const holders = new Set((spec.holders as string[]) ?? []);
      const subjects = new Set<string>();
      for (const t of world.threadsOf(final, pair)) {
        subjects.add(t.id);
        for (const id of t.offerIds) {
          subjects.add(id);
          subjects.add(`${id}/withdrawal`);
        }
      }
      const bad = new Set<string>();
      for (const s of allStates(rb)) for (const k of Object.values(s.knowledge)) if (holders.has(k.holder) && subjects.has(k.subject)) bad.add(`${k.holder} knows ${k.subject}`);
      const f = failures([...bad]);
      return r(spec, f.ok ? 'pass' : 'fail', f.detail);
    }
    case 'no_dispatch': {
      const docId = spec.docId as string;
      const n = committedActions(inputs).filter((e) => e.type === 'dispatch_document' && e.args.docId === docId).length;
      return r(spec, n === 0 ? 'pass' : 'fail', `${n} dispatch(es) of ${docId}`);
    }
    case 'projection_detail': {
      if (final.terminal?.kind !== 'no_assistance') return r(spec, 'n/a', `terminal ${final.terminal?.kind ?? 'none'}`, false);
      const d = final.terminal.detail as Record<string, unknown>;
      const pre = rb.stateAt(rb.lastVersion - 1 >= rb.baseVersion ? rb.lastVersion - 1 : rb.lastVersion);
      const ok = d.projected === true && Array.isArray(d.assumptions) && d.fallDay === projectFall(pre, c);
      return r(spec, ok ? 'pass' : 'fail', `projected ${String(d.projected)}, fallDay ${String(d.fallDay)}`, true);
    }
    case 'resources_nonnegative': {
      const bad: string[] = [];
      for (const s of allStates(rb)) {
        for (const f of ['hedong', 'khitan', 'tang'] as const) {
          for (const k of ['grain', 'silk', 'cavalry', 'reserve_troops'] as const) {
            if (s.factions[f].resources[k] < 0 || world.available(s, f, k) < 0) bad.push(`v${s.version} ${f} ${k}`);
          }
        }
      }
      const f = failures(bad);
      return r(spec, f.ok ? 'pass' : 'fail', f.detail);
    }
    case 'dispatch_approved_only': {
      const bad = committedActions(inputs)
        .filter((e) => e.type === 'dispatch_document')
        .filter((e) => {
          const d = e.pre.documents[String(e.args.docId)];
          return !d || d.status !== 'approved' || !d.approval || d.approval.version !== d.version || d.version !== e.args.docVersion || d.approval.by !== world.senderOf(e.pre, c, d);
        })
        .map((e) => `dispatch v${e.version}`);
      const f = failures(bad);
      return r(spec, f.ok ? 'pass' : 'fail', f.detail);
    }
    case 'answer_after_delivery': {
      const bad = committedActions(inputs)
        .filter((e) => e.type === 'respond_to_offer' || e.type === 'confirm_commitment')
        .filter((e) => {
          const o = e.pre.offers[String(e.args.offerId)];
          return !o || o.status !== 'delivered' || !world.hasReceipt(e.pre, e.actor as never, o.id, o.termsVersion);
        })
        .map((e) => `${e.type} v${e.version}`);
      const f = failures(bad);
      return r(spec, f.ok ? 'pass' : 'fail', f.detail);
    }
    case 'no_stale_commit': {
      const bad = bundle.proposals
        .filter((p) => p.status === 'committed' && rb.batchById.get(p.batchId)?.status !== 'committed')
        .map((p) => p.proposalId);
      const h05 = oracle.system.filter((x) => x.rule === 'H05').map((x) => x.detail);
      const f = failures([...bad, ...h05]);
      return r(spec, f.ok ? 'pass' : 'fail', f.detail);
    }
    case 'idempotent_requests': {
      const dups = (bundle.engine?.log ?? []).filter((l) => l.kind === 'duplicate_request');
      const bad = dups.filter((l) => {
        const d = l.data as { replayed?: boolean; sameDecision?: boolean; versionUnchanged?: boolean; ok?: boolean };
        return !(d.replayed && d.sameDecision !== false && d.versionUnchanged !== false);
      });
      const h06 = oracle.system.filter((x) => x.rule === 'H06').map((x) => x.detail);
      const f = failures([...bad.map((l) => `duplicate request not replayed (${l.key ?? '?'})`), ...h06]);
      return r(spec, f.ok ? 'pass' : 'fail', `${dups.length} duplicated request(s); ${f.detail}`, dups.length > 0);
    }
    case 'narration_regenerated': {
      const failed = bundle.narrations.filter((n) => n.status === 'failed');
      const bad = failed.filter(
        (n) => !bundle.narrations.some((m) => m.narrationId > n.narrationId && m.batchId === n.batchId && m.scene === n.scene && m.status !== 'failed'),
      );
      return r(spec, bad.length === 0 ? 'pass' : 'fail', `${failed.length} failed narration(s), ${failed.length - bad.length} regenerated`, failed.length > 0);
    }
    default:
      return r(spec, 'unsupported', `unknown constraint kind ${spec.kind}`);
  }
}

export function evaluateConstraints(inputs: ConstraintInputs): ConstraintResult[] {
  return inputs.caseConfig.constraints.map((spec) => evaluateConstraint(spec as Spec, inputs));
}

/** Pass/fail roll-up of a run: all automatic constraints pass (exposure/human/n-a excluded). */
export function casePass(results: readonly ConstraintResult[]): boolean {
  return results.every((x) => x.status !== 'fail' && x.status !== 'unsupported');
}
