/**
 * Hand-built audit bundles with hand-computed world states (no harness, no engine): siege transitions, a staged and
 * decided mutiny, and a fall. Values follow PLAN G01–G07 with the scenario defaults (5-day rounds, grain −5,
 * pressure +8, morale −5 if grain < 15 or pressure > 70, mutiny at grain ≤ 10 and morale ≤ 30, fall at grain ≤ 0 or
 * pressure ≥ 100).
 */
import { caseCoreConfig, caseInitialState } from '../../src/content/loader.js';
import type { PatchOp, WorldState } from '../../src/core/types.js';
import type { AuditBundle, BBatch, BEvent } from '../../src/eval/oracle/index.js';
import { content } from './helpers.js';

export interface SiegeStep {
  grain: number;
  pressure: number;
  morale: number;
}

function advanceOps(day: number, round: number, s: SiegeStep, version: number): PatchOp[] {
  return [
    { op: 'replace', path: '/day', value: day },
    { op: 'replace', path: '/round', value: round },
    { op: 'replace', path: '/factions/hedong/resources/grain', value: s.grain },
    { op: 'replace', path: '/siege/pressure', value: s.pressure },
    { op: 'replace', path: '/siege/morale', value: s.morale },
    { op: 'replace', path: '/version', value: version },
  ];
}

function event(version: number, batchId: string, kind: string, changes: PatchOp[], round: number, day: number, extra: Partial<BEvent> = {}): BEvent {
  return { version, batchId, round, day, kind, actor: 'system', proposalId: null, decisionId: null, changes, facts: [], rules: [], stateHash: '', inherited: false, ...extra };
}

function batch(batchId: string, kind: BBatch['kind'], round: number, baseVersion: number, controlSeq: number, commitSeq: number, committedVersion: number): BBatch {
  return { batchId, kind, round, epoch: 0, baseVersion, status: 'committed', generation: 0, controlSeq, commitSeq, committedVersion, narrationStatus: 'none', note: null };
}

export interface HandSpec {
  base: SiegeStep;
  /** Hand-computed post-ADVANCE numbers, one per round. */
  advances: SiegeStep[];
  /** Index (0-based) of the ADVANCE after which a mutiny is staged and decided; its outcome and effects. */
  mutiny?: { after: number; option: 'let_it_happen' | 'urge_payment'; outcome: SiegeStep | null } | null;
  /** Terminal after the last ADVANCE (hand-decided). */
  fall?: { cause: 'grain' | 'pressure' } | null;
}

/** Builds a C5-based bundle: base state with overridden siege numbers, then the given ADVANCE sequence. */
export function handBundle(spec: HandSpec): AuditBundle {
  const config = caseCoreConfig(content(), 'C5');
  const s0: WorldState = structuredClone(caseInitialState(content(), 'C5'));
  s0.factions.hedong.resources.grain = spec.base.grain;
  s0.siege.pressure = spec.base.pressure;
  s0.siege.morale = spec.base.morale;
  const events: BEvent[] = [];
  const batches: BBatch[] = [];
  const b: AuditBundle = {
    dir: null,
    session: { sessionId: 'hand', mode: 'no_judge', caseId: 'C5', status: 'finished', phase: 'finished', round: 1, epoch: 0, rngSeed: 1, contentHash: '', rulesHash: '', promptHash: '', config, baseVersion: 0, parentSessionId: null, runOutcome: null },
    snapshots: [{ version: 0, state: s0, stateHash: '' }],
    events,
    batches,
    proposals: [],
    epochs: [{ epoch: 0, reason: 'start', instructionId: null, controlSeq: 0 }],
    requests: [],
    pauses: [],
    decisions: [],
    dialogue: [],
    narrations: [],
    roundStarts: [],
    llmCalls: [],
    llmAttempts: [],
    revisions: [],
    engine: null,
  };
  let version = 0;
  let seq = 1;
  let day = 0;
  let round = 1;
  spec.advances.forEach((step, i) => {
    const id = `adv${i + 1}`;
    const base = version;
    version += 1;
    events.push(event(version, id, 'advance', advanceOps(day + 5, round + 1, step, version), round, day));
    day += 5;
    round += 1;
    const last = i === spec.advances.length - 1;
    let committed = version;
    if (last && spec.fall) {
      version += 1;
      events.push(event(version, id, 'terminal', [{ op: 'replace', path: '/terminal', value: { kind: 'jinyang_falls', day, round: round - 1, detail: { cause: spec.fall.cause, grain: step.grain, pressure: step.pressure } } }, { op: 'replace', path: '/version', value: version }], round, day));
      committed = version;
    }
    batches.push(batch(id, 'system_advance', round - 1, base, seq, seq + 1, committed));
    seq += 2;
    if (spec.mutiny && spec.mutiny.after === i) {
      const out = `out${i + 1}`;
      const pid = `${out}/p1`;
      const outcomeBase = version;
      const createdAt = seq;
      const pauseSeq = seq + 1;
      const decisionSeq = seq + 2;
      const commitSeq = seq + 3;
      seq += 4;
      b.proposals.push({ proposalId: pid, batchId: out, round, epoch: 0, baseVersion: version, actor: 'system', source: 'system', seq: 1, action: { type: 'mutiny_outbreak', args: {} }, rationale: '', cites: [], askPlayer: null, status: spec.mutiny.option === 'let_it_happen' ? 'committed' : 'withheld', rule: null, reason: null, feedback: null, code: null, category: 'mutiny', gate: null, authorizationId: null, decisionId: 'dm', eventVersions: [], controlSeq: createdAt, probe: false, intake: 'pending' });
      b.pauses.push({ pauseId: 'pm', batchId: out, round, epoch: 0, kind: 'mandatory', category: 'mutiny', proposalIds: [pid], pair: null, visibleFacts: [], question: { zh: '兵变？', en: 'Mutiny?' }, options: ['let_it_happen', 'urge_payment', 'ask'], status: 'resolved', decisionId: 'dm', controlSeq: pauseSeq });
      b.decisions.push({ decisionId: 'dm', pauseId: 'pm', batchId: out, category: 'mutiny', proposalIds: [pid], pair: null, option: spec.mutiny.option, advice: null, payload: {}, by: 'policy', requestId: 'req-dm', round, epoch: 0, controlSeq: decisionSeq });
      if (spec.mutiny.outcome) {
        version += 1;
        const o = spec.mutiny.outcome;
        events.push(event(version, out, 'mutiny_outbreak', [{ op: 'replace', path: '/siege/morale', value: o.morale }, { op: 'replace', path: '/siege/pressure', value: o.pressure }, { op: 'replace', path: '/flags/mutinyOccurred', value: true }, { op: 'replace', path: '/version', value: version }], round, day, { proposalId: pid }));
        (b.proposals.at(-1) as { eventVersions: number[] }).eventVersions = [version];
      } else {
        version += 1;
        events.push(event(version, out, 'mutiny_averted_for_now', [{ op: 'replace', path: '/version', value: version }], round, day, { proposalId: pid, decisionId: 'dm', actor: 'player' }));
        (b.proposals.at(-1) as { eventVersions: number[] }).eventVersions = [version];
      }
      batches.push(batch(out, 'system_outcome', round, outcomeBase, createdAt, commitSeq, version));
    }
  });
  return b;
}
