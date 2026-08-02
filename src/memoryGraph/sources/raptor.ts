/**
 * raptor.ts — RAPTOR annotations that enrich checkpoint nodes (extracted from
 * sources.ts).
 */
import type { MemoryGraphNode, MemoryGraphEdge } from "../../memoryGraph.js";
import { listRaptorNodes } from "../../store/sqlite/raptor.js";

export function addRaptorAnnotations(
  sessionId: string,
  stateDir: string,
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
): void {
  const raptorNodes = listRaptorNodes(sessionId, stateDir);
  if (!raptorNodes || raptorNodes.length === 0) return;

  const nodeIndex = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) {
    nodeIndex.set(nodes[i].id, i);
  }

  for (const rn of raptorNodes) {
    const idx = nodeIndex.get(rn.id);
    if (idx !== undefined) {
      nodes[idx].raptorLevel = rn.level;
    }
    if (!rn.parentId) continue;
    if (nodeIndex.has(rn.id) && nodeIndex.has(rn.parentId)) {
      edges.push({
        source: rn.id,
        target: rn.parentId,
        weight: Math.max(0.1, 1.0 - rn.level * 0.1),
        type: "raptor_parent",
      });
    }
  }
}
