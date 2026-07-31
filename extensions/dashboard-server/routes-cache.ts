/**
 * dashboard-server/routes-cache.ts — Provider prompt-cache stats route handler.
 *
 * GET /api/provider-cache — Lifetime provider prompt cache hit-rate aggregates
 * plus dollar savings estimate (priced from latest model snapshot).
 * Accepts optional ?minutes=N to scope to a trailing window.
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

		// Parse optional ?minutes=N from the query string.
		let windowMinutes: number | null = null;
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
			}
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
				windowMinutes,
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