/**
 * pressure-v2-types.ts — M7 pressure-v2 migration types.
 *
 * Extracted from pressure-v2.ts to keep the parent file under the 300-line
 * soft limit (soft-as-hard gate). Pure type + constant definitions; no logic.
 * PREVENT-002/011/PI-004 honored.
 */

/** The active-version value the v2 pointer is switched to. */
export const PRESSURE_V2_VERSION = 2;
/** The legacy (predecessor) active version. */
export const PRESSURE_LEGACY_VERSION = 1;

/** M7 failure codes. */
export const M7_FAIL = {
  /** A legacy row carries a label outside the canonical five levels. */
  PRESSURE_UNKNOWN: "M7_PRESSURE_UNKNOWN",
  /** Copied row count does not match the legacy row count. */
  COUNT_MISMATCH: "M7_COUNT_MISMATCH",
  /** A v2 row digest does not re-derive from its own declared fields. */
  DIGEST_MISMATCH: "M7_DIGEST_MISMATCH",
  /** A legacy row has no corresponding v2 row (interrupted copy). */
  COPY_PARTIAL: "M7_COPY_PARTIAL",
  /** The active pointer is not on v1; switching would regress or no-op. */
  NOT_ON_LEGACY: "M7_NOT_ON_LEGACY",
} as const;
export type M7MigrationCode = (typeof M7_FAIL)[keyof typeof M7_FAIL];

/**
 * Registered M7 conformance IDs (M7-001..015). The acceptance test reads these
 * rows from the v2 `adaptive-policy/` domain and asserts each returns its
 * manifest bytes or exactly its listed failure code. Mirrors M5_IDS / M6_IDS.
 */
export const M7_IDS: readonly string[] = Array.from(
  { length: 15 },
  (_v, i) => `M7-${String(i + 1).padStart(3, "0")}`,
);

/** Named M7 rows surfaced by the conformance corpus. */
export const M7_NAMED_IDS = ["M7-PRESSURE-003"] as const;

/**
 * A predecessor (v1) pressure row. `label` is UNTRUSTED: the whole point of
 * the migration is that a legacy store may hold labels outside the canonical
 * five, and those must reject rather than be coerced.
 */
export interface PressureV1Row {
  readonly sessionId: string;
  readonly label: string;
  readonly effectiveSeq: number;
  readonly ts: string;
}

/** A v2 pressure row: canonical level + a digest over its own fields. */
export interface PressureV2Row {
  readonly sessionId: string;
  /** One of the canonical five levels — validated, never coerced. */
  readonly level: string;
  readonly effectiveSeq: number;
  readonly ts: string;
  /** SHA-256 over the length-prefixed canonical fields. */
  readonly digest: string;
}

/** The host the migration reads from / writes to (capability-shaped). */
export interface M7Host {
  /** Every predecessor row being migrated. */
  readonly v1Rows: () => readonly PressureV1Row[];
  /** Persisted v2 rows already written (for resume). */
  readonly existingV2: () => readonly PressureV2Row[];
  /** Idempotent write of v2 rows (never mutates v1 rows). */
  readonly putV2: (rows: readonly PressureV2Row[]) => void;
  /** The currently ACTIVE version (1 = legacy; only v1 -> v2 switching). */
  readonly activeVersion: () => number;
  /** Atomically flip the active pointer to v2. */
  readonly switchToV2: () => void;
}

/** An M7 validation result. */
export interface M7ValidateResult {
  readonly ok: boolean;
  readonly codes: readonly M7MigrationCode[];
}
