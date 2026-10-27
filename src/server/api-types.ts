/**
 * Types of the play server's HTTP API (WP-E, PLAN §11), shared by the server (`src/server`) and the web client
 * (`web/`). Self-contained on purpose (no imports), so the browser build never pulls server code.
 *
 * Vantage: every session endpoint answers from the player's vantage (`view: 'player'`, the clerk at Jinyang) unless
 * `?view=director` is given; the director view is gated (chapter ended, explicitly unlocked, or server `--director`).
 */

export type Lang = 'zh' | 'en';
export type ViewMode = 'player' | 'director';
export interface L10n {
  zh: string;
  en: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Server and sessions
// ---------------------------------------------------------------------------------------------------------------

export interface ConfigSummary {
  id: string;
  kind: 'case' | 'dev' | 'pilot' | 'free';
  title: L10n;
  /**
   * Player-safe description. A case's evaluation `purpose` (which names hidden set-ups) is never sent here; it is
   * served only in director views of a session (`SessionInfo.purpose`).
   */
  description: L10n;
  maxRounds: number;
  validTerminals: string[];
  hasScript: boolean;
  hasPolicy: boolean;
}

export interface ServerConfigView {
  version: string;
  liveAvailable: boolean;
  /** Why live calls are unavailable (null when available). */
  liveProblem: string | null;
  defaultLang: Lang;
  modes: string[];
  configs: ConfigSummary[];
  /** Server started with `--director`: director views are never locked (development only). */
  directorOpen: boolean;
  scenario: { title: L10n; startNote: L10n };
}

export type ControlState =
  | 'starting'
  | 'running'
  | 'awaiting_player'
  | 'awaiting_decision'
  | 'suspended'
  | 'finished'
  | 'stopped'
  | 'error'
  | 'unavailable';

/** What the engine is doing / waiting for. */
export interface ControlView {
  state: ControlState;
  round: number;
  day: number;
  phase: string;
  epoch: number;
  /** Number of committed character interactions in this world round. */
  interactionStep: number;
  interactionStepLimit: number;
  sessionStatus: string;
  /** Open pause the engine waits on (awaiting_decision). */
  pauseId: string | null;
  outcome: string | null;
  outcomeDetail: string | null;
  terminal: { kind: string; round: number; day: number } | null;
  error: string | null;
  /** Last lifecycle step among those that occur every round (never reveals offstage-only work). */
  lastStep: string | null;
  /** Suspension reason (budget, wall clock) when suspended. */
  suspendedReason: string | null;
  /**
   * Token of the player turn the engine awaits (null: not the player's turn). Every input and every turn-ending
   * `advance` must carry it; a stale token is refused (409 `stale_turn`).
   */
  turn: string | null;
}

export interface SessionInfo {
  sessionId: string;
  caseId: string;
  caseTitle: L10n;
  kind: ConfigSummary['kind'];
  mode: string;
  lang: Lang;
  llm: 'mock' | 'live';
  /** The case's scripted player lines are applied at the end of each player turn. */
  script: boolean;
  createdAt: string;
  parentSessionId: string | null;
  parentRound: number | null;
  /** Round at which the director view was explicitly unlocked (null: never). */
  directorUnlockedRound: number | null;
  directorAllowed: boolean;
  ended: boolean;
  outcome: string | null;
  /** The configuration's evaluation purpose: director views only (null in player views). */
  purpose: L10n | null;
}

export interface SessionListItem extends SessionInfo {
  status: string;
  phase: string;
  round: number;
  terminal: string | null;
}

export interface CreateSessionBody {
  requestId: string;
  caseId: string;
  mode?: 'full' | 'no_judge' | 'baseline';
  lang?: Lang;
  llm?: 'mock' | 'live';
  script?: boolean;
  /** Unlock the director view from the start (the session is labelled accordingly). */
  director?: boolean;
  wait?: number;
}

// ---------------------------------------------------------------------------------------------------------------
// World, draft, catalog
// ---------------------------------------------------------------------------------------------------------------

export interface TermsView {
  vassal: boolean;
  filial: boolean;
  cession: string;
  annual_silk: number;
  immediate_silk: number;
  aid_cavalry: number;
  aid_arrival_days: number;
  neutrality: boolean;
  marriage_alliance: boolean;
  /** Only clauses the viewer knows (text included); hidden ones are never listed. */
  secret_clauses: Array<{ id: string; text: L10n; burdenWeight?: number }>;
}

export type TermLimitsView = Record<string, boolean | number | string | null>;

export interface CatalogTermView {
  key: string;
  label: L10n;
  type: 'boolean' | 'integer' | 'enum';
  min: number | null;
  max: number | null;
  step: number | null;
  values: Array<{ value: string; label: L10n }>;
  /** Applicable to the draft's principal pair (non-applicable keys must stay at their default). */
  applicable: boolean;
  burdenWeight: number;
  burdenUnit: number | null;
  /** Burden per enum value (cession). */
  burdenByValue: Record<string, number> | null;
  /** Faction paying this term in the draft's pair (null: a parameter, no payer). */
  payer: string | null;
}

export interface CatalogView {
  pair: string;
  /** Faction whose burden the goal limits bound (the non-Khitan party). */
  burdenPayer: string | null;
  terms: CatalogTermView[];
  limitKeys: string[];
  /** Pause categories a delegation may cover. */
  delegableCategories: string[];
}

export interface OfferKnown {
  offerId: string;
  commitmentId: string;
  from: string;
  to: string;
  fromName: L10n;
  toName: L10n;
  termsVersion: number;
  believedStatus: string | null;
  segment: number;
  segmentRound: number;
}

export interface SuggestionView {
  id: string;
  by: string;
  byName: L10n;
  targetVersion: number;
  terms: Record<string, unknown>;
  reason: string;
  round: number;
  day: number;
}

export interface DraftView {
  docId: string;
  version: number;
  status: string;
  to: string;
  toName: L10n;
  holder: string;
  note: string;
  timing: { mode: string; notBeforeRound: number | null };
  approval: { version: number; by: string } | null;
  /** Shi's approval covers the current version. */
  approvedCurrent: boolean;
  terms: TermsView;
  pair: string;
  burden: number;
  withinGoal: { ok: boolean; violations: string[] };
  history: Array<{ version: number; by: string; byName: L10n; round: number }>;
  /** Whether the player may transmit now (the harness decides; this is a hint). */
  transmit: { ok: boolean; reason: string | null };
  suggestions: SuggestionView[];
}

export interface CharacterView {
  id: string;
  name: L10n;
  title: L10n;
  status: string;
  faction: string;
  location: string;
  locationName: L10n;
  present: boolean;
  profile?: { background: L10n; stance: L10n; concern: L10n } | null;
}

export interface BeliefView {
  id: string;
  subject: string;
  predicate: string;
  value: unknown;
  asOfDay: number;
  evidence: { kind: string; ref: string };
  credibility: number;
}

export interface AuthorizationView {
  id: string;
  grantee: string;
  granteeName: L10n;
  categories: string[];
  limits: TermLimitsView;
  grantedRound: number;
  expiresRound: number | null;
  revoked: boolean;
}

export interface WorldView {
  /** Global world version: director view only (null in player views). */
  version: number | null;
  round: number;
  day: number;
  location: string;
  locationName: L10n;
  siege: { pressure: number; morale: number };
  resources: Record<string, number>;
  reserved: Record<string, number>;
  goal: { text: L10n; limits: TermLimitsView };
  authorizations: AuthorizationView[];
  assistanceAbandoned: boolean;
  terminal: { kind: string; round: number; day: number; detail: Record<string, unknown> } | null;
  negotiation: { segment: number; roundsUsed: number; offers: OfferKnown[] };
  beliefs: BeliefView[];
}

export interface StateView {
  view: ViewMode;
  session: SessionInfo;
  control: ControlView;
  world: WorldView;
  /** Round clock and siege outlook (hourglass and city-defence alerts). */
  siegeWatch: SiegeWatchView;
  /** The assistance negotiation as the clerk knows it, on the road between the two courts. */
  negotiationTrack: NegotiationTrackView;
  characters: CharacterView[];
  player: { name: L10n; title: L10n; permissions: string[] };
  document: DraftView | null;
  catalog: CatalogView;
  pendingPause: PauseView | null;
  /** Director view only: the full world state. */
  full?: unknown;
}

/** Siege levels the clerk sees at headquarters. */
export interface SiegeLevels {
  /** Days of grain supply. */
  grain: number;
  pressure: number;
  morale: number;
}

export interface SiegeAlertView {
  level: 'critical' | 'warning' | 'notice';
  code: 'fall_next' | 'mutiny_next' | 'morale_falls' | 'last_round';
  text: L10n;
}

/**
 * The round clock and the siege outlook. Built from what the clerk sees at headquarters (Hedong's grain, siege
 * pressure and morale) and the public game rules; `next` applies the engine's own five-day transition, assuming
 * nothing else happens this round. Advisory only: it never blocks or changes a choice.
 */
export interface SiegeWatchView {
  round: number;
  maxRounds: number;
  /** Rounds left in the chapter, the current one included (0 once the chapter has ended). */
  roundsLeft: number;
  day: number;
  /** Days that pass when a round ends. */
  roundDays: number;
  now: SiegeLevels;
  /** The siege once this round's days have passed, if nothing else changes (null once the chapter has ended). */
  next: (SiegeLevels & { day: number; round: number; moraleDrops: boolean; falls: 'grain' | 'pressure' | null; mutinyRisk: boolean }) | null;
  /** The rules' thresholds, for the gauges. */
  limits: {
    pressureCap: number;
    moraleCap: number;
    moraleLowGrain: number;
    moraleHighPressure: number;
    mutinyGrainMax: number;
    mutinyMoraleMax: number;
    fallGrainMax: number;
    fallPressureMin: number;
  };
  /** Most severe first. */
  alerts: SiegeAlertView[];
}

/** Where an offer stands as far as the clerk can tell. */
export type OfferStage = 'proposed' | 'awaiting' | 'received' | 'countered' | 'confirmed' | 'rejected' | 'withdrawn';

export interface TrackEndView {
  charId: string;
  name: L10n;
  place: L10n;
}

export interface OfferCardView {
  offerId: string;
  /** `out`: sent from Jinyang; `in`: received at Jinyang. */
  direction: 'out' | 'in';
  from: string;
  to: string;
  termsVersion: number;
  stage: OfferStage;
  /** The clerk's own belief about the offer (as in `world.negotiation`). */
  believedStatus: string | null;
  /** Day the clerk learned of it: the day it went out, or the day it reached headquarters. */
  sinceDay: number;
  /** Day the clerk learned its current status (a reply: the day it reached headquarters). */
  statusDay: number | null;
  /** Outgoing: the day the courier should reach the far court by the schedule (the clerk cannot see the delivery). */
  dueDay: number | null;
  /** Place on the road as far as the clerk can tell: 0 at Jinyang, 1 at the far court. */
  position: number;
  /** A withdrawal the clerk knows of: on the road (`pending`), in time (`effective`) or too late (`late`). */
  withdrawal: string | null;
  /** Terms as the clerk knows them (null: unknown). */
  terms: TermsView | null;
  segment: number;
  segmentRound: number;
}

/**
 * The assistance negotiation as the clerk knows it, laid out on the road between Jinyang and the far court. Built
 * from the clerk's own assertions and public facts (courier days, the round cap) only: a reply appears once it has
 * reached headquarters.
 */
export interface NegotiationTrackView {
  near: TrackEndView;
  far: TrackEndView;
  /** Courier days between the two courts. */
  travelDays: number;
  /** Known offers, oldest first; the last one is where the talks stand. */
  cards: OfferCardView[];
  /** Counter-offers allowed per negotiation segment before the talks need a decision (H13). */
  roundCap: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Pauses and decisions
// ---------------------------------------------------------------------------------------------------------------

export interface ProposalBrief {
  proposalId: string;
  actor: string;
  actorName: L10n;
  type: string;
  summary: L10n;
  /** Terms as the viewer can know them (player: own assertions and accessible documents only). */
  terms: TermsView | null;
  /** Why the proposal's terms are unknown to the player (null: known, or no terms). */
  termsUnknown: string | null;
  status: string;
}

export interface PolicySuggestion {
  option: string;
  advice: string | null;
  authorization: unknown;
  goalLimits: unknown;
  counterTerms: unknown;
  amend: unknown;
  note: string | null;
}

export interface PauseView {
  id: string;
  round: number;
  epoch: number;
  kind: string;
  category: string;
  status: string;
  question: L10n;
  visibleFacts: L10n[];
  options: string[];
  proposals: ProposalBrief[];
  decision: { option: string; advice: string | null; by: string } | null;
  /** The paused proposal's player-visible terms vs the current goal (undefined: no terms). */
  withinLimits: boolean | null;
  /** The case's scripted-user policy choice for this pause (cases with a policy only). */
  suggestion: PolicySuggestion | null;
  asked: number;
  /** Characters the player may ask while the engine waits on this pause (empty otherwise). */
  askable: { id: string; name: L10n }[];
  /** This pause's questions and the answers the player heard, in order (answer null while awaited). */
  thread: AskThreadEntry[];
  /** The engine is currently waiting on this pause. */
  pending: boolean;
}

export interface AskThreadEntry {
  question: string;
  answeredBy: L10n | null;
  answer: string | null;
  outcome: string | null;
}

export interface PausesView {
  view: ViewMode;
  open: PauseView[];
  history: PauseView[];
}

export interface DecisionBody {
  requestId: string;
  pauseId: string;
  option: string;
  advice?: string | null;
  authorization?: { grantee: string; categories: string[]; limits?: TermLimitsView; expiresRound?: number | null } | null;
  goalLimits?: TermLimitsView | null;
  amend?: { docId: string; baseDocVersion: number | '$current'; terms: Record<string, unknown>; note?: string } | null;
  counterTerms?: Record<string, unknown> | null;
  wait?: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Player input
// ---------------------------------------------------------------------------------------------------------------

export type InputBody =
  | { requestId: string; turn: string; kind: 'action'; action: { type: string; args: Record<string, unknown> }; wait?: number }
  | { requestId: string; turn: string; kind: 'dialogue'; to: string[]; text: string; wait?: number }
  | { requestId: string; turn: string; kind: 'text'; text: string; wait?: number };

export interface InputOutcome {
  proposalId: string;
  type: string;
  status: string;
  rule: string | null;
  /** What the player is told (actor-facing feedback). */
  feedback: string | null;
}

export interface MappedView {
  kind: string | null;
  status: string;
  action: { type: string; args: Record<string, unknown> } | null;
  dialogue: { to: string[]; text: string } | null;
  question: string | null;
  reason: string | null;
  downgraded: string | null;
  /** Mapped player-initiated critical action (transmit): not applied until confirmed. */
  confirmRequired: boolean;
}

export interface InputResult {
  kind: 'action' | 'dialogue' | 'text';
  applied: boolean;
  outcomes: InputOutcome[];
  /** Dialogue lines recorded by this input. */
  spoken: number;
  mapped: MappedView | null;
  control: ControlView;
}

// ---------------------------------------------------------------------------------------------------------------
// Story, dialogue, inspector, timeline, usage
// ---------------------------------------------------------------------------------------------------------------

export type StoryItem =
  | { kind: 'round'; round: number; day: number }
  | {
      kind: 'facts';
      round: number;
      day: number;
      batchKind: string;
      scene: string;
      sceneName: L10n;
      lines: string[];
      inherited: boolean;
    }
  | {
      kind: 'narration';
      round: number;
      day: number;
      scene: string;
      sceneName: L10n;
      batchId: string;
      narrationId: number;
      attempt: number;
      headerLines: string[];
      prose: string;
      proseLang: Lang;
      status: 'ok' | 'fallback' | 'failed';
      fallbackReason: string | null;
      inherited: boolean;
    };

export interface StoryView {
  view: ViewMode;
  lang: Lang;
  items: StoryItem[];
}

export interface DialogueRowView {
  seq: number;
  round: number;
  speaker: string;
  speakerName: L10n;
  listeners: string[];
  listenerNames: L10n[];
  kind: string;
  text: string;
  inherited: boolean;
  payload: unknown;
}

export interface DialogueView {
  view: ViewMode;
  rows: DialogueRowView[];
}

export interface ChangeView {
  op: string;
  path: string;
  before: unknown;
  after: unknown;
}

export interface EventView {
  /** Position in this list. */
  index: number;
  /** World version: director view only (null in player views). */
  version: number | null;
  round: number;
  day: number;
  kind: string;
  actor: string;
  actorName: L10n;
  batchId: string | null;
  inherited: boolean;
  rulesApplied: string[];
  lines: string[];
  proposal: { proposalId: string; actor: string; type: string } | null;
  decisionId: string | null;
  changes: ChangeView[];
  /** Operations outside the viewer's vantage: a count in the director view; 0/1 (whether any) in the player view. */
  hiddenChanges: number;
}

export interface EventsView {
  view: ViewMode;
  events: EventView[];
}

export interface ProposalView {
  proposalId: string;
  batchId: string;
  round: number;
  epoch: number;
  actor: string;
  actorName: L10n;
  source: string;
  seq: number;
  type: string;
  summary: L10n;
  termsUnknown: string | null;
  args: unknown;
  status: string;
  rule: string | null;
  ruleTitle: string | null;
  /** Director view: the full reason; player view: the actor-facing feedback. */
  reason: string | null;
  category: string | null;
  gate: string | null;
  eventVersions: number[];
  rationale: string | null;
  probe: boolean;
}

export interface ProposalsView {
  view: ViewMode;
  proposals: ProposalView[];
}

export interface DiffView {
  view: ViewMode;
  /** Player view: round starts (`to` null = now); director view: world versions. */
  unit: 'round' | 'version';
  from: number;
  to: number | null;
  entries: ChangeView[];
}

export interface TimelineRound {
  round: number;
  version: number | null;
  day: number;
  inherited: boolean;
  events: number;
  pauses: Array<{ id: string; category: string; status: string; option: string | null; advice: string | null; by: string | null }>;
  interrupts: number;
  narrations: { ok: number; fallback: number; failed: number };
  terminal: string | null;
  canBranch: boolean;
  activations?: Array<{ charId: string; tier: string; reason: string; skipped: boolean }>;
}

export interface TimelineView {
  view: ViewMode;
  rounds: TimelineRound[];
  lineage: {
    parent: { sessionId: string; round: number | null } | null;
    children: Array<{ sessionId: string; round: number | null; outcome: string | null }>;
    related: string[];
  };
  checkpoints: Array<{ name: string; round: number; version: number | null }>;
  outcome: string | null;
  ended: boolean;
}

export interface CompareRound {
  round: number;
  day: number;
  grain: number;
  pressure: number;
  morale: number;
  docVersion: number | null;
  docStatus: string | null;
  timing: string | null;
  terminal: string | null;
}

export interface CompareItem {
  index: number;
  version: number | null;
  round: number;
  text: string;
}

export interface CompareView {
  view: ViewMode;
  a: { sessionId: string; outcome: string | null; rounds: CompareRound[]; items: CompareItem[] };
  b: { sessionId: string; outcome: string | null; rounds: CompareRound[]; items: CompareItem[] };
  /** First divergence (index into `items`, world version in director view); null when identical. */
  divergence: { index: number; round: number | null; version: number | null; a: CompareItem | null; b: CompareItem | null } | null;
  sharedPrefix: number;
}

export interface UsageBucket {
  calls: number;
  attempts: number;
  refused: number;
  inputTokens: number;
  outputTokens: number;
  costReportedUsd: number;
  costEstimatedUsd: number;
  unknownCostCalls: number;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
}

/** Counters that only concern the player (all a locked player view gets). */
export interface PlayerUsage {
  round: number;
  day: number;
  /** The player's own actions (proposals) by status. */
  actions: { total: number; committed: number; rejected: number };
  /** The player's own free-text interpretations (mapper calls). */
  mapperCalls: number;
  /** Coarse share of the session's call budget used: 0, 0.25, 0.5, 0.75 or 1. */
  budgetUsed: number;
}

export interface UsageView {
  view: ViewMode;
  /** Per-call and per-role telemetry is present only when the director view is allowed. */
  detailed: boolean;
  player: PlayerUsage;
  totals: UsageBucket | null;
  byRole: Array<UsageBucket & { role: string }> | null;
  calls: Array<{
    callId: string;
    ts: string;
    role: string;
    actor: string | null;
    round: number | null;
    tag: string | null;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
    costSource: string;
    latencyMs: number;
    attempts: number;
    status: string;
  }> | null;
  budget: { maxCalls: number; maxUsd: number };
}

export interface ReplayView {
  mode: 'patch' | 'rederive';
  ok: boolean;
  /** Counts and hashes: only when the director view is allowed (they reveal offstage activity). */
  checkedEvents: number | null;
  checkedBatches: number | null;
  mismatches: string[];
  finalHash: string | null;
  expectedHash: string | null;
}

export interface ApiErrorBody {
  error: string;
  message: string;
  detail?: unknown;
}
