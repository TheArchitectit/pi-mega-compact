/**
 * api-contracts/vector-cortex-outcomes.ts — VC8A outcomes API contract.
 *
 * PREVENT-PI-004: type definitions only, no network code.
 * PREVENT-011: no `any` type.
 *
 * Reader-only GET /api/vector-cortex/outcomes diagnostics view (VC8A).
 * COUNTS + CODES ONLY. The outcome ledger carries metrics without payload,
 * so this surface exposes only aggregate counts and the observable OUT_*
 * outcome codes — never session content, prompt bytes, response text, or
 * free-text. Consent admin API is audited separately.
 */

/** Runtime triad mode implied by the VC8A flag state. */
export type VectorCortexOutcomesMode = "A" | "B" | "C";

/**
 * Reader-only outcomes aggregate view for
 * GET /api/vector-cortex/outcomes (VC8A).
 */
export interface VectorCortexOutcomesView {
  /** Whether the VC8A outcomes flag is enabled. */
  readonly enabled: boolean;
  /** Runtime triad mode: A=consented learned-policy dataset, B=redacted aggregate stats, C=no learning. */
  readonly mode: VectorCortexOutcomesMode;
  /** Total outcomes appended to the ledger (count only). */
  readonly outcomeCount: number;
  /** Sessions with active explicit consent (count only). */
  readonly consentedSessions: number;
  /** Sessions revoked (count only). */
  readonly revokedSessions: number;
  /** Dataset manifests built (count only). */
  readonly manifestCount: number;
  /** Records excluded from manifests (count only). */
  readonly excludedCount: number;
  /** Last OUT_* failure code, or null if none. */
  readonly lastFailure: string | null;
  /** ISO timestamp of the snapshot. */
  readonly updatedAt: string;
  /** Live-state derivation for the dashboard (off/awaiting_data/deferred/structural). */
  readonly status?: "live" | "awaiting_data" | "deferred" | "structural" | "off";
}

/** Consent admin API request body (audited). */
export interface ConsentAdminRequest {
  readonly sessionId: string;
  readonly action: "grant" | "revoke";
}

/** Consent admin API response (audited). */
export interface ConsentAdminResponse {
  readonly ok: boolean;
  readonly sessionId: string;
  readonly action: "grant" | "revoke";
  readonly effectiveSeq: number;
  readonly audited: boolean;
}
