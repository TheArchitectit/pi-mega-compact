/**
 * routes-health.ts — Context Health + KV Cache Poison route handlers.
 *
 * GET /api/context-health — recent health rows, latest composite, trend,
 *   per-model averages, alert flags. Accepts ?minutes=N (default 30).
 * GET /api/cache-poison — recent cache poison events (last 30 min).
 *
 * Guardrails: PREVENT-PI-004 (loopback-only), PREVENT-001 (null-safe),
 * PREVENT-002 (parameterized SQL via accessors). Localhost dashboard.
 */

import { createRequire } from "node:module";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";

export function handleContextHealth(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): boolean {
	if (!req.url?.startsWith("/api/context-health")) return false;
	try {
		if (req.method !== "GET") {
			res.writeHead(405, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "method_not_allowed" }));
			return true;
		}
		const url = new URL(req.url, "http://localhost");
		const minutes = Math.max(1, Number(url.searchParams.get("minutes") ?? 30));
		const sinceTs = Date.now() - minutes * 60_000;

		const pfReq = createRequire(import.meta.url);
		const {
			readLatestContextHealth,
			readContextHealthTrend,
			readContextHealthRows,
		} = pfReq("../../src/store/sqlite.js") as typeof import("../../src/store/sqlite.js");

		const latest = readLatestContextHealth(ctx.stateDir);
		const trend = readContextHealthTrend(ctx.stateDir, 50);
		const rows = readContextHealthRows(ctx.stateDir, sinceTs);

		const perModel = new Map<string, { sum: number; count: number }>();
		for (const r of rows) {
			const mid = r.modelId ?? "(unknown)";
			const entry = perModel.get(mid) ?? { sum: 0, count: 0 };
			entry.sum += r.composite;
			entry.count += 1;
			perModel.set(mid, entry);
		}
		const perModelAverages = [...perModel.entries()].map(([modelId, v]) => ({
			modelId,
			avgComposite: v.count > 0 ? v.sum / v.count : 0,
			sampleCount: v.count,
		}));

		const alerts = rows.filter(
			(r) => r.composite < 0.5 || r.cachePoison < 0.3,
		);

		const body = {
			updatedAt: new Date().toISOString(),
			latest,
			trend,
			rows: rows.slice(-200),
			perModel: perModelAverages,
			alerts,
		};
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(body));
	} catch (e) {
		res.writeHead(500, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: String(e) }));
	}
	return true;
}

export function handleCachePoison(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): boolean {
	if (!req.url?.startsWith("/api/cache-poison")) return false;
	try {
		if (req.method !== "GET") {
			res.writeHead(405, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "method_not_allowed" }));
			return true;
		}
		const sinceTs = Date.now() - 30 * 60_000;
		const pfReq = createRequire(import.meta.url);
		const { readCachePoisonEvents } = pfReq(
			"../../src/store/sqlite.js",
		) as typeof import("../../src/store/sqlite.js");

		const events = readCachePoisonEvents(ctx.stateDir, sinceTs);
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ updatedAt: new Date().toISOString(), events }));
	} catch (e) {
		res.writeHead(500, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: String(e) }));
	}
	return true;
}
