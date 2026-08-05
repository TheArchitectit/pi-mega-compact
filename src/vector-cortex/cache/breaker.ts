/**
 * cache/breaker.ts — VC7C cache-serve breaker (composes VC0C's createBreaker).
 *
 * This file does NOT reinvent a state machine. It wraps the TRIAD breaker from
 * `../resilience/breaker-core.js` (VC0C) — the same CLOSED_A / OPEN_B / OPEN_C /
 * PROBE_* / MANUAL_HALT states that protect every other subsystem — and adds the
 * ONE cache-specific decision: whether a classified miss should block a cache
 * SERVE before it can answer from a stale or invalid identity.
 *
 * TRIP KIND CLASSIFICATION (per team-lead correction + TRIAD_RESILIENCE §breaker):
 * The four cache demotion conditions map onto `BreakerTripKind` as follows:
 *
 *   CORRECTNESS trips (trip on the FIRST failure, no rolling window):
 *     - profile mismatch     — the crystal was minted under a different provider
 *                              profile; serving it would return bytes for the wrong
 *                              model tier. This is never "recovered from" by waiting.
 *     - range mismatch       — the crystal's covered digest differs from the
 *                              request's; the crystal covers different spans and
 *                              serving it would return another conversation's frozen
 *                              bytes. (Includes digest failure / collision.)
 *     - request mismatch     — the request digest differs; the crystal was built
 *                              for a different request entirely.
 *
 *   PERFORMANCE trips (accumulated over a rolling window before opening):
 *     - dependency advanced   — the dependency high-water moved past the crystal's
 *                              cached position. The crystal is stale but not WRONG;
 *                              a single advance is normal churn. Repeated advances
 *                              across a window indicate the cache is systematically
 *                              behind the frontier — that is a performance signal.
 *     - generation invalidated — the M6 router generation was invalidated. A single
 *                              invalidation is expected during a router cut; repeated
 *                              invalidations indicate a systematic generation
 *                              instability.
 *
 * The distinction matters because a CORRECTNESS trip opens the breaker IMMEDIATELY
 * (first failure), while a PERFORMANCE trip requires BREAKER_PERF_FAILURES within
 * BREAKER_WINDOW_MS. The VC0C breaker-core already implements this via
 * `BreakerTripKind`; we map each miss class to its trip kind and let breaker-core
 * handle the window/threshold logic.
 *
 * "PROBE OUTPUT IS NEVER SERVED" (TRIAD_RESILIENCE line 13): when the breaker is in
 * PROBE_A or PROBE_B, the probe is a TEST serve — its output must not be returned
 * to the caller. `decideCacheServe` enforces this: PROBE_* states always return
 * `block: true` and the fallback mode, never serving from cache.
 *
 * The decision is a CORRECTNESS behavior and is NEVER flag-gated (unlike the
 * reporter seam in `./diagnostics-emit.ts`): flag-off must be byte-identical to
 * the predecessor. `breakerRetryDelay()` from VC0C already implements the
 * deterministic +-10% jitter from the subsystem digest — we use it, don't re-derive.
 *
 * PREVENT-002/011/PI-004 honored.
 */

import { createBreaker, type ConcreteBreaker } from "../resilience/breaker-core.js";
import type { BreakerRecord, BreakerTripKind, Mode } from "../resilience/types.js";
import type { MissClass } from "./diagnostics-types.js";

/** The cache subsystem the breaker tracks (one triad state machine). */
export const CACHE_SUBSYSTEM = "vector-cortex-cache-serve";

/** Build the cache breaker. Composes VC0C — no parallel state machine here. */
export function createCacheBreaker(opts?: {
  now?: () => number;
  onEvent?: (event: Record<string, unknown>) => void;
}): ConcreteBreaker {
  return createBreaker({ now: opts?.now, onEvent: opts?.onEvent });
}

/**
 * Map a miss class to its breaker trip kind. Profile, range (digest/collision),
 * and request mismatches are CORRECTNESS trips — they trip on the FIRST failure
 * because serving a crystal with the wrong identity is never safe, no matter how
 * rarely it happens. Dependency advance and generation invalidation are
 * PERFORMANCE trips — a single occurrence is normal churn; only repeated
 * failures within a window indicate a systematic problem.
 */
export function tripKindForMiss(missClass: MissClass): BreakerTripKind {
  switch (missClass) {
    case "profile":
    case "range":
    case "request":
      return "correctness";
    case "dependency":
    case "generation":
      return "performance";
    case "unknown":
      return "performance";
  }
}

/**
 * Whether a classified miss must block the cache serve. Pure over the class; the
 * ONLY thing that is allowed to demote an otherwise-healthy cache is a real
 * disagreement between what was cached and what the request now requires.
 * `unknown` is not auto-blocked — the triad's own performance window handles it.
 */
export function shouldBlockServe(missClass: MissClass): boolean {
  return missClass !== "unknown";
}

/**
 * Decide the triad mode to render under, given a classified miss and the live
 * breaker. A blockable miss forces mode B (fresh render) unless the breaker is
 * already in a deeper open state (C = all-cache bypass) — never contradicting the
 * triad's own resilience verdict. PROBE_* states are NEVER served from cache
 * (TRIAD_RESILIENCE line 13: "probe output is never served").
 */
export function decideCacheServe(
  missClass: MissClass,
  breaker: ConcreteBreaker,
): { block: boolean; fallbackMode: Mode; tripKind: BreakerTripKind } {
  const tripKind = tripKindForMiss(missClass);
  if (!shouldBlockServe(missClass)) {
    return { block: false, fallbackMode: breaker.modeFor(CACHE_SUBSYSTEM), tripKind };
  }
  const record: BreakerRecord = breaker.snapshot(CACHE_SUBSYSTEM);
  if (record.state === "OPEN_C" || record.state === "MANUAL_HALT") {
    return { block: true, fallbackMode: "C", tripKind };
  }
  if (record.state === "PROBE_A" || record.state === "PROBE_B") {
    return { block: true, fallbackMode: record.state === "PROBE_A" ? "C" : "B", tripKind };
  }
  return { block: true, fallbackMode: "B", tripKind };
}
