/**
 * dashboard-client/src/tabs/CacheTab.tsx — Cache tab (B.3).
 *
 * Two sections, each with its own header:
 *   1. Provider Prompt Cache  → ProviderCacheCard  (/api/provider-cache)
 *   2. Mega-Compact Dedup Cache → CacheHitsCard + TimeSavedCard  (/api/snapshot)
 *
 * Both fetch at 5s polling (same interval). Loading / error shown per-section
 * only when its own fetch fails; the other section keeps rendering.
 */

import type React from "react";
import { useCallback } from "react";
import type { SnapshotResponse, ProviderCacheResponse } from "@contracts";
import { useApi } from "../hooks/useApi";
import { fetchSnapshot, fetchProviderCache } from "../api/client";
import { CacheHitsCard } from "../components/CacheHitsCard";
import { TimeSavedCard } from "../components/TimeSavedCard";
import { ProviderCacheCard } from "../components/ProviderCacheCard";

export default function CacheTab(): React.ReactElement {
	/* --- Provider prompt cache (5s poll) --- */
	const {
		data: providerCache,
		loading: pcLoading,
		error: pcError,
	} = useApi<ProviderCacheResponse>(
		useCallback(() => fetchProviderCache(), []),
		{ pollInterval: 5000 },
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
			{/* ==============================================================
			    Section 1 — Provider Prompt Cache
			    ============================================================== */}
			<h2>Provider Prompt Cache</h2>
			{pcLoading ? (
				<p className="tab-loading">Loading…</p>
			) : pcError ? (
				<p className="tab-error">Provider cache unavailable: {pcError.message}</p>
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
				/>
			) : null}

			{/* ==============================================================
			    Section 2 — Mega-Compact Dedup Cache
			    ============================================================== */}
			<h2>Mega-Compact Dedup Cache</h2>
			{snapLoading ? (
				<p className="tab-loading">Loading…</p>
			) : snapError ? (
				<p className="tab-error">Snapshot unavailable: {snapError.message}</p>
			) : (
				snapshot && (() => {
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
