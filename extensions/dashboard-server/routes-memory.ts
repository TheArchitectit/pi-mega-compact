/**
 * dashboard-server/routes-memory.ts — Memory effectiveness stats route handler (S53B).
 *
 * GET /api/memory-status — Returns memoryStats() aggregated data:
 *   totalMemories, memoriesInLast30Days, topStableMemories, avgRecallScore.
 *
 * Guardrails: PREVENT-PI-004 (loopback-only), PREVENT-001 (null-safe JSON),
 * PREVENT-002 (parameterized SQL — memoryStats uses openStore internally).
 * Loopback-only localhost dashboard endpoint.
 */

import { createRequire } from "node:module";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import type { MemoryStatusResponse } from "./api-contracts/memory.js";

// ---------------------------------------------------------------------------
// handleMemoryStatus — "/api/memory-status"
// ---------------------------------------------------------------------------

export function handleMemoryStatus(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): boolean {
	try {
		if (req.method !== "GET") {
			// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
			res.writeHead(405, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "method_not_allowed" }));
			return true;
		}
		// PREVENT-PI-004: loopback-only — read from local SQLite store.
		const memReq = createRequire(import.meta.url);
		const { memoryStats } = memReq(
			"../../src/memoryStats.js",
		) as typeof import("../../src/memoryStats.js");

		memoryStats(ctx.stateDir)
			.then((stats) => {
				const body: MemoryStatusResponse = {
					totalMemories: stats.totalMemories,
					memoriesInLast30Days: stats.memoriesInLast30Days,
					topStableMemories: stats.topStableMemories.map((m) => ({
						id: m.id,
						text: m.text,
						recallCount: m.recallCount,
						lastRecalledAt: m.lastRecalledAt,
					})),
					avgRecallScore: stats.avgRecallScore,
				};
				// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(body));
			})
			.catch(() => {
				// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "memory_stats_unavailable" }));
			});
		return true;
	} catch {
		return false;
	}
}