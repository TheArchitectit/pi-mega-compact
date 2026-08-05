/**
 * api-contracts/vector-cortex-economics.ts — VC7B cache-economics API contract.
 *
 * PREVENT-PI-004: type definitions only, no network code.
 * PREVENT-011: no `any` type.
 *
 * Reader-only GET /api/vector-cortex/cache-economics diagnostics view (VC7B).
 *
 * COUNTS + CODES ONLY. Cache economics price a FROZEN RENDERED PROMPT's reuse, so
 * this is the surface where an unguarded payload field would leak the frozen
 * bytes, the covered ranges, the span/covered digests, the request digests, or
 * the session ids that identify the framed conversation. It exposes ONLY:
 *   - whether the VC7B flag is enabled and the runtime triad mode it implies;
 *   - how many provider profiles carry economics and how many exclusions are
 *     proven vs unproven (a count, never the excluded pointer or its bytes);
 *   - the last ECON_* rejection code (an outcome code, not a payload).
 * Per-profile prices, digests, ranges, and session ids live in the structured
 * event log / conformance corpus, never here (SECURITY_PRIVACY).
 */

/** Runtime triad mode implied by the VC7B flag state. */
export type VectorCortexEconomicsMode = "A" | "B" | "C";

/**
 * Reader-only cache-economics diagnostics view for
 * GET /api/vector-cortex/cache-economics (VC7B).
 */
export interface VectorCortexEconomicsView {
  /** Whether the VC7B cache-economics flag is enabled. */
  readonly enabled: boolean;
  /**
   * Runtime triad mode: "A" economics applied to a cached/compiled render,
   * "B" economics computed against an uncached fresh render,
   * "C" economics bypassed (flag off) so no economics are served.
   */
  readonly mode: VectorCortexEconomicsMode;
  /** Provider profiles that declare cache economics (a count, not the prices). */
  readonly profileCount: number;
  /** Exclusions that carry a proving fixture id (count only). */
  readonly provenExclusions: number;
  /** Exclusions rejected for lacking a fixture id (count only). */
  readonly unprovenExclusions: number;
  /** Last economics rejection reason (an ECON_* code), or null if none. */
  readonly lastFailure: string | null;
  /** ISO timestamp of the snapshot. */
  readonly updatedAt: string;
}
