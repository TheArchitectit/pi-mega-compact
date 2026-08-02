/**
 * memories.ts — memory node builder (extracted from sources.ts).
 */
import type { DatabaseSync } from "node:sqlite";
import type { MemoryGraphNode, MemoryGraphEdge } from "../../memoryGraph.js";
import { getOrComputeEmbedding, cosineSimilarity } from "../embedding.js";

export function buildMemoryNodes(
  db: DatabaseSync,
  sessionId: string,
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
): void {
  const existingIds = new Set(nodes.map((n) => n.id));
  const rows = db
    .prepare(
      `SELECT id, content, source_turn, created_at
       FROM memories
       ORDER BY created_at ASC`,
    )
    .all() as Array<Record<string, unknown>>;

  if (rows.length === 0) return;

  const memoryNodes: MemoryGraphNode[] = [];

  for (const row of rows) {
    const id = `mem:${String(row.id)}`;
    if (existingIds.has(id)) continue;
    existingIds.add(id);

    const content = row.content ? String(row.content) : "";
    const snippet = content.length > 200 ? content.slice(0, 197) + "..." : content;

    const node: MemoryGraphNode = {
      id,
      sessionId,
      label: `Memory ${String(row.id)}`,
      summaryTruncated: snippet,
      tokenEstimate: content.length,
      timestamp: row.created_at ? Number(row.created_at) : Date.now(),
      dedupStatus: undefined,
      raptorLevel: 0,
      topicSummary: undefined,
      decisionCount: 0,
      textSnippet: snippet,
      nodeType: "memory",
      epochId: undefined,
    };
    memoryNodes.push(node);
  }

  if (memoryNodes.length > 1) {
    const embeddings = memoryNodes.map((n) => {
      try {
        return { id: n.id, vec: getOrComputeEmbedding(db, n.textSnippet) };
      } catch {
        return { id: n.id, vec: null as number[] | null };
      }
    });

    for (let i = 0; i < embeddings.length; i++) {
      if (!embeddings[i].vec) continue;
      for (let j = i + 1; j < embeddings.length; j++) {
        if (!embeddings[j].vec) continue;
        const sim = cosineSimilarity(embeddings[i].vec!, embeddings[j].vec!);
        if (sim > 0) {
          edges.push({
            source: embeddings[i].id,
            target: embeddings[j].id,
            weight: sim,
            type: "semantic",
          });
        }
      }
    }

    crossLinkMemoryToCheckpoints(memoryNodes, nodes, edges);
  }

  nodes.push(...memoryNodes);
}

function crossLinkMemoryToCheckpoints(
  memoryNodes: MemoryGraphNode[],
  allNodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
): void {
  for (const mn of memoryNodes) {
    let bestNeighbor: { id: string; diff: number } | null = null;
    for (const n of allNodes) {
      if (n.nodeType !== "checkpoint" && n.nodeType !== "turn-content") continue;
      if (n.id === mn.id) continue;
      const diff = Math.abs(mn.timestamp - n.timestamp);
      if (bestNeighbor === null || diff < bestNeighbor.diff) {
        bestNeighbor = { id: n.id, diff };
      }
    }
    if (bestNeighbor) {
      edges.push({
        source: mn.id,
        target: bestNeighbor.id,
        weight: 0.85,
        type: "semantic",
      });
    }
  }
}
