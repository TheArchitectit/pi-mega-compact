/**
 * dashboard-server/routes-cache.ts — Provider prompt-cache stats route handler.
 *
 * GET /api/provider-cache — Lifetime provider prompt cache hit-rate aggregates
 * plus dollar savings estimate (priced from latest model snapshot).
 * Accepts optional ?minutes=N, ?since=<epoch-ms>, ?until=<epoch-ms> (S53A).
 *
 * Guardrails: PREVENT-PI-004 (loopback-only), PREVENT-001 (null-safe JSON parse),
 * PREVENT-002 (parameterized SQL). Loopback-only localhost dashboard endpoint.
 */

import { createRequire } from "node:module";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { RouteContext } from "./routes-core.js";
import { computeCacheSavings } from "../../src/pricing.js";

// ---------------------------------------------------------------------------
// handleProviderCache — "/api/provider-cache"
// ---------------------------------------------------------------------------

export function handleProviderCache(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): boolean {
	if (!req.url?.startsWith("/api/provider-cache")) return false;
	try {
		const stateDir = ctx.stateDir;
		// PREVENT-PI-004: loopback.
		const pfReq = createRequire(import.meta.url);
		const { readProviderCacheLifetime, readProviderCacheWindow, latestModelSnapshot } = pfReq(
			"../../src/store/sqlite.js",
		) as typeof import("../../src/store/sqlite.js");
		if (req.method !== "GET") {
			// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
			res.writeHead(405, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "method_not_allowed" }));
			return true;
		}

		// Parse query params: ?minutes=N | ?since=&until= (mutually exclusive).
		let windowMinutes: number | null = null;
		let sinceTs = 0;
		let untilTs = 0;
		if (req.url) {
			const qIdx = req.url.indexOf("?");
			if (qIdx !== -1) {
				const params = new URLSearchParams(req.url.slice(qIdx));
				const m = params.get("minutes");
				if (m != null) {
					const n = parseInt(m, 10);
					if (Number.isFinite(n) && n > 0 && String(n) === m.trim()) {
						windowMinutes = n;
					}
				}
				// S53A: ?since=&until= epoch-ms timestamps.
				const s = params.get("since");
				const u = params.get("until");
				if (s != null) {
					const sn = Number(s);
					if (Number.isFinite(sn) && sn >= 0) sinceTs = sn;
				}
				if (u != null) {
					const un = Number(u);
					if (Number.isFinite(un) && un > 0) untilTs = un;
				}
			}
		}

		// S53A: read prefix_break samples in the same window as the aggregates.
		// Import lazily to avoid a circular dependency in the test harness.
		let prefixBreaks: Array<{
			id: number;
			ts: number;
			cause: "recall" | "compaction" | "inject" | "other";
			confidence: number;
			prevHitPct: number;
			currHitPct: number;
			breakAt: number;
		}> = [];
		try {
			// guardrails-allow PREVENT-PI-004: local SQLite read (loopback dashboard)
			const { readPrefixBreaks } = pfReq(
				"../../src/store/sqlite/perf-samples.js",
			) as typeof import("../../src/store/sqlite/perf-samples.js");
			// When ?since=&until= is used, pass those directly; otherwise derive
			// from windowMinutes or 0 (no bounds = lifetime).
			const pSince = sinceTs > 0 ? sinceTs : (windowMinutes != null ? Date.now() - windowMinutes * 60_000 : 0);
			const pUntil = untilTs > 0 ? untilTs : (windowMinutes != null ? Date.now() : 0);
			const rows = readPrefixBreaks(stateDir, pSince, pUntil);
			prefixBreaks = rows.map((r) => ({
				id: r.id,
				ts: r.ts,
				cause: r.meta.cause,
				confidence: r.meta.confidence,
				prevHitPct: r.meta.prevHitPct,
				currHitPct: r.meta.currHitPct,
				breakAt: r.meta.breakAt,
			}));
		} catch {
			/* prefix-break read unavailable — response still returns empty array */
		}

		try {
			const lifetime = windowMinutes != null
				? readProviderCacheWindow(stateDir, windowMinutes)
				: readProviderCacheLifetime(stateDir); // guardrails-allow PREVENT-PI-004: local SQLite read (loopback dashboard)

			// D3: compute dollar savings from the latest model snapshot.  Null-safe:
			// when no snapshot or zero input rate, savings stays null (UI shows "—").
			let savings: {
				cacheReadSaved: number;
				cacheWriteCost: number;
				netSaved: number;
				model: string;
				inputRate: number;
			} | null = null;
			try {
				const snap = latestModelSnapshot(stateDir); // guardrails-allow PREVENT-PI-004: local SQLite read (loopback dashboard)
				if (snap && snap.inputRate > 0) {
					const s = computeCacheSavings(
						lifetime.totalCacheRead,
						lifetime.totalCacheWrite,
						snap.inputRate,
					);
					savings = {
						cacheReadSaved: s.cacheReadSaved,
						cacheWriteCost: s.cacheWriteCost,
						netSaved: s.netSaved,
						model: snap.modelName ?? snap.modelId ?? "unknown",
						inputRate: snap.inputRate,
					};
				}
			} catch {
				/* pricing unavailable — savings stays null */
			}

			const body: {
				cache: {
					avgHitPct: number;
					turnCount: number;
					totalCacheRead: number;
					totalCacheWrite: number;
					totalInput: number;
					firstTurnAt: string | null;
					latestTurnAt: string | null;
					byModel: Array<{
						model: string;
						hitPct: number;
						totalCacheRead: number;
						totalCacheWrite: number;
						sampleCount: number;
					}>;
				};
				savings: {
					cacheReadSaved: number;
					cacheWriteCost: number;
					netSaved: number;
					model: string;
					inputRate: number;
				} | null;
				updatedAt: string;
				windowMinutes?: number | null;
				prefixBreaks: typeof prefixBreaks;
			} = {
				cache: {
					avgHitPct: lifetime.avgHitPct,
					turnCount: lifetime.sampleCount,
					totalCacheRead: lifetime.totalCacheRead,
					totalCacheWrite: lifetime.totalCacheWrite,
					totalInput: lifetime.totalInput,
					firstTurnAt: lifetime.firstSampleAt,
					latestTurnAt: lifetime.latestSampleAt,
					byModel: lifetime.byModel,
				},
				savings,
				updatedAt: new Date().toISOString(),
				windowMinutes,
				prefixBreaks,
			};
			// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(body));
		} catch (e) {
			// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					error: "provider_cache_unavailable",
					detail: String(e),
				}),
			);
		}
		return true;
	} catch {
		return false;
	}
}
// ---------------------------------------------------------------------------
// handleCacheStripes — "GET /api/cache-stripes"
// ---------------------------------------------------------------------------

export function handleCacheStripes(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): boolean {
	if (!req.url?.startsWith("/api/cache-stripes")) return false;
	if (req.method !== "GET") {
		res.writeHead(405, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "method_not_allowed" }));
		return true;
	}
	try {
		const stateDir = ctx.stateDir;
		const pfReq = createRequire(import.meta.url);
		const { readCacheStripes } = pfReq(
			"../../src/store/sqlite/cache-stripes.js",
		) as typeof import("../../src/store/sqlite/cache-stripes.js");
		const result = readCacheStripes(stateDir);
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(result));
	} catch (e) {
		res.writeHead(500, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				error: "cache_stripes_unavailable",
				detail: String(e),
			}),
		);
	}
	return true;
}
