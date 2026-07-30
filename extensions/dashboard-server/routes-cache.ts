/**
 * dashboard-server/routes-cache.ts — Provider prompt-cache stats route handler.
 *
 * GET /api/provider-cache — Lifetime provider prompt cache hit-rate aggregates
 * plus dollar savings estimate (priced from latest model snapshot).
 *
 * Guardrails: PREVENT-PI-004 (loopback-only), PREVENT-001 (null-safe JSON parse),
 * PREVENT-002 (parameterized SQL). Loopback-only localhost dashboard endpoint.
 */

import { createRequire } from "node:module";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { RouteContext } from "./routes-core.js";

// ---------------------------------------------------------------------------
// handleProviderCache — "/api/provider-cache"
// ---------------------------------------------------------------------------

export function handleProviderCache(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): boolean {
	if (!req.url?.startsWith("/api/provider-cache")) return false;

	const { stateDir } = ctx;

	// /api/provider-cache — GET returns lifetime provider prompt cache aggregates
	// from perf_samples (cache_hit_pct rows with meta JSON) plus an optional
	// dollar savings estimate priced from the latest model snapshot. The dashboard
	// server is a detached child with no MegaRuntime ref, so it reads via a
	// require()'d sqlite helper (same pattern as /api/perf). Non-GET → 405.
	// PREVENT-PI-004: loopback.
	const pfReq = createRequire(import.meta.url);
	const { readProviderCacheLifetime, latestModelSnapshot } = pfReq(
		"../../src/store/sqlite.js",
	) as typeof import("../../src/store/sqlite.js");
	if (req.method !== "GET") {
		// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
		res.writeHead(405, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "method_not_allowed" }));
		return true;
	}
	try {
		const lifetime = readProviderCacheLifetime(stateDir); // guardrails-allow PREVENT-PI-004: local SQLite read (loopback dashboard)

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
				// cacheReadSaved = totalCacheRead × inputRate × 0.9 (reads cost 10% of input → save 90%)
				const cacheReadSaved = lifetime.totalCacheRead * snap.inputRate * 0.9;
				// cacheWriteCost = totalCacheWrite × inputRate × 0.25 (writes cost 125% → 25% premium)
				const cacheWriteCost = lifetime.totalCacheWrite * snap.inputRate * 0.25;
				savings = {
					cacheReadSaved,
					cacheWriteCost,
					netSaved: cacheReadSaved - cacheWriteCost,
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
			};
			savings: {
				cacheReadSaved: number;
				cacheWriteCost: number;
				netSaved: number;
				model: string;
				inputRate: number;
			} | null;
			updatedAt: string;
		} = {
			cache: {
				avgHitPct: lifetime.avgHitPct,
				turnCount: lifetime.sampleCount,
				totalCacheRead: lifetime.totalCacheRead,
				totalCacheWrite: lifetime.totalCacheWrite,
				totalInput: lifetime.totalInput,
				firstTurnAt: lifetime.firstSampleAt,
				latestTurnAt: lifetime.latestSampleAt,
			},
			savings,
			updatedAt: new Date().toISOString(),
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
}
