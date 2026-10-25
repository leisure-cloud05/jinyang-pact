/**
 * Typed access to the store's tables. JSON columns are written as canonical JSON. The repository does no
 * transaction management of its own: callers wrap multi-row writes in `Store.transaction`.
 */
import type { StatementSync } from 'node:sqlite';
import { canonicalJson, hashState, hashValue } from '../core/hash.js';
import { redactSecrets } from '../llm/redact.js';
import type {
  ActorId,
  BatchKind,
  BatchStatus,
  CoreConfig,
  Decision,
  GateKind,
  Mode,
  PauseCategory,
  Proposal,
  Pause,
  RuleId,
  WorldEvent,
  WorldState,
} from '../core/types.js';
import type { Store } from './db.js';

export type SessionStatus =
  | 'ready'
  | 'generating'
  | 'assessing'
  | 'awaiting_decision'
  | 'committing'
  | 'narrating'
  | 'suspended'
  | 'finished'
  | 'stopped';

export type SessionPhase =
  | 'prepare'
  | 'player'
  | 'select'
  | 'generate'
  | 'assess'
  | 'decide'
  | 'commit'
  | 'narrate'
  | 'advance'
  | 'outcome'
  | 'finished';

export interface SessionRecord {
  sessionId: string;
  mode: Mode;
  caseId: string | null;
  status: SessionStatus;
  suspendedFrom: SessionStatus | null;
  phase: SessionPhase;
  round: number;
  epoch: number;
  rngSeed: number;
  contentHash: string;
  rulesHash: string;
  promptHash: string;
  config: CoreConfig;
  /** Version of the session's first snapshot (0, or the parent version for a branch). */
  baseVersion: number;
  parentSessionId: string | null;
  parentRound: number | null;
  parentVersion: number | null;
  runOutcome: string | null;
  controlSeq: number;
  dialogueSeq: number;
  createdAt: string;
}

export type NarrationStatus = 'none' | 'pending' | 'done' | 'failed';

export interface BatchRecord {
  batchId: string;
  sessionId: string;
  kind: BatchKind;
  round: number;
  epoch: number;
  baseVersion: number;
  status: BatchStatus;
  generation: number;
  controlSeq: number;
  commitSeq: number | null;
  committedVersion: number | null;
  narrationStatus: NarrationStatus;
  note: string | null;
}

export interface ProposalRecord extends Proposal {
  code: string | null;
  category: PauseCategory | null;
  gate: GateKind | null;
  authorizationId: string | null;
  decisionId: string | null;
  eventVersions: number[];
  controlSeq: number;
  /** Scripted enforcement probe (§12.4): scored separately from model behaviour. */
  probe?: boolean;
  /** Immutable intake class set when the proposal was stored (never updated). */
  intake?: 'pending' | 'format_error' | 'stale_epoch';
  /** Hash of the action as stored at intake (detects later edits of `action_json`). */
  intakeHash?: string;
}

/** Saved context of a control/user pause: what to restore on resume/retry, and whose call failed. */
export interface PauseMeta {
  continuation?: { status: SessionStatus; phase: SessionPhase } | null;
  actor?: string | null;
}

export interface PauseRecord extends Pause {
  controlSeq: number;
  meta?: PauseMeta;
}

export interface DecisionRecord extends Decision {
  controlSeq: number;
}

export interface EventRecord extends WorldEvent {
  sessionId: string;
  batchId: string | null;
  stateHash: string;
  inherited: boolean;
}

export type DialogueKind = 'speech' | 'advice' | 'question' | 'answer';

export interface DialogueRecord {
  sessionId: string;
  seq: number;
  round: number;
  epoch: number;
  worldVersion: number;
  speaker: ActorId;
  listeners: ActorId[];
  text: string;
  kind: DialogueKind;
  proposalId: string | null;
  decisionId: string | null;
  /** Structured content of advice (e.g. counter_draft terms), else null. */
  payload?: unknown;
  inherited?: boolean;
  /**
   * The session's control sequence when the row was written (the last control record before it); null for rows
   * written before schema v4. Orders dialogue among pauses, decisions, commits and narrations in transcripts.
   * Set by `insertDialogue`; a copied row (branch inheritance) keeps its original value.
   */
  controlAt?: number | null;
}

export interface NarrationRecord {
  narrationId: number;
  sessionId: string;
  batchId: string | null;
  scene: string;
  eventVersions: number[];
  attempt: number;
  status: 'ok' | 'fallback' | 'failed';
  raw: string | null;
  header: string;
  displayed: string;
  check: unknown;
  controlSeq: number;
}

export interface RequestRecord {
  sessionId: string;
  requestId: string;
  op: string;
  payloadHash: string;
  result: unknown;
  controlSeq: number;
}

export interface RoundStartRecord {
  sessionId: string;
  round: number;
  version: number;
  dialogueSeqCutoff: number;
  controlSeqCutoff: number;
}

export interface EpochRecord {
  sessionId: string;
  epoch: number;
  reason: string;
  instructionId: string | null;
  startedAt: string;
  controlSeq: number;
}

export interface InstructionRecord {
  sessionId: string;
  instructionId: string;
  text: string;
  status: 'queued' | 'applied';
  /** True when the instruction interrupted an open character batch. */
  interrupted: boolean;
  epoch: number;
  controlSeq: number;
  appliedRound: number | null;
}

type Row = Record<string, unknown>;

const json = (value: unknown): string => canonicalJson(value);
/** Credential redaction (src/llm) applied to every free-text/log column before it is persisted (PLAN §0/§1). */
const red = (text: string): string => redactSecrets(text);
const redJson = (value: unknown): string => red(json(value));
const redOpt = (text: string | null | undefined): string | null => (text === null || text === undefined ? null : red(text));
const parse = <T>(text: unknown): T => JSON.parse(String(text)) as T;
const str = (v: unknown): string => String(v);
const num = (v: unknown): number => Number(v);
const optStr = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const optNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export class RepoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoError';
  }
}

export class Repo {
  readonly store: Store;
  private readonly cache = new Map<string, StatementSync>();

  constructor(store: Store) {
    this.store = store;
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.store.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  private run(sql: string, ...params: Array<string | number | null | Record<string, string | number | null>>): void {
    this.stmt(sql).run(...(params as never[]));
  }

  private get(sql: string, ...params: Array<string | number | null>): Row | undefined {
    return this.stmt(sql).get(...params) as Row | undefined;
  }

  private all(sql: string, ...params: Array<string | number | null>): Row[] {
    return this.stmt(sql).all(...params) as Row[];
  }

  // ------------------------------------------------------------------------------------------------------------
  // Sessions and sequences
  // ------------------------------------------------------------------------------------------------------------

  insertSession(s: SessionRecord): void {
    this.run(
      `INSERT INTO sessions (session_id, mode, case_id, status, suspended_from, phase, round, epoch, rng_seed, content_hash,
        rules_hash, prompt_hash, config_json, base_version, parent_session_id, parent_round, parent_version, run_outcome,
        control_seq, dialogue_seq, created_at)
       VALUES ($sessionId, $mode, $caseId, $status, $suspendedFrom, $phase, $round, $epoch, $rngSeed, $contentHash,
        $rulesHash, $promptHash, $config, $baseVersion, $parentSessionId, $parentRound, $parentVersion, $runOutcome,
        $controlSeq, $dialogueSeq, $createdAt)`,
      {
        sessionId: s.sessionId,
        mode: s.mode,
        caseId: redOpt(s.caseId),
        status: s.status,
        suspendedFrom: s.suspendedFrom,
        phase: s.phase,
        round: s.round,
        epoch: s.epoch,
        rngSeed: s.rngSeed,
        contentHash: s.contentHash,
        rulesHash: s.rulesHash,
        promptHash: s.promptHash,
        config: redJson(s.config),
        baseVersion: s.baseVersion,
        parentSessionId: s.parentSessionId,
        parentRound: s.parentRound,
        parentVersion: s.parentVersion,
        runOutcome: s.runOutcome,
        controlSeq: s.controlSeq,
        dialogueSeq: s.dialogueSeq,
        createdAt: s.createdAt,
      },
    );
  }

  findSession(sessionId: string): SessionRecord | null {
    const r = this.get('SELECT * FROM sessions WHERE session_id = ?', sessionId);
    if (!r) return null;
    return {
      sessionId: str(r.session_id),
      mode: str(r.mode) as Mode,
      caseId: optStr(r.case_id),
      status: str(r.status) as SessionStatus,
      suspendedFrom: optStr(r.suspended_from) as SessionStatus | null,
      phase: str(r.phase) as SessionPhase,
      round: num(r.round),
      epoch: num(r.epoch),
      rngSeed: num(r.rng_seed),
      contentHash: str(r.content_hash),
      rulesHash: str(r.rules_hash),
      promptHash: str(r.prompt_hash),
      config: parse<CoreConfig>(r.config_json),
      baseVersion: num(r.base_version),
      parentSessionId: optStr(r.parent_session_id),
      parentRound: optNum(r.parent_round),
      parentVersion: optNum(r.parent_version),
      runOutcome: optStr(r.run_outcome),
      controlSeq: num(r.control_seq),
      dialogueSeq: num(r.dialogue_seq),
      createdAt: str(r.created_at),
    };
  }

  getSession(sessionId: string): SessionRecord {
    const s = this.findSession(sessionId);
    if (!s) throw new RepoError(`unknown session ${sessionId}`);
    return s;
  }

  listSessions(): string[] {
    return this.all('SELECT session_id FROM sessions ORDER BY created_at, session_id').map((r) => str(r.session_id));
  }

  updateSession(
    sessionId: string,
    patch: Partial<Pick<SessionRecord, 'status' | 'suspendedFrom' | 'phase' | 'round' | 'epoch' | 'runOutcome'>>,
  ): void {
    const cols: Record<string, string> = {
      status: 'status',
      suspendedFrom: 'suspended_from',
      phase: 'phase',
      round: 'round',
      epoch: 'epoch',
      runOutcome: 'run_outcome',
    };
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const sql = `UPDATE sessions SET ${entries.map(([k]) => `${cols[k]} = $${k}`).join(', ')} WHERE session_id = $sessionId`;
    this.stmt(sql).run({ ...Object.fromEntries(entries), sessionId } as never);
  }

  /** Next control sequence number of the session (orders all control records). */
  nextControlSeq(sessionId: string): number {
    this.run('UPDATE sessions SET control_seq = control_seq + 1 WHERE session_id = ?', sessionId);
    return num(this.get('SELECT control_seq FROM sessions WHERE session_id = ?', sessionId)?.control_seq);
  }

  nextDialogueSeq(sessionId: string): number {
    this.run('UPDATE sessions SET dialogue_seq = dialogue_seq + 1 WHERE session_id = ?', sessionId);
    return num(this.get('SELECT dialogue_seq FROM sessions WHERE session_id = ?', sessionId)?.dialogue_seq);
  }

  // ------------------------------------------------------------------------------------------------------------
  // World state: snapshots and events
  // ------------------------------------------------------------------------------------------------------------

  putSnapshot(sessionId: string, state: WorldState): string {
    const hash = hashState(state);
    this.run(
      'INSERT OR REPLACE INTO snapshots (session_id, version, state_json, state_hash) VALUES (?, ?, ?, ?)',
      sessionId,
      state.version,
      json(state),
      hash,
    );
    return hash;
  }

  getSnapshot(sessionId: string, version: number): { state: WorldState; hash: string } | null {
    const r = this.get('SELECT state_json, state_hash FROM snapshots WHERE session_id = ? AND version = ?', sessionId, version);
    return r ? { state: parse<WorldState>(r.state_json), hash: str(r.state_hash) } : null;
  }

  latestSnapshot(sessionId: string): { state: WorldState; hash: string } {
    const r = this.get(
      'SELECT state_json, state_hash FROM snapshots WHERE session_id = ? ORDER BY version DESC LIMIT 1',
      sessionId,
    );
    if (!r) throw new RepoError(`session ${sessionId} has no snapshot`);
    return { state: parse<WorldState>(r.state_json), hash: str(r.state_hash) };
  }

  listSnapshotVersions(sessionId: string): number[] {
    return this.all('SELECT version FROM snapshots WHERE session_id = ? ORDER BY version', sessionId).map((r) => num(r.version));
  }

  insertEvent(sessionId: string, batchId: string | null, event: WorldEvent, stateHash: string, inherited = false): void {
    this.run(
      `INSERT INTO events (session_id, version, batch_id, round, day, kind, actor, proposal_id, decision_id, changes_json,
        facts_json, rules_json, state_hash, inherited) VALUES ($sessionId, $version, $batchId, $round, $day, $kind, $actor,
        $proposalId, $decisionId, $changes, $facts, $rules, $stateHash, $inherited)`,
      {
        sessionId,
        version: event.version,
        batchId,
        round: event.round,
        day: event.day,
        kind: event.kind,
        actor: event.actor,
        proposalId: event.proposalId,
        decisionId: event.decisionId,
        changes: json(event.changes),
        facts: json(event.facts),
        rules: json(event.rulesApplied),
        stateHash,
        inherited: inherited ? 1 : 0,
      },
    );
  }

  private eventFromRow(r: Row): EventRecord {
    return {
      sessionId: str(r.session_id),
      version: num(r.version),
      batchId: optStr(r.batch_id),
      round: num(r.round),
      day: num(r.day),
      kind: str(r.kind) as WorldEvent['kind'],
      actor: str(r.actor) as ActorId,
      proposalId: optStr(r.proposal_id),
      decisionId: optStr(r.decision_id),
      changes: parse(r.changes_json),
      facts: parse(r.facts_json),
      rulesApplied: parse(r.rules_json),
      stateHash: str(r.state_hash),
      inherited: num(r.inherited) === 1,
    };
  }

  listEvents(sessionId: string, opts: { fromVersion?: number; toVersion?: number; includeInherited?: boolean } = {}): EventRecord[] {
    const rows = this.all(
      `SELECT * FROM events WHERE session_id = ? AND version >= ? AND version <= ? ${opts.includeInherited === false ? 'AND inherited = 0' : ''} ORDER BY version`,
      sessionId,
      opts.fromVersion ?? 0,
      opts.toVersion ?? Number.MAX_SAFE_INTEGER,
    );
    return rows.map((r) => this.eventFromRow(r));
  }

  /** Events a batch committed in this session (a branch child's inherited copies are excluded). */
  listBatchEvents(sessionId: string, batchId: string): EventRecord[] {
    return this.all('SELECT * FROM events WHERE session_id = ? AND batch_id = ? AND inherited = 0 ORDER BY version', sessionId, batchId).map((r) =>
      this.eventFromRow(r),
    );
  }

  // ------------------------------------------------------------------------------------------------------------
  // Batches and proposals
  // ------------------------------------------------------------------------------------------------------------

  insertBatch(b: BatchRecord): void {
    this.run(
      `INSERT INTO batches (batch_id, session_id, kind, round, epoch, base_version, status, generation, control_seq, commit_seq,
        committed_version, narration_status, note) VALUES ($batchId, $sessionId, $kind, $round, $epoch, $baseVersion, $status,
        $generation, $controlSeq, $commitSeq, $committedVersion, $narrationStatus, $note)`,
      { ...b } as never,
    );
  }

  private batchFromRow(r: Row): BatchRecord {
    return {
      batchId: str(r.batch_id),
      sessionId: str(r.session_id),
      kind: str(r.kind) as BatchKind,
      round: num(r.round),
      epoch: num(r.epoch),
      baseVersion: num(r.base_version),
      status: str(r.status) as BatchStatus,
      generation: num(r.generation),
      controlSeq: num(r.control_seq),
      commitSeq: optNum(r.commit_seq),
      committedVersion: optNum(r.committed_version),
      narrationStatus: str(r.narration_status) as NarrationStatus,
      note: optStr(r.note),
    };
  }

  findBatch(batchId: string): BatchRecord | null {
    const r = this.get('SELECT * FROM batches WHERE batch_id = ?', batchId);
    return r ? this.batchFromRow(r) : null;
  }

  getBatch(batchId: string): BatchRecord {
    const b = this.findBatch(batchId);
    if (!b) throw new RepoError(`unknown batch ${batchId}`);
    return b;
  }

  updateBatch(
    batchId: string,
    patch: Partial<Pick<BatchRecord, 'status' | 'commitSeq' | 'committedVersion' | 'narrationStatus' | 'note'>>,
  ): void {
    const cols: Record<string, string> = {
      status: 'status',
      commitSeq: 'commit_seq',
      committedVersion: 'committed_version',
      narrationStatus: 'narration_status',
      note: 'note',
    };
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const sql = `UPDATE batches SET ${entries.map(([k]) => `${cols[k]} = $${k}`).join(', ')} WHERE batch_id = $batchId`;
    this.stmt(sql).run({ ...Object.fromEntries(entries), batchId } as never);
  }

  listBatches(sessionId: string): BatchRecord[] {
    return this.all('SELECT * FROM batches WHERE session_id = ? ORDER BY control_seq', sessionId).map((r) => this.batchFromRow(r));
  }

  /** Batches that are neither committed nor stale/obsolete. */
  openBatches(sessionId: string): BatchRecord[] {
    return this.listBatches(sessionId).filter((b) => b.status === 'generating' || b.status === 'assessed' || b.status === 'paused');
  }

  committedBatches(sessionId: string): BatchRecord[] {
    return this.all(
      `SELECT * FROM batches WHERE session_id = ? AND status = 'committed' ORDER BY commit_seq`,
      sessionId,
    ).map((r) => this.batchFromRow(r));
  }

  insertProposal(p: ProposalRecord): void {
    this.run(
      `INSERT INTO proposals (proposal_id, session_id, batch_id, round, epoch, base_version, actor, source, seq, action_json,
        rationale, cites_json, ask_player_json, status, rule, reason, feedback, code, category, gate, authorization_id,
        decision_id, event_versions_json, control_seq, probe, intake, intake_hash) VALUES ($proposalId, $sessionId, $batchId,
        $round, $epoch, $baseVersion, $actor, $source, $seq, $action, $rationale, $cites, $askPlayer, $status, $rule, $reason,
        $feedback, $code, $category, $gate, $authorizationId, $decisionId, $eventVersions, $controlSeq, $probe, $intake, $intakeHash)`,
      {
        proposalId: p.proposalId,
        sessionId: p.sessionId,
        batchId: p.batchId,
        round: p.round,
        epoch: p.epoch,
        baseVersion: p.baseVersion,
        actor: p.actor,
        source: p.source,
        seq: p.seq,
        action: red(JSON.stringify(p.action === undefined ? null : p.action)),
        rationale: red(p.rationale),
        cites: redJson(p.cites),
        askPlayer: p.askPlayer ? redJson(p.askPlayer) : null,
        status: p.status,
        rule: p.rule,
        reason: redOpt(p.reason),
        feedback: redOpt(p.feedback),
        code: p.code,
        category: p.category,
        gate: p.gate,
        authorizationId: p.authorizationId,
        decisionId: p.decisionId,
        eventVersions: json(p.eventVersions),
        controlSeq: p.controlSeq,
        probe: p.probe ? 1 : 0,
        intake: p.intake ?? (p.status === 'format_error' || p.status === 'stale_epoch' ? p.status : 'pending'),
        intakeHash: p.intakeHash ?? hashValue(JSON.parse(red(JSON.stringify(p.action === undefined ? null : p.action))) as unknown),
      },
    );
  }

  private proposalFromRow(r: Row): ProposalRecord {
    return {
      proposalId: str(r.proposal_id),
      sessionId: str(r.session_id),
      batchId: str(r.batch_id),
      round: num(r.round),
      epoch: num(r.epoch),
      baseVersion: num(r.base_version),
      actor: str(r.actor) as ActorId,
      source: str(r.source) as Proposal['source'],
      seq: num(r.seq),
      action: parse(r.action_json),
      rationale: str(r.rationale),
      cites: parse(r.cites_json),
      askPlayer: r.ask_player_json === null ? null : parse(r.ask_player_json),
      status: str(r.status) as Proposal['status'],
      rule: optStr(r.rule) as RuleId | null,
      reason: optStr(r.reason),
      feedback: optStr(r.feedback),
      code: optStr(r.code),
      category: optStr(r.category) as PauseCategory | null,
      gate: optStr(r.gate) as GateKind | null,
      authorizationId: optStr(r.authorization_id),
      decisionId: optStr(r.decision_id),
      eventVersions: parse(r.event_versions_json),
      controlSeq: num(r.control_seq),
      probe: num(r.probe) === 1,
      intake: str(r.intake) as ProposalRecord['intake'],
      intakeHash: str(r.intake_hash),
    };
  }

  listProposals(batchId: string): ProposalRecord[] {
    return this.all('SELECT * FROM proposals WHERE batch_id = ? ORDER BY control_seq', batchId).map((r) => this.proposalFromRow(r));
  }

  listSessionProposals(sessionId: string): ProposalRecord[] {
    return this.all('SELECT * FROM proposals WHERE session_id = ? ORDER BY control_seq', sessionId).map((r) => this.proposalFromRow(r));
  }

  updateProposal(
    proposalId: string,
    patch: Partial<
      Pick<ProposalRecord, 'status' | 'rule' | 'reason' | 'feedback' | 'code' | 'category' | 'gate' | 'authorizationId' | 'decisionId' | 'eventVersions'>
    >,
  ): void {
    const cols: Record<string, string> = {
      status: 'status',
      rule: 'rule',
      reason: 'reason',
      feedback: 'feedback',
      code: 'code',
      category: 'category',
      gate: 'gate',
      authorizationId: 'authorization_id',
      decisionId: 'decision_id',
      eventVersions: 'event_versions_json',
    };
    const entries = Object.entries(patch)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, k === 'eventVersions' ? json(v) : (k === 'reason' || k === 'feedback') && typeof v === 'string' ? red(v) : v] as const);
    if (entries.length === 0) return;
    const sql = `UPDATE proposals SET ${entries.map(([k]) => `${cols[k]} = $${k}`).join(', ')} WHERE proposal_id = $proposalId`;
    this.stmt(sql).run({ ...Object.fromEntries(entries), proposalId } as never);
  }

  // ------------------------------------------------------------------------------------------------------------
  // Pauses and decisions
  // ------------------------------------------------------------------------------------------------------------

  insertPause(p: PauseRecord): void {
    this.run(
      `INSERT INTO pauses (pause_id, session_id, batch_id, round, epoch, kind, category, proposal_ids_json, pair,
        visible_facts_json, question_json, options_json, status, decision_id, control_seq, meta_json) VALUES ($id, $sessionId,
        $batchId, $round, $epoch, $kind, $category, $proposalIds, $pair, $visibleFacts, $question, $options, $status, $decisionId,
        $controlSeq, $meta)`,
      {
        id: p.id,
        sessionId: p.sessionId,
        batchId: p.batchId,
        round: p.round,
        epoch: p.epoch,
        kind: p.kind,
        category: p.category,
        proposalIds: json(p.proposalIds),
        pair: p.pair,
        visibleFacts: redJson(p.visibleFacts),
        question: redJson(p.question),
        options: json(p.options),
        status: p.status,
        decisionId: p.decisionId,
        controlSeq: p.controlSeq,
        meta: json(p.meta ?? {}),
      },
    );
  }

  private pauseFromRow(r: Row): PauseRecord {
    return {
      id: str(r.pause_id),
      sessionId: str(r.session_id),
      batchId: optStr(r.batch_id),
      round: num(r.round),
      epoch: num(r.epoch),
      kind: str(r.kind) as Pause['kind'],
      category: str(r.category) as PauseCategory,
      proposalIds: parse(r.proposal_ids_json),
      pair: optStr(r.pair) as Pause['pair'],
      visibleFacts: parse(r.visible_facts_json),
      question: parse(r.question_json),
      options: parse(r.options_json),
      status: str(r.status) as Pause['status'],
      decisionId: optStr(r.decision_id),
      controlSeq: num(r.control_seq),
      meta: parse<PauseMeta>(r.meta_json),
    };
  }

  findPause(pauseId: string): PauseRecord | null {
    const r = this.get('SELECT * FROM pauses WHERE pause_id = ?', pauseId);
    return r ? this.pauseFromRow(r) : null;
  }

  listPauses(sessionId: string, filter: { batchId?: string; status?: Pause['status'] } = {}): PauseRecord[] {
    return this.all('SELECT * FROM pauses WHERE session_id = ? ORDER BY control_seq', sessionId)
      .map((r) => this.pauseFromRow(r))
      .filter((p) => (filter.batchId === undefined || p.batchId === filter.batchId) && (filter.status === undefined || p.status === filter.status));
  }

  updatePause(pauseId: string, patch: { status?: Pause['status']; decisionId?: string | null }): void {
    if (patch.status !== undefined) this.run('UPDATE pauses SET status = ? WHERE pause_id = ?', patch.status, pauseId);
    if (patch.decisionId !== undefined) this.run('UPDATE pauses SET decision_id = ? WHERE pause_id = ?', patch.decisionId, pauseId);
  }

  insertDecision(d: DecisionRecord): void {
    this.run(
      `INSERT INTO decisions (decision_id, session_id, pause_id, batch_id, category, proposal_ids_json, pair, option, advice,
        payload_json, by, request_id, round, epoch, control_seq) VALUES ($decisionId, $sessionId, $pauseId, $batchId, $category,
        $proposalIds, $pair, $option, $advice, $payload, $by, $requestId, $round, $epoch, $controlSeq)`,
      {
        decisionId: d.decisionId,
        sessionId: d.sessionId,
        pauseId: d.pauseId,
        batchId: d.batchId,
        category: d.category,
        proposalIds: json(d.proposalIds),
        pair: d.pair,
        option: d.option,
        advice: redOpt(d.advice),
        payload: redJson(d.payload),
        by: d.by,
        requestId: d.requestId,
        round: d.round,
        epoch: d.epoch,
        controlSeq: d.controlSeq,
      },
    );
  }

  private decisionFromRow(r: Row): DecisionRecord {
    return {
      decisionId: str(r.decision_id),
      sessionId: str(r.session_id),
      pauseId: optStr(r.pause_id),
      batchId: str(r.batch_id),
      category: str(r.category) as PauseCategory,
      proposalIds: parse(r.proposal_ids_json),
      pair: optStr(r.pair) as Decision['pair'],
      option: str(r.option) as Decision['option'],
      advice: optStr(r.advice),
      payload: parse(r.payload_json),
      by: str(r.by) as Decision['by'],
      requestId: optStr(r.request_id),
      round: num(r.round),
      epoch: num(r.epoch),
      controlSeq: num(r.control_seq),
    };
  }

  listDecisions(batchId: string): DecisionRecord[] {
    return this.all('SELECT * FROM decisions WHERE batch_id = ? ORDER BY control_seq', batchId).map((r) => this.decisionFromRow(r));
  }

  listSessionDecisions(sessionId: string): DecisionRecord[] {
    return this.all('SELECT * FROM decisions WHERE session_id = ? ORDER BY control_seq', sessionId).map((r) => this.decisionFromRow(r));
  }

  // ------------------------------------------------------------------------------------------------------------
  // Requests, epochs, round starts, instructions
  // ------------------------------------------------------------------------------------------------------------

  findRequest(sessionId: string, requestId: string): RequestRecord | null {
    const r = this.get('SELECT * FROM requests WHERE session_id = ? AND request_id = ?', sessionId, requestId);
    return r
      ? {
          sessionId: str(r.session_id),
          requestId: str(r.request_id),
          op: str(r.op),
          payloadHash: str(r.payload_hash),
          result: parse(r.result_json),
          controlSeq: num(r.control_seq),
        }
      : null;
  }

  insertRequest(r: RequestRecord): void {
    this.run(
      'INSERT INTO requests (session_id, request_id, op, payload_hash, result_json, control_seq) VALUES (?, ?, ?, ?, ?, ?)',
      r.sessionId,
      r.requestId,
      r.op,
      r.payloadHash,
      red(JSON.stringify(r.result ?? null)),
      r.controlSeq,
    );
  }

  listRequests(sessionId: string): RequestRecord[] {
    return this.all('SELECT * FROM requests WHERE session_id = ? ORDER BY control_seq', sessionId).map((r) => ({
      sessionId: str(r.session_id),
      requestId: str(r.request_id),
      op: str(r.op),
      payloadHash: str(r.payload_hash),
      result: parse(r.result_json),
      controlSeq: num(r.control_seq),
    }));
  }

  insertEpoch(e: EpochRecord): void {
    this.run(
      'INSERT INTO epochs (session_id, epoch, reason, instruction_id, started_at, control_seq) VALUES (?, ?, ?, ?, ?, ?)',
      e.sessionId,
      e.epoch,
      e.reason,
      e.instructionId,
      e.startedAt,
      e.controlSeq,
    );
  }

  listEpochs(sessionId: string): EpochRecord[] {
    return this.all('SELECT * FROM epochs WHERE session_id = ? ORDER BY epoch', sessionId).map((r) => ({
      sessionId: str(r.session_id),
      epoch: num(r.epoch),
      reason: str(r.reason),
      instructionId: optStr(r.instruction_id),
      startedAt: str(r.started_at),
      controlSeq: num(r.control_seq),
    }));
  }

  insertRoundStart(r: RoundStartRecord): void {
    this.run(
      'INSERT INTO round_starts (session_id, round, version, dialogue_seq_cutoff, control_seq_cutoff) VALUES (?, ?, ?, ?, ?)',
      r.sessionId,
      r.round,
      r.version,
      r.dialogueSeqCutoff,
      r.controlSeqCutoff,
    );
  }

  findRoundStart(sessionId: string, round: number): RoundStartRecord | null {
    const r = this.get('SELECT * FROM round_starts WHERE session_id = ? AND round = ?', sessionId, round);
    return r
      ? {
          sessionId: str(r.session_id),
          round: num(r.round),
          version: num(r.version),
          dialogueSeqCutoff: num(r.dialogue_seq_cutoff),
          controlSeqCutoff: num(r.control_seq_cutoff),
        }
      : null;
  }

  listRoundStarts(sessionId: string): RoundStartRecord[] {
    return this.all('SELECT * FROM round_starts WHERE session_id = ? ORDER BY round', sessionId).map((r) => ({
      sessionId: str(r.session_id),
      round: num(r.round),
      version: num(r.version),
      dialogueSeqCutoff: num(r.dialogue_seq_cutoff),
      controlSeqCutoff: num(r.control_seq_cutoff),
    }));
  }

  insertInstruction(i: InstructionRecord): void {
    this.run(
      `INSERT INTO pending_instructions (session_id, instruction_id, text, status, interrupted, epoch, control_seq, applied_round)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      i.sessionId,
      i.instructionId,
      red(i.text),
      i.status,
      i.interrupted ? 1 : 0,
      i.epoch,
      i.controlSeq,
      i.appliedRound,
    );
  }

  listInstructions(sessionId: string, status?: InstructionRecord['status']): InstructionRecord[] {
    return this.all('SELECT * FROM pending_instructions WHERE session_id = ? ORDER BY control_seq', sessionId)
      .map((r) => ({
        sessionId: str(r.session_id),
        instructionId: str(r.instruction_id),
        text: str(r.text),
        status: str(r.status) as InstructionRecord['status'],
        interrupted: num(r.interrupted) === 1,
        epoch: num(r.epoch),
        controlSeq: num(r.control_seq),
        appliedRound: optNum(r.applied_round),
      }))
      .filter((i) => status === undefined || i.status === status);
  }

  markInstructionApplied(sessionId: string, instructionId: string, round: number): void {
    this.run(
      `UPDATE pending_instructions SET status = 'applied', applied_round = ? WHERE session_id = ? AND instruction_id = ?`,
      round,
      sessionId,
      instructionId,
    );
  }

  // ------------------------------------------------------------------------------------------------------------
  // Dialogue and narrations
  // ------------------------------------------------------------------------------------------------------------

  insertDialogue(d: DialogueRecord): void {
    this.run(
      `INSERT INTO dialogue (session_id, seq, round, epoch, world_version, speaker, listeners_json, text, kind, proposal_id,
        decision_id, payload_json, inherited, control_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, (SELECT control_seq FROM sessions WHERE session_id = ?)))`,
      d.sessionId,
      d.seq,
      d.round,
      d.epoch,
      d.worldVersion,
      d.speaker,
      json(d.listeners),
      red(d.text),
      d.kind,
      d.proposalId,
      d.decisionId,
      d.payload === undefined || d.payload === null ? null : red(JSON.stringify(d.payload)),
      d.inherited ? 1 : 0,
      d.controlAt ?? null,
      d.sessionId,
    );
  }

  listDialogue(sessionId: string, maxSeq = Number.MAX_SAFE_INTEGER): DialogueRecord[] {
    return this.all('SELECT * FROM dialogue WHERE session_id = ? AND seq <= ? ORDER BY seq', sessionId, maxSeq).map((r) => ({
      sessionId: str(r.session_id),
      seq: num(r.seq),
      round: num(r.round),
      epoch: num(r.epoch),
      worldVersion: num(r.world_version),
      speaker: str(r.speaker) as ActorId,
      listeners: parse(r.listeners_json),
      text: str(r.text),
      kind: str(r.kind) as DialogueKind,
      proposalId: optStr(r.proposal_id),
      decisionId: optStr(r.decision_id),
      payload: r.payload_json === null ? null : parse(r.payload_json),
      inherited: num(r.inherited) === 1,
      controlAt: r.control_at === null || r.control_at === undefined ? null : num(r.control_at),
    }));
  }

  insertNarration(n: Omit<NarrationRecord, 'narrationId'>): number {
    const info = this.stmt(
      `INSERT INTO narrations (session_id, batch_id, scene, event_versions_json, attempt, status, raw, header, displayed,
        check_json, control_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      n.sessionId,
      n.batchId,
      n.scene,
      json(n.eventVersions),
      n.attempt,
      n.status,
      redOpt(n.raw),
      red(n.header),
      red(n.displayed),
      red(JSON.stringify(n.check ?? null)),
      n.controlSeq,
    );
    return Number(info.lastInsertRowid);
  }

  listNarrations(sessionId: string): NarrationRecord[] {
    return this.all('SELECT * FROM narrations WHERE session_id = ? ORDER BY narration_id', sessionId).map((r) => ({
      narrationId: num(r.narration_id),
      sessionId: str(r.session_id),
      batchId: optStr(r.batch_id),
      scene: str(r.scene),
      eventVersions: parse(r.event_versions_json),
      attempt: num(r.attempt),
      status: str(r.status) as NarrationRecord['status'],
      raw: optStr(r.raw),
      header: str(r.header),
      displayed: str(r.displayed),
      check: parse(r.check_json),
      controlSeq: num(r.control_seq),
    }));
  }

  /** Persistent, database-wide monotonic counter (survives restarts). */
  nextCounter(name: string): number {
    this.run('INSERT INTO id_counters (name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1', name);
    return num(this.get('SELECT value FROM id_counters WHERE name = ?', name)?.value);
  }

  // ------------------------------------------------------------------------------------------------------------
  // Generic export helper
  // ------------------------------------------------------------------------------------------------------------

  /** Raw rows of a table for one session (audit export), ordered deterministically. */
  rawRows(table: string, sessionId: string | null, orderBy: string): Row[] {
    const allowed = new Set([
      'sessions',
      'snapshots',
      'events',
      'batches',
      'proposals',
      'pauses',
      'decisions',
      'epochs',
      'requests',
      'round_starts',
      'pending_instructions',
      'dialogue',
      'narrations',
      'llm_calls',
    ]);
    if (!allowed.has(table)) throw new RepoError(`table ${table} is not exportable`);
    return sessionId === null
      ? this.all(`SELECT * FROM ${table} ORDER BY ${orderBy}`)
      : this.all(`SELECT * FROM ${table} WHERE session_id = ? ORDER BY ${orderBy}`, sessionId);
  }

  attemptRowsForSession(sessionId: string): Row[] {
    return this.all(
      `SELECT a.* FROM llm_attempts a JOIN llm_calls c ON c.call_id = a.call_id WHERE c.session_id = ? ORDER BY a.call_id, a.attempt_no`,
      sessionId,
    );
  }
}
