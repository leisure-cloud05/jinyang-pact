/**
 * Domain model (PLAN §3). Pure data types and closed-set constants; no logic.
 *
 * World state is JSON-safe (no `undefined`, no Dates, no Maps) so that canonical hashing, RFC-6902 patch replay
 * and SQLite persistence all see exactly the same value. Session-scoped control ids (batch, proposal, pause,
 * decision, request) never appear inside `WorldState`.
 */
import type { Action, SystemAction } from './actions.js';

// ---------------------------------------------------------------------------------------------------------------
// Identifiers (§3.1)
// ---------------------------------------------------------------------------------------------------------------

export const CHAR_IDS = ['shi_jingtang', 'sang_weihan', 'liu_zhiyuan', 'yelu_deguang', 'li_congke'] as const;
export type CharId = (typeof CHAR_IDS)[number];
export const PLAYER = 'player';
export const SYSTEM = 'system';
export type ActorId = CharId | 'player' | 'system';
export const ACTOR_IDS = [...CHAR_IDS, 'player', 'system'] as const;
/** Actors that can hold knowledge / appear as listeners (everything except `system`). */
export const PERSON_IDS = [...CHAR_IDS, 'player'] as const;
export type PersonId = (typeof PERSON_IDS)[number];

export const FACTION_IDS = ['hedong', 'khitan', 'tang'] as const;
export type FactionId = (typeof FACTION_IDS)[number];

export const LOC_IDS = ['jinyang_hq', 'khitan_court', 'luoyang_court'] as const;
export type LocId = (typeof LOC_IDS)[number];

export const RESOURCE_KEYS = ['grain', 'silk', 'cavalry', 'reserve_troops'] as const;
export type ResourceKey = (typeof RESOURCE_KEYS)[number];

/** Principal pairs, named by their two faction ids in `FACTION_IDS` order. */
export const PAIR_IDS = ['hedong-khitan', 'hedong-tang', 'khitan-tang'] as const;
export type PairId = (typeof PAIR_IDS)[number];

/** Fixed roles of the chapter (§3.1): the besieged faction, the relief power, the besieger. */
export const BESIEGED_FACTION: FactionId = 'hedong';
export const RELIEF_FACTION: FactionId = 'khitan';
export const BESIEGER_FACTION: FactionId = 'tang';
export const ASSISTANCE_PAIR: PairId = 'hedong-khitan';

export const CESSION_VALUES = ['none', 'yanmen_north', 'sixteen_prefectures'] as const;
export type Cession = (typeof CESSION_VALUES)[number];

export interface Localized {
  zh: string;
  en: string;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

// ---------------------------------------------------------------------------------------------------------------
// Actions (closed set, §4) — the zod schemas live in actions.ts
// ---------------------------------------------------------------------------------------------------------------

export const ACTION_TYPES = [
  'speak',
  'send_letter',
  'revise_document',
  'suggest_revision',
  'approve_document',
  'set_dispatch_timing',
  'dispatch_document',
  'propose_terms',
  'respond_to_offer',
  'withdraw_offer',
  'confirm_commitment',
  'allocate_resources',
  'abandon_request',
  'revoke_authorization',
  'wait',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/** System outcomes (never LLM-facing). `character_death` / `allegiance_change` exist only for synthetic tests (§6). */
export const SYSTEM_ACTION_TYPES = ['mutiny_outbreak', 'character_death', 'allegiance_change'] as const;
export type SystemActionType = (typeof SYSTEM_ACTION_TYPES)[number];

export type AnyAction = Action | SystemAction;

/** Actions the player may never perform (H02): approve, propose, respond, confirm, withdraw, allocate, abandon. */
export const PLAYER_FORBIDDEN_ACTIONS: readonly ActionType[] = [
  'approve_document',
  'propose_terms',
  'respond_to_offer',
  'confirm_commitment',
  'withdraw_offer',
  'allocate_resources',
  'abandon_request',
];

/** Actions that only a faction principal may hold as a permission (consent-bearing or principal-level). */
export const PRINCIPAL_ONLY_ACTIONS: readonly ActionType[] = [
  'approve_document',
  'propose_terms',
  'respond_to_offer',
  'withdraw_offer',
  'confirm_commitment',
  'allocate_resources',
  'abandon_request',
];

export const ALLOCATION_PURPOSES = ['intensify_siege', 'pay_troops'] as const;
export type AllocationPurpose = (typeof ALLOCATION_PURPOSES)[number];
/** Valid (faction, resource) per purpose — fixed semantics of G04/G05. */
export const ALLOCATION_TARGETS: Record<AllocationPurpose, { faction: FactionId; resource: ResourceKey }> = {
  intensify_siege: { faction: 'tang', resource: 'reserve_troops' },
  pay_troops: { faction: 'hedong', resource: 'silk' },
};

// ---------------------------------------------------------------------------------------------------------------
// Terms and obligations (§3.2)
// ---------------------------------------------------------------------------------------------------------------

export interface SecretClause {
  id: string;
  text: Localized;
  canary: string;
  knownBy: ActorId[];
}

export interface TermSet {
  vassal: boolean;
  filial: boolean;
  cession: Cession;
  annual_silk: number;
  immediate_silk: number;
  aid_cavalry: number;
  aid_arrival_days: number;
  neutrality: boolean;
  marriage_alliance: boolean;
  secret_clauses: SecretClause[];
}

export const SCALAR_TERM_KEYS = [
  'vassal',
  'filial',
  'cession',
  'annual_silk',
  'immediate_silk',
  'aid_cavalry',
  'aid_arrival_days',
  'neutrality',
  'marriage_alliance',
] as const;
export type ScalarTermKey = (typeof SCALAR_TERM_KEYS)[number];
export type TermKey = ScalarTermKey | 'secret_clauses';

export type ObligationTrigger = 'on_confirm' | 'on_victory' | 'annual_after_confirm' | 'standing' | 'parameter';

export interface Obligation {
  /** Term key, or `secret:<clauseId>` for a secret clause. */
  key: string;
  payer: FactionId;
  beneficiary: FactionId;
  trigger: ObligationTrigger;
  resource: ResourceKey | null;
  amount: number | null;
  value: JsonPrimitive;
  exclusivityKey: string | null;
}

/**
 * Bounds on a TermSet (player goal limits, authorization limits, persona reservations/tolerances).
 * `null` = unconstrained. Boolean keys give the required value.
 */
export interface TermLimits {
  vassal: boolean | null;
  filial: boolean | null;
  neutrality: boolean | null;
  marriage_alliance: boolean | null;
  cession_min: Cession | null;
  cession_max: Cession | null;
  annual_silk_min: number | null;
  annual_silk_max: number | null;
  immediate_silk_min: number | null;
  immediate_silk_max: number | null;
  aid_cavalry_min: number | null;
  aid_cavalry_max: number | null;
  aid_arrival_days_min: number | null;
  aid_arrival_days_max: number | null;
  burden_min: number | null;
  burden_max: number | null;
  secret_clauses_allowed: boolean | null;
}

// ---------------------------------------------------------------------------------------------------------------
// World state (§3.3)
// ---------------------------------------------------------------------------------------------------------------

export type CharacterStatus = 'alive' | 'dead' | 'captured';

export interface CharacterState {
  status: CharacterStatus;
  location: LocId;
  faction: FactionId;
}

export interface PlayerGoal {
  text: Localized;
  limits: TermLimits;
}

export type PauseCategory =
  | 'dispatch_request'
  | 'major_commitment'
  | 'strategic_turn'
  | 'mutiny'
  | 'death'
  | 'allegiance'
  | 'negotiation_deadlock'
  | 'internal_disagreement'
  | 'goal_conflict'
  | 'risky_delay'
  | 'ambiguity'
  | 'prompt_request'
  | 'user_requested'
  | 'error_recovery';

export const PAUSE_CATEGORIES = [
  'dispatch_request',
  'major_commitment',
  'strategic_turn',
  'mutiny',
  'death',
  'allegiance',
  'negotiation_deadlock',
  'internal_disagreement',
  'goal_conflict',
  'risky_delay',
  'ambiguity',
  'prompt_request',
  'user_requested',
  'error_recovery',
] as const satisfies readonly PauseCategory[];

export const MANDATORY_CATEGORIES: readonly PauseCategory[] = [
  'dispatch_request',
  'major_commitment',
  'strategic_turn',
  'mutiny',
  'death',
  'allegiance',
  'negotiation_deadlock',
];
export const SEMANTIC_CATEGORIES: readonly PauseCategory[] = [
  'internal_disagreement',
  'goal_conflict',
  'risky_delay',
  'ambiguity',
];
export const ALL_PAUSE_CATEGORIES: readonly PauseCategory[] = [
  ...MANDATORY_CATEGORIES,
  ...SEMANTIC_CATEGORIES,
  'prompt_request',
  'user_requested',
  'error_recovery',
];

export interface Authorization {
  id: string;
  grantee: CharId;
  categories: PauseCategory[];
  limits: TermLimits;
  grantedRound: number;
  expiresRound: number | null;
  revoked: boolean;
}

export interface PlayerState {
  location: LocId;
  goal: PlayerGoal;
  authorizations: Record<string, Authorization>;
}

export type ResourceMap = Record<ResourceKey, number>;

export interface FactionState {
  resources: ResourceMap;
  reserved: ResourceMap;
}

export type ReservationStatus = 'held' | 'released' | 'debited';

export interface Reservation {
  id: string;
  faction: FactionId;
  /** null for a pure exclusivity claim (e.g. Khitan neutrality) that backs no countable resource. */
  resource: ResourceKey | null;
  amount: number;
  commitmentId: string;
  offerId: string;
  obligationKey: string;
  exclusivityKey: string | null;
  status: ReservationStatus;
}

export interface SiegeState {
  pressure: number;
  morale: number;
}

export type DocumentStatus = 'draft' | 'approved' | 'sent' | 'withdrawn';
export type TimingMode = 'now' | 'delay' | 'hold';

export interface DocumentApproval {
  version: number;
  /** Event id (= world version produced by the approval event); consent evidence for dispatch. */
  eventId: number;
  by: ActorId;
}

export interface DocumentHistoryEntry {
  version: number;
  by: ActorId;
  round: number;
}

export interface Document {
  id: string;
  kind: 'assistance_request';
  /** The character who keeps the document; it is physically at the holder's location. */
  holder: CharId;
  /** Addressee principal (extension to §3.3: fixes the pair of the thread opened at dispatch). */
  to: CharId;
  accessibleBy: ActorId[];
  version: number;
  terms: TermSet;
  note: string;
  status: DocumentStatus;
  approval: DocumentApproval | null;
  timing: { mode: TimingMode; notBeforeRound: number | null };
  history: DocumentHistoryEntry[];
  /** Offer opened by the dispatch (extension; null until sent). */
  sentOfferId: string | null;
}

/** Non-binding term suggestions keep the LLM-facing partial shape (null = no change suggested). */
export interface TermSuggestion {
  vassal: boolean | null;
  filial: boolean | null;
  cession: Cession | null;
  annual_silk: number | null;
  immediate_silk: number | null;
  aid_cavalry: number | null;
  aid_arrival_days: number | null;
  neutrality: boolean | null;
  marriage_alliance: boolean | null;
  secret_clauses: string[] | null;
}

export interface Suggestion {
  id: string;
  by: ActorId;
  target: { kind: 'document' | 'offer'; id: string };
  /** Document version or offer termsVersion the suggestion refers to. */
  targetVersion: number;
  terms: TermSuggestion;
  reason: string;
  round: number;
  day: number;
}

export type CommitmentStatus = 'negotiating' | 'confirmed' | 'rejected' | 'withdrawn';

export interface Consent {
  termsVersion: number | null;
  /** e.g. `event:12` (approval or the consenting action's event). */
  evidence: string | null;
  /** Actor whose action produced the consent record (differs from the party only in baseline on-behalf acts). */
  by: ActorId | null;
}

export interface Commitment {
  id: string;
  parties: [CharId, CharId];
  pair: PairId;
  status: CommitmentStatus;
  liveOfferId: string;
  termsVersion: number;
  consents: Record<string, Consent>;
  secret: boolean;
  confirmedDay: number | null;
  openedDay: number;
  offerIds: string[];
  /** Obligations of the confirmed terms (recorded at confirmation; future ones are never debited in-chapter). */
  obligations: Obligation[];
}

export type OfferStatus = 'in_transit' | 'delivered' | 'accepted' | 'countered' | 'rejected' | 'withdrawn';

export interface Offer {
  id: string;
  commitmentId: string;
  from: CharId;
  to: CharId;
  terms: TermSet;
  termsVersion: number;
  consentEvidence: string;
  sentDay: number;
  arrivalDay: number;
  messageId: string;
  status: OfferStatus;
  withdrawal: null | { messageId: string; effectiveDay: number };
  /** 1-based index of this offer among all offers of its pair (= offersTotal after it). */
  pairSeq: number;
  /** `counter` if created by respond_to_offer, else `opening` (dispatch / propose_terms, i.e. a new thread). */
  origin: 'opening' | 'counter';
  /** Negotiation segment the offer belongs to (§4.1). */
  segment: number;
  /** 0 for the segment's opening offer, else the negotiation round it consumed (1..2 when valid). */
  segmentRound: number;
}

/** Per-pair negotiation bookkeeping (§4.1 segments, H13, G10). */
export interface NegotiationState {
  /** 0 until the pair's first offer, which opens segment 1. */
  segment: number;
  /**
   * `first_offer` for segment 1, else `event:N` — the world event that committed the qualifying
   * negotiation_deadlock decision's reset (world-derived; the decision itself is linked from that event's
   * `decisionId`); null before any offer.
   */
  segmentOpenedBy: string | null;
  /** Offers after the segment's opening offer (counters and replacement-thread offers). */
  roundsInSegment: number;
  offersTotal: number;
  /** Segment used both rounds without agreement and no qualifying decision has resolved it yet. */
  deadlockPending: boolean;
  /**
   * `offersTotal` when the current segment opened (extension needed to identify the segment's opening offer:
   * the next offer is the opening offer iff `offersTotal === segmentStartOffersTotal`).
   */
  segmentStartOffersTotal: number;
}

export type MessageKind = 'offer' | 'response' | 'withdrawal' | 'withdrawal_result' | 'letter' | 'intel';
export type MessageStatus = 'in_transit' | 'delivered';

export interface OfferPayload {
  kind: 'offer';
  offerId: string;
  commitmentId: string;
  termsVersion: number;
  terms: TermSet;
  from: CharId;
  to: CharId;
  note: string;
}

export interface ResponsePayload {
  kind: 'response';
  commitmentId: string;
  offerId: string;
  termsVersion: number;
  response: 'accept' | 'counter' | 'reject';
  reason: string;
  counter: null | { offerId: string; termsVersion: number; terms: TermSet };
}

export interface WithdrawalPayload {
  kind: 'withdrawal';
  commitmentId: string;
  offerId: string;
}

export interface WithdrawalResultPayload {
  kind: 'withdrawal_result';
  commitmentId: string;
  offerId: string;
  effective: boolean;
}

export interface LetterPayload {
  kind: 'letter';
  text: string;
}

export interface IntelPayload {
  kind: 'intel';
  topic: 'envoy_departed';
  text: Localized;
  credibility: number;
}

export type MessagePayload =
  | OfferPayload
  | ResponsePayload
  | WithdrawalPayload
  | WithdrawalResultPayload
  | LetterPayload
  | IntelPayload;

export interface Message {
  id: string;
  from: ActorId;
  to: ActorId;
  kind: MessageKind;
  /** Immutable snapshot taken at send time. */
  payload: MessagePayload;
  sentDay: number;
  arrivalDay: number;
  sendSeq: number;
  status: MessageStatus;
}

export type KnowledgePredicate = 'terms' | 'status' | 'content' | 'value' | 'claim';
export type EvidenceKind = 'initial' | 'source' | 'message' | 'observation' | 'own_action' | 'decision';

export interface KnowledgeItem {
  id: string;
  holder: ActorId;
  subject: string;
  predicate: KnowledgePredicate;
  value: JsonValue;
  /** Day on which the holder acquired the assertion (never before a message's arrivalDay). */
  asOfDay: number;
  evidence: { kind: EvidenceKind; ref: string };
  credibility: number;
  visibility: 'private' | 'faction' | 'public';
}

export type TerminalKind = 'jinyang_falls' | 'pact_concluded' | 'no_assistance' | 'talks_failed';
export const TERMINAL_KINDS = ['jinyang_falls', 'pact_concluded', 'no_assistance', 'talks_failed'] as const satisfies readonly TerminalKind[];

export interface TerminalState {
  kind: TerminalKind;
  day: number;
  round: number;
  detail: Record<string, JsonValue>;
}

export interface WorldFlags {
  assistanceAbandoned: boolean;
  mutinyOccurred: boolean;
  khitanArrivalDay: number | null;
}

export type IdPrefix = 'doc' | 'cmt' | 'offer' | 'msg' | 'k' | 'rsv' | 'auth' | 'sug';
export const ID_PREFIXES: readonly IdPrefix[] = ['doc', 'cmt', 'offer', 'msg', 'k', 'rsv', 'auth', 'sug'];

export interface WorldState {
  version: number;
  round: number;
  day: number;
  /** Per-prefix id counters plus `sendSeq`. */
  counters: Record<string, number>;
  characters: Record<CharId, CharacterState>;
  player: PlayerState;
  factions: Record<FactionId, FactionState>;
  reservations: Record<string, Reservation>;
  siege: SiegeState;
  documents: Record<string, Document>;
  suggestions: Record<string, Suggestion>;
  commitments: Record<string, Commitment>;
  offers: Record<string, Offer>;
  messages: Record<string, Message>;
  knowledge: Record<string, KnowledgeItem>;
  negotiation: Record<PairId, NegotiationState>;
  flags: WorldFlags;
  terminal: TerminalState | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Events (§8.2)
// ---------------------------------------------------------------------------------------------------------------

/** RFC-6902 subset. Values are JSON-safe clones (typed `unknown` so domain interfaces need no index signature). */
export type PatchOp =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'remove'; path: string };

export type EventKind =
  | Exclude<ActionType, 'speak' | 'wait'>
  | SystemActionType
  | 'message_delivered'
  | 'withdrawal_effective'
  | 'withdrawal_late'
  | 'advance'
  | 'mutiny_averted_for_now'
  | 'terminal'
  | 'authorization_granted'
  | 'goal_adjusted'
  | 'deadlock_resolved';

/** Language-neutral fact for narration; `scene` is where it happens, `audience` who witnesses it there. */
export interface NarrationFact {
  scene: LocId;
  kind: string;
  actor: ActorId | null;
  audience: ActorId[];
  data: Record<string, JsonValue>;
}

/** Output of a resolver before it is committed (the reducer adds the version bump). */
export interface EffectDraft {
  kind: EventKind;
  actor: ActorId;
  changes: PatchOp[];
  facts: NarrationFact[];
  rulesApplied: string[];
}

export interface WorldEvent {
  /** World version produced by this event; doubles as the event id (`event:<version>`). */
  version: number;
  /** Round/day of the state the event was applied to. */
  round: number;
  day: number;
  kind: EventKind;
  actor: ActorId;
  proposalId: string | null;
  decisionId: string | null;
  changes: PatchOp[];
  facts: NarrationFact[];
  rulesApplied: string[];
}

// ---------------------------------------------------------------------------------------------------------------
// Session control records (§3.4, §7, §8.3) — never part of WorldState
// ---------------------------------------------------------------------------------------------------------------

export type Mode = 'baseline' | 'no_judge' | 'full';
export const MODES: readonly Mode[] = ['baseline', 'no_judge', 'full'];

export type BatchKind = 'system_prepare' | 'player' | 'character' | 'system_advance' | 'system_outcome';
export type BatchStatus = 'generating' | 'assessed' | 'paused' | 'committed' | 'stale' | 'obsolete';

export interface Batch {
  batchId: string;
  sessionId: string;
  kind: BatchKind;
  round: number;
  epoch: number;
  baseVersion: number;
  status: BatchStatus;
}

export type ProposalSource = 'llm' | 'player' | 'policy' | 'system';
export type ProposalStatus =
  | 'pending'
  | 'committed'
  | 'rejected'
  | 'withheld'
  | 'stale_epoch'
  | 'obsolete'
  | 'unapplied'
  | 'format_error';

export const RULE_IDS = ['H01', 'H02', 'H03', 'H04', 'H05', 'H06', 'H07', 'H08', 'H09', 'H10', 'H11', 'H12', 'H13', 'H14', 'H15', 'H16'] as const;
export type RuleId = (typeof RULE_IDS)[number];

export interface Proposal {
  proposalId: string;
  sessionId: string;
  batchId: string;
  round: number;
  epoch: number;
  baseVersion: number;
  actor: ActorId;
  source: ProposalSource;
  seq: number;
  /** Raw action as proposed (validated against the closed set at commit, H01). */
  action: unknown;
  rationale: string;
  cites: string[];
  askPlayer: { question: string } | null;
  status: ProposalStatus;
  rule: RuleId | null;
  reason: string | null;
  feedback: string | null;
}

export type PauseKind = 'mandatory' | 'semantic' | 'prompt' | 'control' | 'user' | 'error';

export const DECISION_OPTIONS = [
  'endorse',
  'withhold',
  'amend',
  'delegate',
  'ask',
  'counter_draft',
  'let_it_happen',
  'urge_payment',
  'adjust_goal',
  'urge_accept',
  'urge_stop',
  'resume',
  'retry',
  'skip_actor',
  'stop',
  'player_initiated',
] as const;
export type DecisionOption = (typeof DECISION_OPTIONS)[number];

export interface Pause {
  id: string;
  sessionId: string;
  batchId: string | null;
  round: number;
  epoch: number;
  kind: PauseKind;
  category: PauseCategory;
  proposalIds: string[];
  /** Pair concerned by a negotiation_deadlock control pause (extension). */
  pair: PairId | null;
  visibleFacts: Localized[];
  question: Localized;
  options: DecisionOption[];
  status: 'open' | 'resolved' | 'obsolete';
  decisionId: string | null;
}

export interface AuthorizationGrant {
  grantee: CharId;
  categories: PauseCategory[];
  limits: TermLimits;
  expiresRound: number | null;
}

export interface DecisionPayload {
  authorization: AuthorizationGrant | null;
  goalLimits: TermLimits | null;
  amend: null | { docId: string; baseDocVersion: number | '$current'; terms: unknown; note: string };
  counterTerms: unknown | null;
}

export interface Decision {
  decisionId: string;
  sessionId: string;
  pauseId: string | null;
  batchId: string;
  category: PauseCategory;
  proposalIds: string[];
  pair: PairId | null;
  option: DecisionOption;
  advice: string | null;
  payload: DecisionPayload;
  by: 'user' | 'policy' | 'implicit';
  requestId: string | null;
  round: number;
  epoch: number;
}

/** How H10 was satisfied for a committed critical proposal. */
export type GateKind = 'decision' | 'player_initiated' | 'authorization' | 'not_required' | 'ungated';

// ---------------------------------------------------------------------------------------------------------------
// Rules configuration derived from content (§12) — the only input besides state that core functions take
// ---------------------------------------------------------------------------------------------------------------

export interface GameParams {
  round_days: number;
  max_rounds: number;
  /** H13: negotiation rounds (offers after the opening offer) allowed per segment. */
  segment_round_cap: number;
  /** H13: offers per principal pair in total (safety cap). */
  pair_offer_cap: number;
  delay_rounds_min: number;
  delay_rounds_max: number;
  grain_per_advance: number;
  pressure_per_advance: number;
  pressure_cap: number;
  morale_decay: number;
  /** G05: morale decays if grain < this ... */
  morale_low_grain: number;
  /** ... or pressure > this. */
  morale_high_pressure: number;
  morale_cap: number;
  intensify_troops_step: number;
  intensify_pressure_per_step: number;
  pay_silk_step: number;
  pay_morale_per_step: number;
  mutiny_grain_max: number;
  mutiny_morale_max: number;
  mutiny_pressure_add: number;
  /** G07: falls if grain <= this ... */
  fall_grain_max: number;
  /** ... or pressure >= this. */
  fall_pressure_min: number;
  intel_delay_days: number;
  intel_credibility: number;
  letter_credibility: number;
  /** G11 forecast horizon, in ADVANCE steps. */
  projection_max_steps: number;
}

export interface TermCatalogEntry {
  key: ScalarTermKey;
  label: Localized;
  min: number | null;
  max: number | null;
  step: number | null;
  burden_weight: number;
  burden_unit: number | null;
  burden_by_value: Record<string, number> | null;
  applicable_pairs: PairId[];
  source_refs: string[];
}

export interface SecretClauseDef {
  id: string;
  text: Localized;
  canary: string;
  knownBy: ActorId[];
  applicable_pairs: PairId[];
  burden_weight: number;
  source_refs: string[];
}

export interface TermsCatalog {
  terms: Record<ScalarTermKey, TermCatalogEntry>;
  secretClauses: Record<string, SecretClauseDef>;
}

export interface CharacterRules {
  id: CharId;
  faction: FactionId;
  principal: boolean;
  permissions: ActionType[];
  commitPriority: number;
  /** Display name for player-facing text (pause facts); absent in hand-built test configs. */
  name?: Localized;
}

export interface CoreConfig {
  params: GameParams;
  /** Symmetric travel matrix in days; 0 on the diagonal. */
  travel: Record<LocId, Record<LocId, number>>;
  catalog: TermsCatalog;
  factions: Record<FactionId, { principal: CharId }>;
  characters: Record<CharId, CharacterRules>;
  player: { faction: FactionId; permissions: ActionType[]; name?: Localized };
  /** Principal → readers who observe that principal's correspondence when co-located (§4 observation rule). */
  correspondence: Partial<Record<CharId, ActorId[]>>;
}
