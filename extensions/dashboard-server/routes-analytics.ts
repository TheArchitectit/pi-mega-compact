/**
 * routes-analytics.ts — PMA-3 typed analytics API routes.
 *
 * GET /api/analytics/status   — store health + counts.
 * GET /api/analytics/detailed  — filterable, paginated request-event drill-down.
 *
 * Reader-only route context: obtains asReader() (never writer/admin) per spec §10.
 * PREVENT-PI-004: loopback dashboard only. PREVENT-002: parameterized queries.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { RouteContext } from "./routes-core.js";
import type {
	AnalyticsStatusResponse,
	AnalyticsDetailedResponse,
	AnalyticsEventRow,
} from "./api-contracts/analytics.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" }); // guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
	res.end(JSON.stringify(body));
}

/** GET /api/analytics/status — store health + row counts + freshness. */
export function handleAnalyticsStatus(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): boolean {
	if (!req.url?.startsWith("/api/analytics/status")) return false;
	if (req.method !== "GET") {
		sendJson(res, 405, { error: "method_not_allowed" });
		return true;
	}
	try {
		const pfReq = createRequire(import.meta.url);
		const { createAnalyticsStore } = pfReq("../../src/store/analytics/index.js") as
			typeof import("../../src/store/analytics/index.js");
		const store = createAnalyticsStore({ stateDir: ctx.stateDir });
		const st = store.asReader().status();
		const body: AnalyticsStatusResponse = {
			enabled: st.enabled,
			schemaVersion: st.schemaVersion,
			requestEventCount: st.requestEventCount,
			measurementCount: st.measurementCount,
			identityCount: st.identityCount,
			freshThrough: st.freshThrough,
		};
		sendJson(res, 200, body);
		return true;
	} catch (e) {
		sendJson(res, 500, { error: "analytics_unavailable", detail: String(e) });
		return true;
	}
}

/** GET /api/analytics/detailed?from=&to=&provider=&model=&status=&eventKind=&limit=&offset= */
export function handleAnalyticsDetailed(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): boolean {
	if (!req.url?.startsWith("/api/analytics/detailed")) return false;
	if (req.method !== "GET") {
		sendJson(res, 405, { error: "method_not_allowed" });
		return true;
	}
	try {
		// Parse query params.
		const qIdx = req.url.indexOf("?");
		const params = new URLSearchParams(qIdx >= 0 ? req.url.slice(qIdx + 1) : "");
		const fromMs = params.get("from") ? Number(params.get("from")) : undefined;
		const toMs = params.get("to") ? Number(params.get("to")) : undefined;
		const limit = params.get("limit") ? Number(params.get("limit")) : undefined;
		const offset = params.get("offset") ? Number(params.get("offset")) : undefined;

		// Validate numeric params.
		for (const [k, v] of [["from", fromMs], ["to", toMs], ["limit", limit], ["offset", offset]] as const) {
			if (v != null && !Number.isFinite(v)) {
				sendJson(res, 400, { error: "invalid_param", param: k });
				return true;
			}
		}

		const pfReq = createRequire(import.meta.url);
		const { createAnalyticsStore } = pfReq("../../src/store/analytics/index.js") as
			typeof import("../../src/store/analytics/index.js");
		const store = createAnalyticsStore({ stateDir: ctx.stateDir });
		const page = store.asReader().listEvents({
			fromMs,
			toMs,
			provider: params.get("provider") ?? undefined,
			model: params.get("model") ?? undefined,
			status: params.get("status") ?? undefined,
			eventKind: params.get("eventKind") as any ?? undefined,
			limit,
			offset,
		});
		const body: AnalyticsDetailedResponse = {
			events: page.events.map((e): AnalyticsEventRow => ({
				id: e.id,
				correlationId: e.correlationId ?? null,
				sessionId: e.sessionId ?? null,
				eventKind: e.eventKind,
				observedAt: e.observedAt,
				provider: e.provider ?? null,
				model: e.model ?? null,
				status: e.status ?? null,
				inputTokens: e.inputTokens ?? null,
				outputTokens: e.outputTokens ?? null,
				cacheReadTokens: e.cacheReadTokens ?? null,
				cacheWriteTokens: e.cacheWriteTokens ?? null,
				durationMs: e.durationMs ?? null,
				ttftMs: e.ttftMs ?? null,
			})),
			total: page.total,
			hasMore: page.hasMore,
			generatedAt: Date.now(),
			window: { fromMs: fromMs ?? null, toMs: toMs ?? null },
		};
		sendJson(res, 200, body);
		return true;
	} catch (e) {
		sendJson(res, 500, { error: "analytics_unavailable", detail: String(e) });
		return true;
	}
}
