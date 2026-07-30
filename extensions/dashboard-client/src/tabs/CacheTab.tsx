/**
 * dashboard-client/src/tabs/CacheTab.tsx — Cache tab.
 *
 * S53A: renders the Provider Prompt Cache card (provider hit %, cache
 * read/write token totals, $ estimate) from /api/provider-cache alongside the
 * original mega-compact dedup cards from /api/snapshot. Previously this tab
 * rendered ONLY the dedup stats — which read zeros before any compaction —
 * leaving the tab effectively empty (see docs/BRANCH_GAP_ANALYSIS.md §4).
 *
 * Both fetches poll on a 5s interval via the useApi hook.
 */

import type React from "react";
import { useCallback } from "react";
import type {
	SnapshotResponse,
	ProviderCacheStatsResponse,
	MemoryStatusResponse,
} from "@contracts";
import { useApi } from "../hooks/useApi";
import {
	fetchSnapshot,
	fetchProviderCacheStats,
	fetchMemoryStatus,
} from "../api/client";
import { CacheHitsCard } from "../components/CacheHitsCard";
import { ProviderCacheCard } from "../components/ProviderCacheCard";
import { MemoryEffectivenessCard } from "../components/MemoryEffectivenessCard";
import { TimeSavedCard } from "../components/TimeSavedCard";

export default function CacheTab(): React.ReactElement {
	const { data: snapshot, loading, error } = useApi<SnapshotResponse>(
		useCallback(() => fetchSnapshot(), []),
		{ pollInterval: 5000 },
	);
	// Provider cache + memory effectiveness load independently: keep the dedup
	// cards working even if these newer endpoints fail on an older server build.
	const { data: providerCache } = useApi<ProviderCacheStatsResponse>(
		useCallback(() => fetchProviderCacheStats(), []),
		{ pollInterval: 5000 },
	);
	const { data: memoryStatus } = useApi<MemoryStatusResponse>(
		useCallback(() => fetchMemoryStatus(), []),
		{ pollInterval: 5000 },
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
				{providerCache && (
					<ProviderCacheCard
						stats={providerCache}
						inputRatePerToken={snapshot.model?.inputRate ?? null}
					/>
				)}
				{memoryStatus && <MemoryEffectivenessCard status={memoryStatus} />}
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
		</div>
	);
}
