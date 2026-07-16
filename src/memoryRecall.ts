/**
 * memoryRecall.ts — semantic recall over the durable memories table (S21).
 * Embeds a query with the same local embedder used by RAPTOR, ranks every
 * memory in the current repo's SQLite by cosine similarity combined with a
 * category-weighted + recency-boosted score, and returns the top-k. Side
 * effect: marks returned memories as referenced (last_referenced) so drift
 * can be measured. PREVENT-PI-004 — embedder is the same local one used
 * everywhere else; no remote calls are introduced here.
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
  /** Per-category ranking weights. Categories not listed default to 1.0. */
  categoryWeights?: Record<string, number>;
  /** Recency boost strength. Default 0.05 (5% bonus per log-day since reference). */
  recencyWeight?: number;
}

/** Default category weights — `decision` wins ties on tied cosine. */
export const DEFAULT_CATEGORY_WEIGHTS: Record<string, number> = {
  decision: 1.10,
  preference: 1.05,
  fact: 1.0,
};

const DEFAULT_RECENCY_WEIGHT = 0.05;

/**
 * Rank memories by a blended score of cosine similarity, category weight, and
 * recency of last_referenced (with createdAt as a fallback). Returns the
 * top-k above minSimilarity, sorted by blended score descending. Empty on
 * no matches.
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
  const categoryWeights = { ...DEFAULT_CATEGORY_WEIGHTS, ...(opts.categoryWeights ?? {}) };
  const recencyWeight = opts.recencyWeight ?? DEFAULT_RECENCY_WEIGHT;

  const queryVec = embedder.embed(query);
  const memories = listMemories(repo, 1000, stateDir);
  if (!memories.length || !query.trim()) return [];

  const nowSec = Math.floor(Date.now() / 1000);
  const scored: Array<{ memory: MemoryRecord; score: number }> = [];
  for (const mem of memories) {
    const vec = embedder.embed(mem.content);
    const sim = cosineSimilarity(queryVec, vec);
    if (sim < minSimilarity) continue;
    const categoryW = categoryWeights[mem.category ?? "fact"] ?? 1.0;
    const lastTouch = mem.lastReferenced ?? mem.createdAt ?? nowSec;
    // log(1 + daysSince) grows slowly — half-life-style decay.
    const daysSince = Math.max(0, (nowSec - lastTouch) / 86_400);
    const recencyBoost = Math.log1p(daysSince) * recencyWeight;
    const finalScore = sim * categoryW * (1 + recencyBoost);
    scored.push({ memory: mem, score: finalScore });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, topK);
  if (markReferenced) {
    for (const hit of top) referenceMemory(hit.memory.id, stateDir);
  }
  return top;
}
