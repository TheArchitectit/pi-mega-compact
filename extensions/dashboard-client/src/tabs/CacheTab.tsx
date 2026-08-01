/**
 * dashboard-client/src/tabs/CacheTab.tsx -- Cache tab (B.3 + A3).
 *
 * Sections:
 *   1. Provider Prompt Cache    -> ProviderCacheCard        (/api/provider-cache)
 *   2. Cache Stripe Distribution -> StripeDistributionCard  (/api/cache-stripes)
 *   3. Cache Hit-Rate Trend     -> CacheHitRateTrendCard    (/api/perf)
 *   4. Mega-Compact Dedup Cache -> CacheHitsCard + TimeSavedCard  (/api/snapshot)
 *
 * Each section fetches independently; failures in one do not affect others.
 * 5s polling on provider cache and activity snapshot; 15s on stripes + trend.
 */

import { useState, useCallback } from "react";
import type {
	SnapshotResponse,
	ProviderCacheResponse,
	CacheStripesResponse,
	PerfResponse,
} from "@contracts";
import { useApi } from "../hooks/useApi";
import {
	fetchSnapshot,
	fetchProviderCache,
	fetchCacheStripes,
	fetchPerf,
} from "../api/client";
import { CacheHitsCard } from "../components/CacheHitsCard";
import { TimeSavedCard } from "../components/TimeSavedCard";
import { ProviderCacheCard } from "../components/ProviderCacheCard";
import { StripeDistributionCard } from "../components/StripeDistributionCard";
import { CacheHitRateTrendCard } from "../components/CacheHitRateTrendCard";

export default function CacheTab(): React.ReactElement {
	const [infoExpanded, setInfoExpanded] = useState(false);
	/* --- Provider prompt cache (5s poll) --- */
	const {
		data: providerCache,
		loading: pcLoading,
		error: pcError,
	} = useApi<ProviderCacheResponse>(
		useCallback(() => fetchProviderCache(), []),
		{ pollInterval: 5000 },
	);

	/* --- Cache stripe distribution (15s poll) --- */
	const {
		data: stripes,
		loading: stripesLoading,
		error: stripesError,
	} = useApi<CacheStripesResponse>(
		useCallback(() => fetchCacheStripes(), []),
		{ pollInterval: 15000 },
	);

	/* --- Cache hit-rate trend from perf samples (15s poll) --- */
	const {
		data: perf,
		loading: perfLoading,
		error: perfError,
	} = useApi<PerfResponse>(
		useCallback(() => fetchPerf({ minutes: 30 }), []),
		{ pollInterval: 15000 },
	);

	/* --- Dedup cache snapshot (5s poll) --- */
	const {
		data: snapshot,
		loading: snapLoading,
		error: snapError,
	} = useApi<SnapshotResponse>(
		useCallback(() => fetchSnapshot(), []),
		{ pollInterval: 5000 },
	);

	return (
		<div className="cache-tab">
			<div className="card-section">
				<button
					type="button"
					className="info-toggle"
					onClick={() => setInfoExpanded(!infoExpanded)}
				>
					{infoExpanded ? "Hide Guidance" : "Show Cache-Friendly Prompt Ordering Guidance"}
				</button>
				{infoExpanded && (
					<div className="info-panel">
						<h3>Cache-Friendly Prompt Ordering</h3>
						<ul>
							<li>Keep system prompts and stable context at the top of your conversation — the provider caches the leading prefix.</li>
							<li>Tool results and volatile content are automatically moved to the tail by message separation (<code>MEGACOMPACT_MESSAGE_SEPARATION</code>) so they don't invalidate the cache prefix.</li>
							<li>Cache striping (<code>MEGACOMPACT_CACHE_STRIPING</code>) further orders stable context by a stability score so the most durable chunks lead.</li>
							<li>Avoid inserting new instructions mid-conversation — prepend them instead.</li>
						</ul>
						{snapshot && (
							<div className="cache-status-indicator">
								<strong>Status:</strong>{" "}
								{snapshot.config.messageSeparation ? "Separation Enabled" : "Separation Disabled (Check env)"} |{" "}
								{snapshot.config.cacheStriping ? "Striping Enabled" : "Striping Disabled (Check env)"}
							</div>
						)}
					</div>
				)}
			</div>
			{/* ==============================================================
			    Section 1 -- Provider Prompt Cache
			    ============================================================== */}
			<h2>Provider Prompt Cache</h2>
			{pcLoading ? (
				<p className="tab-stub">Loading...</p>
			) : pcError ? (
				<p className="tab-stub">
					Provider cache unavailable: {pcError.message}
				</p>
			) : providerCache ? (
				<ProviderCacheCard
					hitPct={providerCache.cache.avgHitPct}
					turnCount={providerCache.cache.turnCount}
					totalCacheRead={providerCache.cache.totalCacheRead}
					totalCacheWrite={providerCache.cache.totalCacheWrite}
					totalInput={providerCache.cache.totalInput}
					cacheReadSaved={providerCache.savings?.cacheReadSaved ?? null}
					cacheWriteCost={providerCache.savings?.cacheWriteCost ?? null}
					netSaved={providerCache.savings?.netSaved ?? null}
					modelLabel={providerCache.savings?.model ?? null}
					firstTurnAt={providerCache.cache.firstTurnAt}
					latestTurnAt={providerCache.cache.latestTurnAt}
					byModel={providerCache.cache.byModel ?? []}
				/>
			) : null}

			{/* ==============================================================
			    Section 2 -- Cache Stripe Distribution
			    ============================================================== */}
			<h2>Cache Stripe Distribution</h2>
			{stripesLoading ? (
				<p className="tab-stub">Loading...</p>
			) : stripesError ? (
				<p className="tab-stub">
					Cache stripe data unavailable: {stripesError.message}
				</p>
			) : stripes ? (
				<StripeDistributionCard data={stripes} />
			) : null}

			{/* ==============================================================
			    Section 3 -- Cache Hit-Rate Trend
			    ============================================================== */}
			<h2>Cache Hit-Rate Trend</h2>
			{perfLoading ? (
				<p className="tab-stub">Loading...</p>
			) : perfError ? (
				<p className="tab-stub">
					Hit-rate trend unavailable: {perfError.message}
				</p>
			) : perf ? (
				<CacheHitRateTrendCard perf={perf} />
			) : null}

			{/* ==============================================================
			    Section 4 -- Mega-Compact Dedup Cache
			    ============================================================== */}
			<h2>Mega-Compact Dedup Cache</h2>
			{snapLoading ? (
				<p className="tab-stub">Loading...</p>
			) : snapError ? (
				<p className="tab-stub">Snapshot unavailable: {snapError.message}</p>
			) : (
				snapshot &&
				(() => {
					const { cacheHits, compacts, timeSaved } = snapshot;
					return (
						<div className="card-grid overview-card-grid">
							<CacheHitsCard
								cacheHitsSession={cacheHits.session}
								cacheHitsTotal={cacheHits.total}
								tokensSavedSession={cacheHits.sessionTokensSaved}
								tokensSavedTotal={cacheHits.totalTokensSaved}
								compactionsSession={compacts.session}
								compactionsTotal={compacts.total}
							/>
							<TimeSavedCard
								compactSessionSec={timeSaved.compact.sessionSec}
								compactTotalSec={timeSaved.compact.totalSec}
								cacheHitSessionSec={timeSaved.cacheHit.sessionSec}
								cacheHitTotalSec={timeSaved.cacheHit.totalSec}
							/>
						</div>
					);
				})()
			)}
		</div>
	);
}
