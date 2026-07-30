/**
 * routes-memory.ts — S53B durable-memory effectiveness route.
 *
 * GET /api/memory-status[?repo=<path>] — aggregates from src/memoryStats.ts:
 * stored-vs-served counts, 30d recall events/scores (memory-source
 * turn_recall provenance), and the top-stable memory list. Read-only;
 * non-GET -> 405. Loopback-only (PREVENT-PI-004); underlying SQL is
 * parameterized (PREVENT-002).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { readMemoryEffectiveness } from "../../src/memoryStats.js";
import type { MemoryStatusResponse } from "./api-contracts/memory.js";

export function handleMemoryStatus(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): boolean {
	if (!req.url?.startsWith("/api/memory-status")) return false;

	if (req.method !== "GET") {
		res.writeHead(405, { "Content-Type": "application/json" }); // guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
		res.end(JSON.stringify({ error: "method_not_allowed" }));
		return true;
	}

	try {
		// guardrails-allow PREVENT-PI-004: localhost dashboard URL base (loopback-only)
		const url = new URL(req.url, "http://x");
		const repo = url.searchParams.get("repo");
		// guardrails-allow PREVENT-PI-004: local SQLite reads (loopback dashboard)
		const eff = readMemoryEffectiveness(
			repo && repo.trim() !== "" ? repo : null,
			ctx.stateDir,
		);
		const body: MemoryStatusResponse = {
			updatedAt: new Date().toISOString(),
			scope: repo && repo.trim() !== "" ? repo : null,
			totals: {
				memories: eff.totalMemories,
				neverReferenced: eff.neverReferenced,
				stable: eff.stableCount,
			},
			recall: {
				windowDays: 30,
				events30d: eff.recallEvents30d,
				distinctMemories30d: eff.distinctRecalled30d,
				avgScore: eff.avgRecallScore,
			},
			topStable: eff.topStable.map((r) => ({
				id: r.id,
				kind: r.kind,
				category: r.category,
				stability: r.stability,
				events30d: r.events30d,
				avgScore: r.avgScore,
				lastReferencedAt: r.lastReferencedAt,
			})),
			stabilityEnabled: eff.stabilityEnabled,
		};
		res.writeHead(200, { "Content-Type": "application/json" }); // guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
		res.end(JSON.stringify(body));
	} catch {
		// Non-fatal: stats must never take down the dashboard.
		res.writeHead(500, { "Content-Type": "application/json" }); // guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
		res.end(JSON.stringify({ error: "memory_status_failed" }));
	}
	return true;
}
