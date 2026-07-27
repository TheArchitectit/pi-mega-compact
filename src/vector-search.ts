/**
 * vector-search.ts — free functions for VectorStore search operations.
 *
 * Extracted from vectorStore.ts (PR0 split) to bring it under 500 lines.
 * All functions take `store: VectorStore` as first param and access store
 * fields/props directly via type-cast to access private fields (acceptable
 * since these fields were effectively public via the original methods).
 *
 * Call sites in src/ and extensions/ are rewritten from `store.search(...)`
 * → `vectorSearch(store, ...)` and `store.searchAsync(...)` →
 * `vectorSearchAsync(store, ...)`.
 */

import { cosineSimilarity } from "./embedder.js";
import { normalizeSessionId } from "./store.js";
import { mmrRerank, type MmrItem } from "./dedup/mmr.js";
import { topK } from "./dedup/topk.js";
import {
  listCheckpoints,
  getCheckpoint,
  maxCheckpointTimestamp,
} from "./store/sqlite.js";
import {
  initVectorIndex,
  searchAsync as vectorIndexSearch,
  type VectorIndexHit,
} from "./store/vectorIndex.js";
import { rehydrateRaptorTree, isShadowMode } from "./dedup/raptor/index.js";
import { stagedExpansion } from "./dedup/raptor/retrieval.js";
import type { SearchHit, VectorStore } from "./vectorStore.js";

// ---------------------------------------------------------------------------
// raptorSearchHits — internal helper (NOT exported)
// ---------------------------------------------------------------------------

/**
 * Serve the RAPTOR tree for a query (Fix D): rehydrate the persisted tree and
 * return its staged-expansion leaf hits as SearchHits. Returns [] when no tree
 * exists (small sessions — flat search remains the path). Best-effort/non-fatal.
 */
function raptorSearchHits(store: VectorStore, sid: string, query: string, k: number): SearchHit[] {
  const t0 = Date.now();
  try {
    const stateDir = store.stateDir;
    const cfg = store.cfg;
    const embedder = store.embedder;
    const record = store.record;

    // S25 gate (a): honor the shadow contract at SERVE time. The tree is still
    // built + persisted (logging-only) but NOT merged into recall while
    // RAPTOR_SHADOW_MODE is anything other than "false".
    if (isShadowMode()) return [];
    const tree = rehydrateRaptorTree(sid, stateDir);
    if (!tree || !tree.rootId) return [];
    // S25 gate (b): freshness + fallback guards. Skip a tree built before the
    // newest checkpoint (stale → may reference trimmed/deduped leaves) or one
    // whose root is a budget-exhausted extractive fallback (level 99).
    if (tree.timedOut) return [];
    const maxTs = maxCheckpointTimestamp(sid, stateDir);
    if (tree.builtAt && tree.builtAt < maxTs) return [];
    const leafIds = stagedExpansion(query, tree, {
      embedder,
      k,
      topM: cfg.RAPTOR_CLUSTERS_PER_LEVEL,
      mmrLambda: cfg.MMR_LAMBDA,
    });
    if (leafIds.length === 0) return [];
    const all = listCheckpoints(sid, stateDir).filter(
      (cp) => cp.dedupStatus !== "removed",
    );
    const qv = embedder.embed(query);
    const hits: SearchHit[] = [];
    for (const id of leafIds) {
      const cp = all.find((c) => c.checkpointId === id);
      if (cp) hits.push({ checkpoint: cp, score: cosineSimilarity(qv, cp.embedding) });
    }
    // S25 monitoring: emit a raptor_serve decision so canary.ts can track
    // p95 latency + the tier's live traffic (non-fatal, best-effort).
    record("RAPTOR", hits.length > 0 ? "new" : "mark_only", `leaves=${leafIds.length}`, Date.now() - t0);
    return hits;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// vectorSearch
// ---------------------------------------------------------------------------

/**
 * Semantic search within a session's checkpoints. Returns top-K by cosine
 * similarity, diversified via MMR (QA #10) so a cluster of near-identical
 * hits yields at most a few distinct-relevance results.
 *
 * Heap-based top-K (QA #4, O(N log k)) replaces the old full sort; MMR then
 * reranks the candidate window for diversity.
 */
export function vectorSearch(
  store: VectorStore,
  sessionId: string,
  query: string,
  k = 3,
): SearchHit[] {
  const stateDir = store.stateDir;
  const cfg = store.cfg;
  const embedder = store.embedder;

  const sid = normalizeSessionId(sessionId);
  const checkpoints = listCheckpoints(sid, stateDir).filter(
    (cp) => cp.dedupStatus !== "removed", // SemDeDup: exclude removed rows
  );
  if (checkpoints.length === 0) return [];
  const qv = embedder.embed(query);

  const scored: SearchHit[] = checkpoints.map((cp) => ({
    checkpoint: cp,
    score: cosineSimilarity(qv, cp.embedding),
  }));

  // Heap top-K over a widened window (2k) so MMR has diverse candidates.
  const window = topK(
    scored.map((h) => ({ item: h, score: h.score })),
    Math.max(k * 2, k),
  ).map((s) => s.item);
  // MMR (QA #10) is part of the L2 semantic tier: skip it when L2 is disabled
  // (Sprint 14 flag), returning the plain relevance-ranked window instead.
  if (!cfg.L2_ENABLED) return window.slice(0, k);

  // Fix D: when RAPTOR is promoted, ALSO recall high-level tree summaries and
  // merge them with the flat hits via MMR so RAPTOR + flat don't double-cover.
  // RAPTOR returns fewer, broader hits (O(log n) high-level nodes) than the
  // O(n) flat leaves, tightening the block at read time.
  if (cfg.RAPTOR_ENABLED) {
    const rh = raptorSearchHits(store, sid, query, k);
    if (rh.length > 0) {
      const merged: SearchHit[] = [...window];
      for (const h of rh) {
        if (!merged.some((m) => m.checkpoint.checkpointId === h.checkpoint.checkpointId)) {
          merged.push(h);
        }
      }
      const mmrItems: MmrItem<SearchHit>[] = merged.map((h) => ({
        item: h,
        vector: h.checkpoint.embedding,
        relevance: h.score,
      }));
      return mmrRerank(mmrItems, k, cfg.MMR_LAMBDA);
    }
  }

  const mmrItems: MmrItem<SearchHit>[] = window.map((h) => ({
    item: h,
    vector: h.checkpoint.embedding,
    relevance: h.score,
  }));
  const ranked = mmrRerank(mmrItems, k, cfg.MMR_LAMBDA);
  return ranked;
}

// ---------------------------------------------------------------------------
// vectorSearchAsync
// ---------------------------------------------------------------------------

export interface VectorSearchOptions {
  /** Scope to a specific repo (omit for cross-repo NN). */
  repoId?: string;
  /** Include hits from all repos (cross-repo NN). Mutually exclusive with repoId. */
  crossRepo?: boolean;
}

/**
 * Slice 2: async cross-repo (or single-repo) recall via the PGlite/HNSW index.
 *
 * This is the ONLY async recall surface and is a BONUS path — the synchronous
 * `vectorSearch` above remains the default. `opts.repoId` scopes to one repo;
 * omit it for cross-repo nearest-neighbor recall (the headline capability the
 * sync per-session scan cannot provide).
 *
 * Best-effort: if the index is disabled/empty/failing, we fall back to the
 * synchronous per-session `vectorSearch` for THIS repo so callers always get
 * a sensible result. Hydrates each hit's StoredCheckpoint from the authoritative
 * node:sqlite store (the hit's repoId doubles as that repo's stateDir), then
 * MMR-dedupes the merged set.
 */
export async function vectorSearchAsync(
  store: VectorStore,
  sessionId: string,
  query: string,
  k = 3,
  opts: VectorSearchOptions = {},
): Promise<SearchHit[]> {
  const cfg = store.cfg;
  const embedder = store.embedder;

  const sid = normalizeSessionId(sessionId);
  const qv = embedder.embed(query);
  // repoId filter: explicit opts.repoId wins; else this repo unless crossRepo.
  const selfRepo = store.repoId;
  const repoId = opts.repoId ?? (opts.crossRepo ? undefined : selfRepo);
  let indexHits: VectorIndexHit[] = [];
  try {
    await initVectorIndex();
    indexHits = await vectorIndexSearch(qv, { k: Math.max(k * 2, k), repoId });
  } catch {
    indexHits = [];
  }
  if (indexHits.length === 0) {
    // Index empty/unavailable → synchronous per-session fallback (this repo).
    return vectorSearch(store, sid, query, k);
  }
  // Hydrate each index hit from the authoritative node:sqlite store. repoId is
  // that repo's stateDir, so cross-repo hits resolve against their own store.
  // Tag cross-repo hits with their source repoId so the recall block can label
  // them ("from repo <name>"); same-repo hits stay unlabeled.
  const hydrated: SearchHit[] = [];
  for (const h of indexHits) {
    const cp = getCheckpoint(h.sessionId, h.checkpointId, h.repoId);
    if (cp && cp.dedupStatus !== "removed") {
      const crossRepo = opts.crossRepo && selfRepo && h.repoId && h.repoId !== selfRepo;
      hydrated.push({ checkpoint: cp, score: h.score, repoId: crossRepo ? h.repoId : undefined });
    }
  }
  if (hydrated.length === 0) return vectorSearch(store, sid, query, k);
  // MMR-dedupe the merged candidate set for diversity (mirrors sync search).
  const mmrItems: MmrItem<SearchHit>[] = hydrated.map((h) => ({
    item: h,
    vector: h.checkpoint.embedding,
    relevance: h.score,
  }));
  return mmrRerank(mmrItems, k, cfg.MMR_LAMBDA);
}