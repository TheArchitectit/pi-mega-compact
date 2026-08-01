/**
 * memoryGraph.ts — S46 visual memory map: build a graph of graphs.
 *
 * Nodes = checkpoints (with optional RAPTOR level annotations).
 * Edges = temporal adjacency, semantic similarity (cosine above threshold), and
 *         RAPTOR parent–child links.
 *
 * pi-agnostic (no pi runtime types). Zero network calls (PREVENT-PI-004).
 * Synchronous read-only interface — non-fatal on store errors.
 *
 * Re-exports the public types as both MemoryGraph* and shorter aliases
 * (GraphNode, GraphEdge, GraphMetadata) so dashboard api-contracts can import
 * from the canonical source.
 */
import { getStateDir, normalizeSessionId } from "./store.js";
import { openStore, decodeEmbedding } from "./store/sqlite/utils.js";
import { listRaptorNodes } from "./store/sqlite/raptor.js";
import { Logger } from "./log.js";
const log = new Logger();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A node in the memory graph represents one checkpoint (potentially with
 *  RAPTOR level information if it participates in a RAPTOR tree). */
export interface MemoryGraphNode {
  id: string;
  sessionId: string;
  label: string;
  summaryTruncated: string;
  tokenEstimate: number;
  /** Unix-epoch ms (from checkpoint timestamp or created_at). */
  timestamp: number;
  dedupStatus: string | undefined;
  /** 0 = no RAPTOR parent; 1+ = RAPTOR cluster level. */
  raptorLevel: number;
  topicSummary: string | undefined;
  decisionCount: number;
  /** First ~200 chars of the checkpoint summary/text for inline preview. */
  textSnippet: string;
}

/** Edge types indicate the *reason* two nodes are connected. */
export type MemoryGraphEdgeType = "temporal" | "semantic" | "raptor_parent";

export interface MemoryGraphEdge {
  source: string;
  target: string;
  weight: number;
  type: MemoryGraphEdgeType;
}

export interface MemoryGraphMetadata {
  sessionCount: number;
  totalCheckpoints: number;
  totalEdges: number;
  semanticEdgeCount: number;
  temporalEdgeCount: number;
  raptorEdgeCount: number;
  similarityThresholdUsed: number;
  builtAt: number;
}

/** The complete memory graph returned by buildMemoryGraph. */
export interface MemoryGraph {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  metadata: MemoryGraphMetadata;
}

// ---------------------------------------------------------------------------
// Short aliases for dashboard api-contracts import convenience
// ---------------------------------------------------------------------------

export type GraphNode = MemoryGraphNode;
export type GraphEdge = MemoryGraphEdge;
export type GraphMetadata = MemoryGraphMetadata;

/** Options to configure graph construction. */
export interface MemoryGraphOptions {
  /** Similarity threshold for semantic edges (cosine). Default 0.7. */
  similarityThreshold?: number;
  /** Maximum number of semantic edges per node (avoids dense clique). Default 4. */
  maxEdgesPerNode?: number;
  /** Optional session filter — undefined = all sessions. */
  sessionId?: string;
  /** State directory (defaults to getStateDir()). */
  stateDir?: string;
  /** Include RAPTOR parent–child edges when available. Default true. */
  includeRaptorEdges?: boolean;
  /** Include temporal adjacency edges (consecutive checkpoints in same session). Default true. */
  includeTemporalEdges?: boolean;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_SIMILARITY_THRESHOLD = 0.7;
const DEFAULT_MAX_EDGES_PER_NODE = 4;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a memory graph from the store.
 *
 * Opens the SQLite store, reads all (or session-filtered) checkpoints,
 * computes cosine similarity edges, temporal edges, and RAPTOR parent edges.
 * Returns a MemoryGraph or an empty graph on failure (non-fatal).
 */
export function buildMemoryGraph(opts: MemoryGraphOptions = {}): MemoryGraph {
  const {
    similarityThreshold = DEFAULT_SIMILARITY_THRESHOLD,
    maxEdgesPerNode = DEFAULT_MAX_EDGES_PER_NODE,
    sessionId,
    stateDir = getStateDir(),
    includeRaptorEdges = true,
    includeTemporalEdges = true,
  } = opts;

  const builtAt = Date.now();

  try {
    const nodes = loadNodes(sessionId, stateDir);
    const nodeIndex = buildNodeIndex(nodes);
    const edges: MemoryGraphEdge[] = [];

    // Temporal edges: consecutive checkpoints within the same session
    if (includeTemporalEdges) {
      edges.push(...buildTemporalEdges(nodes));
    }

    // Semantic edges: cosine similarity above threshold
    edges.push(...buildSemanticEdges(nodes, nodeIndex, similarityThreshold, maxEdgesPerNode));

    // RAPTOR parent–child edges
    if (includeRaptorEdges) {
      edges.push(...buildRaptorEdges(nodes, sessionId, stateDir, nodeIndex));
    }

    // Deduplicate edges (keep highest weight for each source-target pair)
    const dedupedEdges = deduplicateEdges(edges);

    // Count sessions
    const sessionSet = new Set<string>();
    for (const n of nodes) {
      sessionSet.add(n.sessionId);
    }

    const meta: MemoryGraphMetadata = {
      sessionCount: sessionSet.size,
      totalCheckpoints: nodes.length,
      totalEdges: dedupedEdges.length,
      semanticEdgeCount: dedupedEdges.filter((e) => e.type === "semantic").length,
      temporalEdgeCount: dedupedEdges.filter((e) => e.type === "temporal").length,
      raptorEdgeCount: dedupedEdges.filter((e) => e.type === "raptor_parent").length,
      similarityThresholdUsed: similarityThreshold,
      builtAt,
    };

    return { nodes, edges: dedupedEdges, metadata: meta };
  } catch (err) {
    log.warn("buildMemoryGraph failed", { error: String(err) });
    return {
      nodes: [],
      edges: [],
      metadata: {
        sessionCount: 0,
        totalCheckpoints: 0,
        totalEdges: 0,
        semanticEdgeCount: 0,
        temporalEdgeCount: 0,
        raptorEdgeCount: 0,
        similarityThresholdUsed: similarityThreshold,
        builtAt,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Node loading
// ---------------------------------------------------------------------------

function loadNodes(sessionId: string | undefined, stateDir: string): MemoryGraphNode[] {
  const db = openStore(stateDir);

  const sql = sessionId
    ? "SELECT * FROM context_chunks WHERE session_id = ? ORDER BY id ASC"
    : "SELECT * FROM context_chunks ORDER BY session_id, id ASC";

  const rows = sessionId
    ? (db.prepare(sql).all(normalizeSessionId(sessionId)) as any[])
    : (db.prepare(sql).all() as any[]);

  return rows.map(rowToGraphNode);
}

function rowToGraphNode(row: any): MemoryGraphNode {
  const summary = row.summary ?? "";
  return {
    id: row.id,
    sessionId: row.session_id,
    label: row.id,
    summaryTruncated: summary.length > 200 ? summary.slice(0, 197) + "..." : summary,
    tokenEstimate: row.token_estimate ?? 0,
    timestamp: row.created_at ?? Date.now(),
    dedupStatus: row.dedup_status ?? undefined,
    raptorLevel: 0, // enriched below if RAPTOR data exists
    topicSummary: row.topic_summary ?? undefined,
    decisionCount: row.key_decisions
      ? safeJsonCount(row.key_decisions)
      : 0,
    textSnippet: summary.length > 200 ? summary.slice(0, 197) + "..." : summary,
  };
}

/** Parse a JSON array stored in a text column and return its length. */
function safeJsonCount(raw: string | null | undefined): number {
  if (!raw) return 0;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Node index building
// ---------------------------------------------------------------------------

function buildNodeIndex(nodes: MemoryGraphNode[]): Map<string, number> {
  const idx = new Map<string, number>();
  nodes.forEach((n, i) => idx.set(n.id, i));
  return idx;
}

// ---------------------------------------------------------------------------
// Edges: temporal
// ---------------------------------------------------------------------------

function buildTemporalEdges(nodes: MemoryGraphNode[]): MemoryGraphEdge[] {
  const edges: MemoryGraphEdge[] = [];
  if (nodes.length < 2) return edges;

  let prev = nodes[0];
  for (let i = 1; i < nodes.length; i++) {
    const cur = nodes[i];
    if (cur.sessionId === prev.sessionId) {
      edges.push({
        source: prev.id,
        target: cur.id,
        weight: 1.0,
        type: "temporal",
      });
    }
    prev = cur;
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Edges: semantic (cosine similarity)
// ---------------------------------------------------------------------------

function buildSemanticEdges(
  nodes: MemoryGraphNode[],
  _nodeIndex: Map<string, number>,
  threshold: number,
  maxPerNode: number,
): MemoryGraphEdge[] {
  if (nodes.length < 2) return [];
  const db = openStore();

  // Retrieve embeddings from DB for each node
  const embeddings = new Map<string, number[]>();
  const placeholders = nodes.map(() => "?").join(",");
  const ids = nodes.map((n) => n.id);
  const rows = db
    .prepare(`SELECT id, embedding_blob FROM context_chunks WHERE id IN (${placeholders})`)
    .all(...ids) as unknown as Array<{ id: string; embedding_blob: Uint8Array | null }>;

  for (const row of rows) {
    const emb = decodeEmbedding(row.embedding_blob as Uint8Array | null | undefined);
    if (emb.length > 0) {
      embeddings.set(row.id, emb);
    }
  }

  type EdgeCandidate = { target: string; weight: number };
  const edges: MemoryGraphEdge[] = [];

  for (const node of nodes) {
    const aId = node.id;
    const aEmb = embeddings.get(aId);
    if (!aEmb) continue;

    const candidates: EdgeCandidate[] = [];

    for (const other of nodes) {
      if (other.id === aId) continue;
      // Skip if already connected via temporal or raptor edge
      const bEmb = embeddings.get(other.id);
      if (!bEmb) continue;

      const sim = cosineSimilarity(aEmb, bEmb);
      if (sim >= threshold) {
        candidates.push({ target: other.id, weight: sim });
      }
    }

    // Keep top-K highest-weight semantic neighbors
    candidates.sort((a, b) => b.weight - a.weight);
    const top = candidates.slice(0, maxPerNode);
    for (const c of top) {
      edges.push({
        source: aId,
        target: c.target,
        weight: c.weight,
        type: "semantic",
      });
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Edges: RAPTOR parent–child
// ---------------------------------------------------------------------------

function buildRaptorEdges(
  nodes: MemoryGraphNode[],
  sessionId: string | undefined,
  stateDir: string,
  nodeIndex: Map<string, number>,
): MemoryGraphEdge[] {
  const edges: MemoryGraphEdge[] = [];

  try {
    if (sessionId) {
      enrichRaptorForSession(sessionId, stateDir, nodeIndex, nodes, edges);
    } else {
      // Load all sessions from DB
      const db = openStore(stateDir);
      const sessionRows = db
        .prepare("SELECT DISTINCT session_id FROM raptor_nodes ORDER BY session_id")
        .all() as any[];
      for (const row of sessionRows) {
        enrichRaptorForSession(row.session_id as string, stateDir, nodeIndex, nodes, edges);
      }
    }
  } catch (err) {
    log.warn("RAPTOR edge build failed (non-fatal)", { error: String(err) });
  }

  return edges;
}

function enrichRaptorForSession(
  sessId: string,
  stateDir: string,
  nodeIndex: Map<string, number>,
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
): void {
  const raptorNodes = listRaptorNodes(sessId, stateDir);

  for (const rn of raptorNodes) {
    const idx = nodeIndex.get(rn.id);
    if (idx !== undefined) {
      // Annotate the graph node with the RAPTOR level
      nodes[idx].raptorLevel = rn.level;
    }

    if (!rn.parentId) continue;
    // Only create edge if both nodes are in the graph
    if (nodeIndex.has(rn.id) && nodeIndex.has(rn.parentId)) {
      edges.push({
        source: rn.id,
        target: rn.parentId,
        weight: Math.max(0.1, 1.0 - rn.level * 0.1), // higher levels = weaker link
        type: "raptor_parent",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Edge deduplication
// ---------------------------------------------------------------------------

function deduplicateEdges(edges: MemoryGraphEdge[]): MemoryGraphEdge[] {
  const seen = new Map<string, MemoryGraphEdge>();

  for (const e of edges) {
    const keyA = `${e.source}|${e.target}`;
    const keyB = `${e.target}|${e.source}`;
    const existing = seen.get(keyA) ?? seen.get(keyB);

    if (!existing) {
      seen.set(keyA, e);
    } else if (e.weight > existing.weight) {
      // Replace with higher-weight edge
      seen.delete(keyA);
      seen.delete(keyB);
      seen.set(keyA, e);
    }
  }

  return Array.from(seen.values());
}

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
