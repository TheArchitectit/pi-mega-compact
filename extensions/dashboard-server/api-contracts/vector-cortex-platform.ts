/**
 * api-contracts/vector-cortex-platform.ts — VC8C engine parity/selection API contract.
 *
 * PREVENT-PI-004: type definitions only, no network code.
 * PREVENT-011: no `any` type.
 *
 * Reader-only GET /api/vector-cortex/platform diagnostics view (VC8C).
 * COUNTS + CODES ONLY. The selector carries no payload — this surface exposes
 * only the engine selection mode, parity counts, and machine codes, never
 * artifact bytes, output bytes, or free-text.
 */

/** Runtime triad mode implied by the VC8C flag state. */
export type VectorCortexPlatformMode = "A" | "B" | "C";

/** Reader-only engine parity/selection aggregate view for GET /api/vector-cortex/platform. */
export interface VectorCortexPlatformView {
  /** Whether the VC8C platform flag is enabled. */
  readonly enabled: boolean;
  /** Runtime triad mode: A=qualified external Rust, B=TS reference, C=legacy path. */
  readonly mode: VectorCortexPlatformMode;
  /** Total fixtures in the parity matrix (count only). */
  readonly fixtureCount: number;
  /** Fixtures that passed byte-equal comparison (count only). */
  readonly passed: number;
  /** Fixtures that mismatched (count only). */
  readonly failed: number;
  /** Whether an external Rust runner is configured (boolean, no path). */
  readonly externalRunnerConfigured: boolean;
  /** Last RUST_ failure code, or null if none. */
  readonly lastFailure: string | null;
  /** ISO timestamp of the snapshot. */
  readonly updatedAt: string;
  /** Live-state derivation for the dashboard (off/awaiting_data/deferred/structural). */
  readonly status?: "live" | "awaiting_data" | "deferred" | "structural" | "off";
}
