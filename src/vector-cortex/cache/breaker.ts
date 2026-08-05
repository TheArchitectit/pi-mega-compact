/**
 * cache/breaker.ts — VC7C cache-serve breaker (composes VC0C's createBreaker).
 *
 * This file does NOT reinvent a state machine. It wraps the TRIAD breaker from
 * `../resilience/breaker-core.js` (VC0C) — the same CLOSED_A / OPEN_B / OPEN_C /
 * PROBE_* / MANUAL_HALT states that protect every other subsystem — and adds the
 * ONE cache-specific decision: whether a classified miss should block a cache
 * SERVE before it can answer from a stale or invalid identity.
 *
 * The decision is a CORRECTNESS behavior and is NEVER flag-gated (unlike the
 * reporter seam in `./diagnostics-emit.ts`): flag-off must be byte-identical to
 * the predecessor, and "byte-identical" includes "still refuses to serve a
 * crystal minted under a profile you are no longer using." The flag gates only
 * the announcement.
 *
 * Blocking conditions (sprint task 3): demote before cache serve on
 *   - profile mismatch        (identity collision / wrong provider profile)
 *   - covered-digest mismatch (digest failure / range drift)
 *   - dependency advanced     (stale crystal — frontier moved past it)
 *   - generation invalidated  (stale M6 generation — the crystal is dead)
 * i.e. block whenever the miss class is anything other than `unknown`. An
 * `unknown` miss is a disagreement we cannot name, so it is NOT auto-blocked —
 * the triad still demotes via its own performance window if it misbehaves.
 *
 * PREVENT-002/011/PI-004 honored.
 */

import { createBreaker, type ConcreteBreaker } from "../resilience/breaker-core.js";
import type { BreakerRecord, Mode } from "../resilience/types.js";
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
 * Whether a classified miss must block the cache serve. Pure over the class; the
 * ONLY thing that is allowed to demote an otherwise-healthy cache is a real
 * disagreement between what was cached and what the request now requires.
 */
export function shouldBlockServe(missClass: MissClass): boolean {
  return missClass !== "unknown";
}

/**
 * Decide the triad mode to render under, given a classified miss and the live
 * breaker. A blockable miss forces mode B (fresh render) unless the breaker is
 * already in a deeper open state, in which case we honor it (C = all-cache
 * bypass) — never contradicting the triad's own resilience verdict.
 */
export function decideCacheServe(
  missClass: MissClass,
  breaker: ConcreteBreaker,
): { block: boolean; fallbackMode: Mode } {
  if (!shouldBlockServe(missClass)) {
    return { block: false, fallbackMode: breaker.modeFor(CACHE_SUBSYSTEM) };
  }
  const record: BreakerRecord = breaker.snapshot(CACHE_SUBSYSTEM);
  // If the triad has already escalated past B, follow it (C wins over B).
  if (record.state === "OPEN_C" || record.state === "MANUAL_HALT") {
    return { block: true, fallbackMode: "C" };
  }
  return { block: true, fallbackMode: "B" };
}
