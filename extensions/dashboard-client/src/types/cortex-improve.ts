/**
 * dashboard-client/src/types/cortex-improve.ts — ML5-D Improve Cortex client types.
 *
 * Client-side mirrors of the server contract (extensions/dashboard-server/
 * api-contracts/cortex-improve.ts), kept in lockstep so the ModelImprovementCard
 * is fully typed end-to-end. The client bundle does not import the server tree,
 * so these are redeclared here (PREVENT-011: no `any`; every type explicit).
 * Aggregate values only — mode/verdict/digest/reason/progress, never payload
 * bytes or corpus content (EVAL-REDACT-002).
 */

/** The five-head qualification verdict projected by an improve job. */
export interface QualificationV1 {
  readonly mode: "A" | "B" | "C";
  readonly assetDigestPrefix: string | null;
  readonly verdict: "qualified" | "demoted";
  readonly reasonCode?: string;
}

/** Response body for POST /api/cortex/improve. */
export interface CortexImproveStart {
  readonly status: "improving";
  readonly jobId: string;
}

/** Response body for GET /api/cortex/improve/status/:jobId. */
export type CortexImproveStatus =
  | {
      readonly status: "improving";
      readonly progress: number;
    }
  | {
      readonly status: "qualified";
      readonly progress: number;
      readonly verdict: QualificationV1;
      readonly assetDigest: string;
    }
  | {
      readonly status: "demoted_to_B";
      readonly progress: number;
      readonly reason: string;
    };
