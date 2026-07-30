/**
 * dashboard-client/src/tabs/CacheTab.tsx — Cache tab (NEW).
 *
 * Renders CacheHitsCard + TimeSavedCard from /api/snapshot
 * + ProviderCacheCard from /api/provider-cache via the useApi hook with 5s/30s polling.
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
	const {
		data: snapshot,
		loading,
		error,
	} = useApi<SnapshotResponse>(
		useCallback(() => fetchSnapshot(), []),
		{ pollInterval: 5000 },
	);
	const { data: providerCache } = useApi<ProviderCacheResponse>(
		useCallback(() => fetchProviderCache(), []),
		{ pollInterval: 30000 },
	);

	if (loading && !snapshot)
		return <div className="tab-stub">Loading snapshot…</div>;
	if (error && !snapshot)
		return <div className="tab-stub">Error: {error.message}</div>;
	if (!snapshot) return <div className="tab-stub">No snapshot data.</div>;

	const { cacheHits, compacts, timeSaved } = snapshot;

	return (
		<div className="cache-tab">
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
				{providerCache && <ProviderCacheCard data={providerCache} />}
			</div>
		</div>
	);
}
