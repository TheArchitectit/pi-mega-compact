/**
 * api-contracts/vector-cortex.ts — vector-cortex dashboard API contracts.
 *
 * Owned by the vector-cortex sprints. VC0A ships only the reader-only aggregate
 * `GET /api/vector-cortex/evaluation`. VC0C adds the breaker health endpoint
 * and reset mutation into this SAME file — keep entries small and additive so
 * the file stays within extension limits (400 soft / 500 hard).
 *
 * PREVENT-PI-004: type definitions only, no network code.
 * PREVENT-011: no `any` type.
 */

/**
 * Aggregate evaluation summary for GET /api/vector-cortex/evaluation.
 * Reader-only: exposes aggregates (histogram cells, counts), never payloads or
 * exact ledger text.
 */
export interface VectorCortexEvaluationSummary {
  /** Whether the VC0A observer flag is enabled in this process. */
  readonly enabled: boolean;
  /** Triad observer mode reflected in the summary ("C" when observer absent). */
  readonly mode: "A" | "B" | "C";
  /** Total evaluation samples aggregated. */
  readonly samples: number;
  /** Per-mode sample distribution. */
  readonly byMode: {
    readonly A: number;
    readonly B: number;
    readonly C: number;
  };
  /** Fixed latency histogram (inclusive edges, separate overflow). */
  readonly histogram: {
    readonly edges: readonly number[];
    readonly cells: readonly number[];
    readonly overflow: number;
    readonly total: number;
  };
  /** Evaluator rejections (EVAL_*) observed in this window. */
  readonly rejects: readonly string[];
  /** ISO timestamp of the summary. */
  readonly updatedAt: string;
}

/**
 * Health-card aggregate for GET /api/vector-cortex/health. Reader-only: exposes
 * breaker state, window/probe/backoff, and durable spool frontier/authority/lag
 * aggregates — never payloads, prompts, or exact ledger text.
 */
export interface VectorCortexHealthCard {
  /** Whether the VC0C safety envelope is enabled in this process. */
  readonly enabled: boolean;
  /** Selected triad mode ("A" healthy, "B" spool fallback, "C" unchanged). */
  readonly mode: "A" | "B" | "C";
  /** Breaker state: CLOSED_A | OPEN_B | OPEN_C | PROBE_B | PROBE_A | MANUAL_HALT. */
  readonly state: string;
  /** Tracked subsystem (this shell owns the "provider" breaker). */
  readonly subsystem: string;
  /** Milliseconds since the last transition. */
  readonly sinceMs: number;
  /** Manual halt reason, when MANUAL_HALT. */
  readonly reason?: string;
  /** Rolling window length (ms). */
  readonly windowMs: number;
  /** Consecutive successful probes. */
  readonly probeCount: number;
  /** Current exponential backoff delay (ms). */
  readonly backoffDelayMs: number;
  /** Derived frontier frozen by an authority outage. */
  readonly frontierFrozen: boolean;
  /** Authority (mode-A ledger) currently in outage. */
  readonly authorityOutage: boolean;
  /** Durable spool unacknowledged tail (records awaiting authority commit). */
  readonly spoolLag: number;
  /** Rolling window attempt count. */
  readonly attempts: number;
  /** Rolling window failure count. */
  readonly failures: number;
  /** Rolling window p95 latency (ms). */
  readonly p95Ms: number;
  /** Rolling window failure rate (0..1). */
  readonly failureRate: number;
  /** ISO timestamp of the snapshot. */
  readonly updatedAt: string;
  /** Worst aggregate state across all health cards (this shell has one). */
  readonly aggregate: string;
  /**
   * Breaker state source. "ephemeral" (the ONLY value until VC0D) = this breaker
   * is per-process/in-memory, rebuilt on every request — NOT a live persistent
   * breaker; the dashboard/README must not present it as live. "live" appears
   * only once the persistent breaker runtime + producer wiring land (VC0D).
   */
  readonly stateSource: "ephemeral" | "live";
}

/**
 * Response for POST /api/vector-cortex/breakers/reset. Admin capability: clears
 * cooldown but never evidence (failures/attempts retained) or unwires a
 * MANUAL_HALT. Returns the post-reset breaker record (aggregate, never payloads).
 */
export interface VectorCortexResetResult {
  readonly subsystem: string;
  readonly state: string;
  readonly cooldownCleared: boolean;
  readonly attempts: number;
  readonly failures: number;
  readonly probeCount: number;
  readonly manualReason?: string;
  readonly updatedAt: string;
}
