/**
 * World terminals (PLAN §6, G12). Evaluated at the end of PREPARE, after each committed action/decision effect,
 * after ADVANCE and after a staged outcome. Precedence: jinyang_falls > pact_concluded > no_assistance >
 * talks_failed; the first satisfied condition wins and the world is frozen.
 *
 * Shi's evidence is read from his assertions: a thread he believes `confirmed` (own confirm or delivered
 * acceptance) or `rejected`/`withdrawn` (delivered rejection, delivered effective withdrawal_result, a delivered
 * withdrawal by the counterparty, or his own rejection — directly or inside abandon_request — as `own_action`).
 */
import { believedThreadStatus } from './knowledge.js';
import { commitmentsOfPair, negotiationStatus } from './negotiation.js';
import { projectSiege, projectionDetail } from './projection.js';
import { Draft } from './reducer.js';
import { siegeFallCause, siegeNumbers } from './siege.js';
import {
  ASSISTANCE_PAIR,
  BESIEGED_FACTION,
  type CharId,
  type Commitment,
  type CoreConfig,
  type EffectDraft,
  type JsonValue,
  type TerminalKind,
  type WorldState,
} from './types.js';

export type TerminalPhase = 'prepare' | 'action' | 'advance' | 'outcome';

export interface TerminalCandidate {
  kind: TerminalKind;
  detail: Record<string, JsonValue>;
}

export function besiegedPrincipal(config: CoreConfig): CharId {
  return config.factions[BESIEGED_FACTION].principal;
}

export function hasClosureEvidence(state: WorldState, config: CoreConfig, thread: Commitment): boolean {
  const belief = believedThreadStatus(state, besiegedPrincipal(config), thread.id);
  return belief === 'rejected' || belief === 'withdrawn';
}

export function evaluateTerminal(state: WorldState, config: CoreConfig, phase: TerminalPhase): TerminalCandidate | null {
  if (state.terminal !== null) return null;
  const p = config.params;
  const shi = besiegedPrincipal(config);

  // 1. jinyang_falls (G07)
  const n = siegeNumbers(state);
  const cause = siegeFallCause(n, p);
  if (cause) return { kind: 'jinyang_falls', detail: { cause, grain: n.grain, pressure: n.pressure } };

  const threads = commitmentsOfPair(state, ASSISTANCE_PAIR);

  // 2. pact_concluded: confirmed thread + Shi's evidence of it
  const pact = threads.find((t) => t.status === 'confirmed' && believedThreadStatus(state, shi, t.id) === 'confirmed');
  if (pact) {
    return {
      kind: 'pact_concluded',
      detail: {
        commitmentId: pact.id,
        termsVersion: pact.termsVersion,
        confirmedDay: pact.confirmedDay,
        khitanArrivalDay: state.flags.khitanArrivalDay,
      },
    };
  }

  const open = threads.some((t) => t.status === 'negotiating' || t.status === 'confirmed');

  // Interactive chapters have a diplomatic deadline, independent of grain/pressure thresholds. A pact
  // already known to Shi wins above; an unfinished draft or an offer still in transit does not secure relief.
  if (config.chapterDeadlineRound !== undefined && state.round > config.chapterDeadlineRound) {
    return {
      kind: 'jinyang_falls',
      detail: {
        cause: 'missed_opportunity',
        escalation: 'full_war',
        besieger: 'tang',
        deadlineRound: config.chapterDeadlineRound,
        grain: n.grain,
        pressure: n.pressure,
      },
    };
  }

  // 3. no_assistance: abandoned, nothing open, closure evidence for every thread (or nothing was ever sent)
  if (state.flags.assistanceAbandoned && !open && threads.every((t) => hasClosureEvidence(state, config, t))) {
    return { kind: 'no_assistance', detail: { threads: threads.length, ...projectionDetail(projectSiege(state, config)) } };
  }

  // 4. talks_failed: not abandoned, ≥1 thread, all closed, evidence of the latest closure, and either the global
  //    cap is reached or this is the ADVANCE of a round in which no new hedong offer was sent (a new offer would
  //    have opened a negotiating thread).
  if (!state.flags.assistanceAbandoned && threads.length > 0 && !open) {
    const latest = threads[threads.length - 1] as Commitment;
    const capReached = negotiationStatus(state, config, ASSISTANCE_PAIR).globalCapReached;
    if (hasClosureEvidence(state, config, latest) && (capReached || phase === 'advance')) {
      return {
        kind: 'talks_failed',
        detail: { threads: threads.length, latestCommitmentId: latest.id, capReached },
      };
    }
  }
  return null;
}

const TERMINAL_RULES: Record<TerminalKind, string[]> = {
  jinyang_falls: ['G07', 'G12'],
  pact_concluded: ['G12'],
  no_assistance: ['G11', 'G12'],
  talks_failed: ['G10', 'G12'],
};

/**
 * Round a terminal belongs to: the current round, except after ADVANCE (and the staged outcome that follows it),
 * where the world has already moved to the next round's day — the terminal then belongs to the round that ended.
 */
export function terminalRound(state: WorldState, phase: TerminalPhase): number {
  return phase === 'advance' || phase === 'outcome' ? state.round - 1 : state.round;
}

/** The terminal event for the current state, if a terminal condition now holds. */
export function terminalEffect(state: WorldState, config: CoreConfig, phase: TerminalPhase): EffectDraft | null {
  const candidate = evaluateTerminal(state, config, phase);
  if (!candidate) return null;
  const d = new Draft(state);
  d.set(['terminal'], { kind: candidate.kind, day: state.day, round: terminalRound(state, phase), detail: candidate.detail });
  d.fact({
    scene: state.characters[besiegedPrincipal(config)].location,
    kind: 'terminal',
    actor: null,
    audience: [],
    data: { terminal: candidate.kind, phase, ...candidate.detail },
  });
  d.rule(...TERMINAL_RULES[candidate.kind]);
  return d.build('terminal', 'system');
}
