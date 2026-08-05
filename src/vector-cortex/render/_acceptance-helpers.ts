/**
 * render/_acceptance-helpers.ts — barrel re-export for the VC5B render + provider
 * acceptance rows.
 *
 * The implementation is split across focused sibling files to keep each under
 * the src/ 500-line hard limit; this file is the single import surface the
 * acceptance aggregator uses:
 *   - `_acceptance-fixture.ts`  — manifest I/O + RenderFx/ProviderFx shapes + withFlagsOn
 *   - `_acceptance-scenario.ts` — declarative graph materialization + runRenderScenario
 *   - `_acceptance-provider.ts` — provider-registry runner + KNOWN_KEYS
 *
 * Every function drives the REAL render / validate / provider logic — no mocks,
 * no stubs.
 */

export {
  REPO_ROOT,
  V2,
  readManifest,
  renderFixture,
  providerFixture,
  withFlagsOn,
} from "./_acceptance-fixture.js";
export type {
  ManifestRow,
  Manifest,
  RenderFxInput,
  RenderFxExpected,
  RenderFx,
  ProviderFxInput,
  ProviderFxExpected,
  ProviderFx,
} from "./_acceptance-fixture.js";

export { materializeGraph, runRenderScenario } from "./_acceptance-scenario.js";
export type { MaterializedGraph, RenderRunOutcome } from "./_acceptance-scenario.js";

export { runProviderScenario, KNOWN_KEYS } from "./_acceptance-provider.js";
export type { ProviderRunOutcome } from "./_acceptance-provider.js";
