/**
 * vector-cortex/cache/economics-emit.ts — VC7B event reporter seam.
 *
 * Mirrors `./crystal-emit.ts`: a thin `safe()` wrapper around an optional
 * injected `emit` (unit tests pass `undefined` and stay pure), and the two event
 * names the sprint spec requires verbatim:
 *   - `vector_cortex_cache_experiment_assigned` — a session entered an arm.
 *   - `vector_cortex_cache_economics_estimated` — net savings were computed.
 *
 * FLAG SEMANTICS. `computeEconomics`, `compileCrystalBoundaries` and
 * `assignExperiment` are PURE and run REGARDLESS of `MEGACOMPACT_VC7B`. The flag
 * gates ONLY this reporting + dashboard seam: with the flag off a session still
 * hashes to the SAME arm, the compiler still produces the SAME boundaries, and
 * the same net savings are still computed — we just do not announce them under
 * the VC7B event namespace, and the dashboard reports `enabled:false` + mode C.
 * That is what makes flag-off byte-identical to VC7A: the arithmetic is never
 * skipped, only the emission.
 *
 * PAYLOAD DISCIPLINE. These events carry the ARM, the BUCKET, integer money
 * AGGREGATES, and the evidence label — never a session id, never covered ranges,
 * never frozen bytes, never a request or covered digest. A session id here would
 * re-identify a user's conversation in a log file, and the bucket already carries
 * everything needed to audit the split (SECURITY_PRIVACY — the exact ledger is
 * not diagnostic data). The `evidence` label travels WITH every economics event
 * so a downstream aggregator can never mistake a shadow estimate for a measured,
 * randomized result.
 *
 * No console, no storage, no network (PREVENT-PI-004 / PREVENT-011). Every line
 * is a structured JSON event with `ts` + `event`.
 */

import { VC7B_ENABLED } from "../../config/vector-cortex.js";
import type { EconomicsEvidence } from "../provider/economics.js";
import type { AssignmentSource, ExperimentArm } from "../provider/experiments.js";

/** The two structured events the VC7B reporter emits. */
export type EconomicsEventName =
  | "vector_cortex_cache_experiment_assigned"
  | "vector_cortex_cache_economics_estimated";

/** Optional emit fn injected by the runtime; tests pass `undefined`. */
export type EconomicsEmit = (name: string, payload: unknown) => void;

/** Run `fn` only when an emit exists; a reporting failure is never fatal. */
function safe(emit: EconomicsEmit | undefined, fn: (emit: EconomicsEmit) => void): void {
  if (emit === undefined) return;
  try {
    fn(emit);
  } catch {
    // Non-fatal: a reporting failure must never break the agent loop.
  }
}

/** The event names VC7B emits, exported for the dashboard seam and tests. */
export const ECONOMICS_EVENT_NAMES: readonly EconomicsEventName[] = [
  "vector_cortex_cache_experiment_assigned",
  "vector_cortex_cache_economics_estimated",
] as const;

/**
 * Report a session's experiment assignment.
 *
 * Arm + bucket + source only. The bucket is sufficient to audit that the split
 * is being honored; the SESSION ID is deliberately absent so the event log
 * cannot be used to reconstruct who was in which arm.
 */
export function reportCacheExperimentAssigned(
  emit: EconomicsEmit | undefined,
  payload: {
    readonly experimentId: string;
    readonly arm: ExperimentArm;
    readonly bucket: number;
    readonly source: AssignmentSource;
  },
): void {
  if (!VC7B_ENABLED()) return;
  safe(emit, (e) =>
    e("vector_cortex_cache_experiment_assigned", {
      ts: undefined,
      event: "vector_cortex_cache_experiment_assigned",
      experimentId: payload.experimentId,
      arm: payload.arm,
      bucket: payload.bucket,
      source: payload.source,
    }),
  );
}

/**
 * Report computed cache economics.
 *
 * Integer micro-unit aggregates plus the evidence label. `netSavings` may be
 * NEGATIVE and is reported as such — a cache that lost money is the outcome this
 * telemetry exists to surface, so it is never clamped on the way out.
 */
export function reportCacheEconomicsEstimated(
  emit: EconomicsEmit | undefined,
  payload: {
    readonly profileId: string;
    readonly netSavings: number;
    readonly tokenSavings: number;
    readonly evidence: EconomicsEvidence;
  },
): void {
  if (!VC7B_ENABLED()) return;
  safe(emit, (e) =>
    e("vector_cortex_cache_economics_estimated", {
      ts: undefined,
      event: "vector_cortex_cache_economics_estimated",
      profileId: payload.profileId,
      netSavings: payload.netSavings,
      tokenSavings: payload.tokenSavings,
      evidence: payload.evidence,
    }),
  );
}
