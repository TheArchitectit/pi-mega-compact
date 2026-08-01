/**
 * routes-memory-map.ts — GET /api/memory-map route handler (S46/D3).
 *
 * Builds a memory graph from the local SQLite store and returns it as JSON.
 * D3: surfaces nodeType on each node and the GraphValidationReport.
 * Uses an inline require to the pi-agnostic src/memoryGraph.ts builder.
 */
import { createRequire } from "node:module";
import type { ServerResponse, IncomingMessage } from "node:http";
import { parse as parseUrl } from "node:url";
import type { RouteContext } from "./routes-core.js";
import type { MemoryMapResponse, MemoryMapNode, MemoryMapEdgeEntry } from "./api-contracts/memory-map.js";

const _req = createRequire(import.meta.url);

// guardrails-allow PREVENT-PI-004: localhost-only dashboard API endpoint that reads from the local SQLite store — zero remote network calls.

export function handleMemoryMap(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): boolean {
	if (req.method !== "GET") return false;
	const parsed = parseUrl(req.url ?? "", true);
	if (parsed.pathname !== "/api/memory-map") return false;

	// guardrails-allow PREVENT-PI-004: local loopback-only dashboard server — reads the local SQLite store for graph data.
	const { buildMemoryGraph } = _req("../../src/memoryGraph.js") as {
		buildMemoryGraph: (sessionId: string, stateDir: string) => MemoryGraphReturn;
	};

	type MemoryGraphReturn = {
		nodes: Array<{
			id: string;
			sessionId: string;
			label: string;
			summaryTruncated: string;
			tokenEstimate: number;
			timestamp: number;
			dedupStatus: string | undefined;
			raptorLevel: number;
			topicSummary: string | undefined;
			decisionCount: number;
			textSnippet: string;
			nodeType: "checkpoint" | "turn" | "turn-content" | "memory";
		}>;
		edges: Array<{
			source: string;
			target: string;
			weight: number;
			type: "temporal" | "semantic" | "raptor_parent";
		}>;
		metadata: {
			totalNodes: number;
			totalEdges: number;
			avgWeight: number;
			nodeTypeBreakdown: Record<string, number>;
			edgeTypeBreakdown: Record<string, number>;
		};
		validation: {
			gatesRun: number;
			gatesPassed: number;
			dropped: { nodes: number; edges: number };
			warnings: Array<{ gate: string; code: string; count: number }>;
			sources: { checkpoint: number; turn: number; turnContent: number; memory: number };
			builtAt: number;
		};
	};

	const sessionId = typeof parsed.query.sessionId === "string" ? parsed.query.sessionId : "";

	const graph = buildMemoryGraph(sessionId, ctx.stateDir);

	const nodes: MemoryMapNode[] = graph.nodes.map((n) => ({
		id: n.id,
		sessionId: n.sessionId,
		label: n.label,
		summaryTruncated: n.summaryTruncated,
		tokenEstimate: n.tokenEstimate,
		timestamp: n.timestamp,
		dedupStatus: n.dedupStatus,
		raptorLevel: n.raptorLevel,
		topicSummary: n.topicSummary,
		decisionCount: n.decisionCount,
		textSnippet: n.textSnippet,
		// D3: pass through nodeType for UI node-shape encoding
		nodeType: n.nodeType,
	}));

	const edges: MemoryMapEdgeEntry[] = graph.edges as MemoryMapEdgeEntry[];
	// D3: surface the validation report (optional in the response type for backward compat)
	const response: MemoryMapResponse = { nodes, edges, metadata: graph.metadata, validation: graph.validation };

	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify(response));
	return true;
}
