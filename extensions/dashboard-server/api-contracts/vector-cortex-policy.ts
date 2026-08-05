/**
 * api-contracts/vector-cortex-policy.ts — VC8B shadow adaptive policy API contract.
 *
 * PREVENT-PI-004: type definitions only, no network code.
 * PREVENT-011: no `any` type.
 *
 * Reader-only GET /api/vector-cortex/policy diagnostics view (VC8B).
 * COUNTS + CODES ONLY. The policy engine carries no payload — this surface
 * exposes only aggregate decision counts and machine codes, never session
 * content, prompt bytes, or free-text.
 */

/** Runtime triad mode implied by the VC8B flag state. */
export type VectorCortexPolicyMode = "A" | "B" | "C";

/** Reader-only policy + shadow aggregate view for GET /api/vector-cortex/policy. */
export interface VectorCortexPolicyView {
  /** Whether the VC8B policy flag is enabled. */
  readonly enabled: boolean;
  /** Runtime triad mode: A=shadow candidate, B=static calibrated, C=fixed legacy. */
  readonly mode: VectorCortexPolicyMode;
  /** Total shadow decisions evaluated (count only). */
  readonly shadowDecisions: number;
  /** Decisions whose budget was clamped at a bound (count only). */
  readonly clampedDecisions: number;
  /** Shadow rejections (unknown pressure / bad bounds) (count only). */
  readonly rejectedInputs: number;
  /** Live mutations detected (structurally always 0). */
  readonly liveMutations: number;
  /** M7 migration state: active pressure version (1 or 2). */
  readonly pressureVersion: number;
  /** Last POL_ or M7_ failure code, or null if none. */
  readonly lastFailure: string | null;
  /** ISO timestamp of the snapshot. */
  readonly updatedAt: string;
  /** Present when the shadow controller is not yet instantiated, with a reason. */
  readonly deferredReason?: string;
}
