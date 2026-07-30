/**
 * pricing.ts — provider prompt-cache pricing math (S53C).
 *
 * Pure, pi-agnostic cost estimates for the dashboard Cache tab. Rates come
 * from the caller (pi's model registry / the snapshot's model block); this
 * module owns only the Anthropic-style cache multipliers + the savings math.
 *
 * Multipliers (Anthropic prompt caching, mirrored in
 * extensions/dashboard-client ProviderCacheCard.tsx — keep in sync):
 *   cache read  = 10%  of the model's full input rate
 *   cache write = 125% of the full input rate
 */

/** Cache-read tokens are billed at this fraction of the full input rate. */
export const PROVIDER_CACHE_READ_MULT = 0.1;
/** Cache-write tokens are billed at this multiple of the full input rate. */
export const PROVIDER_CACHE_WRITE_MULT = 1.25;

/** Token totals consumed by {@link estimateCacheSavings}. */
export interface CacheSavingsInput {
	readonly totalInput: number;
	readonly totalCacheRead: number;
	readonly totalCacheWrite: number;
}

/**
 * Estimate USD saved by provider prompt caching vs the no-cache hypothetical.
 *
 *   withoutCache = totalInput * rate
 *   withCache    = freshInput * rate          (fresh = totalInput − cacheRead)
 *                + totalCacheRead * rate * 0.1
 *                + totalCacheWrite * rate * 1.25
 *   saved        = withoutCache − withCache   (floored at 0 — a cache-heavy
 *                  session with writes can surface as negative savings;
 *                  that is a real signal, not display noise)
 *
 * Returns null when the estimate would be meaningless (non-positive rate,
 * non-finite/negative totals) so the UI can render "—" instead of an
 * invented number.
 */
export function estimateCacheSavings(
	stats: CacheSavingsInput,
	inputRatePerToken: number | null | undefined,
): number | null {
	if (inputRatePerToken == null) return null;
	if (!Number.isFinite(inputRatePerToken) || inputRatePerToken <= 0)
		return null;
	const { totalInput, totalCacheRead, totalCacheWrite } = stats;
	if (
		!Number.isFinite(totalInput) ||
		!Number.isFinite(totalCacheRead) ||
		!Number.isFinite(totalCacheWrite) ||
		totalInput < 0 ||
		totalCacheRead < 0 ||
		totalCacheWrite < 0
	)
		return null;
	const rate = inputRatePerToken;
	const withoutCache = totalInput * rate;
	const freshInput = Math.max(totalInput - totalCacheRead, 0);
	const withCache =
		freshInput * rate +
		totalCacheRead * rate * PROVIDER_CACHE_READ_MULT +
		totalCacheWrite * rate * PROVIDER_CACHE_WRITE_MULT;
	return Math.max(withoutCache - withCache, 0);
}
