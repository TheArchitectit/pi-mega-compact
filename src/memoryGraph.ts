/**
 * memoryGraph.ts — S46/D3 visual memory map: build a graph of graphs.
 *
 * Delegated-shell pattern: implementation lives in memoryGraph/gates.ts,
 * memoryGraph/sources.ts, and memoryGraph/embedding.ts. This file owns
 * the public types, the entry point (buildMemoryGraph), and exports.
 *
 * pi-agnostic (no pi runtime types). Zero network calls (PREVENT-PI-004).
 * Synchronous read-only interface -- non-fatal on store errors.
 *
 * Re-exports the public types as both MemoryGraph* and shorter aliases
 * (GraphNode, GraphEdge, GraphMetadata) so dashboard api-contracts can import
 * from the canonical source.
 */
import { getStateDir } from "./store.js";
import { openStore } from "./store/sqlite/utils.js";
import type { DatabaseSync } from "node:sqlite";
import { Logger } from "./log.js";
import { runValidationPipeline } from "./memoryGraph/gates.js";
import {
  buildCheckpointNodes,
  buildTurnNodes,
  buildTurnContentNodes,
  buildMemoryNodes,
  addRaptorAnnotations,
  deduplicateEdges,
  areTurnsEnabled,
  isTurnContentEnabled,
  isTurnContentFlaggedOn,
  areMemoriesEnabled,
} from "./memoryGraph/sources.js";
const log = new Logger();

// ---------------------------------------------------------------------------
// Types
// ------

/** A single node in the memory graph. */
export interface MemoryGraphNode {
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
  /** D3: node type discriminator for validation and UI styling. */
  nodeType: "checkpoint" | "turn" | "turn-content" | "memory";
  /** D3: if this turn node has an associated checkpoint epoch. */
  epochId?: string;
}

/** A directed edge between two graph nodes. */
export interface MemoryGraphEdge {
  source: string;
  target: string;
  weight: number;
  type: "temporal" | "semantic" | "raptor_parent";
}

/** D3: validation report baked into every graph. */
export interface GraphValidationReport {
  gatesRun: number;
  gatesPassed: number;
  dropped: { nodes: number; edges: number };
  warnings: Array<{ gate: string; code: string; count: number }>;
  sources: {
    checkpoint: number;
    turn: number;
    turnContent: number;
    memory: number;
  };
  builtAt: number;
}

/** The full graph structure returned to consumers. */
export interface MemoryGraph {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  metadata: {
    totalNodes: number;
    totalEdges: number;
    avgWeight: number;
    nodeTypeBreakdown: Record<string, number>;
    edgeTypeBreakdown: Record<string, number>;
  };
  /** D3: validation report from the 9-gate pipeline. */
  validation: GraphValidationReport;
}

// ---------------------------------------------------------------------------
// Short aliases (dashboard api-contracts import these)
// ---------------------------------------------------------------------------

export type GraphNode = MemoryGraphNode;
export type GraphEdge = MemoryGraphEdge;
export type GraphMetadata = MemoryGraph["metadata"];

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Build a memory graph from three sources (checkpoints / turns / memories)
 * wired through a 9-gate validation pipeline.
 *
 * Returns an empty graph (byte-identical pre-change for checkpoint-only) when
 * no sources are available.
 */
export function buildMemoryGraph(
  sessionId: string,
  stateDir: string = getStateDir(),
): MemoryGraph {
  const { nodes, edges } = buildUnvalidatedGraph(sessionId, stateDir);

  // Gate pipeline -- filters, deduplicates, and validates
  const { ws, stats } = runValidationPipeline({ nodes, edges });

  const nodeTypeBreakdown: Record<string, number> = {};
  const edgeTypeBreakdown: Record<string, number> = {};
  for (const n of ws.nodes) {
    nodeTypeBreakdown[n.nodeType] = (nodeTypeBreakdown[n.nodeType] ?? 0) + 1;
  }
  for (const e of ws.edges) {
    edgeTypeBreakdown[e.type] = (edgeTypeBreakdown[e.type] ?? 0) + 1;
  }

  const avgWeight =
    ws.edges.length > 0
      ? ws.edges.reduce((s, e) => s + e.weight, 0) / ws.edges.length
      : 0;

  const sources = countSourcesByType(ws.nodes);

  const validation: GraphValidationReport = {
    gatesRun: stats.gatesRun.length,
    gatesPassed: stats.gatesPassed.length,
    dropped: stats.dropped,
    warnings: stats.warnings.map((w) => ({
      gate: w.gate,
      code: w.code,
      count: w.count,
    })),
    sources,
    builtAt: Date.now(),
  };

  return {
    nodes: ws.nodes,
    edges: ws.edges,
    metadata: {
      totalNodes: ws.nodes.length,
      totalEdges: ws.edges.length,
      avgWeight,
      nodeTypeBreakdown,
      edgeTypeBreakdown,
    },
    validation,
  };
}

// ---------------------------------------------------------------------------
// Source orchestrator
// ---------------------------------------------------------------------------

function buildUnvalidatedGraph(
  sessionId: string,
  stateDir: string,
): { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] } {
  const nodes: MemoryGraphNode[] = [];
  const edges: MemoryGraphEdge[] = [];

  let db: DatabaseSync;
  try {
    db = openStore(stateDir);
  } catch {
    log.warn("graph_source_unavailable", { detail: "Cannot open store" });
    return { nodes: [], edges: [] };
  }

  try {
    // Source: checkpoints (always on)
    buildCheckpointNodes(db, sessionId, nodes, edges);

    // Source A: turns (structural, metadata-only)
    if (areTurnsEnabled()) {
      try {
        buildTurnNodes(db, sessionId, nodes, edges);
      } catch (err) {
        log.warn("graph_source_unavailable", {
          source: "turns",
          detail: String(err),
        });
      }
    }

    // Source B: turn content (raw_transcript join, embedding-based)
    if (isTurnContentEnabled()) {
      try {
        buildTurnContentNodes(db, sessionId, nodes, edges);
      } catch (err) {
        log.warn("graph_source_unavailable", {
          source: "turn-content",
          detail: String(err),
        });
      }
    } else if (isTurnContentFlaggedOn() && !isTurnContentEnabled()) {
      log.warn("graph_source_unavailable", {
        source: "turn-content",
        detail: "dbMirror is OFF -- no raw_transcript available",
      });
    }

    // Source C: memories
    if (areMemoriesEnabled()) {
      try {
        buildMemoryNodes(db, sessionId, nodes, edges);
      } catch (err) {
        log.warn("graph_source_unavailable", {
          source: "memories",
          detail: String(err),
        });
      }
    }

    // RAPTOR annotations on checkpoint nodes
    try {
      addRaptorAnnotations(sessionId, stateDir, nodes, edges);
    } catch {
      // non-fatal
    }
  } finally {
    // DatabaseSync has no close in Node 22 -- leave GC to clean up
  }

  // Pre-gate edge deduplication
  const deduped = deduplicateEdges(edges);
  edges.length = 0;
  edges.push(...deduped);

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countSourcesByType(
  nodes: MemoryGraphNode[],
): GraphValidationReport["sources"] {
  let checkpoint = 0;
  let turn = 0;
  let turnContent = 0;
  let memory = 0;
  for (const n of nodes) {
    switch (n.nodeType) {
      case "checkpoint":
        checkpoint++;
        break;
      case "turn":
        turn++;
        break;
      case "turn-content":
        turnContent++;
        break;
      case "memory":
        memory++;
        break;
    }
  }
  return { checkpoint, turn, turnContent, memory };
}