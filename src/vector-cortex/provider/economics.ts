/**
 * vector-cortex/provider/economics.ts — VC7B cache economics (ProviderProfileV1
 * extension).
 *
 * VC7A proved a render can be FROZEN and reused. VC7B answers the question that
 * immediately follows: is reusing it actually WORTH IT? Provider prompt caching
 * is not free — a cache WRITE typically costs MORE than an uncached token, and a
 * cache READ costs less. So a cache is profitable only when a written prefix is
 * read back enough times, before its TTL expires, to repay the write premium.
 * This file is that arithmetic and nothing else.
 *
 * THE NET-SAVINGS MODEL. For a prefix of `cachedTokens` tokens:
 *
 *   baseline (no cache) = cachedTokens * basePrice * (writes + hits)
 *   actual (cached)     = cachedTokens * (writePrice * writes + readPrice * hits)
 *   netSavings          = baseline - actual
 *
 * A NEGATIVE `netSavings` is a real, expected, and important outcome: it means
 * the cache LOST money (a prefix written once and never re-read always does, by
 * exactly the write premium). We report it rather than clamping it at zero,
 * because a floor at zero would make every rollout look free and would hide the
 * single failure mode this sprint exists to detect.
 *
 * EXACT ARITHMETIC, NO FLOATS IN THE MONEY PATH. Prices are integer
 * MICRO-UNITS per token (1e-6 of the provider's currency unit), never floating
 * point. `0.1 + 0.2 !== 0.3` is not an acceptable property for a cost ledger, and
 * accumulating float error across millions of tokens produces aggregates that
 * silently disagree with the provider's own bill. All money is integer; only the
 * derived RATIO is a float, and it is finite-guarded.
 *
 * EVERY EXCLUSION NEEDS A FIXTURE (the sprint's headline safety rule). A provider
 * profile may declare that some request field does not affect cache identity —
 * but an UNPROVEN exclusion is how you get silent cache poisoning: the renderer
 * folds a field the provider actually keys on, two different requests collapse to
 * one cache entry, and one conversation is served another's prefix. So an
 * exclusion without a `fixtureId` (or with a blank one) is REJECTED here —
 * `ECON_EXCLUSION_UNPROVEN` — rather than trusted. There is no override.
 *
 * ESTIMATE VS MEASURED. Every result is labeled. Only telemetry from a
 * RANDOMIZED live assignment may be called `measured` and fed into a causal
 * interval; shadow or non-randomized numbers are `estimate` and are excluded
 * from causal aggregates (see `experiments.ts`). Mixing the two would let a
 * self-selected population masquerade as a controlled experiment.
 *
 * PURE. No clock, no storage, no console, no network (PREVENT-PI-004 /
 * PREVENT-011). Runs identically with `MEGACOMPACT_VC7B` on or off — the flag
 * gates only the reporter/dashboard seam in `../cache/economics-emit.ts`.
 */

import type { ProviderProfileExclusion, ProviderProfileV1 } from "./types.js";

/**
 * Cache economics attached to a provider profile.
 *
 * Prices are integer MICRO-UNITS PER TOKEN (1e-6 currency units), so a provider
 * charging $3.00 per million input tokens has `basePrice: 3`. Integers keep the
 * money path exact; see the file header for why floats are refused.
 */
export interface ProviderEconomicsV1 {
  readonly schema: "provider-economics-v1";
  /** The `ProviderProfileV1.id` these economics belong to. */
  readonly profileId: string;
  /** Profile version — economics are versioned WITH the profile they price. */
  readonly profileVersion: string;
  /** Uncached price per token, integer micro-units. The savings baseline. */
  readonly basePrice: number;
  /** Cache-READ price per token, integer micro-units. Normally < basePrice. */
  readonly readPrice: number;
  /** Cache-WRITE price per token, integer micro-units. Normally > basePrice. */
  readonly writePrice: number;
  /** Cache entry lifetime in ms. A prefix older than this cannot be read back. */
  readonly ttlMs: number;
  /** Minimum cacheable prefix in tokens; a shorter prefix is never cached. */
  readonly minPrefix: number;
  /**
   * Conformance fixture ID proving this profile's exclusion set is safe, or
   * `null` when the profile declares NO exclusions (nothing to prove). A profile
   * WITH exclusions and a null/blank id is rejected — see `validateEconomics`.
   */
  readonly exclusionFixtureId: string | null;
}

/** Observed (or shadow) cache traffic for one economics computation. */
export interface CacheUsageV1 {
  /** Tokens in the cached prefix. Must be a non-negative safe integer. */
  readonly cachedTokens: number;
  /** Number of cache WRITES (each pays the write premium). */
  readonly writeCount: number;
  /** Number of cache HITS (each pays the discounted read price). */
  readonly hitCount: number;
}

/**
 * Whether a figure may be used as causal evidence.
 *
 *   `measured` — from a RANDOMIZED live assignment; admissible in causal
 *                intervals.
 *   `estimate` — shadow, projected, or non-randomized; reportable but NEVER
 *                admissible in a causal interval.
 */
export type EconomicsEvidence = "measured" | "estimate";

/** VC7B economics failure codes. */
export type EconomicsFailureCode =
  /** A profile declares exclusions but names no proving fixture. */
  | "ECON_EXCLUSION_UNPROVEN"
  /** A price / TTL / prefix is negative, fractional, or not finite. */
  | "ECON_PRICE_INVALID"
  /** A usage count is negative, fractional, or not finite. */
  | "ECON_USAGE_INVALID"
  /** The computed result overflowed the exact-integer safe range. */
  | "ECON_OVERFLOW";

/** The computed economics of a cache decision. All money in micro-units. */
export interface EconomicsResultV1 {
  readonly profileId: string;
  /** What the same traffic would have cost with no cache at all. */
  readonly baselineCost: number;
  /** What it actually cost: write premium on writes, discount on hits. */
  readonly actualCost: number;
  /** `baselineCost - actualCost`. NEGATIVE means the cache lost money. */
  readonly netSavings: number;
  /** Tokens billed at the discounted read price (the cache's token benefit). */
  readonly tokenSavings: number;
  /** `netSavings / baselineCost`, or 0 when the baseline is 0. Always finite. */
  readonly savingsRatio: number;
  /** Hits needed to break even on one write, or null when never profitable. */
  readonly breakEvenHits: number | null;
  /** Whether this figure may enter a causal interval. */
  readonly evidence: EconomicsEvidence;
}

/** The verdict of an economics computation. */
export type EconomicsResult =
  | { readonly ok: true; readonly result: EconomicsResultV1 }
  | { readonly ok: false; readonly codes: readonly EconomicsFailureCode[] };

/** A non-negative safe integer — the only shape money and counts may take. */
function isCount(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 0;
}

/**
 * Validate a profile's economics, enforcing the exclusion-proof rule.
 *
 * An exclusion claims "this field cannot affect provider cache identity". That
 * claim is only as good as the fixture that proves it, so a profile carrying
 * exclusions MUST name a `exclusionFixtureId`, and every individual exclusion
 * must carry its own `fixtureId` too (VC5B already models that field; VC7B makes
 * a blank one fatal instead of decorative). Returns deduplicated codes in a
 * deterministic order.
 */
export function validateEconomics(
  econ: ProviderEconomicsV1,
  exclusions: readonly ProviderProfileExclusion[],
): readonly EconomicsFailureCode[] {
  const codes = new Set<EconomicsFailureCode>();

  for (const n of [econ.basePrice, econ.readPrice, econ.writePrice, econ.ttlMs, econ.minPrefix]) {
    if (!isCount(n)) codes.add("ECON_PRICE_INVALID");
  }

  // The headline rule: exclusions without a proving fixture are never trusted.
  if (exclusions.length > 0) {
    const id = econ.exclusionFixtureId;
    if (id === null || id.trim() === "") codes.add("ECON_EXCLUSION_UNPROVEN");
    for (const ex of exclusions) {
      if (ex.fixtureId.trim() === "") codes.add("ECON_EXCLUSION_UNPROVEN");
    }
  }

  const order: EconomicsFailureCode[] = ["ECON_EXCLUSION_UNPROVEN", "ECON_PRICE_INVALID"];
  return order.filter((c) => codes.has(c));
}

/**
 * Validate a profile + its economics together. Convenience over
 * `validateEconomics` for callers holding a whole `ProviderProfileV1`: the
 * exclusion list is read from the profile itself, so the two can never disagree.
 */
export function validateProfileEconomics(
  profile: ProviderProfileV1,
  econ: ProviderEconomicsV1,
): readonly EconomicsFailureCode[] {
  return validateEconomics(econ, profile.excludedJsonPointers);
}

/**
 * Hits required for ONE write to break even.
 *
 * One write costs `(writePrice - basePrice)` extra per token; each subsequent
 * hit saves `(basePrice - readPrice)` per token. So break-even is the ceiling of
 * premium/discount. Returns `null` when the cache can NEVER pay for itself
 * (a read that costs at least as much as an uncached token) — reporting a huge
 * number there would imply "just get more hits", which is false.
 * Returns 0 when writing is already free or cheaper than not caching.
 */
export function breakEvenHits(econ: ProviderEconomicsV1): number | null {
  const premium = econ.writePrice - econ.basePrice;
  const discount = econ.basePrice - econ.readPrice;
  if (premium <= 0) return 0;
  if (discount <= 0) return null;
  return Math.ceil(premium / discount);
}

/**
 * Compute net cache savings for observed (or shadow) usage.
 *
 * Pure integer arithmetic in micro-units. The only float is `savingsRatio`, and
 * it is zero-guarded so a zero baseline yields 0 rather than NaN/Infinity — the
 * sprint invariant is that every reported aggregate is FINITE.
 *
 * `evidence` is supplied by the caller and simply carried through: this function
 * cannot know whether its inputs came from a randomized arm, and guessing would
 * be exactly the mislabeling the causal rules forbid.
 */
export function computeEconomics(
  econ: ProviderEconomicsV1,
  usage: CacheUsageV1,
  evidence: EconomicsEvidence,
): EconomicsResult {
  const codes: EconomicsFailureCode[] = [];
  for (const n of [econ.basePrice, econ.readPrice, econ.writePrice, econ.ttlMs, econ.minPrefix]) {
    if (!isCount(n)) {
      codes.push("ECON_PRICE_INVALID");
      break;
    }
  }
  for (const n of [usage.cachedTokens, usage.writeCount, usage.hitCount]) {
    if (!isCount(n)) {
      codes.push("ECON_USAGE_INVALID");
      break;
    }
  }
  if (codes.length > 0) return { ok: false, codes };

  const { cachedTokens, writeCount, hitCount } = usage;
  const baselineCost = cachedTokens * econ.basePrice * (writeCount + hitCount);
  const actualCost = cachedTokens * (econ.writePrice * writeCount + econ.readPrice * hitCount);

  // Exactness is the whole point of the integer model: if any product leaves the
  // safe-integer range the result is silently wrong, so we fail instead.
  if (!Number.isSafeInteger(baselineCost) || !Number.isSafeInteger(actualCost)) {
    return { ok: false, codes: ["ECON_OVERFLOW"] };
  }

  const netSavings = baselineCost - actualCost;
  // Tokens served at the discounted read price — the cache's token-level benefit,
  // independent of price (a hit re-reads the whole prefix).
  const tokenSavings = cachedTokens * hitCount;
  const savingsRatio = baselineCost === 0 ? 0 : netSavings / baselineCost;

  return {
    ok: true,
    result: {
      profileId: econ.profileId,
      baselineCost,
      actualCost,
      netSavings,
      tokenSavings,
      savingsRatio,
      breakEvenHits: breakEvenHits(econ),
      evidence,
    },
  };
}

/**
 * Whether a prefix is eligible to be cached at all: it must meet the profile's
 * minimum prefix, and it must still be within TTL. A prefix below `minPrefix` is
 * not "a small win", it is not cacheable by the provider at all.
 */
export function isCacheEligible(
  econ: ProviderEconomicsV1,
  prefixTokens: number,
  ageMs: number,
): boolean {
  if (!isCount(prefixTokens) || !isCount(ageMs)) return false;
  return prefixTokens >= econ.minPrefix && ageMs < econ.ttlMs;
}

// Conformance ID ranges + named rows extracted to economics-ids.ts to keep this
// file under the 300-line soft limit (soft-as-hard gate). Re-exported here so no
// consumer import path changes.
export {
  CACHE_IDS,
  ECONOMICS_PROVIDER_IDS,
  ECONOMICS_NAMED_IDS,
} from "./economics-ids.js";
