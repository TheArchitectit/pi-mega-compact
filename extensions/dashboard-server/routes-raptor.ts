/**
 * routes-raptor.ts — GET /api/raptor-tree route handler (Part B).
 *
 * Returns the hierarchical RAPTOR tree (summary nodes by level) for a session.
 * When no sessionId is given, resolves to the most recent session that has
 * raptor nodes. Reads only from the local SQLite store (PREVENT-PI-004 OK).
 * Uses an inline require to the pi-agnostic src/store/sqlite/raptor.ts reader.
 */
import { createRequire } from "node:module";
import type { ServerResponse, IncomingMessage } from "node:http";
import { parse as parseUrl } from "node:url";
import type { RouteContext } from "./routes-core.js";
import type { RaptorTreeResponse, RaptorNodeDTO, RaptorBuildHistoryResponse, RaptorBuildHistoryDTO } from "./api-contracts/raptor.js";
import { openStore } from "../../src/store/sqlite.js";

const _req = createRequire(import.meta.url);

// guardrails-allow PREVENT-PI-004: local loopback-only dashboard endpoint — reads the local SQLite store for RAPTOR tree data, zero remote network calls.

/** Full node shape returned by listRaptorNodes (includes the embedding vector). */
type StoredRaptorNode = {
	id: string;
	sessionId: string;
	level: number;
	parentId: string | null;
	children: string[];
	summary: string;
	embedding: number[];
	qualityMarker: string;
	tokenEstimate: number;
	builtAt: number;
};

/** Find the most recent sessionId that has raptor nodes (else null). */
function latestRaptorSession(stateDir: string): string | null {
	try {
		const db = openStore(stateDir);
		const row = db
			.prepare(
				"SELECT DISTINCT session_id FROM raptor_nodes ORDER BY built_at DESC LIMIT 1",
			)
			.get() as { session_id: string } | undefined;
		return row?.session_id ?? null;
	} catch {
		// no raptor_nodes table yet (fresh DB) — treat as empty
		return null;
	}
}

function toDTO(node: StoredRaptorNode): RaptorNodeDTO {
	return {
		id: node.id,
		sessionId: node.sessionId,
		level: node.level,
		parentId: node.parentId,
		children: node.children,
		summary: node.summary,
		qualityMarker: node.qualityMarker,
		tokenEstimate: node.tokenEstimate,
		builtAt: node.builtAt,
	};
}

function emptyResponse(): RaptorTreeResponse {
	return { nodes: [], levels: 0, rootId: null, builtAt: null, empty: true };
}

export function handleRaptorTree(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): boolean {
	if (req.method !== "GET") return false;
	const parsed = parseUrl(req.url ?? "", true);
	if (parsed.pathname !== "/api/raptor-tree") return false;

	try {
		const { listRaptorNodes } = _req(
			"../../src/store/sqlite/raptor.js",
		) as {
			listRaptorNodes: (
				sessionId: string,
				stateDir: string,
			) => StoredRaptorNode[];
		};

		let sessionId =
			typeof parsed.query.sessionId === "string" ? parsed.query.sessionId : "";

		if (!sessionId) {
			sessionId = latestRaptorSession(ctx.stateDir) ?? "";
			if (!sessionId) {
				const body = emptyResponse();
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(body));
				return true;
			}
		}

		const nodes = listRaptorNodes(sessionId, ctx.stateDir);
		if (nodes.length === 0) {
			const body = emptyResponse();
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(body));
			return true;
		}

		const dtos: RaptorNodeDTO[] = nodes.map(toDTO);
		const levels = dtos.reduce((m, n) => Math.max(m, n.level), 0);
		const root = dtos.find((n) => n.parentId === null);
		const builtAt = dtos.reduce((m, n) => Math.max(m, n.builtAt), 0);
		const body: RaptorTreeResponse = {
			nodes: dtos,
			levels,
			rootId: root?.id ?? null,
			builtAt,
			empty: false,
		};

		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(body));
		return true;
	} catch (e) {
		res.writeHead(500, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: String(e) }));
		return true;
	}
}

/** Find the most recent session that has build history rows (else null). */
function latestBuildSession(stateDir: string): string | null {
	try {
		const db = openStore(stateDir);
		const row = db
			.prepare(
				"SELECT DISTINCT session_id FROM raptor_build_history ORDER BY completed_at DESC LIMIT 1",
			)
			.get() as { session_id: string } | undefined;
		return row?.session_id ?? null;
	} catch {
		return null;
	}
}

export function handleRaptorBuildHistory(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): boolean {
	if (req.method !== "GET") return false;
	const parsed = parseUrl(req.url ?? "", true);
	if (parsed.pathname !== "/api/raptor-build-history") return false;

	try {
		const { listBuildHistory } = _req(
			"../../src/dedup/raptor/buildHistory.js",
		) as {
			listBuildHistory: (
				sessionId: string,
				stateDir: string,
			) => Array<{
				buildId: string;
				sessionId: string;
				startedAt: number;
				completedAt: number;
				nodeCount: number;
				leafCount: number;
				depth: number;
				coherenceScore: number | null;
				timedOut: boolean;
			}>;
		};

		let sessionId =
			typeof parsed.query.sessionId === "string" ? parsed.query.sessionId : "";

		if (!sessionId) {
			sessionId = latestBuildSession(ctx.stateDir) ?? "";
			if (!sessionId) {
				const body: RaptorBuildHistoryResponse = { builds: [], empty: true };
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(body));
				return true;
			}
		}

		const rows = listBuildHistory(sessionId, ctx.stateDir);
		if (rows.length === 0) {
			const body: RaptorBuildHistoryResponse = { builds: [], empty: true };
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(body));
			return true;
		}

		const dtos: RaptorBuildHistoryDTO[] = rows.map((r) => ({
			buildId: r.buildId,
			sessionId: r.sessionId,
			startedAt: r.startedAt,
			completedAt: r.completedAt,
			nodeCount: r.nodeCount,
			leafCount: r.leafCount,
			depth: r.depth,
			coherenceScore: r.coherenceScore,
			timedOut: r.timedOut,
		}));
		const body: RaptorBuildHistoryResponse = { builds: dtos, empty: false };
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(body));
		return true;
	} catch (e) {
		res.writeHead(500, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: String(e) }));
		return true;
	}
}
