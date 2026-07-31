/**
 * api-contracts/provider-cache.ts — Provider prompt cache contract (A.2).
 *
 * Response shape for GET /api/provider-cache: lifetime cache hit-rate
 * aggregates plus optional $ savings estimate priced from model snapshots.
 */

/** Savings estimate derived from model pricing snapshot. */
export interface ProviderCacheSavings {
	readonly cacheReadSaved: number;
	readonly cacheWriteCost: number;
	readonly netSaved: number;
	readonly model: string;
	readonly inputRate: number;
}

/** Response body for GET /api/provider-cache. */
export interface ProviderCacheResponse {
	readonly cache: {
		readonly avgHitPct: number;
		readonly turnCount: number;
		readonly totalCacheRead: number;
		readonly totalCacheWrite: number;
		readonly totalInput: number;
		readonly firstTurnAt: string | null;
		readonly latestTurnAt: string | null;
	};
	readonly savings: ProviderCacheSavings | null;
	readonly updatedAt: string;
	/** When non-null, the response is scoped to the last N minutes. */
	readonly windowMinutes?: number | null;
}
