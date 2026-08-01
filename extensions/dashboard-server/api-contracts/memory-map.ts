/**
 * api-contracts/memory-map.ts — Memory graph API contract (S46/D3).
 *
 * Response shape for GET /api/memory-map: graph nodes, edges, metadata,
 * and validation report. Consumed by the MemoryMapTab React component.
 */
import type { GraphMetadata, GraphValidationReport } from "../../../src/memoryGraph.js";
export type { GraphValidationReport } from "../../../src/memoryGraph.js";

/**
 * Query parameters for GET /api/memory-map.
 * All fields are optional.
 */
export interface MemoryMapQuery {
  /** Filter to a single session ID. */
  readonly sessionId?: string;
  /** Cosine similarity threshold (0..1). Default 0.7. */
  readonly threshold?: number;
  /** Max semantic edges per node. Default 3. */
  readonly maxEdgesPerNode?: number;
}

/** Response body for GET /api/memory-map (D3: +validation). */
export interface MemoryMapResponse {
  readonly nodes: MemoryMapNode[];
  readonly edges: MemoryMapEdgeEntry[];
  readonly metadata: GraphMetadata;
  /** D3: validation report from the 9-gate pipeline. Optional for backward compat. */
  readonly validation?: GraphValidationReport;
}

/**
 * A node in the response (client-safe subset — no full embedding vector).
 * D3: +nodeType discriminator for UI node-shape rendering.
 */
export interface MemoryMapNode {
  readonly id: string;
  readonly sessionId: string;
  readonly label: string;
  readonly summaryTruncated: string;
  readonly tokenEstimate: number;
  readonly timestamp: number;
  readonly dedupStatus: string | undefined;
  readonly raptorLevel: number;
  readonly topicSummary: string | undefined;
  readonly decisionCount: number;
  readonly textSnippet: string;
  /** D3: source type discriminator for UI node-shape encoding. */
  readonly nodeType: "checkpoint" | "turn" | "turn-content" | "memory";
}

/** An edge entry in the response. */
export interface MemoryMapEdgeEntry {
  readonly source: string;
  readonly target: string;
  readonly weight: number;
  readonly type: "temporal" | "semantic" | "raptor_parent";
}
