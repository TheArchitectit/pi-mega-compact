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
