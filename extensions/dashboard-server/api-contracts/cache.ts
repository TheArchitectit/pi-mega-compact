/**
 * api-contracts/cache.ts — S53A provider prompt-cache stats contracts.
 *
 * `GET /api/provider-cache` serves aggregated provider prompt-cache telemetry
 * (capture: extensions/mega-events/perf-handler.ts → perf_samples rows of kind
 * `cache_hit_pct` with meta {input, cacheRead, cacheWrite}). This is the data
 * source for the dashboard Cache tab's "Provider Prompt Cache" card — the fix
 * for the empty-Cache-tab gap (docs/BRANCH_GAP_ANALYSIS.md §4): the tab
 * previously rendered only mega-compact's internal dedup cache (/api/snapshot).
 *
 * Distinct from /api/perf (rolling-window percentiles): this endpoint reports
 * lifetime token totals + hit-rate aggregates, optionally windowed by
 * `minutes`. PREVENT-PI-004: loopback-only data path; all values derive from
 * the local perf_samples table.
 */

/** Query parameters for GET /api/provider-cache. */
export interface ProviderCacheQuery {
	/**
	 * Optional rolling window in minutes. When omitted (or invalid), the
	 * aggregates cover ALL recorded samples ("all-time") and the response's
	 * `windowMinutes` is null.
	 */
	readonly minutes?: number;
}

/**
 * One classified cache prefix break (S54). `cause` is one of
 * "epoch-change" | "recall-injection" | "tool-insertion" | "other" (typed as
 * string at the boundary — the server labels, the client renders).
 */
export interface PrefixBreakRow {
	readonly cause: string;
	readonly count: number;
}

/**
 * Response for GET /api/provider-cache. Token totals are summed from the
 * sample meta blocks; rows with missing/malformed meta are skipped for the
 * totals but still counted in `sampleCount` for the hit-rate averages.
 */
export interface ProviderCacheStatsResponse {
	/** ISO 8601 generation timestamp. */
	readonly updatedAt: string;
	/** Echoed window in minutes, or null when aggregating all-time. */
	readonly windowMinutes: number | null;
	/** Number of cache_hit_pct samples aggregated. */
	readonly sampleCount: number;
	/** Mean hit rate across samples (percent, 0–100). */
	readonly avgHitPct: number;
	/** Most recent sample's hit rate (percent, 0–100). */
	readonly latestHitPct: number;
	/** Σ meta.input — fresh (uncached) input tokens billed at full rate. */
	readonly totalInput: number;
	/** Σ meta.cacheRead — tokens served from the provider cache. */
	readonly totalCacheRead: number;
	/** Σ meta.cacheWrite — tokens written into the provider cache. */
	readonly totalCacheWrite: number;
	/** ts of the oldest sample in the window, or null when empty. */
	readonly oldestTs: number | null;
	/** ts of the newest sample in the window, or null when empty. */
	readonly newestTs: number | null;
	/**
	 * S54: cache prefix breaks by cause within the same window (empty array
	 * when none were recorded — telemetry starts breaking even from S54 on).
	 */
	readonly prefixBreaks: PrefixBreakRow[];
}
