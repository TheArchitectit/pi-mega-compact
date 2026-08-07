/**
 * api-contracts/vector-cortex-ledger.ts — VC1B occurrence-ledger surface.
 *
 * Extracted from `vector-cortex.ts` so the combined api-contracts module stays
 * under the 400-line `extensions/` soft limit. Owns the reader-only ledger
 * views (VC1B aggregate + identity rows). PREVENT-PI-004: type definitions
 * only, no network code. PREVENT-011: no `any` type.
 */

/** Live-state derivation shared across the VC views (mirrors vector-cortex.ts). */
type VcStatus = "live" | "awaiting_data" | "deferred" | "structural" | "off";

/**
 * Reader-only occurrence-ledger identity view for GET /api/vector-cortex/ledger (VC1B).
 * Built on the LedgerReader capability surface. Exposes occurrence IDENTITY
 * (seq/eventId/kind/digest/toolCallId) and the per-session high-water/count —
 * NEVER sourceBytes or prompt text, honoring the reader-only no-ledger-text rule.
 */
export interface VectorCortexLedgerView {
  /** Whether the VC1B occurrence ledger flag is enabled in this process. */
  readonly enabled: boolean;
  /** The ledger session whose occurrences are returned. */
  readonly session: string;
  /** Durable contiguous high-water (stringified bigint) for the session. */
  readonly highWater: string;
  /** Number of accepted occurrences for the session. */
  readonly count: number;
  /** Capped identity rows (ascending seq). No source bytes, never payload text. */
  readonly occurrences: readonly {
    readonly seq: string;
    readonly eventId: string;
    readonly kind: string;
    readonly digest: string;
    readonly toolCallId?: string;
  }[];
  /** ISO timestamp of the snapshot. */
  readonly updatedAt: string;
  readonly status?: VcStatus;
}
