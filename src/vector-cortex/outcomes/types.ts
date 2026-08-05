/**
 * outcomes/types.ts — VC8A consent-bound outcome ledger type definitions.
 *
 * Payload-free metrics only — no prompt bytes, response text, or free-text.
 * OutcomeV1 carries session/repo/assignment/metrics fields ONLY.
 * ConsentV1 is append-only grants/revocations with effective sequence.
 * DatasetManifestV1 groups rows/digests/split (train/calibration/held-out).
 *
 * Conformance IDs OUT-001..OUT-025 are registered here as the single source of
 * truth for the sprint's conformance rows.
 *
 * PREVENT-PI-004: type definitions only, no network code.
 * PREVENT-011: no `any` type.
 */

/** Schema version for OutcomeV1. */
export const OUTCOME_SCHEMA_V1 = "outcome-v1";

/** Schema version for ConsentV1. */
export const CONSENT_SCHEMA_V1 = "consent-v1";

/** Schema version for DatasetManifestV1. */
export const DATASET_MANIFEST_SCHEMA_V1 = "dataset-manifest-v1";

/** Failure code when a payload-bearing field is passed to the ledger. */
export const OUT_PAYLOAD_FORBIDDEN = "OUT_PAYLOAD_FORBIDDEN";

/** Failure code when consent is missing at export time. */
export const OUT_CONSENT_MISSING = "OUT_CONSENT_MISSING";

/** Failure code when a group would cross split boundaries. */
export const OUT_SPLIT_VIOLATION = "OUT_SPLIT_VIOLATION";

/**
 * OutcomeV1 — a single payload-free outcome metric row.
 * Contains session/repo/assignment/metrics ONLY — never prompt, response,
 * exact bytes, or free-text payload fields.
 */
export interface OutcomeV1 {
  readonly schema: typeof OUTCOME_SCHEMA_V1;
  readonly outcomeId: string;
  readonly sessionId: string;
  readonly repoId: string;
  readonly assignment: string;
  readonly metrics: ReadonlyArray<OutcomeMetric>;
  readonly ts: string;
}

/** A single numeric metric with a named code — never free-text. */
export interface OutcomeMetric {
  readonly code: string;
  readonly value: number;
  readonly unit: string;
}

/**
 * ConsentV1 — append-only consent record (grant or revocation).
 * An outcome is included in a dataset manifest only if its session has an
 * active explicit grant at export time (no revocation after the grant).
 */
export interface ConsentV1 {
  readonly schema: typeof CONSENT_SCHEMA_V1;
  readonly consentId: string;
  readonly sessionId: string;
  readonly action: "grant" | "revoke";
  readonly effectiveSeq: number;
  readonly ts: string;
}

/** A split assignment for a dataset row group. */
export type DatasetSplit = "train" | "calibration" | "held-out";

/**
 * DatasetManifestV1 — a frozen snapshot of consented outcome rows grouped
 * by (repo, session) into train/calibration/held-out splits.
 */
export interface DatasetManifestV1 {
  readonly schema: typeof DATASET_MANIFEST_SCHEMA_V1;
  readonly manifestId: string;
  readonly rows: ReadonlyArray<DatasetManifestRow>;
  readonly splitDigests: Readonly<Record<DatasetSplit, string>>;
  readonly createdAt: string;
}

/** A single row in a dataset manifest. */
export interface DatasetManifestRow {
  readonly outcomeId: string;
  readonly repoId: string;
  readonly sessionId: string;
  readonly split: DatasetSplit;
}

/** Conformance IDs OUT-001..OUT-025 for the 25 numbered rows. */
export const OUTCOMES_CONFORMANCE_IDS: readonly string[] = Array.from(
  { length: 25 },
  (_, i) => `OUT-${String(i + 1).padStart(3, "0")}`,
);

/** Named conformance fixtures for the sprint's headline assertions. */
export const OUTCOMES_NAMED_FIXTURES = [
  "OUT-CONSENT-001",
  "OUT-REVOKE-002",
  "OUT-SPLIT-003",
] as const;
