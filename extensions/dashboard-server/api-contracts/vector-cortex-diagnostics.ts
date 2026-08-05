/**
 * api-contracts/vector-cortex-diagnostics.ts — VC7C cache-diagnostics API
 * contract.
 *
 * PREVENT-PI-004: type definitions only, no network code.
 * PREVENT-011: no `any` type.
 *
 * Reader-only GET /api/vector-cortex/cache-diagnostics view (VC7C).
 *
 * COUNTS + CODES ONLY, and this surface is the most dangerous one in the whole
 * VC7 cache phase. A cache MISS DIAGNOSTIC exists to answer "why did this exact
 * request not hit the cache?", and the honest answer is naturally phrased in
 * terms of the very things that must never leave the process: the full request
 * payload that was hashed, its RequestHashV2 digest, the covered source ranges,
 * the span/covered digests, the provider profile digest and the session id that
 * frames the conversation. Every one of those is precisely the evidence a
 * debugger would want inline — which is exactly why an unguarded diagnostic
 * field here leaks the framed conversation itself (SECURITY_PRIVACY). The
 * classification is therefore projected down to a COUNT PER MISS CLASS before it
 * ever reaches this contract: the class names are a closed enumeration fixed by
 * the sprint, so a count discloses nothing about content.
 *
 * This view exposes ONLY:
 *   - whether the VC7C flag is enabled and the runtime triad mode it implies;
 *   - one count per exclusive miss class (profile, range, dependency, request,
 *     generation, unknown) — classification is exclusive, so a single miss
 *     increments exactly one of these six counters and they sum to the total;
 *   - how many cache serves the breaker blocked (a count, never the blocked key
 *     or the entry it would have served);
 *   - the breaker's observable state and the last CACHE/M5 rejection code.
 * Request payloads, request digests, covered ranges, span digests, profile
 * digests, and session ids live in the structured event log / conformance
 * corpus, never here.
 */

/** Runtime triad mode implied by the VC7C flag state. */
export type VectorCortexDiagnosticsMode = "A" | "B" | "C";

/**
 * Reader-only cache-diagnostics view for
 * GET /api/vector-cortex/cache-diagnostics (VC7C).
 */
export interface VectorCortexDiagnosticsView {
  /** Whether the VC7C cache-diagnostics flag is enabled. */
  readonly enabled: boolean;
  /**
   * Runtime triad mode: "A" a crystal was served from cache,
   * "B" a fresh render was forced by a breaker condition,
   * "C" all caches are bypassed (flag off, or render and cache diagnostics
   * disagree) so nothing is served from cache.
   */
  readonly mode: VectorCortexDiagnosticsMode;
  /** Misses classified as a provider-profile mismatch (count only). */
  readonly profileMisses: number;
  /** Misses classified as a covered-range mismatch (count only). */
  readonly rangeMisses: number;
  /** Misses classified as a dependency high-water mismatch (count only). */
  readonly dependencyMisses: number;
  /** Misses classified as a request (RequestHashV2) mismatch (count only). */
  readonly requestMisses: number;
  /** Misses classified as a stale/invalidated generation (count only). */
  readonly generationMisses: number;
  /** Misses no earlier class claimed — the terminal fallback (count only). */
  readonly unknownMisses: number;
  /**
   * Cache serves the breaker demoted BEFORE serving, on collision, stale
   * generation, digest failure, or profile mismatch (a count, never the key).
   */
  readonly serveBlocked: number;
  /** Observable cache-breaker state (a state name, not a payload). */
  readonly breakerState: string;
  /** Last diagnostics rejection reason (a CACHE or M5 code), or null. */
  readonly lastFailure: string | null;
  /** ISO timestamp of the snapshot. */
  readonly updatedAt: string;
}
