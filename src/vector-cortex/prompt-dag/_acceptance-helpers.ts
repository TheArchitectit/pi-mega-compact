/**
 * prompt-dag/_acceptance-helpers.ts — barrel re-export for the VC5A DAG +
 * planner acceptance rows.
 *
 * The implementation is split across focused sibling files to keep each under
 * the src/ 500-line hard limit; this file is the single import surface the
 * acceptance aggregator uses:
 *   - `_acceptance-fixture.ts`  — manifest I/O + DagFixture/PlnFixture shapes + withFlagsOn
 *   - `_acceptance-dag.ts`      — declarative DAG materialization + runDagScenario
 *   - `_acceptance-planner.ts` — candidate-set materialization + runPlannerScenario
 *   - `_acceptance-shuffle.ts` — deterministic eq/shuffle helpers
 *
 * Every function drives the REAL prompt-dag / planner logic — no mocks, no stubs.
 */

export {
  REPO_ROOT,
  V2,
  readManifest,
  dagFixture,
  plnFixture,
  withFlagsOn,
} from "./_acceptance-fixture.js";
export type {
  ManifestRow,
  Manifest,
  DagFxInput,
  DagFxExpected,
  DagFixture,
  PlnFxInput,
  PlnFxExpected,
  PlnFixture,
} from "./_acceptance-fixture.js";

export { materializeDag, runDagScenario } from "./_acceptance-dag.js";
export type { MaterializedDag } from "./_acceptance-dag.js";

export { materializeCandidates, runPlannerScenario } from "./_acceptance-planner.js";
export type { PlnResult } from "./_acceptance-planner.js";
