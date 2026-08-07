/**
 * dashboard-client/src/types/setup-cortex.ts — Setup Cortex client types.
 *
 * Client-side mirrors of the server contract (extensions/dashboard-server/
 * api-contracts/setup-cortex.ts), kept in lockstep so the SetupTab Cortex
 * sub-tab is fully typed end-to-end. The client bundle does not import the
 * server tree, so these are redeclared here (PREVENT-011: no `any`; every type
 * explicit). Aggregate values only — never payload bytes/prompts/ledger
 * (EVAL-REDACT-002).
 */

/** The deriveVcStatus status projected by the VC9A reader endpoint. */
export type VcStatus = "live" | "awaiting_data" | "deferred" | "structural" | "off";

/** One open hard-gate blocker row surfaced on the blockers card. */
export interface BlockerV1 {
  /** Stable machine id keying the row (HG-1, HG-3, ...). */
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

/** Encoder qualification verdict projected for the reader. */
export type SetupCortexQualificationVerdict = "qualified" | "demoted" | "unavailable";

/** Reader-only view of the encoder health facts (digest prefix, no bytes). */
export interface SetupCortexEncoderHealth {
  /** First 12 hex chars of the committed asset-manifest digest, or null. */
  readonly assetDigestPrefix: string | null;
  /** Effective encoder triad mode (A verified / B demoted / C absent). */
  readonly mode: "A" | "B" | "C";
}

/** Response for GET /api/setup-cortex-status. */
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
  /** The open hard-gate blockers (never closed here). */
  readonly blockers: BlockerV1[];
  /** Encoder health facts (digest prefix + mode). */
  readonly encoderHealth: SetupCortexEncoderHealth;
  /** ISO 8601 read timestamp. */
  readonly updatedAt: string;
  /** Shared status derivation (deriveVcStatus). */
  readonly status: VcStatus;
  /**
   * ENC-0e: darwin-x64 explicit demotion disposition. Present (additively) ONLY
   * on an Intel-Mac host where the runtime demoted to WASM under
   * `MEGACOMPACT_ENC_0E`; omitted on every non-darwin-x64 host, so the payload
   * stays byte-compatible.
   */
  readonly darwinX64?: {
    readonly demoted: boolean;
    readonly reason?: string;
  };
}

/** The set of developer actions the Setup Cortex action drivers can run. */
export type SetupCortexActionKind = "fetch-model" | "bench" | "verify-asset";

/** Request body for POST /api/setup-cortex-action. confirm:true required. */
export interface SetupCortexActionRequest {
  readonly action: SetupCortexActionKind;
  readonly confirm: boolean;
}

/** Outcome of running one Setup Cortex action. */
export interface SetupCortexActionResult {
  readonly action: SetupCortexActionKind;
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly logPath: string;
  readonly logName: string;
  readonly spawned: boolean;
}

/** Error body used when a hard gate blocks the requested action. */
export interface SetupCortexActionBlocked {
  readonly error: "action_blocked_by_open_item";
  /** The open hard-gate ids (HG-1/HG-3) that gate this action. */
  readonly blockers: string[];
}

/** Error body used when confirm:true was not supplied. */
export interface SetupCortexActionConfirmRequired {
  readonly error: "confirmation_required";
}

/** Error body used when the setup-cortex action path is disabled (flag off). */
export interface SetupCortexActionDisabled {
  readonly error: "disabled";
}

/** Union of every non-2xx action error body the route can return. */
export type SetupCortexActionErrorBody =
  | SetupCortexActionBlocked
  | SetupCortexActionConfirmRequired
  | SetupCortexActionDisabled;

/** Request query for GET /api/setup-cortex-action-log. */
export interface SetupCortexActionLogQuery {
  readonly name: string;
}

/** Response body for GET /api/setup-cortex-action-log (bounded, redacted). */
export interface SetupCortexActionLogResponse {
  readonly name: string;
  readonly tail: string;
  /** True when the full file fit in the tail (false = truncated to 8 KiB). */
  readonly complete: boolean;
}
