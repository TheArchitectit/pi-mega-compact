/**
 * dashboard-server/routes-prefix-stability.ts — Prompt-cache prefix-stability route (PC-C).
 *
 * GET /api/prefix-stability?limit=50 — reads recent prefix_stability rows from the
 * local monitoring events log (ctx.eventsPath) and returns the per-turn stable-prefix
 * ratio trend. Flag-off (MEGACOMPACT_PC_C=0) → 404, byte-identical to PC-B predecessor.
 *
 * Guardrails: PREVENT-PI-004 (loopback-only local dashboard), PREVENT-001 (null-safe
 * JSON.parse), PREVENT-011 (no `any`). Zero network reads.
 */

import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { PrefixStabilityResponse } from "./api-contracts/prefix-stability.js";
import type { RouteContext } from "./routes-core.js";

/** Parse one events.log line into a generic JSON object, null-safe (PREVENT-001). */
function parseEventLine(line: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(line);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return null;
	} catch {
		return null;
	}
}

/** Read the tail of events.log and return only prefix_stability rows, newest last. */
function readPrefixStabilityEvents(
	eventsPath: string,
	limit: number,
): Array<{ ts: number; stablePrefix: number; totalMessages: number; separation: string; striping: string }> {
	const samples: Array<{
		ts: number;
		stablePrefix: number;
		totalMessages: number;
		separation: string;
		striping: string;
	}> = [];
	let raw = "";
	try {
		raw = readFileSync(eventsPath, "utf-8"); // guardrails-allow PREVENT-PI-004: local events.log read (loopback dashboard)
	} catch {
		return samples;
	}
	for (const line of raw.split("\n")) {
		if (!line.includes('"prefix_stability"')) continue;
		const obj = parseEventLine(line);
		if (!obj) continue;
		// Only rows we appended (event === "prefix_stability").
		if (obj.event !== "prefix_stability") continue;
		const ts = typeof obj.ts === "number" ? obj.ts : 0;
		const stablePrefix = typeof obj.stablePrefix === "number" ? obj.stablePrefix : 0;
		const totalMessages = typeof obj.totalMessages === "number" ? obj.totalMessages : 0;
		const striping = typeof obj.striping === "string" ? obj.striping : "off";
		const separation = typeof obj.separation === "string" ? obj.separation : "off";
		samples.push({ ts, stablePrefix, totalMessages, separation, striping });
	}
	return samples.slice(-limit);
}

/** Classify the three-point trend across the returned window (head-mean vs tail-mean). */
function classifyTrend(ratios: number[]): PrefixStabilityResponse["trend"] {
	if (ratios.length < 3) return "stable";
	const third = Math.max(1, Math.floor(ratios.length / 3));
	const head = ratios.slice(0, third).reduce((a, b) => a + b, 0) / third;
	const tail = ratios.slice(-third).reduce((a, b) => a + b, 0) / third;
	const delta = tail - head;
	if (delta > 0.05) return "improving";
	if (delta < -0.05) return "degrading";
	return "stable";
}

/** Positive sprint-flag check (matches sprintFlag: `=0`/`=false`/`_DISABLED=true` → OFF). */
function prefixStabilityEnabled(): boolean {
	const v = process.env.MEGACOMPACT_PC_C;
	if (v === "0" || v === "false") return false;
	const disabled = process.env.MEGACOMPACT_PC_C_DISABLED;
	if (disabled === "true" || disabled === "1") return false;
	return true;
}

export function handlePrefixStability(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): boolean {
	if (!req.url?.startsWith("/api/prefix-stability")) return false;
	if (!prefixStabilityEnabled()) {
		// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "not_found" }));
		return true;
	}
	if (req.method !== "GET") {
		// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
		res.writeHead(405, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "method_not_allowed" }));
		return true;
	}
	let limit = 50;
	if (req.url.includes("?")) {
		const params = new URLSearchParams(req.url.slice(req.url.indexOf("?")));
		const l = params.get("limit");
		if (l != null) {
			const n = parseInt(l, 10);
			if (Number.isFinite(n) && n > 0) limit = Math.min(n, 500);
		}
	}
	try {
		const events = readPrefixStabilityEvents(ctx.eventsPath, limit);
		const turns = events.map((e, i) => ({
			turnIndex: i,
			stablePrefix: e.stablePrefix,
			totalMessages: e.totalMessages,
			ratio: e.totalMessages > 0 ? e.stablePrefix / e.totalMessages : 0,
			striping: e.striping,
			timestamp: new Date(e.ts).toISOString(),
		}));
		const avgRatio = turns.length
			? turns.reduce((a, t) => a + t.ratio, 0) / turns.length
			: 0;
		const body: PrefixStabilityResponse = {
			turns,
			avgRatio: Math.round(avgRatio * 1000) / 1000,
			trend: classifyTrend(turns.map((t) => t.ratio)),
			count: turns.length,
			lastScanAt: Date.now(),
		};
		// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(body));
	} catch (e) {
		// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
		res.writeHead(500, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "prefix_stability_unavailable", detail: String(e) }));
	}
	return true;
}
