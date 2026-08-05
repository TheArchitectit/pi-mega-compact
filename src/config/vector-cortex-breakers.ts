/**
 * config/vector-cortex-breakers.ts — breaker state machine constants.
 *
 * Extracted from vector-cortex.ts to keep that file under the 300-line soft
 * limit (soft-as-hard gate). These constants are normative in
 * TRIAD_RESILIENCE.md §breaker and consumed by VC0C's breaker seam.
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

/** Rolling eligibility window (milliseconds). */
export const BREAKER_WINDOW_MS = 60_000;
/** Minimum attempts before a breaker may trip or promote. */
export const BREAKER_MIN_ATTEMPTS = 20;
/** Performance trip: ≥ this many failures in window, or ≥ this fraction. */
export const BREAKER_PERF_FAILURES = 5;
export const BREAKER_PERF_FAILURE_RATE = 0.1;
/** Correctness trip trips on the first correctness failure. */
export const BREAKER_CORRECTNESS_FAILURES = 1;
/** Cooldown before an open breaker may probe (milliseconds). */
export const BREAKER_COOLDOWN_MS = 30_000;
/** Consecutive successful probes required to advance a state. */
export const BREAKER_PROBE_COUNT = 3;
/** Exponential retry base: 30s * 2^attempt, capped, ±10% jitter. */
export const BREAKER_RETRY_BASE_MS = 30_000;
export const BREAKER_RETRY_CAP_MS = 15 * 60_000;
export const BREAKER_RETRY_JITTER = 0.1;
/** Promotion hysteresis: failure rate must be < this and p95 within budget. */
export const BREAKER_HYSTERESIS_FAILURE_RATE = 0.02;
export const BREAKER_HYSTERESIS_BUDGET_P95_MS = 50;
/** Minimum healthy residence before a further promotion (milliseconds). */
export const BREAKER_MIN_HEALTHY_RESIDENCE_MS = 5 * 60_000;
