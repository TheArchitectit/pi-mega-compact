/**
 * config/vector-cortex.ts — vector-cortex feature flags + breaker/triad constants.
 *
 * Every sprint ships one positive `MEGACOMPACT_<SPRINT>` flag, default ON and
 * `=0`/`_DISABLED` off. Flag-OFF is byte-identical to the predecessor sprint's
 * behavior (for VC0A: mode C — observer absent, zero evaluation writes).
 *
 * The breaker/triad constants (TRIAD_RESILIENCE.md) live here so VC0C consumes
 * them without re-declaring the ownership boundary. Pi-agnostic, dependency-free.
 */

/** Positive sprint flag: `=0` or `_DISABLED=true` disables (default ON). */
function sprintFlag(name: string): boolean {
  const v = process.env[name];
  if (v === "0" || v === "false") return false;
  const disabled = process.env[name + "_DISABLED"];
  if (disabled === "true" || disabled === "1") return false;
  return true;
}

/** VC0A — baseline observability (MetricEventV1 / AnnotationV1). Default ON. */
export const VC0A_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC0A");

/**
 * VC0B — replay correctness (ReplayCutV2 / ReplayReportV2, M3 effective-cut-v2).
 * Default ON. `MEGACOMPACT_VC0B=0` disables and is byte-identical to the
 * predecessor (legacy capped-replay behavior preserved; the v2 cut/replay is
 * only consulted on the vector-cortex path).
 */
export const VC0B_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC0B");

/**
 * VC1A — canonical byte events (EventV2 / EventCodec).
 * Default ON. `MEGACOMPACT_VC1A=0` disables and is byte-identical to the
 * predecessor (mode C: ledger absent, current transcript codec unchanged).
 * The single real consumer is the ledger emit seam (`ledger/emit.ts`): flag OFF
 * gates zero observability writes.
 */
export const VC1A_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC1A");

/**
 * VC0C — live safety envelope (TriadResult / Breaker / KillDecision + durable
 * spool). Default ON. `MEGACOMPACT_VC0C=0` disables and is byte-identical to
 * the predecessor (mode C: selected before provider invocation, unchanged host
 * transcript, breaker/spool idle and emitting nothing). The single real
 * consumer is the resilience emit seam + the safety adapter's triad selection.
 */
export const VC0C_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC0C");

// ---------------------------------------------------------------------------
// Breaker state machine constants (TRIAD_RESILIENCE.md §breaker).
// Rolled numbers for one 60s window; VC0C consumes these at its breaker seam.
// ---------------------------------------------------------------------------

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
