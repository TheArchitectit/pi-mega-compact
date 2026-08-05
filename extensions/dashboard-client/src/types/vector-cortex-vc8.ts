/**
 * dashboard-client/src/types/vector-cortex-vc8.ts — VC8-era client view types.
 *
 * Extracted from vector-cortex.ts to keep the parent file under the 300-line
 * soft limit (soft-as-hard gate). Each interface mirrors a reader-only server
 * API contract: counts + codes only, never prompt payloads, response text,
 * or free-text.
 */

/**
 * Reader-only outcomes aggregate view (VC8A). Counts + OUT_* codes only —
 * the outcome ledger carries metrics without payload, so no prompt bytes,
 * response text, free-text, or session content ever reaches the client.
 */
export interface VectorCortexOutcomesView {
  enabled: boolean;
  mode: "A" | "B" | "C";
  outcomeCount: number;
  consentedSessions: number;
  revokedSessions: number;
  manifestCount: number;
  excludedCount: number;
  lastFailure: string | null;
  updatedAt: string;
}
