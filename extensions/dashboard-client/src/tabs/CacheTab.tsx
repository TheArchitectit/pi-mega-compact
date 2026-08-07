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
	PrefixStabilityResponse,
	SettingsResponse,
} from "@contracts";
import { useApi } from "../hooks/useApi";
import {
	fetchSnapshot,
	fetchProviderCache,
	fetchCacheStripes,
	fetchPrefixStability,
	fetchPerf,
	fetchSettings,
} from "../api/client";
import { CacheHitsCard } from "../components/CacheHitsCard";
import { TimeSavedCard } from "../components/TimeSavedCard";
import { ProviderCacheCard } from "../components/ProviderCacheCard";
import { StripeDistributionCard } from "../components/StripeDistributionCard";
import { CacheHitRateTrendCard } from "../components/CacheHitRateTrendCard";
import { PrefixStabilityCard } from "../components/PrefixStabilityCard";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { MetricsCards } from "./CacheTab/MetricsCards";

const DASH_0C_KEY = "MEGACOMPACT_DASH_0C";

/** Resolve the DASH-0c consolidation flag from the server settings state.
 *  The dashboard client is a browser bundle with NO `process` global, so the
 *  positive sprint flag is read from the server-authoritative /api/rag-settings
 *  state (the server resolves MEGACOMPACT_DASH_0C into a SettingState boolean).
 *  Absent/not-yet-loaded => false (flag-off posture), so flag-off users never
 *  see the Performance section flash; it mounts only once settings confirm ON. */
function dash0cEnabled(settings: SettingsResponse | null): boolean {
	if (!settings) return false;
	for (const cat of settings.categories) {
		for (const s of cat.settings) {
			if (s.key === DASH_0C_KEY && s.type === "boolean") return s.value === true;
		}
	}
	return false;
}

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

	/* --- Per-turn stable-prefix ratio trend (PC-C, 15s poll) --- */
	const {
		data: prefixStability,
		loading: psLoading,
	} = useApi<PrefixStabilityResponse>(
		useCallback(() => fetchPrefixStability(50), []),
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

	/* --- DASH-0c: server-resolved settings state for the flag gate --- */
	const { data: settingsData } = useApi<SettingsResponse>(
		useCallback(() => fetchSettings(), []),
		{ pollInterval: 0, maxRetries: 0 },
	);
	const dash0cOn = dash0cEnabled(settingsData);

	return (
		<div className="flex flex-col gap-4">
			<div>
				<Button
					type="button"
					variant="outline"
					onClick={() => setInfoExpanded(!infoExpanded)}
				>
					{infoExpanded ? "Hide Guidance" : "Show Cache-Friendly Prompt Ordering Guidance"}
				</Button>
				{infoExpanded && (
					<Card className="mt-3">
						<CardHeader>
							<CardTitle>Cache-Friendly Prompt Ordering</CardTitle>
						</CardHeader>
						<CardContent>
							<ul className="list-disc space-y-1 pl-5">
								<li>Keep system prompts and stable context at the top of your conversation — the provider caches the leading prefix.</li>
								<li>Tool results and volatile content are automatically moved to the tail by message separation (<code>MEGACOMPACT_MESSAGE_SEPARATION</code>) so they don't invalidate the cache prefix.</li>
								<li>Cache striping (<code>MEGACOMPACT_CACHE_STRIPING</code>) further orders stable context by a stability score so the most durable chunks lead.</li>
								<li>Avoid inserting new instructions mid-conversation — prepend them instead.</li>
							</ul>
							{snapshot && (
								<div className="mt-2 text-sm">
									<strong>Status:</strong>{" "}
									{snapshot.config.auto ? "Auto-compaction Enabled" : "Auto-compaction Disabled"} |{" "}
									fast-gate {snapshot.config.fastGatePct}% / threshold{" "}
									{snapshot.config.thresholdTokens.toLocaleString()} tokens
								</div>
							)}
						</CardContent>
					</Card>
				)}
			</div>
			{/* ==============================================================
			    Section 1 -- Provider Prompt Cache
			    ============================================================== */}
			<h2 className="font-heading text-lg font-semibold">Provider Prompt Cache</h2>
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
			<h2 className="font-heading text-lg font-semibold">Cache Stripe Distribution</h2>
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
			<h2 className="font-heading text-lg font-semibold">Cache Hit-Rate Trend</h2>
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
			    Section 3b -- Per-Turn Stable Prefix (PC-C)
			    Omitted when flag-off: the endpoint 404s, so psError is set and
			    this section stays empty. No sample/time-series data, only
			    per-turn prefix ratios read from the local events log.
			    ============================================================== */}
			{prefixStability && !psLoading ? (
				<div>
					<h2 className="font-heading text-lg font-semibold">
						Per-Turn Stable Prefix
					</h2>
					<PrefixStabilityCard data={prefixStability} />
				</div>
			) : null}

			{/* ==============================================================
			    Section 4 -- Mega-Compact Dedup Cache
			    ============================================================== */}
			<h2 className="font-heading text-lg font-semibold">Mega-Compact Dedup Cache</h2>
			{snapLoading ? (
				<p className="tab-stub">Loading...</p>
			) : snapError ? (
				<p className="tab-stub">Snapshot unavailable: {snapError.message}</p>
			) : (
				snapshot &&
				(() => {
					const { cacheHits, compacts, timeSaved } = snapshot;
					return (
						<div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
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
			{/* ==============================================================
			    Section 5 -- Performance (DASH-0c)
			    The metrics body (ModelBadge + PerfChart + PerfCards + RagDashboard)
			    absorbed from MetricsTab as a Performance section. Moved VERBATIM to
			    ./CacheTab/MetricsCards.tsx. Omitted entirely when flag-off so the
			    cache-only body is byte-identical to the predecessor.
			    ============================================================== */}
			{dash0cOn && (
				<section aria-labelledby="cache-perf-cards">
					<h2
						id="cache-perf-cards"
						className="font-heading text-lg font-semibold"
					>
						Performance
					</h2>
					<MetricsCards />
				</section>
			)}
		</div>
	);
}
