/**
 * cache/diagnostics-types.ts — VC7C cache miss-diagnostic contract types.
 *
 * Single source of truth for the miss-classification vocabulary. Kept separate
 * from the arithmetic (`diagnostics.ts`) so the dashboard client, the emit layer
 * and the acceptance test all import ONE definition. No logic here; pure types
 * + the registered ID lists. PREVENT-011 honored (no `any`).
 */

/** The exclusive miss classes, in the order the classifier ranks them. */
export type MissClass =
  | "profile"
  | "range"
  | "dependency"
  | "request"
  | "generation"
  | "unknown";

/**
 * Payload-free by construction. Every field is a boolean or a bounded,
 * non-negative count — there is no string slot into which a request body, a
 * session id, or a covered range of user content could be placed. See
 * SECURITY_PRIVACY: a diagnostic that carried the offending payload would leak
 * it to the dashboard.
 */
export interface MissEvidence {
  readonly profileMismatch: boolean;
  readonly rangeMismatch: boolean;
  readonly dependencyAdvanced: boolean;
  readonly requestMismatch: boolean;
  readonly generationInvalidated: boolean;
  /** Ranges the caller asked for (always observable, even on a cold key). */
  readonly requestedRangeCount: number;
  /** Ranges the cache could serve; 0 on a cold key (no crystal). */
  readonly cachedRangeCount: number;
  /** max(0, requestHighWater - cachedHighWater), saturated at MAX_SAFE_INTEGER. */
  readonly dependencyDelta: number;
  /** True when nothing was cached for this key (null cached fields). */
  readonly absent: boolean;
}

/**
 * A single observation fed to the classifier. A `null` cached field means that
 * piece of state was never persisted — "absence is not a mismatch". Digests
 * follow convention: `coveredDigest` is `sha256:<hex>` (WITH prefix);
 * `requestDigest` is BARE lowercase hex (NO prefix).
 */
export interface MissObservation {
  readonly requestProfileId: string;
  readonly requestProfileVersion: string;
  readonly cachedProfileId: string | null;
  readonly cachedProfileVersion: string | null;
  readonly requestCoveredDigest: string;
  readonly cachedCoveredDigest: string | null;
  readonly requestedRangeCount: number;
  readonly cachedRangeCount: number | null;
  readonly requestDigest: string;
  readonly cachedRequestDigest: string | null;
  /** Dependency validation high-water (monotonic frontier), as a bigint. */
  readonly requestDependencyHighWater: bigint;
  readonly cachedDependencyHighWater: bigint | null;
  readonly generationInvalidated: boolean;
}

/** The versioned diagnostic record emitted for every classified miss. */
export interface CacheDiagnosticV1 {
  readonly schema: "cache-diagnostic-v1";
  readonly missClass: MissClass;
  readonly evidence: MissEvidence;
}

/** Registered conformance IDs (CACHE-016..030). */
export const CACHE_DIAGNOSTIC_IDS: readonly string[] = Array.from(
  { length: 15 },
  (_v, i) => `CACHE-${String(i + 16).padStart(3, "0")}`,
);

/** Named headlines surfaced by the conformance corpus. */
export const CACHE_DIAGNOSTIC_NAMED_IDS = [
  "CACHE-MISS-001",
  "CACHE-STALE-003",
] as const;

/** Event names this subsystem emits (gated by MEGACOMPACT_VC7C). */
export type CacheDiagnosticEventName =
  | "vector_cortex_cache_miss_classified"
  | "vector_cortex_cache_serve_blocked";
