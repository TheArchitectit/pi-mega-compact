/**
 * vector-cortex/resilience/types.ts — VC0C breaker/triad contracts (VC0C).
 *
 * Owns `Mode`, `TriadResult<T>`, `BreakerRecord`, `KillDecision`, and the
 * `Breaker` circuit-breaker seam from CONTRACTS.md §TriadResult and breaker
 * seam, plus the durable spool record shapes. Pure type/schema definitions +
 * small pure predicates (no storage, no console, no network, no side effects —
 * PREVENT-PI-004 / PREVENT-011). The live state machine lives in
 * `breaker.ts`/`spool.ts`; the safety adapter selects A→B→C in
 * `extensions/mega-runtime/vector-cortex-safety.ts`.
 *
 * Triad semantics (TRIAD_RESILIENCE.md): A is optimized/learned; B is
 * deterministic/local and derives directly from authority; C is continuity, not
 * semantic completeness — it uses only the exact current transcript and reports
 * that limitation.
 */

/** Triad execution modes: A optimized/learned, B deterministic/local, C continuity. */
export type Mode = "A" | "B" | "C";

/** Breaker circuit states (TRIAD_RESILIENCE.md §breaker state machine). */
export type BreakerState =
  | "CLOSED_A"
  | "OPEN_B"
  | "OPEN_C"
  | "PROBE_B"
  | "PROBE_A"
  | "MANUAL_HALT";

/** The type of trip that opened or is being tracked on a window. */
export type BreakerTripKind = "performance" | "correctness" | "manual";

/**
 * A snapshot of the breaker from the perspective of one triad execution. Mirrors
 * the contract shape `breaker: BreakerRecord` on `TriadResult<T>`. All window /
 * cooldown / residence fields are MONOTONIC elapsed milliseconds; wall time
 * appears only on the `updatedAt` record timestamp. The `frozenFrontier` field
 * records whether derived frontiers were frozen by an authority outage.
 */
export interface BreakerRecord {
  /** Per-subsystem breaker identity. */
  readonly subsystem: string;
  /** Current circuit state. */
  readonly state: BreakerState;
  /** Monotonic start of the current rolling eligibility window (ms). */
  readonly windowStartMs: number;
  /** Attempts observed within the current window. */
  readonly attempts: number;
  /** Failures observed within the current window. */
  readonly failures: number;
  /** Trip kind of the failure that most recently opened the breaker. */
  readonly tripKind: BreakerTripKind;
  /** Monotonic time when the breaker entered its current state (ms). */
  readonly transitionedAtMs: number;
  /** Monotonic time when a current cooldown started (ms), or undefined. */
  readonly cooldownUntilMs?: number;
  /** Recovery-probe count already satisfied in the current probe phase. */
  readonly probeCount: number;
  /** Exponential backoff attempt index (0 before any backoff increment). */
  readonly retryAttempt: number;
  /** Backoff delay currently in force (ms, with deterministic ±10% jitter). */
  readonly retryDelayMs: number;
  /** Whether derived frontiers are frozen by an authority outage. */
  readonly frozenFrontier: boolean;
  /** Reason captured on a manual halt (present only in MANUAL_HALT). */
  readonly manualReason?: string;
  /** Wall-clock ISO timestamp of the last state transition (records only). */
  readonly updatedAt: string;
  /** Approximate p95 latency over the current window (ms), for hysteresis. */
  readonly p95Ms: number;
  /** Failure rate over the current window (0..1), for hysteresis. */
  readonly failureRate: number;
}

/**
 * The discriminated result every critical operation returns (CONTRACTS.md).
 * A successful head carries its output plus the breaker snapshot; a failure
 * carries a code and a retryability flag plus the same breaker snapshot.
 */
export type TriadResult<T> =
  | {
      ok: true;
      value: T;
      mode: Mode;
      inputDigest: string;
      outputDigest: string;
      algorithmVersion: string;
      latencyMs: number;
      breaker: BreakerRecord;
    }
  | {
      ok: false;
      mode: Mode;
      code: string;
      retryable: boolean;
      breaker: BreakerRecord;
    };

/**
 * KillDecision — the VC0C decision to demote before provider invocation.
 * Correctness demotion before the provider call is required in 100% of chaos
 * cases (sprint acceptance). `mode` is the mode actually selected; `demoteTo`
 * is the lower mode the current head demotes to (C is terminal continuity).
 */
export interface KillDecision {
  readonly session: string;
  readonly subsystem: string;
  readonly reason: string;
  readonly code: string;
  readonly demoteTo: Mode;
  readonly state: BreakerState;
  readonly frozenFrontier: boolean;
  readonly atMs: number;
}

/**
 * The circuit-breaker seam (CONTRACTS.md). `execute` runs the triad A→B→C and
 * returns a `TriadResult<T>`; `recordProbe` advances recovery probes;
 * `manualHalt` requires a reason and `reset` (admin) clears cooldown but never
 * evidence.
 */
export interface Breaker {
  execute<T>(
    subsystem: string,
    inputDigest: string,
    run: Record<Mode, () => T>,
    validate: (v: T) => boolean,
  ): TriadResult<T>;
  recordProbe(subsystem: string): BreakerRecord;
  manualHalt(reason: string): BreakerRecord;
}

/**
 * Registered TRI conformance ID range (TRI-001..030). The acceptance test reads
 * these rows from the v2 `resilience/` domain and asserts each returns its
 * manifest bytes or exactly its listed failure code. TRI-001..015 are owned by
 * VC0C (window/probe/hysteresis/cooldown transitions); TRI-016..030 span the
 * spool protocol (frame, drain, gap, digest conflict, ack crash, frozen
 * frontier). Mirrors EVT_IDS / CUT_IDS / M3_IDS.
 */
export const TRI_IDS = [
  "TRI-001", "TRI-002", "TRI-003", "TRI-004", "TRI-005",
  "TRI-006", "TRI-007", "TRI-008", "TRI-009", "TRI-010",
  "TRI-011", "TRI-012", "TRI-013", "TRI-014", "TRI-015",
  "TRI-016", "TRI-017", "TRI-018", "TRI-019", "TRI-020",
  "TRI-021", "TRI-022", "TRI-023", "TRI-024", "TRI-025",
  "TRI-026", "TRI-027", "TRI-028", "TRI-029", "TRI-030",
] as const;

/**
 * Acknowledgment outcome of a spool frame drain against the durable ledger.
 * `SPOOL_IDEMPOTENT_ACK` acknowledges a duplicate with the same digest; a
 * conflicting digest is `SPOOL_MANUAL_HALT` (never acknowledged).
 */
export type SpoolDrainVerdict =
  | "SPOOL_COMMITTED"
  | "SPOOL_IDEMPOTENT_ACK"
  | "SPOOL_MANUAL_HALT";
