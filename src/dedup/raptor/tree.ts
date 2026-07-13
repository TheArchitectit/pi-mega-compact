/**
 * tree.ts — RAPTOR hierarchical summary-tree builder (Sprint 13, Phase 6).
 *
 * Builds a multi-level tree of summary nodes over leaf chunks: leaves are the
 * original regions; each higher level summarizes clusters of the level below
 * until a single root remains. QA ops: a wall-clock budget guard — on exhaustion
 * we build an extractive fallback root. <10 leaves → a single summary node.
 *
 * Node model (kept simple + flat): every RaptorNode stores the LIST OF LEAF IDS
 * it ultimately covers in `children` (not a mix of node/leaf ids). So the node
 * map holds ONLY internal summary nodes — never per-leaf wrappers — which is
 * what makes RAPTOR consolidate (nodes.size << leaves) and makes retrieval's
 * leaf walk trivial.
 *
 * PREVENT-PI-004: no network here. summarizeCluster() may call a localhost
 * Ollama (annotated in summarizer.ts); extractive is the default.
 */

import type { Embedder, Vector } from "../../embedder.js";
import { kmeanspp, meanVector } from "./kmeans.js";
import { summarizeCluster } from "./summarizer.js";
import { applyHallucinationGuardrails, sourceTokenSet, type QualityMarker } from "./guardrails.js";
import type { EngineMessage } from "../../types.js";

export interface RaptorNode {
  id: string;
  level: number;
  parentId: string | null;
  /** Leaf ids this node ultimately covers (flattened through the hierarchy). */
  children: string[];
  summary: string;
  embedding: Vector; // centroid of the covered leaves
  qualityMarker: QualityMarker;
  tokenEstimate: number;
}

export interface RaptorTree {
  nodes: Map<string, RaptorNode>;
  rootId: string | null;
  levels: number;
  /** True when the budget forced an extractive fallback root. */
  timedOut: boolean;
}

export interface Leaf {
  id: string;
  messages: EngineMessage[];
  /** Precomputed source text (for grounding) + embedding (leaf centroid). */
  sourceText: string;
  embedding: Vector;
}

export interface BuildOptions {
  embedder: Embedder;
  /** Max wall-clock ms for the whole build (QA ops budget). */
  budgetMs?: number;
  /** Target clusters per level (k for k-means). */
  clustersPerLevel?: number;
  /** Consistency gate (guardrails.ts). */
  consistencyThreshold?: number;
  /** Injectable id generator (deterministic in tests). */
  nextId?: (level: number, index: number) => string;
  /** Injectable clock for the budget guard (ms). */
  now?: () => number;
}

const DEFAULT_BUDGET_MS = 5000;
const DEFAULT_CLUSTERS = 5;

function defaultNextId(level: number, index: number): string {
  return `r${level}_${index}`;
}

/** An item being clustered at any level: a leaf, or a grouping of leaves. */
interface ClusterItem {
  id: string;
  embedding: Vector;
  leafIds: string[];
  /** Source messages for summarization (flattened). */
  messages: EngineMessage[];
  /** Source texts for grounding (flattened). */
  sources: string[];
}

function summarizeInto(
  item: ClusterItem,
  centroid: Vector,
  embedder: Embedder,
  consistencyThreshold?: number,
): { summary: string; tokenEstimate: number; qualityMarker: QualityMarker } {
  let summary = summarizeCluster(item.messages);
  const guard = applyHallucinationGuardrails({
    summary: summary.summary,
    sources: item.sources,
    centroid,
    embedder,
    sourceTokens: sourceTokenSet(item.sources),
    consistencyThreshold,
  });
  if (guard.marker === "extractive_fallback") {
    summary = summarizeCluster(item.messages); // deterministic extractive text
  }
  return {
    summary: summary.summary,
    tokenEstimate: summary.tokenEstimate,
    qualityMarker: guard.marker === "extractive_fallback" ? "low" : guard.marker,
  };
}

/**
 * Build a RAPTOR tree from leaf chunks. Synchronous; guarded by an elapsed-time
 * budget. Returns a tree whose `nodes` map holds ONLY internal summary nodes.
 */
export function buildRaptorTree(leaves: Leaf[], opts: BuildOptions): RaptorTree {
  const embedder = opts.embedder;
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const clustersPerLevel = opts.clustersPerLevel ?? DEFAULT_CLUSTERS;
  const nextId = opts.nextId ?? defaultNextId;
  const now = opts.now ?? (() => Date.now());
  const start = now();
  const within = () => now() - start <= budgetMs;

  const nodes = new Map<string, RaptorNode>();

  // <10 leaves → single summary root (no hierarchy needed).
  if (leaves.length < 10) {
    const item: ClusterItem = {
      id: "root",
      embedding: meanVector(leaves.map((l) => l.embedding)),
      leafIds: leaves.map((l) => l.id),
      messages: leaves.flatMap((l) => l.messages),
      sources: leaves.map((l) => l.sourceText),
    };
    const centroid = item.embedding;
    const { summary, tokenEstimate, qualityMarker } = summarizeInto(item, centroid, embedder, opts.consistencyThreshold);
    const rootId = nextId(0, 0);
    nodes.set(rootId, {
      id: rootId,
      level: 0,
      parentId: null,
      children: item.leafIds,
      summary,
      embedding: centroid,
      qualityMarker,
      tokenEstimate,
    });
    return { nodes, rootId, levels: 1, timedOut: false };
  }

  let currentLevel: ClusterItem[] = leaves.map((l) => ({
    id: l.id,
    embedding: l.embedding,
    leafIds: [l.id],
    messages: l.messages,
    sources: [l.sourceText],
  }));

  let level = 0;
  while (currentLevel.length > 1) {
    if (!within()) return extractiveFallbackRoot(leaves, nodes, nextId);

    // Once we're down to a handful of items, collapse them all into one root.
    // (k === currentLevel.length would make every item its own singleton
    // cluster and never shrink — an infinite loop until the budget blows.)
    if (currentLevel.length <= clustersPerLevel) {
      const merged: ClusterItem = {
        id: "merge",
        embedding: meanVector(currentLevel.map((c) => c.embedding)),
        leafIds: currentLevel.flatMap((c) => c.leafIds),
        messages: currentLevel.flatMap((c) => c.messages),
        sources: currentLevel.flatMap((c) => c.sources),
      };
      const centroid = merged.embedding;
      const { summary, tokenEstimate, qualityMarker } = summarizeInto(merged, centroid, embedder, opts.consistencyThreshold);
      const rootId = nextId(level + 1, 0);
      nodes.set(rootId, {
        id: rootId,
        level: level + 1,
        parentId: null,
        children: merged.leafIds,
        summary,
        embedding: centroid,
        qualityMarker,
        tokenEstimate,
      });
      return { nodes, rootId, levels: level + 2, timedOut: false };
    }

    const k = Math.max(1, Math.min(clustersPerLevel, currentLevel.length));
    const clustered = kmeanspp(currentLevel.map((c) => c.embedding), k, { seed: 0x1234 + level });

    const groups: ClusterItem[][] = Array.from({ length: clustered.k }, () => []);
    clustered.assignments.forEach((c, i) => groups[c].push(currentLevel[i]));

    const nextLevel: ClusterItem[] = [];
    for (let g = 0; g < groups.length; g++) {
      const group = groups[g];
      if (group.length === 0) continue;
      const merged: ClusterItem = {
        id: nextId(level + 1, g),
        embedding: clustered.centroids[g],
        leafIds: group.flatMap((c) => c.leafIds),
        messages: group.flatMap((c) => c.messages),
        sources: group.flatMap((c) => c.sources),
      };
      const { summary, tokenEstimate, qualityMarker } = summarizeInto(merged, merged.embedding, embedder, opts.consistencyThreshold);
      nodes.set(merged.id, {
        id: merged.id,
        level: level + 1,
        parentId: null,
        children: merged.leafIds,
        summary,
        embedding: merged.embedding,
        qualityMarker,
        tokenEstimate,
      });
      nextLevel.push(merged);
    }
    currentLevel = nextLevel;
    level++;
  }

  const root = currentLevel[0];
  return {
    nodes,
    rootId: root ? root.id : null,
    levels: level + 1,
    timedOut: false,
  };
}

/**
 * Budget-exceeded fallback: build a single deterministic extractive root over
 * all leaves and mark it low quality. Keeps a valid (if shallow) tree.
 */
function extractiveFallbackRoot(
  leaves: Leaf[],
  nodes: Map<string, RaptorNode>,
  nextId: (level: number, index: number) => string,
): RaptorTree {
  const summary = summarizeCluster(leaves.flatMap((l) => l.messages));
  const rootId = nextId(99, 0);
  nodes.set(rootId, {
    id: rootId,
    level: 99,
    parentId: null,
    children: leaves.map((l) => l.id),
    summary: summary.summary,
    embedding: meanVector(leaves.map((l) => l.embedding)),
    qualityMarker: "low",
    tokenEstimate: summary.tokenEstimate,
  });
  return { nodes, rootId, levels: 2, timedOut: true };
}
