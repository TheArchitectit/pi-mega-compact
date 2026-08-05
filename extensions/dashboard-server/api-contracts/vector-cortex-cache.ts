/**
 * api-contracts/vector-cortex-cache.ts — VC7A frozen-range-crystal API contract.
 *
 * Split from vector-cortex-heal.ts (a separate concern, not a size overflow):
 * crystals are a derived CACHE, not a repair path, and keeping the contract in
 * its own file leaves both well under the 400-line extension limit as VC7B lands.
 *
 * PREVENT-PI-004: type definitions only, no network code.
 * PREVENT-011: no `any` type.
 */

/**
 * Reader-only frozen-crystal cache diagnostics view for
 * GET /api/vector-cortex/cache-crystals (VC7A).
 *
 * COUNTS + BYTES ONLY. A crystal IS a rendered prompt, which makes this the one
 * surface where an unguarded payload field would dump the entire framed
 * conversation into the dashboard. So the view carries no frozen bytes, no
 * covered source ranges, no span or covered digests, no session ids, and no
 * request digests (SECURITY_PRIVACY — the exact ledger is not diagnostic data).
 * Only aggregate counters and the observable byte volumes are exposed; per-key
 * detail lives in the structured event log, not here.
 */
export interface VectorCortexCrystalsView {
  /** Whether the VC7A frozen-range-crystal flag is enabled. */
  readonly enabled: boolean;
  /**
   * Runtime triad mode: "A" crystal store hit, "B" miss/collision forced a
   * fresh deterministic render, "C" store unavailable so the cache is bypassed
   * and nothing is served from it.
   */
  readonly mode: "A" | "B" | "C";
  /** Distinct crystals currently held by the store. */
  readonly crystalCount: number;
  /** Aggregate frozen bytes held across all crystals. */
  readonly totalBytes: number;
  /** Reads answered from the store (mode A). */
  readonly hits: number;
  /** Reads with no stored crystal, forcing a fresh render (mode B). */
  readonly misses: number;
  /** Bytes served from hits — the cache's observable benefit. */
  readonly hitBytes: number;
  /** First writes that actually published a crystal. */
  readonly writes: number;
  /** Idempotent re-writes of byte-identical crystals. */
  readonly duplicateWrites: number;
  /** Same-key, different-bytes writes refused (CRY_KEY_COLLISION). */
  readonly collisions: number;
  /** Last failure reason (a CRY_* code), or null if none yet. */
  readonly lastFailure: string | null;
  /** ISO timestamp of the snapshot. */
  readonly updatedAt: string;
  /**
   * Present when the underlying subsystem is not fully wired yet, explaining
   * why emit-only counters are reported instead of live cache-serve integration.
   */
  readonly deferredReason?: string;
}
