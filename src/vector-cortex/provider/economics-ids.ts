/**
 * vector-cortex/provider/economics-ids.ts — VC7B conformance ID registrations.
 *
 * Extracted from economics.ts to keep that file under the 300-line soft limit
 * (soft-as-hard gate). The ID ranges and named rows are pure data — splitting
 * them out mirrors how vector-cortex-breakers.ts was extracted from
 * vector-cortex.ts. economics.ts re-exports them so no consumer import path
 * changes.
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

/**
 * Registered VC7B cache-economics conformance ID range (CACHE-001..015). The
 * acceptance aggregator reads these rows from the v2 manifest and asserts each
 * returns its manifest `ok`/`code`.
 */
export const CACHE_IDS: readonly string[] = Array.from(
  { length: 15 },
  (_v, i) => `CACHE-${String(i + 1).padStart(3, "0")}`,
);

/**
 * Registered VC7B provider-economics conformance rows (PRO-024..030), continuing
 * VC7A's PRO-016..023. These pin the ECONOMICS half of a provider profile:
 * pricing validity, the exclusion-proof rule, and TTL/min-prefix eligibility.
 */
export const ECONOMICS_PROVIDER_IDS: readonly string[] = Array.from(
  { length: 7 },
  (_v, i) => `PRO-${String(i + 24).padStart(3, "0")}`,
);

/** Named VC7B conformance assertions (the sprint's headline rows). */
export const ECONOMICS_NAMED_IDS = [
  "CACHE-COST-001",
  "CACHE-EXCLUDE-002",
  "CACHE-RANDOM-003",
] as const;
