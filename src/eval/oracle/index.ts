/**
 * Independent oracle (PLAN §13.3). Imports only domain types (`src/core/types.ts`) and the content loader's types;
 * `tests/eval/oracle-isolation.test.ts` scans every file of this folder and fails on any other project import.
 */
export * from './bundle.js';
export * from './checks.js';
export * from './narration.js';
export * from './oracle.js';
export { ReplayedBundle, recordOffer, QUALIFYING_DEADLOCK } from './replay.js';
export { applyPatchOps, canonical, deepEqual, idNum, byIdNum } from './patch.js';
export * as world from './world.js';
export { parseOracleAction, OracleAction, OracleSystemAction, type OAction, type OSystemAction } from './actions.js';
