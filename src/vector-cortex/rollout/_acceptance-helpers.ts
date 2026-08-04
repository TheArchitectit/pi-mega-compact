/**
 * rollout/_acceptance-helpers.ts — pure barrel re-export of the VC5C rollout
 * acceptance helpers (fixture I/O + REAL runner). Mirrors the render family's
 * delegate-shell split so the aggregator stays under the 600-line test hard
 * limit.
 */

export {
  REPO_ROOT,
  V2,
  readManifest,
  rolloutFixture,
  withFlagsOn,
} from "./_acceptance-fixture.js";
export type {
  Manifest,
  ManifestRow,
  RolloutFx,
  RolloutFxInput,
  RolloutFxExpected,
  RolloutFxEvidence,
} from "./_acceptance-fixture.js";
export { runRolloutScenario } from "./_acceptance-scenario.js";
export type { RolloutRunOutcome } from "./_acceptance-scenario.js";
