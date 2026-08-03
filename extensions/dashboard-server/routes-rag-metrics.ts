/**
 * dashboard-server/routes-rag-metrics.ts — GET /api/rag-metrics route (H2).
 *
 * Aggregates the H1 HyDE + recall-quality telemetry columns from turns.db into
 * a compact response (flags, totals, recent rows, daily series).
 *
 * Guardrails: PREVENT-PI-004 (loopback-only), PREVENT-002 (parameterized),
 * PREVENT-011 (no `any`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { RouteContext } from "./routes-core.js";
import { openTurnStore } from "../../src/store/turns/connection.js";
import {
	listTelemetryTurns,
	aggregateDailyTelemetry,
} from "../../src/store/turns/hydeStore.js";
import { RAG_HYDE_ENABLED, RAG_RECALL_METRICS } from "../../src/config.js";
import type { RagMetricsResponse } from "./api-contracts/rag-metrics.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

export function handleRagMetrics(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): boolean {
	const url = req.url ?? "";
	if (url !== "/api/rag-metrics" || req.method !== "GET") return false;

	let db: DatabaseSync | null;
	try {
		db = openTurnStore(ctx.stateDir);
	} catch {
		db = null;
	}
	const recent = db ? listTelemetryTurns(db, { limit: 200 }) : [];
	const daily = db ? aggregateDailyTelemetry(db, 14) : [];

	const hydeRanTurns = recent.filter((t) => t.hydeRan === 1).length;
	const liftSum = recent.reduce((s, t) => s + t.hydeLift, 0);
	const genSum = recent.reduce((s, t) => s + t.hydeGenerationMs, 0);
	const scored = recent.filter(
		(t) => t.recallScore > 0 || t.recallPass === 1,
	);
	const avgScore =
		scored.length > 0
			? Math.round(
					(scored.reduce((s, t) => s + t.recallScore, 0) / scored.length) * 100,
				) / 100
			: null;
	const passCount = scored.filter((t) => t.recallPass === 1).length;
	const recentPassRate =
		scored.length > 0 ? Math.round((passCount / scored.length) * 100) / 100 : 0;

	const body: RagMetricsResponse = {
		flags: {
			hydeEnabled: RAG_HYDE_ENABLED(),
			recallMetricsEnabled: RAG_RECALL_METRICS(),
		},
		totals: {
			telemetryTurns: recent.length,
			hydeRanTurns,
			avgLift:
				recent.length > 0
					? Math.round((liftSum / recent.length) * 100) / 100
					: 0,
			avgScore,
			avgGenerationMs: recent.length > 0 ? Math.round(genSum / recent.length) : 0,
			recentPassRate,
		},
		recent: recent.slice(0, 50),
		daily,
	};
	sendJson(res, 200, body);
	return true;
}
