/** Public API of the harness (persistence-backed; the only writer of world state). */
export * from './harness.js';
export type { CommitResult, OutcomeSummary } from './commit.js';
export { HarnessError, type CommitStage, type HarnessHooks } from './context.js';
export type { AssessResult, DecisionInput, ResolveResult, SemanticPauseInput, PauseSpec } from './decisions.js';
export type { NarrateFn, NarrateOutput, NarrateRequest, NarrationInput } from './narration.js';
export type { RecoveryReport } from './recovery.js';
export type { ReplayReport } from './replay.js';
export type { BranchResult } from './branch.js';
export { SessionMutex } from './mutex.js';
