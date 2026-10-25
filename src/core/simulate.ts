/**
 * Pure reference-trace runner (PLAN §12.4): replays a scripted per-round sequence of player inputs, character
 * proposals and decisions through the same core functions the harness uses (PREPARE → PLAYER → character batch
 * with the pause plan and decisions → ADVANCE → G06 outcome), without persistence or LLM calls. Used by tests
 * to check that each case's reference trace reaches its terminal within the round budget.
 *
 * Regenerating decisions (`amend`, deadlock `adjust_goal`/`urge_accept`/`urge_stop`) commit a `player` batch and
 * switch the round to the trace's next generation of proposals (`regenerations`), as in §7.
 */
import { executeBatch, type BatchDecision, type BatchProposal, type ExecuteOptions, type OutcomeStatus, type ProposalOutcome } from './execute.js';
import { planPauses, type PauseRequest } from './plan.js';
import { QUALIFYING_DEADLOCK_OPTIONS, optionsForPause } from './pauses.js';
import { resolvePlaceholders } from './script.js';
import { MUTINY_OUTBREAK, mutinyDue, runAdvance, runPrepare } from './system.js';
import type {
  ActorId,
  AuthorizationGrant,
  BatchKind,
  CoreConfig,
  DecisionOption,
  Mode,
  PauseCategory,
  RuleId,
  TermLimits,
  TerminalKind,
  TerminalState,
  WorldEvent,
  WorldState,
} from './types.js';

export interface TraceExpectation {
  status: OutcomeStatus;
  rule?: RuleId | null;
}

export interface TraceProposalSpec {
  ref?: string | null;
  actor: ActorId;
  action: unknown;
  ask_player?: { question: string } | null;
  expect?: TraceExpectation | null;
}

export interface TraceDecisionSpec {
  /** Proposal ref the decision answers (omit for the deadlock control pause). */
  ref?: string | null;
  category?: PauseCategory | null;
  choose: DecisionOption;
  advice?: string | null;
  authorization?: AuthorizationGrant | null;
  goal_limits?: TermLimits | null;
  amend?: { docId: string; baseDocVersion: number | '$current'; terms: unknown; note: string } | null;
}

export interface TraceGenerationSpec {
  proposals: TraceProposalSpec[];
  decisions: TraceDecisionSpec[];
}

export interface TraceRoundSpec {
  round: number;
  player: Array<{ action: unknown; expect?: TraceExpectation | null }>;
  proposals: TraceProposalSpec[];
  decisions: TraceDecisionSpec[];
  regenerations: TraceGenerationSpec[];
  mutiny: 'let_it_happen' | 'urge_payment' | null;
}

export interface TraceSpec {
  case: string;
  max_rounds: number;
  rounds: TraceRoundSpec[];
  expected: { terminal: TerminalKind | null; round: number | null };
}

export interface BatchLog {
  round: number;
  kind: BatchKind;
  generation: number;
  outcomes: ProposalOutcome[];
  pauses: PauseRequest[];
  decisions: BatchDecision[];
}

export interface SimulationResult {
  terminal: TerminalState | null;
  /** Round in which the run ended (terminal round, or max_rounds). */
  lastRound: number;
  state: WorldState;
  events: WorldEvent[];
  batches: BatchLog[];
  /** Differences between the trace's expectations and what happened (empty = trace is legal and matches). */
  mismatches: string[];
}

function toDecision(spec: TraceDecisionSpec, id: string, req: PauseRequest): BatchDecision {
  return {
    decisionId: id,
    category: req.category,
    option: spec.choose,
    proposalIds: req.proposalIds,
    pair: req.pair,
    authorization: spec.authorization ?? null,
    goalLimits: spec.goal_limits ?? null,
  };
}

function isRegenerating(req: PauseRequest, option: DecisionOption): boolean {
  return option === 'amend' || (req.category === 'negotiation_deadlock' && QUALIFYING_DEADLOCK_OPTIONS.includes(option));
}

export function simulateTrace(initial: WorldState, config: CoreConfig, trace: TraceSpec, mode: Mode): SimulationResult {
  const opts: ExecuteOptions = { config, mode };
  let state = initial;
  const events: WorldEvent[] = [];
  const batches: BatchLog[] = [];
  const mismatches: string[] = [];
  const maxRounds = trace.max_rounds;

  const check = (where: string, outcome: ProposalOutcome, expect: TraceExpectation | null | undefined): void => {
    const want = expect?.status ?? 'committed';
    if (outcome.status !== want) {
      mismatches.push(`${where}: expected ${want}, got ${outcome.status}${outcome.rule ? ` (${outcome.rule}: ${outcome.reason})` : outcome.reason ? ` (${outcome.reason})` : ''}`);
    } else if (expect?.rule && outcome.rule !== expect.rule) {
      mismatches.push(`${where}: expected rule ${expect.rule}, got ${outcome.rule ?? 'none'}`);
    }
  };
  const run = (kind: BatchKind, round: number, generation: number, proposals: BatchProposal[], decisions: BatchDecision[], pauses: PauseRequest[]) => {
    const result = executeBatch(state, { kind, proposals, decisions }, opts);
    state = result.state;
    events.push(...result.events);
    batches.push({ round, kind, generation, outcomes: result.outcomes, pauses, decisions });
    return result;
  };

  let lastRound = state.round;
  roundLoop: while (state.round <= maxRounds && !state.terminal) {
    const round = state.round;
    lastRound = round;
    const spec = trace.rounds.find((r) => r.round === round);

    const prep = runPrepare(state, config);
    state = prep.state;
    events.push(...prep.events);
    if (state.terminal) break;

    // PLAYER
    if (spec && spec.player.length > 0) {
      const proposals = spec.player.map((p, i) => ({ proposalId: `r${round}-player-${i + 1}`, actor: 'player' as const, seq: i + 1, action: p.action, askPlayer: null }));
      const result = run('player', round, 0, proposals, [], []);
      for (const o of result.outcomes) {
        const index = proposals.findIndex((p) => p.proposalId === o.proposalId);
        check(`round ${round} player input ${o.proposalId}`, o, spec.player[index]?.expect);
      }
      if (state.terminal) break;
    }

    // CHARACTER (with regenerations)
    const generations: { proposals: TraceProposalSpec[]; decisions: TraceDecisionSpec[] }[] = spec
      ? [{ proposals: spec.proposals, decisions: spec.decisions }, ...spec.regenerations]
      : [{ proposals: [], decisions: [] }];
    let generation = 0;
    generationLoop: while (generation < generations.length) {
      const gen = generations[generation] as TraceGenerationSpec;
      const refs = new Map<string, string>();
      const proposals: BatchProposal[] = gen.proposals.map((p, i) => {
        const proposalId = `r${round}-g${generation}-${i + 1}`;
        if (p.ref) refs.set(p.ref, proposalId);
        const seq = gen.proposals.slice(0, i).filter((q) => q.actor === p.actor).length + 1;
        return { proposalId, actor: p.actor, seq, action: p.action, askPlayer: p.ask_player ?? null };
      });
      const decisions: BatchDecision[] = [];
      const opened: PauseRequest[] = [];
      let plan = planPauses(state, { kind: 'character', proposals, decisions }, opts);
      for (let guard = 0; plan.required.length > 0 && guard <= proposals.length + 2; guard++) {
        for (const req of plan.required) {
          opened.push(req);
          const spec2 = gen.decisions.find((d) =>
            req.category === 'negotiation_deadlock'
              ? d.category === 'negotiation_deadlock'
              : d.ref !== undefined && d.ref !== null && req.proposalIds.includes(refs.get(d.ref) ?? '') && (!d.category || d.category === req.category),
          );
          if (!spec2 || spec2.choose === 'ask') {
            mismatches.push(`round ${round} generation ${generation}: no decision in the trace for ${req.category} pause on [${req.proposalIds.join(', ')}]`);
            batches.push({ round, kind: 'character', generation, outcomes: plan.outcomes, pauses: plan.required, decisions });
            break roundLoop;
          }
          const feasible = optionsForPause(
            state,
            config,
            req.category,
            req.pair,
            proposals.filter((p) => req.proposalIds.includes(p.proposalId)).map((p) => p.action),
          );
          if (!feasible.includes(spec2.choose)) {
            mismatches.push(
              `round ${round} generation ${generation}: decision "${spec2.choose}"${spec2.ref ? ` for ref ${spec2.ref}` : ''} is not a feasible option for the ${req.category} pause on [${req.proposalIds.join(', ')}] (feasible: ${feasible.join(', ')})`,
            );
            batches.push({ round, kind: 'character', generation, outcomes: plan.outcomes, pauses: plan.required, decisions });
            break roundLoop;
          }
          if (spec2.choose === 'amend' && !spec2.amend) {
            mismatches.push(`round ${round} generation ${generation}: decision "amend" needs an \`amend\` payload`);
            break roundLoop;
          }
          const decisionId = `r${round}-g${generation}-d${decisions.length + 1}`;
          if (isRegenerating(req, spec2.choose)) {
            // Regenerating decision: player batch with its world effects, then the next generation.
            let amendAction: unknown = null;
            if (spec2.choose === 'amend' && spec2.amend) {
              const resolved = resolvePlaceholders(state, { type: 'revise_document', args: spec2.amend });
              if (!resolved.ok) {
                mismatches.push(`round ${round} generation ${generation}: amend: ${resolved.reason}`);
                break roundLoop;
              }
              amendAction = resolved.action;
            }
            const playerProposals: BatchProposal[] =
              amendAction !== null
                ? [{ proposalId: `${decisionId}-amend`, actor: 'player', seq: 1, action: amendAction, askPlayer: null }]
                : [];
            const playerDecisions = spec2.choose === 'amend' ? [] : [toDecision(spec2, decisionId, req)];
            // The regenerating transition is atomic in the harness: a rejected amendment rolls it back entirely.
            const regen = executeBatch(state, { kind: 'player', proposals: playerProposals, decisions: playerDecisions }, opts);
            const amended = regen.outcomes[0];
            if (spec2.choose === 'amend' && (!amended || amended.status !== 'committed')) {
              mismatches.push(
                `round ${round} generation ${generation}: amend rejected (${amended?.rule ?? '-'}): ${amended?.reason ?? 'no outcome'}; the regenerating decision does not take effect`,
              );
              batches.push({ round, kind: 'character', generation, outcomes: plan.outcomes, pauses: [...opened], decisions: [...decisions] });
              break roundLoop;
            }
            batches.push({ round, kind: 'character', generation, outcomes: plan.outcomes, pauses: [...opened], decisions: [...decisions] });
            state = regen.state;
            events.push(...regen.events);
            batches.push({ round, kind: 'player', generation, outcomes: regen.outcomes, pauses: [], decisions: playerDecisions });
            generation += 1;
            if (generation >= generations.length) {
              mismatches.push(`round ${round}: regenerating decision ${spec2.choose} but the trace has no regeneration ${generation}`);
              break roundLoop;
            }
            continue generationLoop;
          }
          decisions.push(toDecision(spec2, decisionId, req));
        }
        plan = planPauses(state, { kind: 'character', proposals, decisions }, opts);
      }
      if (plan.required.length > 0) {
        mismatches.push(`round ${round}: pause plan did not stabilise`);
        break roundLoop;
      }
      const result = run('character', round, generation, proposals, decisions, opened);
      for (const o of result.outcomes) {
        const index = proposals.findIndex((p) => p.proposalId === o.proposalId);
        check(`round ${round} ${o.proposalId} (${o.actor})`, o, gen.proposals[index]?.expect);
      }
      break;
    }
    if (state.terminal) break;

    // ADVANCE
    const adv = runAdvance(state, config);
    state = adv.state;
    events.push(...adv.events);
    if (state.terminal) break;

    // G06 staged outcome
    if (mutinyDue(state, config)) {
      const proposalId = `r${round}-mutiny`;
      const choice = spec?.mutiny ?? 'let_it_happen';
      const decisions: BatchDecision[] =
        mode === 'baseline'
          ? []
          : [{ decisionId: `r${round}-mutiny-d`, category: 'mutiny', option: choice, proposalIds: [proposalId] }];
      run('system_outcome', round, 0, [{ proposalId, actor: 'system', seq: 1, action: MUTINY_OUTBREAK, askPlayer: null }], decisions, []);
    }
  }

  const terminal = state.terminal;
  const expected = trace.expected;
  if ((terminal?.kind ?? null) !== expected.terminal) {
    mismatches.push(`expected terminal ${expected.terminal ?? 'none'}, got ${terminal?.kind ?? 'none'}`);
  }
  if (expected.round !== null && terminal && terminal.round !== expected.round) {
    mismatches.push(`expected terminal in round ${expected.round}, got round ${terminal.round}`);
  }
  if (terminal && terminal.round > maxRounds + 1) mismatches.push(`terminal after the round budget (${terminal.round} > ${maxRounds})`);
  return { terminal, lastRound: terminal?.round ?? lastRound, state, events, batches, mismatches };
}
