/**
 * api-contracts/setup-cortex.ts — Setup Cortex status API types (VC9A).
 *
 * Types for GET /api/setup-cortex-status, the reader-only aggregate that
 * surfaces the vector-cortex encoder gate (mode A/B/C, qualification verdict,
 * blockers, encoder health) in the dashboard Setup tab WITHOUT closing the ML
 * gate. Reader-only: never payloads/prompts/ledger (EVAL-REDACT-002).
 *
 * PREVENT-PI-004: type definitions only, no network code.
 * PREVENT-011: no `any` type — all types are explicit.
 */

import type { VcStatus } from "../vc-status.js";

/** One blocker row surfaced on the dashboard Setup Cortex blockers card. */
export interface BlockerV1 {
  /** Stable machine id (HG-1, HG-3, ...) keying the row. */
  readonly id: string;
  /** Human title shown on the blockers card. */
  readonly title: string;
  /** Severity: blocker | high | medium. */
  readonly severity: "blocker" | "high" | "medium";
  /** Lifecycle state — always "open" (hard gates not closed in-workstream). */
  readonly status: "open";
  /** Optional candidate resolution surfaced for the user / controller. */
  readonly resolution?: string;
}

/** The encoder qualification verdict projected for the reader (no calibration run). */
export type SetupCortexQualificationVerdict = "qualified" | "demoted" | "unavailable";

/** Reader-only view of the encoder health facts (digest prefix, no bytes). */
export interface SetupCortexEncoderHealth {
  /** First 12 hex chars of the committed asset-manifest digest, or null. */
  readonly assetDigestPrefix: string | null;
  /** Effective encoder triad mode (A verified / B demoted / C absent). */
  readonly mode: "A" | "B" | "C";
}

/**
 * Response for GET /api/setup-cortex-status.
 */
export interface SetupCortexStatusResponse {
  /** Whether the VC9A setup-cortex read path is active (its flag). */
  readonly enabled: boolean;
  /** The gating flag name ("MEGACOMPACT_VC9A"). */
  readonly flag: string;
  /** Effective encoder triad mode (A verified / B demoted / C absent / off). */
  readonly mode: "A" | "B" | "C";
  /** First 12 hex chars of the asset-manifest digest, or null. */
  readonly assetDigestPrefix: string | null;
  /** Qualification projection: verdict + any threshold failures surfaced. */
  readonly qualification: {
    readonly verdict: SetupCortexQualificationVerdict;
    readonly thresholdFailures: string[];
  };
  /** The open hard-gate blockers (vc2-model-prep §6, never closed here). */
  readonly blockers: BlockerV1[];
  /** Encoder health facts (digest prefix + mode). */
  readonly encoderHealth: SetupCortexEncoderHealth;
  /** ISO 8601 read timestamp. */
  readonly updatedAt: string;
  /** Shared status derivation (deriveVcStatus). */
  readonly status: VcStatus;
}
