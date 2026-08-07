/**
 * api-contracts/cosine-fp.ts — cosine-FP report API contract (COS-FP-A).
 *
 * Reader-only shape for GET /api/cosine-fp-report: the last written synthetic
 * bench aggregate + report digest + recommendation. The bench emits counts +
 * fractions + digests ONLY (EVAL-REDACT-002) — never template text. No `any`.
 */

/** Derived endpoint status (from vc-status.ts). */
export type CosineFpStatus = "live" | "awaiting_data" | "deferred" | "structural" | "off";

/** The bench aggregate's own outcome label. */
export type CosineFpBenchStatus = "ok" | "no_data" | "off" | "awaiting_data";

export interface CosineFpGrid {
  readonly lo: number;
  readonly hi: number;
  readonly step: number;
  readonly points: number;
}

export interface CosineFpPerTypeCounts {
  readonly items: number;
  readonly dup: number;
  readonly near: number;
  readonly clean: number;
}

export interface CosineFpPerTypeResult {
  readonly fp: number;
  readonly fpRate: number | null;
  readonly fn: number;
  readonly fnRate: number | null;
}

export interface CosineFpPerTypeRow {
  readonly code: CosineFpPerTypeResult;
  readonly prose: CosineFpPerTypeResult;
  readonly mixed: CosineFpPerTypeResult;
}

export interface CosineFpRow {
  readonly threshold: number;
  readonly overallFpRate: number | null;
  readonly overallFnRate: number | null;
  readonly overallF1: number | null;
  readonly perType: CosineFpPerTypeRow;
}

export interface CosineFpCorpusSummary {
  readonly items: number;
  readonly pairs: number;
  readonly types: string[];
  readonly perType: Readonly<Record<string, CosineFpPerTypeCounts>>;
  readonly digest: string | null;
}

export interface CosineFpOverrides {
  readonly code: number | null;
  readonly prose: number | null;
  readonly mixed: number | null;
}

/** Response body for GET /api/cosine-fp-report. */
export interface CosineFpReportV1 {
  /** Derived endpoint status (deriveVcStatus): off (flag) / awaiting_data (no run). */
  readonly status: CosineFpStatus;
  /** Outcome the bench itself recorded: ok / no_data / off / awaiting_data. */
  readonly benchStatus: CosineFpBenchStatus;
  readonly seed: number | null;
  readonly grid: CosineFpGrid | null;
  readonly corpusSummary: CosineFpCorpusSummary | null;
  readonly rows: CosineFpRow[] | null;
  readonly recommendedDefault: number | null;
  readonly shippedDefault: number;
  readonly overrides: CosineFpOverrides | null;
  readonly fpBudget: number | null;
  readonly digest: string | null;
  /** mtime (epoch ms) of the bench-run aggregate file backing this response. */
  readonly reportFileMtime: number | null;
}
