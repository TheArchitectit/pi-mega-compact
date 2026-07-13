/**
 * retrieval.ts — staged RAPTOR retrieval (Sprint 13, Phase 6).
 *
 * Given a built tree (shadow or live), answer a query by:
 *   1. ANN: score the top-level nodes at every level by cosine to the query.
 *   2. expand: take the top-M nodes (across levels) and descend.
 *   3. BFS: from those anchors, walk down to leaf nodes.
 *   4. MMR: diversify the resulting leaf set before returning.
 *
 * This module is pure query logic over an in-memory RaptorTree. In Sprint 13 it
 * is exercised only in shadow/eval; the live store (vectorStore.search) is NOT
 * replaced until Sprint 14 promotes RAPTOR.
 */

import type { Embedder, Vector } from "../../embedder.js";
import { cosineSimilarity } from "../../embedder.js";
import { mmrRerank } from "../mmr.js";
import type { RaptorTree, RaptorNode } from "./tree.js";

export interface RaptorRetrieveOptions {
  embedder: Embedder;
  /** How many top nodes per level to expand from. */
  topM?: number;
  /** Final number of leaf nodes to return. */
  k?: number;
  /** MMR diversity weight. */
  mmrLambda?: number;
}

/** Any child id not present in the node map is a raw leaf id. */
function isLeafId(id: string, tree: RaptorTree): boolean {
  return !tree.nodes.has(id);
}

/** All leaf (raw) ids reachable beneath a node via BFS. */
function leafDescendants(node: RaptorNode, tree: RaptorTree): string[] {
  const out: string[] = [];
  const queue = [node];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const childId of cur.children) {
      if (isLeafId(childId, tree)) out.push(childId);
      else {
        const child = tree.nodes.get(childId);
        if (child) queue.push(child);
      }
    }
  }
  return out;
}

/**
 * Staged expansion retrieval over a RAPTOR tree.
 *
 * Returns up to `k` leaf ids, diversiﬁed by MMR. Deterministic given the
 * tree + query. Throws nothing — returns [] on empty tree.
 */
export function stagedExpansion(
  query: string,
  tree: RaptorTree,
  opts: RaptorRetrieveOptions,
): string[] {
  if (!tree.rootId) return [];
  const embedder = opts.embedder;
  const topM = opts.topM ?? 3;
  const k = opts.k ?? 5;
  const lambda = opts.mmrLambda ?? 0.5;

  const qv = embedder.embed(query);

  // 1. ANN: score every node at every level by cosine to the query.
  const scored = [...tree.nodes.values()].map((n) => ({
    node: n,
    score: cosineSimilarity(qv, n.embedding),
  }));

  // 2. expand: top-M nodes overall (BFS anchors).
  const anchors = scored
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, topM)
    .map((s) => s.node);

  // 3. BFS to leaves from those anchors.
  const leaves = new Map<string, RaptorNode>();
  for (const a of anchors) {
    for (const lid of leafDescendants(a, tree)) {
      // Represent each leaf by its nearest internal parent so we can score it.
      // (The leaf's own centroid is stored on the level-0 node that wraps it.)
      const parent = [...tree.nodes.values()].find((n) => n.children.includes(lid));
      if (parent) leaves.set(lid, parent);
    }
  }

  // 4. MMR diversify the expanded leaf set by their (parent) embeddings.
  const items = [...leaves.entries()].map(([lid, n]) => ({
    item: lid,
    vector: n.embedding as Vector,
    relevance: cosineSimilarity(qv, n.embedding),
  }));
  return mmrRerank(items, k, lambda);
}
