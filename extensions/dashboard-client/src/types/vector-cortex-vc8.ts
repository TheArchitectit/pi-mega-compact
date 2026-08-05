/**
 * dashboard-client/src/types/vector-cortex-vc8.ts — VC8-era client view types.
 *
 * Extracted from vector-cortex.ts to keep the parent file under the 300-line
 * soft limit (soft-as-hard gate). Each interface mirrors a reader-only server
 * API contract: counts + codes only, never prompt payloads, response text,
 * or free-text.
 */

/**
 * Reader-only outcomes aggregate view (VC8A). Counts + OUT_ codes only —
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

/**
 * Reader-only shadow adaptive policy aggregate view (VC8B). Counts + POL_ and
 * M7_ codes only — the policy engine carries no payload, so no prompt bytes,
 * session content, or free-text ever reaches the client.
 */
export interface VectorCortexPolicyView {
  enabled: boolean;
  mode: "A" | "B" | "C";
  shadowDecisions: number;
  clampedDecisions: number;
  rejectedInputs: number;
  liveMutations: number;
  pressureVersion: number;
  lastFailure: string | null;
  updatedAt: string;
}

/**
 * Reader-only engine parity/selection aggregate view (VC8C). Counts + RUST_
 * codes only — the selector carries no payload, so no artifact bytes, output
 * bytes, or free-text ever reaches the client.
 */
export interface VectorCortexPlatformView {
  enabled: boolean;
  mode: "A" | "B" | "C";
  fixtureCount: number;
  passed: number;
  failed: number;
  externalRunnerConfigured: boolean;
  lastFailure: string | null;
  updatedAt: string;
}
