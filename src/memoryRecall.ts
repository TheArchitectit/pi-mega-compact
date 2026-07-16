/**
 * memoryRecall.ts — semantic recall over the durable memories table (S21).
 * Embeds a query with the same local embedder used by RAPTOR, ranks every
 * memory in the current repo's SQLite by cosine similarity, and returns the
 * top-k. Side effect: marks returned memories as referenced (last_referenced)
 * so drift can be measured. PREVENT-PI-004 — embedder is the same local one
 * used everywhere else; no remote calls are introduced here.
 * @module
 */
import { defaultEmbedder, cosineSimilarity } from "./embedder.js";
import { listMemories, referenceMemory, type MemoryRecord } from "./store/sqlite.js";

export interface RecallMemoriesOptions {
  /** Max memories to return. Default 10. */
  topK?: number;
  /** Min cosine similarity (0..1) to include. Default 0.2 — filters unrelated. */
  minSimilarity?: number;
  /** If true, mark returned memories as referenced. Default true. */
  markReferenced?: boolean;
  /** Override the embedder (test-only seam). */
  embedder?: { embed(text: string): number[] };
  /** Repo filter; null = current repo's memories. */
  repo?: string | null;
}

/**
 * Rank memories by similarity to the query. Returns the top-k above
 * minSimilarity, sorted by score descending. Empty on no matches.
 */
export async function recallMemories(
  query: string,
  stateDir: string,
  opts: RecallMemoriesOptions = {},
): Promise<Array<{ memory: MemoryRecord; score: number }>> {
  const topK = opts.topK ?? 10;
  const minSimilarity = opts.minSimilarity ?? 0.2;
  const markReferenced = opts.markReferenced ?? true;
  const embedder = opts.embedder ?? defaultEmbedder();
  const repo = opts.repo === undefined ? null : opts.repo;

  const queryVec = embedder.embed(query);
  const memories = listMemories(repo, 1000, stateDir);
  if (!memories.length || !query.trim()) return [];

  const scored: Array<{ memory: MemoryRecord; score: number }> = [];
  for (const mem of memories) {
    const vec = embedder.embed(mem.content);
    const sim = cosineSimilarity(queryVec, vec);
    if (sim >= minSimilarity) scored.push({ memory: mem, score: sim });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, topK);
  if (markReferenced) {
    for (const hit of top) referenceMemory(hit.memory.id, stateDir);
  }
  return top;
}
