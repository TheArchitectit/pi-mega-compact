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
