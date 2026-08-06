/**
 * api-contracts/cortex-improve.ts — ML5-D "Improve Cortex" job API types.
 *
 * Types for POST /api/cortex/improve (launch a local ML5-A training job that
 * re-qualifies the five heads against the latest local corpus) and GET
 * /api/cortex/improve/status/:jobId (poll the in-process job state to a
 * terminal qualified / demoted_to_B verdict). Local-only, aggregate surfaces:
 * mode / verdict / digest / reason / progress — never message content or corpus
 * rows (EVAL-REDACT-002).
 *
 * PREVENT-PI-004: type definitions only, no network code.
 * PREVENT-011: no `any` type — all types are explicit.
 */

/**
 * The five-head qualification verdict projected from the improve job.
 * Aggregate-only: current surrogate mode + asset digest prefix + a reason code
 * when the asset failed to qualify (never weights or corpus content).
 */
export interface QualificationV1 {
  /** Surrogate encoder mode the improve job would promote to on success. */
  readonly mode: "A" | "B" | "C";
  /** First 12 hex chars of the produced asset manifest digest, or null. */
  readonly assetDigestPrefix: string | null;
  /** Terminal verdict: qualified when the heads fit within gate, else demoted. */
  readonly verdict: "qualified" | "demoted";
  /** A stable reason code when verdict is "demoted" (e.g. ENC_ASSET_UNREADABLE). */
  readonly reasonCode?: string;
}

/** Response body for POST /api/cortex/improve (confirmation-gated). */
export interface CortexImproveStart {
  /** Always "improving" immediately after the job is spawned. */
  readonly status: "improving";
  /** Opaque job token (sha256 of ts+random, hex-sliced), pollable via status. */
  readonly jobId: string;
}

/** Lifecycle status of a Cortex improve job (in-process, restart-scoped). */
export type CortexImproveJobStatus =
  | "improving"
  | "qualified"
  | "demoted_to_B";

/** Progressing (non-terminal) response for GET /api/cortex/improve/status/:jobId. */
export interface CortexImproveProgress {
  readonly status: "improving";
  /** 0..1 progress through the local ML5-A training run. */
  readonly progress: number;
}

/** Terminal success: the five heads re-qualified under mode A. */
export interface CortexImproveQualified {
  readonly status: "qualified";
  readonly progress: number;
  readonly verdict: QualificationV1;
  readonly assetDigest: string;
}

/** Terminal demotion: the re-trained heads failed to qualify — stay mode B. */
export interface CortexImproveDemoted {
  readonly status: "demoted_to_B";
  readonly progress: number;
  readonly reason: string;
}

/** Response body for GET /api/cortex/improve/status/:jobId. */
export type CortexImproveStatus =
  | CortexImproveProgress
  | CortexImproveQualified
  | CortexImproveDemoted;

/** Error body returned when the improve surface is disabled (flag off). */
export interface CortexImproveDisabled {
  readonly error: "disabled";
}

/** Request body for POST /api/cortex/improve. `confirm:true` is the server-side hard requirement. */
export interface CortexImproveStartRequest {
  /** Required explicit confirmation. Absent/false → 400 confirmation_required. */
  readonly confirm: boolean;
}
