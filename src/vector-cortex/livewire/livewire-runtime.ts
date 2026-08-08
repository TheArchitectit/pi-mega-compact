/**
 * vector-cortex/livewire/livewire-runtime.ts — LIVEWIRE runtime accumulation seam.
 *
 * The WRITE side of LIVEWIRE: the runtime calls these methods wherever the
 * corresponding subsystem path actually runs, and each call accumulates into the
 * per-stateDir live state and persists a reduced count-only snapshot (best-effort,
 * non-fatal). This is the seam that turns the pure VC7A/VC7B/VC7C/VC8B arithmetic
 * into LIVE dashboard state.
 *
 * FLAG SEMANTICS (mirrors every other VC writer): these methods run REGARDLESS of
 * the corresponding `MEGACOMPACT_VC*` flag — the arithmetic is never skipped, and
 * a miss is still classified / a write still stored exactly as before. Only the
 * dashboard REPORT seam (`routes-vector-cortex-*.ts`) is flag-gated: with the
 * flag off a route returns the legacy `deferredReason` (byte-identical to the
 * predecessor). The reporter emit seams in `cache/*-emit.ts` / `controller/
 * policy-emit.ts` remain the event-announcement gate.
 *
 * PREVENT-PI-004: no network. PREVENT-011: no `any`. Every write is best-effort.
 */

import type { MissClass, MissObservation } from "../cache/diagnostics-types.js";
import { classifyMiss } from "../cache/diagnostics.js";
import { shouldBlockServe } from "../cache/breaker.js";
import type { CrystalV1, CrystalWriteResult } from "../cache/types.js";
import type { ShadowResult } from "../controller/types.js";
import { livewireOf, persistLivewire } from "./livewire-registry.js";

/**
 * Record a VC7A crystal WRITE attempt (write-once + collision arithmetic). The
 * caller passes the fully-formed `CrystalV1`; the store returns the write result
 * (first-write / idempotent / collision). The dashboard's `stats()` reflects it.
 *
 * @returns the store's write verdict, forwarded so the runtime can act on a
 *          collision without re-deriving it.
 */
export function recordCrystalWrite(stateDir: string, crystal: CrystalV1): CrystalWriteResult {
  const state = livewireOf(stateDir);
  const result = state.crystalStore.write(crystal);
  persistLivewire(state, stateDir);
  return result;
}

/**
 * Record a VC7A crystal READ attempt. Returns the stored crystal (or undefined
 * on a miss / mode C), mirroring `CrystalStore.read` so the cache-serve path can
 * use this seam entirely.
 */
export function readCrystal(stateDir: string, keyDigest: string): CrystalV1 | undefined {
  const state = livewireOf(stateDir);
  const found = state.crystalStore.read(keyDigest);
  persistLivewire(state, stateDir);
  return found;
}

/**
 * Record a VC7C miss observation: classify it into its exclusive class and tally
 * it. When the class demands the cache serve be demoted BEFORE answering, the
 * `serveBlocked` counter is also incremented. The live breaker state itself is
 * driven by the real cache-serve path (through `breaker.execute`), not here; this
 * seam only observes and tallies.
 *
 * @returns the exclusive class the observation was tallied under.
 */
export function observeCacheMiss(stateDir: string, observation: MissObservation): MissClass {
  const state = livewireOf(stateDir);
  const missClass = classifyMiss(observation).missClass;
  state.diagnostics.tallies[missClass] += 1;
  if (shouldBlockServe(missClass)) state.diagnostics.serveBlocked += 1;
  persistLivewire(state, stateDir);
  return missClass;
}

/**
 * Record a VC7C cache serve that the breaker demoted BEFORE answering. Talls the
 * `serveBlocked` counter the diagnostics card surfaces.
 */
export function recordServeBlocked(stateDir: string): void {
  const state = livewireOf(stateDir);
  state.diagnostics.serveBlocked += 1;
  persistLivewire(state, stateDir);
}

/**
 * Record a VC8B shadow evaluation run: accumulate its decision metrics so the
 * policy card reports how many shadow decisions were evaluated / clamped /
 * rejected and how many live mutations the shadow proved (structurally 0).
 */
export function recordShadowRun(stateDir: string, result: ShadowResult): void {
  const state = livewireOf(stateDir);
  state.shadow.shadowDecisions += result.metrics.evaluated;
  state.shadow.clampedDecisions += result.metrics.clamped;
  state.shadow.rejectedInputs += result.metrics.rejected;
  state.shadow.liveMutations += result.metrics.liveMutations;
  persistLivewire(state, stateDir);
}

/**
 * Set the active M7 pressure version (1 = legacy, 2 = migrated). The runtime
 * calls this after a successful `migratePressureV2` so the policy card reflects
 * the live migration state rather than a hardcoded 1.
 */
export function setPressureVersion(stateDir: string, version: 1 | 2): void {
  const state = livewireOf(stateDir);
  state.shadow.pressureVersion = version;
  persistLivewire(state, stateDir);
}

/**
 * Mark that VC7B cache economics have actually been computed at runtime (the
 * `computed` bit drives the economics card's `hasData`). The runtime calls this
 * after the first real `computeEconomics` over observed usage.
 */
export function markEconomicsComputed(stateDir: string): void {
  const state = livewireOf(stateDir);
  state.economics.computed = true;
  persistLivewire(state, stateDir);
}
