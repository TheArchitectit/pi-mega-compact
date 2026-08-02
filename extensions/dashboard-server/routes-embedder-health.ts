/**
 * dashboard-server/routes-embedder-health.ts — Embedder health probe route.
 *
 * GET /api/embedder-health — Round-trips a test embed through the active
 * embedder and reports reachability + latency + dimensions.
 *
 * PREVENT-PI-004: probes the active embedder, which is either the built-in
 * TrigramEmbedder (pure local math) or the HttpEmbedder pointed at a
 * user-spawned localhost server — the existing audited loopback exception
 * (see httpEmbedder.ts). No new network paths are introduced here.
 */

import { performance } from "node:perf_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { detectCurrentEmbedder } from "./routes-setup.js";
import { defaultEmbedder } from "../../src/embedder.js";
import type { EmbedderHealthResponse } from "./api-contracts/embedder-health.js";

/** Mask an embedding URL down to scheme://hostname:port, stripping path +
 *  any embedded credentials. Returns null when the env URL is unset/empty. */
function maskEmbeddingUrl(): string | null {
	const raw = process.env["MEGACOMPACT_EMBEDDING_URL"];
	if (!raw || raw.trim().length === 0) return null;
	try {
		const u = new URL(raw);
		return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`;
	} catch {
		return null;
	}
}

export function handleEmbedderHealth(
	req: IncomingMessage,
	res: ServerResponse,
	_ctx: RouteContext,
): boolean {
	if (req.url !== "/api/embedder-health") return false;
	if (req.method !== "GET") {
		// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
		res.writeHead(405, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "method_not_allowed" }));
		return true;
	}

	const activeEmbedder = detectCurrentEmbedder();
	const url = maskEmbeddingUrl();

	let status: "ok" | "unreachable" | "error" = "ok";
	let dim = 0;
	let error: string | undefined;
	const start = performance.now();
	try {
		const embedder = defaultEmbedder();
		embedder.embed("mega-compact health probe");
		dim = embedder.dim;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		status = /unreachable/i.test(msg) ? "unreachable" : "error";
		error = msg;
	}
	const latencyMs = performance.now() - start;

	const body: EmbedderHealthResponse = {
		activeEmbedder,
		status,
		latencyMs,
		dim,
		url,
		...(error !== undefined ? { error } : {}),
	};

	// guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
	return true;
}
