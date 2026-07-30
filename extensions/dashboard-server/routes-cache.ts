/**
 * routes-cache.ts — S53A provider prompt-cache stats route.
 *
 * GET /api/provider-cache[?minutes=N] — aggregated provider prompt-cache
 * telemetry (hit %, token totals) over `perf_samples` rows of kind
 * `cache_hit_pct`. All-time unless `minutes` is given (clamped, never
 * throws). This is the lifetime companion to the rolling-window /api/perf —
 * the data source for the Cache tab's Provider Prompt Cache card (the tab
 * previously read only /api/snapshot, i.e. internal dedup stats).
 *
 * Read-only; non-GET -> 405. Loopback-only (PREVENT-PI-004). The underlying
 * query is parameterized and meta-parsed defensively (PREVENT-001/002).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import {
	readProviderCacheStats,
	readPerfSamples,
} from "../../src/store/sqlite.js";
import type {
	PrefixBreakRow,
	ProviderCacheStatsResponse,
} from "./api-contracts/cache.js";

/** Upper bound for the optional window: 30 days in minutes. */
const MAX_WINDOW_MINUTES = 43_200;

export function handleProviderCache(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): boolean {
	if (!req.url?.startsWith("/api/provider-cache")) return false;

	if (req.method !== "GET") {
		res.writeHead(405, { "Content-Type": "application/json" }); // guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
		res.end(JSON.stringify({ error: "method_not_allowed" }));
		return true;
	}

	try {
		// guardrails-allow PREVENT-PI-004: localhost dashboard URL base (loopback-only)
		const url = new URL(req.url, "http://x");
		const raw = url.searchParams.get("minutes");
		let windowMinutes: number | null = null;
		if (raw != null) {
			let minutes = Number(raw);
			if (!Number.isFinite(minutes) || minutes <= 0) minutes = 30;
			windowMinutes = Math.min(minutes, MAX_WINDOW_MINUTES);
		}
		const sinceTs =
			windowMinutes != null ? Date.now() - windowMinutes * 60_000 : 0;
		// guardrails-allow PREVENT-PI-004: local SQLite read (loopback dashboard)
		const stats = readProviderCacheStats(ctx.stateDir, sinceTs);
		// S54: classify-count cache_prefix_break samples within the same window.
		// Defensive meta read (PREVENT-001): cause defaults to "other".
		const breaksByCause = new Map<string, number>();
		// guardrails-allow PREVENT-PI-004: local SQLite read (loopback dashboard)
		for (const row of readPerfSamples(ctx.stateDir, sinceTs, "cache_prefix_break")) {
			const meta = row.meta as { cause?: unknown } | null;
			const cause =
				meta != null && typeof meta.cause === "string" ? meta.cause : "other";
			breaksByCause.set(cause, (breaksByCause.get(cause) ?? 0) + 1);
		}
		const prefixBreaks: PrefixBreakRow[] = [...breaksByCause.entries()]
			.map(([cause, count]) => ({ cause, count }))
			.sort((a, b) => b.count - a.count);
		const body: ProviderCacheStatsResponse = {
			updatedAt: new Date().toISOString(),
			windowMinutes,
			sampleCount: stats.sampleCount,
			avgHitPct: stats.avgHitPct,
			latestHitPct: stats.latestHitPct,
			totalInput: stats.totalInput,
			totalCacheRead: stats.totalCacheRead,
			totalCacheWrite: stats.totalCacheWrite,
			oldestTs: stats.oldestTs,
			newestTs: stats.newestTs,
			prefixBreaks,
		};
		res.writeHead(200, { "Content-Type": "application/json" }); // guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
		res.end(JSON.stringify(body));
	} catch {
		// Non-fatal: a cache-stats failure must never take down the dashboard.
		res.writeHead(500, { "Content-Type": "application/json" }); // guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
		res.end(JSON.stringify({ error: "provider_cache_stats_failed" }));
	}
	return true;
}
