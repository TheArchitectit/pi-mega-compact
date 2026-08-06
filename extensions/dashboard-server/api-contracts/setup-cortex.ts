/**
 * api-contracts/setup-cortex.ts — Setup Cortex status + action API types (VC9A/VC9B).
 *
 * Types for GET /api/setup-cortex-status (reader-only aggregate that surfaces
 * the vector-cortex encoder gate WITHOUT closing the ML gate) and the VC9B
 * action drivers POST /api/setup-cortex-action + GET /api/setup-cortex-action-log
 * (confirmation-gated, hard-gate-aware fetches/bench/verify). Reader/actor-only:
 * never payload bytes/prompts/ledger (EVAL-REDACT-002).
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

// ─── VC9B action drivers ────────────────────────────────────────────────────

/** The set of developer actions the Setup Cortex action drivers can run. */
export type SetupCortexActionKind = "fetch-model" | "bench" | "verify-asset";

/**
 * Request body for POST /api/setup-cortex-action. `confirm:true` is the
 * server-side hard requirement (mirrors the client ActionDef confirm pattern);
 * anything else is rejected with confirmation_required.
 */
export interface SetupCortexActionRequest {
  /** Which action to run. */
  readonly action: SetupCortexActionKind;
  /** Required explicit confirmation. Absent/false → 400 confirmation_required. */
  readonly confirm: boolean;
}

/** Outcome of running one Setup Cortex action. */
export interface SetupCortexActionResult {
  readonly action: SetupCortexActionKind;
  /** True when the subprocess (or asset re-verification) ran to completion. */
  readonly ok: boolean;
  /** Exit code of the spawned script, or null for verify-asset / no-spawn. */
  readonly exitCode: number | null;
  /** Absolute path of the captured log file under <stateDir>/logs/vc9b/. */
  readonly logPath: string;
  /** Relative basename of the log file (the value to pass to the log-tail route). */
  readonly logName: string;
  /** True when the subprocess was spawned (verify-asset re-runs asset seams only). */
  readonly spawned: boolean;
}

/**
 * Error body used when a hard gate blocks the requested action: the action is
 * NOT spawned, and the blocking open hard-gate ids (HG-1/HG-3) are surfaced.
 */
export interface SetupCortexActionBlocked {
  readonly error: "action_blocked_by_open_item";
  /** The open hard-gate ids (HG-1/HG-3) that gate this action. */
  readonly blockers: string[];
}

/** Request query for GET /api/setup-cortex-action-log. */
export interface SetupCortexActionLogQuery {
  /** Basename of a log file inside <stateDir>/logs/vc9b/ (traversal rejected). */
  readonly name: string;
}

/** Response body for GET /api/setup-cortex-action-log (bounded, redacted). */
export interface SetupCortexActionLogResponse {
  readonly name: string;
  /** Tail of the action log, capped at 8 KiB and redacted. */
  readonly tail: string;
  /** True when the full file fit in the tail (false = truncated to 8 KiB). */
  readonly complete: boolean;
}
