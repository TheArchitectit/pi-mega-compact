/**
 * cache/diagnostics.ts — VC7C pure miss classification (flag-independent).
 *
 * The classifier is PURE arithmetic: given a `MissObservation` it returns
 * exactly ONE `MissClass` and the payload-free `MissEvidence`. It is NOT gated by
 * MEGACOMPACT_VC7C — flag-off must be byte-identical to the predecessor, so the
 * SAME class a user sees today, they see tomorrow. The flag gates only the
 * reporter/dashboard seam (see `diagnostics-emit.ts`).
 *
 * Exclusive ranking: profile -> range -> dependency -> request -> generation ->
 * unknown. First match wins; the ranking itself is the contract and is pinned by
 * CACHE-016..030. "Absence is not a mismatch": a cold key (null cached fields)
 * classifies `unknown`, never `profile`. PREVENT-002/011/PI-004 honored.
 */

import type {
  CacheDiagnosticV1,
  MissClass,
  MissEvidence,
  MissObservation,
} from "./diagnostics-types.js";

/** A cached field is present iff it is non-null. */
function isPresent(value: string | number | bigint | null): boolean {
  return value !== null;
}

/**
 * Clamp the dependency delta to a non-negative, safe-integer count. A request
 * BEHIND the cached frontier is not an advance (delta 0); a huge advance
 * saturates rather than losing precision.
 */
function advanceDelta(
  request: bigint,
  cached: bigint | null,
): { advanced: boolean; delta: number } {
  if (cached === null) return { advanced: false, delta: 0 };
  if (request <= cached) return { advanced: false, delta: 0 };
  const diff = request - cached;
  if (diff > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { advanced: true, delta: Number.MAX_SAFE_INTEGER };
  }
  return { advanced: true, delta: Number(diff) };
}

/** Collect the payload-free evidence from one observation. */
export function collectEvidence(o: MissObservation): MissEvidence {
  const profileMismatch =
    isPresent(o.cachedProfileId) &&
    isPresent(o.cachedProfileVersion) &&
    (o.cachedProfileId !== o.requestProfileId ||
      o.cachedProfileVersion !== o.requestProfileVersion);

  const rangeMismatch =
    (isPresent(o.cachedCoveredDigest) &&
      o.cachedCoveredDigest !== o.requestCoveredDigest) ||
    (isPresent(o.cachedRangeCount) &&
      o.cachedRangeCount !== o.requestedRangeCount);

  const dep = advanceDelta(
    o.requestDependencyHighWater,
    o.cachedDependencyHighWater,
  );

  const requestMismatch =
    isPresent(o.cachedRequestDigest) &&
    o.cachedRequestDigest !== o.requestDigest;

  return {
    profileMismatch,
    rangeMismatch,
    dependencyAdvanced: dep.advanced,
    requestMismatch,
    generationInvalidated: o.generationInvalidated,
    requestedRangeCount: o.requestedRangeCount,
    cachedRangeCount: o.cachedRangeCount === null ? 0 : o.cachedRangeCount,
    dependencyDelta: dep.delta,
    absent:
      !isPresent(o.cachedProfileId) &&
      !isPresent(o.cachedCoveredDigest) &&
      !isPresent(o.cachedRequestDigest) &&
      !isPresent(o.cachedDependencyHighWater),
  };
}

/** The exclusive ranking: first true cause wins. */
export function classFor(e: MissEvidence): MissClass {
  if (e.profileMismatch) return "profile";
  if (e.rangeMismatch) return "range";
  if (e.dependencyAdvanced) return "dependency";
  if (e.requestMismatch) return "request";
  if (e.generationInvalidated) return "generation";
  return "unknown";
}

/** Classify one observation: exactly one deterministic class. */
export function classifyMiss(o: MissObservation): CacheDiagnosticV1 {
  const evidence = collectEvidence(o);
  return {
    schema: "cache-diagnostic-v1",
    missClass: classFor(evidence),
    evidence,
  };
}

/**
 * A miss a caller can self-heal on the next turn (re-fetch under a fresh
 * profile / a new generation), so a triad recovery path may treat it as
 * transient. Only profile + generation qualify; the rest are hard mismatches.
 * An `unknown` miss is NEVER transient.
 */
export function isTransientMiss(d: CacheDiagnosticV1): boolean {
  return d.missClass === "profile" || d.missClass === "generation";
}
