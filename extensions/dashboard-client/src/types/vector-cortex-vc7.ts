/**
 * dashboard-client/src/types/vector-cortex-vc7.ts — VC7-era client view types.
 *
 * Extracted from vector-cortex.ts to keep the parent file under the 300-line
 * soft limit (soft-as-hard gate). Each interface mirrors a reader-only server
 * API contract: counts + codes only, never prompt payloads, digests, or session
 * bytes.
 */

/**
 * Reader-only frozen-crystal cache view (VC7A). Counts + byte volumes + CRY_*
 * codes only — a crystal is a rendered prompt, so no frozen bytes, covered
 * ranges, digests, or session ids ever reach the client.
 */
export interface VectorCortexCrystalsView {
  enabled: boolean;
  mode: "A" | "B" | "C";
  crystalCount: number;
  totalBytes: number;
  hits: number;
  misses: number;
  hitBytes: number;
  writes: number;
  duplicateWrites: number;
  collisions: number;
  lastFailure: string | null;
  updatedAt: string;
}

/**
 * Reader-only cache-economics diagnostics view (VC7B). Counts + ECON_* codes only
 * — never prices, digests, ranges, or session ids.
 */
export interface VectorCortexEconomicsView {
  enabled: boolean;
  mode: "A" | "B" | "C";
  profileCount: number;
  provenExclusions: number;
  unprovenExclusions: number;
  lastFailure: string | null;
  updatedAt: string;
}

/**
 * Reader-only cache miss-diagnostics view (VC7C). One count per EXCLUSIVE miss
 * class plus breaker state and CACHE_* / M5_* codes only — a miss diagnostic would
 * otherwise carry the missed request itself, so no request payload, request
 * digest, covered range, span digest, or session id ever reaches the client.
 */
export interface VectorCortexDiagnosticsView {
  enabled: boolean;
  mode: "A" | "B" | "C";
  profileMisses: number;
  rangeMisses: number;
  dependencyMisses: number;
  requestMisses: number;
  generationMisses: number;
  unknownMisses: number;
  serveBlocked: number;
  breakerState: string;
  lastFailure: string | null;
  updatedAt: string;
}
