/**
 * request-hash-v2-types.ts — M5 request-hash-v2 migration types.
 *
 * Extracted from request-hash-v2.ts to keep the parent file under the 300-line
 * soft limit (soft-as-hard gate). Pure type + constant definitions; no logic.
 * PREVENT-002/011/PI-004 honored.
 */

/** The active-version value the v2 pointer is switched to. */
export const REQUEST_HASH_V2_VERSION = 2;
/** The legacy (predecessor) active version. */
export const REQUEST_HASH_LEGACY_VERSION = 1;

/** M5 failure codes. */
export const M5_FAIL = {
  COPY_PARTIAL: "M5_COPY_PARTIAL",
  COUNT_MISMATCH: "M5_COUNT_MISMATCH",
  DIGEST_MISMATCH: "M5_DIGEST_MISMATCH",
  IDENTITY_DRIFT: "M5_IDENTITY_DRIFT",
  /** Two distinct v1 rows map to the same v2 hash — blocks the switch. (VC7C) */
  REQUEST_HASH_COLLISION: "M5_REQUEST_HASH_COLLISION",
  /** The active pointer is not on v1; switching would be a no-op or a regression. */
  NOT_ON_LEGACY: "M5_NOT_ON_LEGACY",
} as const;
export type M5MigrationCode = (typeof M5_FAIL)[keyof typeof M5_FAIL];

/**
 * Registered M5 conformance IDs (M5-001..020). The acceptance test reads these
 * rows from the v2 `migrations/` domain and asserts each returns its manifest
 * bytes or exactly its listed failure code. Mirrors M6_IDS / M4_IDS.
 */
export const M5_IDS: readonly string[] = Array.from(
  { length: 20 },
  (_v, i) => `M5-${String(i + 1).padStart(3, "0")}`,
);

/** Named M5 rows surfaced by the conformance corpus (mirrors M6_NAMED_IDS). */
export const M5_NAMED_IDS = ["M5-COLLIDE-002"] as const;

/** A predecessor (v1) request-hash row. */
export interface RequestHashV1Row {
  readonly profileId: string;
  /** BARE lowercase hex canonical request digest (VC5B convention). */
  readonly requestDigest: string;
  /** The v1 cache-identity hash derived from the request. */
  readonly hash: string;
}

/**
 * A v2 request-hash row. Identity is `(profileId, requestDigest)` — unchanged
 * from v1, which is the point: only `hash` is re-derived, now folding in the
 * economics version.
 */
export interface RequestHashV2Row {
  readonly profileId: string;
  readonly requestDigest: string;
  /** Economics version folded into the v2 hash (absent in v1). */
  readonly economicsVersion: string;
  /** The v2 cache-identity hash. */
  readonly hash: string;
}

/** The host the migration reads from / writes to (capability-shaped). */
export interface M5Host {
  /** Every predecessor row being migrated. */
  readonly v1Rows: () => readonly RequestHashV1Row[];
  /** The economics version to fold in, per profile. */
  readonly economicsVersionOf: (profileId: string) => string;
  /** The session a profile belongs to, for M6 generation invalidation lookup. */
  readonly sessionOf: (profileId: string) => string;
  /** The currently live M6 generation for a session (for invalidation checks). */
  readonly liveGenerationOf: (session: string) => bigint;
  /** Persisted v2 rows already written (for resume). */
  readonly existingV2: () => readonly RequestHashV2Row[];
  /** Idempotent write of v2 rows (never mutates v1 rows). */
  readonly putV2: (rows: readonly RequestHashV2Row[]) => void;
  /** The currently ACTIVE version (1 = legacy; only v1 → v2 switching). */
  readonly activeVersion: () => number;
  /** Atomically flip the active pointer to v2. Mirrors M6Host.switchToV2. */
  readonly switchToV2: () => void;
}

/** An M5 validation result. */
export interface M5ValidateResult {
  readonly ok: boolean;
  readonly codes: readonly M5MigrationCode[];
}
