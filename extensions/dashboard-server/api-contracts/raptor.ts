/**
 * api-contracts/raptor.ts — RAPTOR tree API contract.
 *
 * Response shape for GET /api/raptor-tree: the hierarchical RAPTOR tree
 * (summary nodes by level) for a session. Client-safe — the raw 512-dim
 * embedding vector is stripped before sending.
 */

/**
 * A single RAPTOR tree node (client-safe — no `embedding` vector).
 * Mirrors src/store/sqlite/raptor.ts StoredRaptorNode minus the embedding.
 */
export interface RaptorNodeDTO {
	/** Stable node id (persisted in raptor_nodes.id). */
	readonly id: string;
	/** Session this node belongs to. */
	readonly sessionId: string;
	/** Tree depth level (0 = root summary, higher = more granular). */
	readonly level: number;
	/** Parent node id, or null for the root of the tree. */
	readonly parentId: string | null;
	/** Child node ids. */
	readonly children: string[];
	/** Summarized content of this cluster. */
	readonly summary: string;
	/** Quality marker of the summary (e.g. "high" | "med" | "low"). */
	readonly qualityMarker: string;
	/** Estimated token count of the summary. */
	readonly tokenEstimate: number;
	/** Epoch ms when the tree containing this node was built. */
	readonly builtAt: number;
}

/**
 * Response body for GET /api/raptor-tree.
 * `empty: true` when no RAPTOR nodes exist for the resolved session.
 */
export interface RaptorTreeResponse {
	/** Flat list of all nodes (tree shape recoverable via parentId/children). */
	readonly nodes: RaptorNodeDTO[];
	/** Max level across nodes (0 when empty). */
	readonly levels: number;
	/** The root node id (node with parentId === null), or null when empty. */
	readonly rootId: string | null;
	/** Max builtAt across nodes (epoch ms), or null when empty. */
	readonly builtAt: number | null;
	/** True when there are no RAPTOR nodes for the resolved session. */
	readonly empty: boolean;
}

/** A single build-history row (client-safe). */
export interface RaptorBuildHistoryDTO {
	readonly buildId: string;
	readonly sessionId: string;
	readonly startedAt: number;
	readonly completedAt: number;
	readonly nodeCount: number;
	readonly leafCount: number;
	readonly depth: number;
	readonly coherenceScore: number | null;
	readonly timedOut: boolean;
}

/** Response body for GET /api/raptor-build-history. */
export interface RaptorBuildHistoryResponse {
	readonly builds: RaptorBuildHistoryDTO[];
	readonly empty: boolean;
}
