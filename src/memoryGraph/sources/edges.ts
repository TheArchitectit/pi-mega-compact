/**
 * edges.ts — edge deduplication (extracted from sources.ts).
 */
import type { MemoryGraphEdge } from "../../memoryGraph.js";

export function deduplicateEdges(edges: MemoryGraphEdge[]): MemoryGraphEdge[] {
  const seen = new Map<string, MemoryGraphEdge>();

  for (const e of edges) {
    const keyA = `${e.source}|${e.target}`;
    const keyB = `${e.target}|${e.source}`;
    const existing = seen.get(keyA) ?? seen.get(keyB);
    if (existing) {
      if (e.weight > existing.weight) {
        seen.set(keyA, e);
      }
    } else {
      seen.set(keyA, e);
    }
  }

  return [...seen.values()];
}
