/**
 * incremental.ts — incremental RAPTOR tree update (Sprint 26, #7).
 *
 * Instead of rebuilding the full tree (~2s per compaction), insert only the new
 * checkpoints since the last build and recompute only the affected cluster
 * assignments up the tree. Falls back to a full rebuild when the tree is
 * missing, corrupted, or >50% of nodes are new.
 *
 * Non-fatal: every failure logs and returns null (caller falls back to full
 * rebuild). PREVENT-PI-004: zero network; all operations are local SQLite + CPU.
 */

import type { Embedder, Vector } from "../../embedder.js";
import { cosineSimilarity } from "../../embedder.js";
import { defaultEmbedder as getDefaultEmbedder } from "../../embedder.js";
import type { EngineMessage } from "../../types.js";
import { buildRaptorTree, type Leaf, type RaptorTree } from "./tree.js";
import type { QualityMarker } from "./guardrails.js";
import { applyHallucinationGuardrails, sourceTokenSet } from "./guardrails.js";
import { meanVector } from "./kmeans.js";
import { summarizeCluster, extractiveClusterSummary } from "./summarizer.js";
import type { Logger } from "../../log.js";
import {
  saveRaptorTree,
  listRaptorNodes,
  type StoredRaptorNode,
} from "../../store/sqlite.js";

/** When >FRESH_THRESHOLD of existing leaves are new, a full rebuild is cheaper. */
const FRESH_THRESHOLD = 0.5;

/**
 * Summarize + apply hallucination guardrails (mirrors tree.ts:summarizeInto).
 * If the guardrail marks the summary as extractive_fallback (drift/hallucination),
 * re-summarize with the deterministic extractive path so we never serve a
 * drifted LLM summary from an incremental update.
 */
function summarizeGuarded(
  messages: EngineMessage[],
  centroid: Vector,
  embedder: Embedder,
  consistencyThreshold?: number,
): { summary: string; tokenEstimate: number; qualityMarker: QualityMarker } {
  let cs = summarizeCluster(messages);
  const sources = messages.map((m) => m.text);
  const guard = applyHallucinationGuardrails({
    summary: cs.summary,
    sources,
    centroid,
    embedder,
    sourceTokens: sourceTokenSet(sources),
    consistencyThreshold,
  });
  if (guard.marker === "extractive_fallback") {
    cs = extractiveClusterSummary(messages);
  }
  return {
    summary: cs.summary,
    tokenEstimate: cs.tokenEstimate,
    qualityMarker: guard.marker === "extractive_fallback" ? "low" : guard.marker,
  };
}

/**
 * Incrementally update a persisted RAPTOR tree with new leaves.
 *
 * 1. Reads the existing tree from the store.
 * 2. Filters `newLeaves` to those NOT already covered by the tree.
 * 3. If no new leaves → early-return (existing tree).
 * 4. If no existing tree or >50% new → full rebuild.
 * 5. For each new leaf, finds the best-matching Level-0 cluster node,
 *    reassigns (inserts into its children), updates that node's summary
 *    and centroid embedding.
 * 6. Propagates changes up through parent levels to the root.
 * 7. Persists the updated tree (full delete + reinsert in a tx).
 *
 * Never throws. Returns the updated tree, or null on failure/fallback.
 */
export function incrementRaptorTree(
  existingLeaves: Leaf[],
  newLeaves: Leaf[],
  opts: {
    embedder?: Embedder;
    stateDir: string;
    sessionId: string;
    budgetMs?: number;
    clustersPerLevel?: number;
    consistencyThreshold?: number;
    logger?: Logger;
    builtAt?: number;
  },
): RaptorTree | null {
  const logger = opts.logger;
  const builtAt = opts.builtAt ?? Date.now();

  try {
    // 1. Read existing tree.
    const storedNodes = listRaptorNodes(opts.sessionId, opts.stateDir);
    if (storedNodes.length === 0) {
      logger?.info("raptor_incremental_no_tree", { sessionId: opts.sessionId });
      return null; // no existing tree — caller falls back to full buildRaptorTree
    }

    // 2. Find new leaf ids not already in the tree.
    const coveredLeafIds = new Set<string>();
    for (const n of storedNodes) {
      for (const cid of n.children) coveredLeafIds.add(cid);
    }
    const reallyNewLeaves = newLeaves.filter(
      (l) => !coveredLeafIds.has(l.id),
    );
    const totalCovered = coveredLeafIds.size;

    if (reallyNewLeaves.length === 0) {
      logger?.info("raptor_incremental_no_new", { sessionId: opts.sessionId });
      return rehydrateFromStored(storedNodes);
    }

    // 4. Fallback guard: >50% new → full rebuild.
    if (
      totalCovered > 0 &&
      reallyNewLeaves.length / totalCovered > FRESH_THRESHOLD
    ) {
      logger?.info("raptor_incremental_fallback_ratio", {
        sessionId: opts.sessionId,
        coveredNodes: totalCovered,
        newLeaves: reallyNewLeaves.length,
        threshold: FRESH_THRESHOLD,
      });
      return fullRebuild(existingLeaves, reallyNewLeaves, opts, logger);
    }

    // 5. Build the in-memory tree from stored nodes.
    const tree = rehydrateFromStored(storedNodes);
    if (!tree || tree.nodes.size === 0) {
      logger?.info("raptor_incremental_rehydrate_failed", {
        sessionId: opts.sessionId,
      });
      return fullRebuild(existingLeaves, reallyNewLeaves, opts, logger);
    }

    // Group stored nodes by level.
    const levelGroups = new Map<number, StoredRaptorNode[]>();
    for (const n of storedNodes) {
      const g = levelGroups.get(n.level);
      if (g) g.push(n);
      else levelGroups.set(n.level, [n]);
    }
    // Level-0 covers leaf ids directly.
    const level0Nodes =
      levelGroups.get(0) ??
      storedNodes.filter((n) => {
        // A node is level 0 if its level is the minimum.
        const minLevel = Math.min(...storedNodes.map((x) => x.level));
        return n.level === minLevel;
      });
    if (level0Nodes.length === 0) {
      // Single-root tree with no hierarchy: cannot increment, fall back.
      return fullRebuild(existingLeaves, reallyNewLeaves, opts, logger);
    }

    // For each new leaf, assign to the nearest Level-0 cluster node.
    const leafEmbeddings = new Map<string, Vector>();
    for (const l of reallyNewLeaves) leafEmbeddings.set(l.id, l.embedding);

    // Track which Level-0 nodes changed (by their stored id).
    const affectedNodeIds = new Set<string>();

    for (const leaf of reallyNewLeaves) {
      const emb = leafEmbeddings.get(leaf.id);
      if (!emb || emb.length === 0) continue;

      // Find best matching Level-0 node.
      let bestNode: StoredRaptorNode | null = null;
      let bestSim = -Infinity;
      for (const cn of level0Nodes) {
        const sim = cosineSimilarity(emb, cn.embedding);
        if (sim > bestSim) {
          bestSim = sim;
          bestNode = cn;
        }
      }
      if (!bestNode) continue;

      // Add the leaf id to this node's children.
      const updated = tree.nodes.get(bestNode.id);
      if (updated) {
        if (!updated.children.includes(leaf.id)) {
          updated.children.push(leaf.id);
        }
        affectedNodeIds.add(bestNode.id);
      }
    }

    if (affectedNodeIds.size === 0) {
      // No matches found — fall back to full rebuild.
      logger?.info("raptor_incremental_no_matches", {
        sessionId: opts.sessionId,
      });
      return fullRebuild(existingLeaves, reallyNewLeaves, opts, logger);
    }

    // 6. Recompute embeddings and summaries for affected nodes, bottom-up.
    // Build a map: leafId → leaf info for summarization.
    const leafMap = new Map<string, Leaf>();
    for (const l of existingLeaves) leafMap.set(l.id, l);
    for (const l of reallyNewLeaves) leafMap.set(l.id, l);

    // Recompute affected Level-0 nodes.
    const embedder = opts.embedder ?? getDefaultEmbedder();
    for (const nid of affectedNodeIds) {
      const node = tree.nodes.get(nid);
      if (!node) continue;
      const coveredLeaves = node.children
        .map((cid) => leafMap.get(cid))
        .filter((l): l is Leaf => !!l);
      if (coveredLeaves.length > 0) {
        node.embedding = meanVector(
          coveredLeaves.map((l) => l.embedding),
        );
        // Summarize: flatten messages from all covered leaves.
        const messages = coveredLeaves.flatMap((l) => l.messages);
        if (messages.length > 0) {
          const cs = summarizeGuarded(
            messages,
            node.embedding,
            embedder,
            opts.consistencyThreshold,
          );
          node.summary = cs.summary;
          node.tokenEstimate = cs.tokenEstimate;
        }
      }
    }

    // Propagate up: for each higher level, recompute nodes whose leaf set
    // includes any newly inserted leaf. Since `children` stores flattened leaf
    // ids (not node ids), we check intersection with the new leaf id set.
    const newLeafIds = new Set(reallyNewLeaves.map((l) => l.id));
    const sortedLevels = [...levelGroups.keys()].sort((a, b) => a - b);
    for (const level of sortedLevels.slice(1)) {
      const levelNodes = levelGroups.get(level) ?? [];
      for (const stored of levelNodes) {
        const node = tree.nodes.get(stored.id);
        if (!node) continue;

        if (node.children.some((cid) => newLeafIds.has(cid))) {
          // Recompute embedding as centroid of covered leaves.
          const covered = node.children
            .map((cid) => leafMap.get(cid))
            .filter((l): l is Leaf => !!l);
          if (covered.length > 0) {
            node.embedding = meanVector(
              covered.map((l) => l.embedding),
            );
            const messages = covered.flatMap((l) => l.messages);
            if (messages.length > 0) {
              const cs = summarizeGuarded(
                messages,
                node.embedding,
                embedder,
                opts.consistencyThreshold,
              );
              node.summary = cs.summary;
              node.tokenEstimate = cs.tokenEstimate;
            }
          }
        }
      }
    }

    // 7. Persist the full updated tree (delete + reinsert in a tx).
    tree.builtAt = builtAt;
    saveRaptorTree(opts.sessionId, tree, builtAt, opts.stateDir);

    logger?.info("raptor_incremental_success", {
      sessionId: opts.sessionId,
      nodeCount: tree.nodes.size,
      newLeaves: reallyNewLeaves.length,
      affectedNodes: affectedNodeIds.size,
    });

    return tree;
  } catch (e) {
    logger?.error("raptor_incremental_failed", {
      sessionId: opts.sessionId,
      error: String(e instanceof Error ? e.message : e),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Full rebuild fallback: merges existingLeaves + newLeaves, builds from scratch.
 */
function fullRebuild(
  existingLeaves: Leaf[],
  newLeaves: Leaf[],
  opts: {
    embedder?: Embedder;
    budgetMs?: number;
    clustersPerLevel?: number;
    consistencyThreshold?: number;
    stateDir: string;
    sessionId: string;
    logger?: Logger;
    builtAt?: number;
  },
  logger?: Logger,
): RaptorTree | null {
  logger?.info("raptor_incremental_full_rebuild", {
    sessionId: opts.sessionId,
  });
  try {
    // Merge: deduplicate by leaf id.
    const seen = new Set<string>();
    const allLeaves: Leaf[] = [];
    for (const l of existingLeaves) {
      if (!seen.has(l.id)) {
        seen.add(l.id);
        allLeaves.push(l);
      }
    }
    for (const l of newLeaves) {
      if (!seen.has(l.id)) {
        seen.add(l.id);
        allLeaves.push(l);
      }
    }
    const tree = buildRaptorTree(allLeaves, {
      embedder: opts.embedder ?? getDefaultEmbedder(),
      budgetMs: opts.budgetMs,
      clustersPerLevel: opts.clustersPerLevel,
      consistencyThreshold: opts.consistencyThreshold,
    });
    const builtAt = opts.builtAt ?? Date.now();
    saveRaptorTree(opts.sessionId, tree, builtAt, opts.stateDir);
    return tree;
  } catch (e2) {
    logger?.error("raptor_incremental_full_rebuild_failed", {
      sessionId: opts.sessionId,
      error: String(e2 instanceof Error ? e2.message : e2),
    });
    return null;
  }
}

/** Rebuild the in-memory RaptorTree from stored nodes. */
function rehydrateFromStored(
  nodes: StoredRaptorNode[],
): RaptorTree | null {
  if (nodes.length === 0) return null;
  const root = nodes.reduce<StoredRaptorNode | null>(
    (best, n) => (!best || n.level > (best?.level ?? -1) ? n : best),
    null,
  );
  const tree: RaptorTree = {
    nodes: new Map(
      nodes.map((n) => [
        n.id,
        {
          id: n.id,
          level: n.level,
          parentId: n.parentId,
          children: n.children,
          summary: n.summary,
          embedding: n.embedding,
          qualityMarker: n.qualityMarker as QualityMarker,
          tokenEstimate: n.tokenEstimate,
        },
      ]),
    ),
    rootId: root?.id ?? null,
    levels: Math.max(1, ...nodes.map((n) => n.level + 1)),
    timedOut: root != null && root.level >= 99,
    builtAt: nodes.reduce((max, n) => Math.max(max, n.builtAt), 0),
  };
  return tree;
}

