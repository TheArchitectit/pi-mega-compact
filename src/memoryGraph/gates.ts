/**
 * gates.ts — D3 graph validation pipeline for memoryGraph.
 *
 * Nine ordered pure functions over { nodes, edges } that filter invalid or
 * redundant entries. Each returns { ok, dropped, reason }; failing entries are
 * removed from the working set. The final validated graph is what buildMemoryGraph
 * returns.
 *
 * All functions are synchronous pure logic — no store I/O, no network.
 * Logged events use the `event` names specified in D3.
 */
import type { MemoryGraphNode, MemoryGraphEdge } from "../memoryGraph.js";
import { Logger } from "../log.js";
const log = new Logger();

// ---------------------------------------------------------------------------
// Working set type passed through the pipeline
// ---------------------------------------------------------------------------

export interface GraphWorkingSet {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
}

export interface GateResult {
  ok: boolean;
  dropped: number;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Gate 1 — Source availability guard (informational, no drop)
// ---------------------------------------------------------------------------

export function gateSourceAvailable(ws: GraphWorkingSet): GateResult {
  if (ws.nodes.length === 0) {
    log.warn("graph_source_unavailable", {
      detail: "No nodes from any source — graph will be empty",
    });
    return { ok: false, dropped: 0, reason: "No nodes from any source" };
  }
  return { ok: true, dropped: 0 };
}

// ---------------------------------------------------------------------------
// Gate 2 — Identity merge: duplicate nodes with same id → richest wins
// ---------------------------------------------------------------------------

export function gateIdentityMerge(ws: GraphWorkingSet): GateResult {
  const { nodes } = ws;
  const seen = new Map<string, MemoryGraphNode>();
  let dropped = 0;

  for (const n of nodes) {
    const existing = seen.get(n.id);
    if (!existing) {
      seen.set(n.id, n);
      continue;
    }
    const existingScore = fieldScore(existing);
    const currentScore = fieldScore(n);
    if (currentScore > existingScore) {
      seen.set(n.id, n);
    }
    dropped++;
    log.warn("graph_identity_leak", {
      nodeId: n.id,
      dropped: currentScore > existingScore ? existing.id : n.id,
    });
  }

  ws.nodes = [...seen.values()];
  return { ok: dropped === 0, dropped, reason: dropped > 0 ? `${dropped} duplicate node ids merged` : undefined };
}

function fieldScore(n: MemoryGraphNode): number {
  // Base score by nodeType — richer sources win ties (spec: "richest available
  // source wins"). checkpoint > turn-content > memory > turn-structural.
  let s = 0;
  switch (n.nodeType) {
    case "checkpoint": s += 4; break;
    case "turn-content": s += 3; break;
    case "memory": s += 2; break;
    case "turn": s += 1; break;
  }
  if (n.summaryTruncated) s++;
  if (n.textSnippet) s++;
  if (n.topicSummary) s++;
  if (n.tokenEstimate > 0) s++;
  if (n.decisionCount > 0) s++;
  if (n.dedupStatus) s++;
  return s;
}

// ---------------------------------------------------------------------------
// Gate 3 — Promotion guard: suppress turns with epoch_id if checkpoint exists
// ---------------------------------------------------------------------------

export function gatePromotionGuard(ws: GraphWorkingSet): GateResult {
  const checkpointIds = new Set<string>();
  for (const n of ws.nodes) {
    if (n.nodeType === "checkpoint") checkpointIds.add(n.id);
  }

  const keep: MemoryGraphNode[] = [];
  const droppedIds = new Set<string>();
  let dropped = 0;

  for (const n of ws.nodes) {
    if (n.nodeType !== "turn" && n.nodeType !== "turn-content") {
      keep.push(n);
      continue;
    }
    const epochId = n.epochId;
    if (epochId && checkpointIds.has(epochId)) {
      droppedIds.add(n.id);
      dropped++;
      log.warn("graph_orphaned_epoch", {
        nodeId: n.id,
        epochId,
        detail: "Turn suppressed because its checkpoint exists in the graph",
      });
    } else {
      if (epochId && !checkpointIds.has(epochId)) {
        log.warn("graph_orphaned_epoch", {
          nodeId: n.id,
          epochId,
          detail: "Orphaned epoch — no matching checkpoint; keeping turn",
        });
      }
      keep.push(n);
    }
  }

  ws.nodes = keep;
  ws.edges = ws.edges.filter((e) => !droppedIds.has(e.source) && !droppedIds.has(e.target));
  return {
    ok: dropped === 0,
    dropped,
    reason: dropped > 0 ? `${dropped} turn nodes suppressed (checkpoint exists)` : undefined,
  };
}

// ---------------------------------------------------------------------------
// Gate 4 — Node type / field completeness
// ---------------------------------------------------------------------------

export function gateNodeCompleteness(ws: GraphWorkingSet): GateResult {
  const validNodes: MemoryGraphNode[] = [];
  let dropped = 0;

  for (const n of ws.nodes) {
    if (!n.nodeType || !n.sessionId) {
      dropped++;
      log.warn("graph_node_double", {
        nodeId: n.id,
        detail: "Missing nodeType or sessionId",
      });
      continue;
    }
    validNodes.push(n);
  }

  ws.nodes = validNodes;
  return {
    ok: dropped === 0,
    dropped,
    reason: dropped > 0 ? `${dropped} nodes dropped for missing fields` : undefined,
  };
}

// ---------------------------------------------------------------------------
// Gate 5 — Dangling edge guard
// ---------------------------------------------------------------------------

export function gateDanglingEdges(ws: GraphWorkingSet): GateResult {
  const validIds = new Set(ws.nodes.map((n) => n.id));
  const validEdges: MemoryGraphEdge[] = [];
  let dropped = 0;

  for (const e of ws.edges) {
    if (validIds.has(e.source) && validIds.has(e.target)) {
      validEdges.push(e);
    } else {
      dropped++;
      log.warn("graph_dangling_edge", {
        source: e.source,
        target: e.target,
        detail: "Edge references non-existent node(s)",
      });
    }
  }

  ws.edges = validEdges;
  return {
    ok: dropped === 0,
    dropped,
    reason: dropped > 0 ? `${dropped} dangling edges removed` : undefined,
  };
}

// ---------------------------------------------------------------------------
// Gate 6 — Edge type / threshold enforcement
// ---------------------------------------------------------------------------

function envThreshold(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export function gateEdgeThresholds(
  ws: GraphWorkingSet,
  options?: { withinTypeThreshold?: number; crossTypeThreshold?: number },
): GateResult {
  const withinThreshold = options?.withinTypeThreshold ?? envThreshold("MEGACOMPACT_MEMORY_GRAPH_WITHIN_TYPE_THRESHOLD", 0.7);
  const crossThreshold = options?.crossTypeThreshold ?? envThreshold("MEGACOMPACT_MEMORY_GRAPH_CROSS_TYPE_THRESHOLD", 0.85);
  const nodeTypeMap = new Map(ws.nodes.map((n) => [n.id, n.nodeType]));
  const validEdges: MemoryGraphEdge[] = [];
  let dropped = 0;

  for (const e of ws.edges) {
    if (e.type !== "semantic") {
      validEdges.push(e);
      continue;
    }
    const srcType = nodeTypeMap.get(e.source);
    const tgtType = nodeTypeMap.get(e.target);

    if (srcType === "turn" || tgtType === "turn") {
      dropped++;
      log.warn("graph_structural_semantic_edge", {
        nodeId: srcType === "turn" ? e.source : e.target,
        source: e.source,
        target: e.target,
        score: e.weight,
        detail: "Semantic edge on structural (turn) node",
      });
      continue;
    }

    const sameType = srcType != null && srcType === tgtType;
    const threshold = sameType ? withinThreshold : crossThreshold;

    if (e.weight < threshold) {
      dropped++;
      log.warn("graph_edge_below_threshold", {
        source: e.source,
        target: e.target,
        score: e.weight,
        typePair: `${String(srcType)}↔${String(tgtType)}`,
        threshold,
        detail: `Edge below ${sameType ? "within-type" : "cross-type"} threshold`,
      });
      continue;
    }
    validEdges.push(e);
  }

  ws.edges = validEdges;
  return {
    ok: dropped === 0,
    dropped,
    reason: dropped > 0 ? `${dropped} edges below threshold removed` : undefined,
  };
}

// ---------------------------------------------------------------------------
// Gate 7 — Dedup mirror cross-check
// ---------------------------------------------------------------------------

export function gateDedupRedundant(
  ws: GraphWorkingSet,
  options?: { redundantIds?: Set<string> },
): GateResult {
  const redundant = options?.redundantIds ?? new Set<string>();
  if (redundant.size === 0) return { ok: true, dropped: 0 };

  const keep: MemoryGraphNode[] = [];
  const droppedIds = new Set<string>();
  let dropped = 0;

  for (const n of ws.nodes) {
    if (n.nodeType === "turn-content" && redundant.has(n.id)) {
      dropped++;
      droppedIds.add(n.id);
      log.warn("graph_dedup_redundant", {
        nodeId: n.id,
        contentHash: n.id,
        detail: "Turn content already collapsed into checkpoint",
      });
    } else {
      keep.push(n);
    }
  }

  if (droppedIds.size > 0) {
    ws.edges = ws.edges.filter((e) => !droppedIds.has(e.source) && !droppedIds.has(e.target));
  }
  ws.nodes = keep;
  return {
    ok: dropped === 0,
    dropped,
    reason: dropped > 0 ? `${dropped} turn-content nodes redundant with checkpoints` : undefined,
  };
}

// ---------------------------------------------------------------------------
// Gate 8 — Structural vs semantic edge consistency
// ---------------------------------------------------------------------------

export function gateStructuralSemanticEdges(ws: GraphWorkingSet): GateResult {
  const structuralTypes = new Set<MemoryGraphNode["nodeType"]>(["checkpoint", "turn"]);
  const keep: MemoryGraphEdge[] = [];
  let dropped = 0;

  for (const e of ws.edges) {
    if (e.type !== "semantic") {
      keep.push(e);
      continue;
    }
    const srcNode = ws.nodes.find((n) => n.id === e.source);
    const tgtNode = ws.nodes.find((n) => n.id === e.target);
    if (srcNode && structuralTypes.has(srcNode.nodeType)) {
      dropped++;
      log.warn("graph_structural_semantic_edge", {
        nodeId: srcNode.id,
        nodeType: srcNode.nodeType,
        detail: "Structural node has semantic edge",
      });
    } else if (tgtNode && structuralTypes.has(tgtNode.nodeType)) {
      dropped++;
      log.warn("graph_structural_semantic_edge", {
        nodeId: tgtNode.id,
        nodeType: tgtNode.nodeType,
        detail: "Structural node has semantic edge",
      });
    } else {
      keep.push(e);
    }
  }

  ws.edges = keep;
  return {
    ok: dropped === 0,
    dropped,
    reason: dropped > 0 ? `${dropped} semantic edges on structural nodes removed` : undefined,
  };
}

// ---------------------------------------------------------------------------
// Gate 9 — Same-type edge deduplication
// ---------------------------------------------------------------------------

export function gateDedupEdges(ws: GraphWorkingSet): GateResult {
  const best = new Map<string, MemoryGraphEdge>();
  let dropped = 0;

  for (const e of ws.edges) {
    const key = `${e.source}|${e.target}|${e.type}`;
    const existing = best.get(key);
    if (!existing || e.weight > existing.weight) {
      if (existing) dropped++;
      best.set(key, e);
    } else {
      dropped++;
    }
  }

  if (dropped > 0) {
    log.warn("graph_dedup_redundant", {
      count: dropped,
      detail: "Redundant edges deduplicated",
    });
  }
  ws.edges = [...best.values()];
  return {
    ok: dropped === 0,
    dropped,
    reason: dropped > 0 ? `${dropped} redundant edges deduplicated` : undefined,
  };
}

// ---------------------------------------------------------------------------
// Pipeline aggregate result (without source counts / builtAt — caller fills those)
// ---------------------------------------------------------------------------

export interface GatePipelineStats {
  gatesRun: string[];
  gatesPassed: string[];
  dropped: { nodes: number; edges: number };
  warnings: Array<{ gate: string; code: string; count: number }>;
}

/** Run all 9 gates in order over a working set. Returns validated set + stats.
 *  Gate 7 uses optional redundantIds from the caller. */
export function runValidationPipeline(
  ws: GraphWorkingSet,
  options?: {
    withinTypeThreshold?: number;
    crossTypeThreshold?: number;
    redundantIds?: Set<string>;
  },
): { ws: GraphWorkingSet; stats: GatePipelineStats } {
  const gatesRun: string[] = [];
  const gatesPassed: string[] = [];
  const warnings: Array<{ gate: string; code: string; count: number }> = [];
  let totalDroppedNodes = 0;
  let totalDroppedEdges = 0;

  const gates: { name: string; fn: () => GateResult }[] = [
    { name: "source_available", fn: () => gateSourceAvailable(ws) },
    { name: "identity_merge", fn: () => gateIdentityMerge(ws) },
    { name: "promotion_guard", fn: () => gatePromotionGuard(ws) },
    { name: "node_completeness", fn: () => gateNodeCompleteness(ws) },
    { name: "dangling_edges", fn: () => gateDanglingEdges(ws) },
    { name: "edge_thresholds", fn: () => gateEdgeThresholds(ws, { withinTypeThreshold: options?.withinTypeThreshold, crossTypeThreshold: options?.crossTypeThreshold }) },
    { name: "dedup_redundant", fn: () => gateDedupRedundant(ws, { redundantIds: options?.redundantIds }) },
    { name: "structural_semantic", fn: () => gateStructuralSemanticEdges(ws) },
    { name: "dedup_edges", fn: () => gateDedupEdges(ws) },
  ];

  for (const gate of gates) {
    gatesRun.push(gate.name);
    const r = gate.fn();
    if (r.ok) {
      gatesPassed.push(gate.name);
    }
    if (r.reason) {
      warnings.push({ gate: gate.name, code: "gate_warning", count: r.dropped || 1 });
    }
    // Track by category
    if (["identity_merge", "promotion_guard", "node_completeness"].includes(gate.name)) {
      totalDroppedNodes += r.dropped;
    }
    if (["dangling_edges", "edge_thresholds", "dedup_redundant", "structural_semantic", "dedup_edges"].includes(gate.name)) {
      totalDroppedEdges += r.dropped;
    }
  }

  return {
    ws,
    stats: {
      gatesRun,
      gatesPassed,
      dropped: { nodes: totalDroppedNodes, edges: totalDroppedEdges },
      warnings,
    },
  };
}
