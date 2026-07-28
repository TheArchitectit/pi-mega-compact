/**
 * multilevel.ts — Multi-level RAPTOR retrieval engine (S42A).
 *
 * Upgrades the RAPTOR recall path from flat (leaf-only) to multi-level
 * retrieval across the entire hierarchical tree. Searches ALL levels with
 * configurable level weights, supports leaf expansion for cluster hits,
 * and deduplicates overlapping results.
 *
 * PREVENT-PI-004: pure in-process math (cosine, BFS, extractive). No network.
 * PREVENT-PI-001: produces SearchHit[] that feed into recallAndInline() —
 * affects which checkpoints are recalled, not how messages are dropped.
 */

import type { Embedder, Vector } from "../../embedder.js";
import { cosineSimilarity } from "../../embedder.js";
import { mmrRerank } from "../mmr.js";
import type { RaptorTree, RaptorNode } from "./tree.js";
import { leafDescendants } from "./retrieval.js";

// ── S42A-1: Types ──────────────────────────────────────────────────────────

export interface MultilevelRetrieveOptions {
  embedder: Embedder;
  /** Weight per tree level (index 0 = leaves, index 1 = level 1, etc.).
   *  Default: [1.0, 0.9, 0.8, 0.7, 0.5]. Capped at tree depth.
   *  UNCALIBRATED — requires real-data calibration before stable. */
  levelWeights?: number[];
  /** When true, expand cluster hits to include leaf descendants. Default: true. */
  leafExpansion?: boolean;
  /** Max leaf descendants to fetch per cluster hit. Default: 10. */
  maxLeafExpansion?: number;
  /** Final number of results to return. Default: 5. */
  k?: number;
  /** MMR diversity weight. Default: 0.5. */
  mmrLambda?: number;
}

export interface MultilevelHit {
  nodeId: string;
  level: number;
  /** Weighted score after level weighting. */
  score: number;
  /** Raw cosine similarity before level weighting. */
  rawScore: number;
  isLeaf: boolean;
  /** Leaf ids covered by this node (for leaf expansion). */
  leafIds: string[];
  summary: string;
  embedding: Vector;
}

const DEFAULT_LEVEL_WEIGHTS = [1.0, 0.9, 0.8, 0.7, 0.5];

// ── S42A-2: Level-weighted scoring ─────────────────────────────────────────

/**
 * Score all RAPTOR tree nodes by cosine similarity to the query, then apply
 * level-specific weights. Returns hits sorted by weighted score descending.
 *
 * Level weights: leaves (level 0) get weight 1.0, level 1 gets 0.9, etc.
 * This ensures detailed leaves score highest while still surfacing higher-level
 * summaries when they're highly relevant.
 */
export function scoreTreeLevels(
  query: string,
  tree: RaptorTree,
  opts: Pick<MultilevelRetrieveOptions, "embedder" | "levelWeights">,
): MultilevelHit[] {
  const { embedder } = opts;
  const weights = opts.levelWeights ?? DEFAULT_LEVEL_WEIGHTS;
  const qv = embedder.embed(query);
  const hits: MultilevelHit[] = [];

  // 1. Score all internal (summary) nodes.
  for (const node of tree.nodes.values()) {
    const rawScore = cosineSimilarity(qv, node.embedding);
    const levelWeight = weights[Math.min(node.level, weights.length - 1)];
    hits.push({
      nodeId: node.id,
      level: node.level,
      score: rawScore * levelWeight,
      rawScore,
      isLeaf: false,
      leafIds: node.children,
      summary: node.summary,
      embedding: node.embedding,
    });
  }

  // 2. Score leaf nodes. Leaf ids are not in tree.nodes — they are children
  //    referenced by internal nodes. Each leaf's embedding is the level-0
  //    parent node that wraps it (same approach as stagedExpansion:95–102).
  const seenLeaves = new Set<string>();
  for (const node of tree.nodes.values()) {
    for (const leafId of node.children) {
      if (seenLeaves.has(leafId) || tree.nodes.has(leafId)) continue;
      seenLeaves.add(leafId);
      const rawScore = cosineSimilarity(qv, node.embedding);
      const leafWeight = weights[0];
      hits.push({
        nodeId: leafId,
        level: 0,
        score: rawScore * leafWeight,
        rawScore,
        isLeaf: true,
        leafIds: [leafId],
        summary: "", // leaves have no summary — they are raw checkpoint ids
        embedding: node.embedding,
      });
    }
  }

  hits.sort((a, b) => b.score - a.score);
  return hits;
}

// ── S42A-3: Leaf expansion ─────────────────────────────────────────────────

/** Build a reverse index: childId → parent RaptorNode. O(N). */
export function buildChildParentIndex(tree: RaptorTree): Map<string, RaptorNode> {
  const idx = new Map<string, RaptorNode>();
  for (const node of tree.nodes.values()) {
    for (const cid of node.children) {
      if (!idx.has(cid)) idx.set(cid, node);
    }
  }
  return idx;
}

/**
 * Given a set of cluster-level hits, expand each one to include its leaf
 * descendants. Deduplicates: if a leaf is already present as a direct hit,
 * it is not duplicated. Returns the merged set (original hits + expanded leaves).
 */
export function expandLeafDescendants(
  hits: MultilevelHit[],
  tree: RaptorTree,
  maxPerCluster: number,
  _embedder: Embedder,
  queryVector: Vector,
  levelWeights?: number[],
): MultilevelHit[] {
  const weights = levelWeights ?? DEFAULT_LEVEL_WEIGHTS;
  const existingIds = new Set(hits.map((h) => h.nodeId));
  const childParentIdx = buildChildParentIndex(tree);
  const expanded: MultilevelHit[] = [];

  for (const hit of hits) {
    if (hit.isLeaf) {
      expanded.push(hit);
      continue;
    }

    // Get all leaf descendants for this cluster node.
    const node = tree.nodes.get(hit.nodeId);
    if (!node) {
      expanded.push(hit);
      continue;
    }

    const rawLeafIds = leafDescendants(node, tree);

    // Sort by cosine similarity to query, cap at maxPerCluster.
    // Skip leaves with no parent (orphan) — they have no reliable embedding.
    const leafHits: MultilevelHit[] = rawLeafIds
      .map((lid) => {
        const parent = childParentIdx.get(lid);
        const sim = parent
          ? cosineSimilarity(queryVector, parent.embedding)
          : -Infinity; // orphan: excluded
        return { lid, sim, parent };
      })
      .filter((l) => l.sim > -Infinity && !existingIds.has(l.lid))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, maxPerCluster)
      .map((l) => {
        existingIds.add(l.lid);
        const rawScore = l.sim;
        return {
          nodeId: l.lid,
          level: 0,
          score: rawScore * weights[0],
          rawScore,
          isLeaf: true,
          leafIds: [l.lid],
          summary: "",
          embedding: l.parent!.embedding, // parent guaranteed non-null here
        } as MultilevelHit;
      });

    expanded.push(hit, ...leafHits);
  }

  return expanded;
}

// ── S42A-4: Result dedup ───────────────────────────────────────────────────

/**
 * Deduplicate hits: if both a cluster node and its leaf children appear in
 * results, remove the cluster hit (leaves provide more specific context).
 * If no leaves are in the set, keep the cluster hit (it provides the abstract view).
 */
export function deduplicateMultilevelHits(hits: MultilevelHit[]): MultilevelHit[] {
  const leafIds = new Set(hits.filter((h) => h.isLeaf).map((h) => h.nodeId));
  return hits.filter((h) => {
    if (h.isLeaf) return true;
    // Cluster hit: keep only if none of its leaf children are present.
    return !h.leafIds.some((lid) => leafIds.has(lid));
  });
}

// ── S42A-5: Top-level pipeline ─────────────────────────────────────────────

/**
 * Full multi-level retrieval pipeline: score → expand → dedup → MMR → top-K.
 * Drop-in replacement for `stagedExpansion()` in the RAPTOR recall path.
 */
export function multilevelRetrieval(
  query: string,
  tree: RaptorTree,
  opts: MultilevelRetrieveOptions,
): MultilevelHit[] {
  if (!tree.rootId) return [];

  const { embedder } = opts;
  const weights = opts.levelWeights ?? DEFAULT_LEVEL_WEIGHTS;
  const leafExp = opts.leafExpansion !== false; // default true
  const maxLeafExp = opts.maxLeafExpansion ?? 10;
  const k = opts.k ?? 5;
  const lambda = opts.mmrLambda ?? 0.5;

  const qv = embedder.embed(query);

  // 1. Score all nodes with level weights.
  const scored = scoreTreeLevels(query, tree, { embedder, levelWeights: weights });

  // 2. Top-N candidates for MMR diversity window.
  const topN = scored.slice(0, k * 3);

  // 3. Leaf expansion (optional).
  const expanded = leafExp
    ? expandLeafDescendants(topN, tree, maxLeafExp, embedder, qv, weights)
    : topN;

  // 4. Dedup: remove cluster hits when leaf children are present.
  const deduped = deduplicateMultilevelHits(expanded);

  // 5. MMR rerank to k.
  const mmrItems = deduped.map((h) => ({
    item: h,
    vector: h.embedding as Vector,
    relevance: h.score,
  }));
  return mmrRerank(mmrItems, k, lambda);
}
