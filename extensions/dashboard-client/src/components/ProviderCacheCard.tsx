/**
 * dashboard-client/src/components/ProviderCacheCard.tsx — Provider Prompt
 * Cache card (S53A/S53C).
 *
 * The data the Cache tab was missing: the LLM provider's prompt-cache stats
 * (hit %, tokens read/written through the cache, fresh input), aggregated
 * from perf_samples via GET /api/provider-cache. Distinct from the
 * CacheHitsCard, which shows mega-compact's internal dedup cache.
 *
 * The $ estimate mirrors src/pricing.ts (Anthropic-style multipliers:
 * cache read = 10% of input rate, cache write = 125%) using the live model's
 * input rate from the snapshot. Keep the two implementations in sync.
 */

import type React from "react";
import type { ProviderCacheStatsResponse } from "@contracts";

export interface ProviderCacheCardProps {
	/** Aggregate stats payload from /api/provider-cache. */
	stats: ProviderCacheStatsResponse;
	/**
	 * Active model's full input rate in USD/token (snapshot.model.inputRate),
	 * used for the savings estimate. Null/undefined → "$ saved" shows "—".
	 */
	inputRatePerToken?: number | null;
}

// Mirror of src/pricing.ts (dashboard-client cannot import outside its vite
// root). PROVIDER_CACHE_READ_MULT = 0.1, PROVIDER_CACHE_WRITE_MULT = 1.25.
function estimateSavedUsd(
	stats: ProviderCacheStatsResponse,
	inputRatePerToken: number | null | undefined,
): number | null {
	if (inputRatePerToken == null) return null;
	if (!Number.isFinite(inputRatePerToken) || inputRatePerToken <= 0)
		return null;
	const rate = inputRatePerToken;
	const freshInput = Math.max(stats.totalInput - stats.totalCacheRead, 0);
	const withoutCache = stats.totalInput * rate;
	const withCache =
		freshInput * rate +
		stats.totalCacheRead * rate * 0.1 +
		stats.totalCacheWrite * rate * 1.25;
	return Math.max(withoutCache - withCache, 0);
}

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return `${Math.round(n)}`;
}

function StatRow({
	label,
	value,
	title,
}: {
	label: string;
	value: string;
	title?: string;
}): React.ReactElement {
	return (
		<div className="ov-stat-row">
			<span className="ov-stat-label" title={title}>
				{label}
			</span>
			<span className="ov-stat-value">{value}</span>
		</div>
	);
}

export function ProviderCacheCard(
	props: ProviderCacheCardProps,
): React.ReactElement {
	const { stats } = props;
	const savedUsd = estimateSavedUsd(stats, props.inputRatePerToken);
	const windowLabel =
		stats.windowMinutes != null
			? `last ${stats.windowMinutes} min`
			: "all-time";
	const empty = stats.sampleCount === 0;

	return (
		<div className="card provider-cache-card">
			<h3>⚡ Provider Prompt Cache</h3>
			{empty ? (
				<div className="ov-stat-row">
					<span className="ov-stat-label">
						No provider cache samples yet ({windowLabel}). Samples appear after
						turns with cache-enabled models.
					</span>
				</div>
			) : (
				<>
					<StatRow
						label="Cache Hit % (avg)"
						value={`${stats.avgHitPct.toFixed(1)}%`}
						title={`Mean provider cache hit rate across ${stats.sampleCount} samples (${windowLabel}). Cache reads bill at ~10% of the input rate.`}
					/>
					<StatRow
						label="Cache Hit % (latest)"
						value={`${stats.latestHitPct.toFixed(1)}%`}
						title="Hit rate of the most recent turn."
					/>
					<StatRow
						label="Tokens Read from Cache"
						value={fmtTokens(stats.totalCacheRead)}
						title={`${stats.totalCacheRead.toLocaleString()} tokens served from the provider cache.`}
					/>
					<StatRow
						label="Tokens Written to Cache"
						value={fmtTokens(stats.totalCacheWrite)}
						title={`${stats.totalCacheWrite.toLocaleString()} tokens written into the provider cache (billed at ~125% of input).`}
					/>
					<StatRow
						label="Fresh Input Tokens"
						value={fmtTokens(stats.totalInput)}
						title={`${stats.totalInput.toLocaleString()} uncached input tokens billed at the full rate.`}
					/>
					<StatRow
						label="Est. $ Saved"
						value={savedUsd != null ? `≈ $${savedUsd.toFixed(4)}` : "—"}
						title="vs the no-cache hypothetical: cache reads at 10% of the input rate, writes at 125%. Requires the active model's input rate."
					/>
					<StatRow label="Window" value={windowLabel} />
					{stats.prefixBreaks.length > 0 && (
						<>
							<div className="ov-subtable-label" title="S54 prefix-break telemetry: why the provider cache prefix broke, by cause. epoch-change = re-compaction rewrote the summary; recall-injection = a recall prepend mutated the system prompt; tool-insertion = mid-array tool churn.">
								Prefix breaks ({windowLabel})
							</div>
							{stats.prefixBreaks.map((b) => (
								<div className="ov-stat-row" key={b.cause}>
									<span className="ov-stat-label">{b.cause}</span>
									<span className="ov-stat-value">{b.count}</span>
								</div>
							))}
						</>
					)}
				</>
			)}
		</div>
	);
}
