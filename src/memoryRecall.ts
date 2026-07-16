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

/**
 * Cross-repo memory recall (S24): augments the same-repo `recallMemories` with
 * HNSW NN over the global PGlite `memory_index` (other repos' memories). Content
 * is read inline from the index hit (the recall process can't open other repos'
 * SQLite dirs), so no other-repo db access is required. Returns hits sorted by
 * descending cosine, above `crossRepoCosine`. De-duped by content against
 * `sameRepoContent` so we never surface a memory the same-repo scan already has.
 * Non-fatal: any index failure returns []. Best-effort + PREVENT-PI-004 (local
 * WASM only).
 */
export async function recallMemoriesCrossRepo(
  query: string,
  stateDir: string,
  opts: RecallMemoriesOptions & { crossRepoCosine?: number; limit?: number } = {},
): Promise<Array<{ memory: MemoryRecord; score: number; repoId: string }>> {
  const embedder = opts.embedder ?? defaultEmbedder();
  const queryVec = embedder.embed(query);
  const { searchMemoriesAsync } = await import("./store/memoryIndex.js");
  const k = opts.limit ?? 5;
  const floor = opts.crossRepoCosine ?? 0.3;
  const hits = await searchMemoriesAsync(queryVec, { k });
  if (!hits.length) return [];
  // Mark same-repo content as already-covered so we don't duplicate it.
  const sameRepo = new Set(
    listMemories(opts.repo ?? null, 1000, stateDir).map((m) => m.content.trim().toLowerCase()),
  );
  const out: Array<{ memory: MemoryRecord; score: number; repoId: string }> = [];
  for (const h of hits) {
    if (h.score < floor) continue;
    if (sameRepo.has(h.content.trim().toLowerCase())) continue;
    out.push({
      memory: {
        id: h.memoryId,
        repo: h.repoId,
        kind: "note",
        content: h.content,
        tags: [],
        createdAt: 0,
        lastRecalledAt: null,
        category: null,
        target: null,
        lastReferenced: null,
        sourceTurn: null,
      } as MemoryRecord,
      score: h.score,
      repoId: h.repoId,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
