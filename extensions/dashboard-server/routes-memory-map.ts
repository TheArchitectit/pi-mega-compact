/**
 * routes-memory-map.ts — GET /api/memory-map route handler (S46).
 *
 * Builds a memory graph from the local SQLite store and returns it as JSON.
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
		buildMemoryGraph: (opts?: {
			sessionId?: string;
			similarityThreshold?: number;
			maxEdgesPerNode?: number;
			stateDir?: string;
			includeRaptorEdges?: boolean;
			includeTemporalEdges?: boolean;
		}) => MemoryGraphReturn;
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
		}>;
		edges: Array<{
			source: string;
			target: string;
			weight: number;
			type: "temporal" | "semantic" | "raptor_parent";
		}>;
		metadata: {
			sessionCount: number;
			totalCheckpoints: number;
			totalEdges: number;
			semanticEdgeCount: number;
			temporalEdgeCount: number;
			raptorEdgeCount: number;
			similarityThresholdUsed: number;
			builtAt: number;
		};
	};

	const sessionId = typeof parsed.query.sessionId === "string" ? parsed.query.sessionId : undefined;
	const threshold = typeof parsed.query.threshold === "string" ? Number.parseFloat(parsed.query.threshold) : undefined;
	const maxEdges = typeof parsed.query.maxEdgesPerNode === "string" ? Number.parseInt(parsed.query.maxEdgesPerNode, 10) : undefined;
	const raptorEdges = parsed.query.includeRaptorEdges === "false" ? false : true;
	const temporalEdges = parsed.query.includeTemporalEdges === "false" ? false : true;

	const graph = buildMemoryGraph({
		sessionId,
		similarityThreshold: threshold,
		maxEdgesPerNode: maxEdges,
		stateDir: ctx.stateDir,
		includeRaptorEdges: raptorEdges,
		includeTemporalEdges: temporalEdges,
	});

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
	}));

	const edges: MemoryMapEdgeEntry[] = graph.edges as MemoryMapEdgeEntry[];
	const response: MemoryMapResponse = { nodes, edges, metadata: graph.metadata };

	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify(response));
	return true;
}
