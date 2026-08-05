/**
 * api-contracts/vector-cortex-heal.ts — VC6A+ heal API contracts.
 *
 * Extracted from vector-cortex.ts to keep both files under the 400-line
 * extension soft limit. Owns the reader-only closure-optimization and
 * restoration diagnostic views emitted by the heal sprint handlers.
 *
 * PREVENT-PI-004: type definitions only, no network code.
 * PREVENT-011: no `any` type.
 */

/**
 * Reader-only closure-optimization diagnostics view for
 * GET /api/vector-cortex/closure-proof (VC6A).
 *
 * AGGREGATE + IDENTITY ONLY: counts and the runtime mode. It deliberately does
 * NOT carry the per-edge proof rows, node ids, the closed selection, or any
 * source payload (SECURITY_PRIVACY — reader-only, no ledger text rendered through
 * a diagnostic surface). The detailed proof lives in the structured event log,
 * not the dashboard.
 */
export interface VectorCortexClosureProofView {
  /** Whether the VC6A advanced-closure-optimization flag is enabled. */
  readonly enabled: boolean;
  /** Runtime triad mode of the most recent closure: "A" | "B" | "C". */
  readonly mode: "A" | "B" | "C";
  /** Total optimizations produced (event counter). */
  readonly optimizations: number;
  /** Total proofs rejected by the verifier (event counter). */
  readonly proofRejections: number;
  /** Cumulative retained edges across observed optimizations. */
  readonly retainedEdgeTotal: number;
  /** Cumulative removed edges across observed optimizations. */
  readonly removedEdgeTotal: number;
  /** Cumulative conservative traversal-walk count. */
  readonly conservativeTraversalTotal: number;
  /** Cumulative optimized traversal-walk count. */
  readonly optimizedTraversalTotal: number;
  /** Last rejection reason (a HEAL_* code), or null if none yet. */
  readonly lastRejection: string | null;
  /** ISO timestamp of the snapshot. */
  readonly updatedAt: string;
}

/**
 * Reader-only exact-source-restoration diagnostics view for
 * GET /api/vector-cortex/restore (VC6B).
 *
 * COUNTS + ERROR CODES ONLY. There is NO payload endpoint for restoration, ever:
 * this view deliberately carries no restored bytes, span ids, node ids, byte
 * ranges, shard identifiers, or ledger text (SECURITY_PRIVACY — the exact ledger
 * is never rendered through a diagnostic surface). Only the restore counters and
 * the last HEAL_RESTORE_* failure code are exposed; the per-span detail lives in
 * the structured event log, not the dashboard.
 */
export interface VectorCortexRestoreView {
  /** Whether the VC6B exact-source-restoration flag is enabled. */
  readonly enabled: boolean;
  /** Runtime triad mode: "A" exact shard, "B" ledger range scan, "C" loss disclosed. */
  readonly mode: "A" | "B" | "C";
  /** Total restore attempts observed (event counter). */
  readonly restoreAttempts: number;
  /** Spans restored with a verified SHA-256 digest (event counter). */
  readonly restoredCount: number;
  /** Spans with no exact source available (HEAL_RESTORE_SOURCE_MISSING). */
  readonly missingCount: number;
  /** Restores rejected by digest verification (HEAL_RESTORE_DIGEST_MISMATCH). */
  readonly digestRejections: number;
  /** Last rejection reason (a HEAL_RESTORE_* code), or null if none yet. */
  readonly lastRejection: string | null;
  /** ISO timestamp of the snapshot. */
  readonly updatedAt: string;
}

/**
 * Reader-only self-healing derived-state diagnostics view for
 * GET /api/vector-cortex/repair (VC6C).
 *
 * COUNTS + ERROR CODES ONLY. Like the restore view, this surface deliberately
 * carries no payload: no subsystem source bytes, no rebuilt derived rows, no
 * subsystem names paired with their gap ranges, no high-water values, no root
 * digests, and no ledger text (SECURITY_PRIVACY — a diagnostic surface never
 * renders the authority's contents). Only the controller's rebuild counters,
 * the backoff schedule's observable timing, and the last HEAL_REPAIR_* failure
 * code are exposed; the per-subsystem gap detail lives in the structured event
 * log, not the dashboard.
 */
export interface VectorCortexRepairView {
  /** Whether the VC6C self-healing derived-controller flag is enabled. */
  readonly enabled: boolean;
  /**
   * Runtime triad mode: "A" targeted single-subsystem rebuild, "B" full
   * deterministic rebuild (ambiguous gap), "C" derived state disabled (both
   * rebuild paths failed, or the controller is not running at all).
   */
  readonly mode: "A" | "B" | "C";
  /** Total rebuild attempts started by the controller (event counter). */
  readonly repairAttempts: number;
  /** Rebuilds planned after gap detection, before rate limiting (counter). */
  readonly repairsPlanned: number;
  /** Rebuilds that reached a verified atomic pointer switch (counter). */
  readonly pointersSwitched: number;
  /** Attempts deferred by the rate limiter / exponential backoff (counter). */
  readonly backoffs: number;
  /** Most recent deterministic backoff delay in ms, or null if none yet. */
  readonly lastBackoffMs: number | null;
  /** Last failure reason (a HEAL_REPAIR_* code), or null if none yet. */
  readonly lastFailure: string | null;
  /** ISO timestamp of the snapshot. */
  readonly updatedAt: string;
}
