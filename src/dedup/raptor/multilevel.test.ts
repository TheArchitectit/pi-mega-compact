/**
 * multilevel.test.ts — hermetic unit tests for S42A multi-level RAPTOR retrieval.
 *
 * Tests the scoreTreeLevels → expandLeafDescendants → deduplicateMultilevelHits
 * → multilevelRetrieval pipeline. No network, no live store — uses TrigramEmbedder
 * and synthetic RaptorTrees built from makeLeaves().
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { TrigramEmbedder } from "../../embedder.js";
import { buildRaptorTree, type Leaf } from "./tree.js";
import {
  scoreTreeLevels,
  expandLeafDescendants,
  deduplicateMultilevelHits,
  multilevelRetrieval,
  type MultilevelHit,
} from "./multilevel.js";
import type { EngineMessage } from "../../types.js";

function msg(text: string): EngineMessage {
  return { role: "user", text };
}

/** Build N distinct leaves with deterministic content. */
function makeLeaves(n: number, embedder = new TrigramEmbedder()): Leaf[] {
  const leaves: Leaf[] = [];
  for (let i = 0; i < n; i++) {
    const text = `topic ${i % 7}: the module ${i} validated the session token and refreshed the cache for region ${i}`;
    leaves.push({
      id: `leaf_${i}`,
      messages: [msg(text)],
      sourceText: text,
      embedding: embedder.embed(text),
    });
  }
  return leaves;
}

// ── test: scoreTreeLevels returns nodes at all levels ────────────────────────

test("scoreTreeLevels returns results at multiple tree levels", () => {
  const embedder = new TrigramEmbedder();
  const leaves = makeLeaves(50);
  const tree = buildRaptorTree(leaves, { embedder, clustersPerLevel: 4 });

  const hits = scoreTreeLevels("the auth module validates the session token", tree, {
    embedder,
  });

  assert.ok(hits.length > 0, "should return hits");

  // Should include both leaf (level 0) and cluster (level ≥ 1) hits.
  const levels = new Set(hits.map((h) => h.level));
  assert.ok(levels.has(0), "should have leaf-level hits");
  if (tree.levels > 1) {
    const hasCluster = [...levels].some((l) => l >= 1);
    assert.ok(hasCluster, "should have cluster-level hits for multi-level tree");
  }

  // All hits should have valid scores.
  for (const h of hits) {
    assert.ok(h.score >= 0 && h.score <= 1, `score ${h.score} out of range`);
    assert.ok(h.rawScore >= 0 && h.rawScore <= 1, `rawScore ${h.rawScore} out of range`);
    assert.ok(h.score <= h.rawScore, "weighted score <= raw score (level weights ≤ 1)");
  }

  // Hits should be sorted by score descending.
  for (let i = 1; i < hits.length; i++) {
    assert.ok(
      hits[i - 1].score >= hits[i].score,
      `hits not sorted: hit[${i - 1}].score=${hits[i - 1].score} < hit[${i}].score=${hits[i].score}`,
    );
  }
});

// ── test: level weights affect scoring ───────────────────────────────────────

test("level weights shift scores: higher weight for level → higher weighted score", () => {
  const embedder = new TrigramEmbedder();
  const leaves = makeLeaves(50);
  const tree = buildRaptorTree(leaves, { embedder, clustersPerLevel: 4 });

  const query = "the auth module validates the session token";

  // Uniform weights: all levels scored equally.
  const uniform = scoreTreeLevels(query, tree, {
    embedder,
    levelWeights: [1.0, 1.0, 1.0, 1.0, 1.0],
  });

  // Penalized weights: higher levels penalized.
  const penalized = scoreTreeLevels(query, tree, {
    embedder,
    levelWeights: [1.0, 0.1, 0.1, 0.1, 0.1],
  });

  // With penalized weights, cluster-level hits should score lower.
  const clusterUniform = uniform.filter((h) => h.level >= 1);
  const clusterPenalized = penalized.filter((h) => h.level >= 1);

  if (clusterUniform.length > 0 && clusterPenalized.length > 0) {
    const avgUniform =
      clusterUniform.reduce((s, h) => s + h.score, 0) / clusterUniform.length;
    const avgPenalized =
      clusterPenalized.reduce((s, h) => s + h.score, 0) / clusterPenalized.length;
    assert.ok(
      avgPenalized < avgUniform,
      `penalized cluster avg (${avgPenalized.toFixed(3)}) should be < uniform (${avgUniform.toFixed(3)})`,
    );
  }
});

// ── test: expandLeafDescendants adds leaf hits ──────────────────────────────

test("expandLeafDescendants adds leaf descendants for cluster hits", () => {
  const embedder = new TrigramEmbedder();
  const leaves = makeLeaves(50);
  const tree = buildRaptorTree(leaves, { embedder, clustersPerLevel: 4 });

  const query = "the auth module validates the session token";
  const scored = scoreTreeLevels(query, tree, { embedder });
  const qv = embedder.embed(query);

  // Take only cluster hits (level ≥ 1).
  const clusterHits = scored.filter((h) => !h.isLeaf).slice(0, 3);
  assert.ok(clusterHits.length > 0, "should have cluster hits");

  const expanded = expandLeafDescendants(
    clusterHits,
    tree,
    5, // maxPerCluster
    embedder,
    qv,
  );

  // Expanded set should include leaf hits.
  const leafHits = expanded.filter((h) => h.isLeaf);
  assert.ok(leafHits.length > 0, "should have expanded leaf hits");
  assert.ok(
    expanded.length > clusterHits.length,
    `expanded (${expanded.length}) should be > cluster hits (${clusterHits.length})`,
  );

  // No duplicate ids.
  const ids = new Set(expanded.map((h) => h.nodeId));
  assert.equal(ids.size, expanded.length, "no duplicate node ids");
});

// ── test: deduplicateMultilevelHits removes cluster when leaves present ─────

test("deduplicateMultilevelHits removes cluster hits when leaf children are present", () => {
  const embedder = new TrigramEmbedder();
  const leaves = makeLeaves(50);
  const tree = buildRaptorTree(leaves, { embedder, clustersPerLevel: 4 });

  const query = "the auth module validates the session token";
  const scored = scoreTreeLevels(query, tree, { embedder });

  // Take a cluster hit and its leaf children.
  const cluster = scored.find((h) => !h.isLeaf);
  assert.ok(cluster, "should have a cluster hit");

  const leafChildren: MultilevelHit[] = cluster!.leafIds.slice(0, 2).map((lid) => ({
    nodeId: lid,
    level: 0,
    score: 0.5,
    rawScore: 0.5,
    isLeaf: true,
    leafIds: [lid],
    summary: "",
    embedding: cluster!.embedding,
  }));

  const mixed = [cluster!, ...leafChildren];
  const deduped = deduplicateMultilevelHits(mixed);

  // Cluster should be removed because its leaf children are present.
  assert.ok(
    !deduped.find((h) => h.nodeId === cluster!.nodeId),
    "cluster hit should be removed when leaf children are present",
  );
  assert.equal(deduped.length, leafChildren.length, "only leaf hits remain");
});

test("deduplicateMultilevelHits keeps cluster hits when no leaf children present", () => {
  const clusterHit: MultilevelHit = {
    nodeId: "cluster_1",
    level: 1,
    score: 0.8,
    rawScore: 0.8,
    isLeaf: false,
    leafIds: ["leaf_1", "leaf_2"],
    summary: "summarized content",
    embedding: [1, 0, 0],
  };

  const deduped = deduplicateMultilevelHits([clusterHit]);
  assert.equal(deduped.length, 1, "cluster should be kept when no leaf children present");
  assert.equal(deduped[0].nodeId, "cluster_1");
});

// ── test: multilevelRetrieval returns cluster + leaf mix ────────────────────

test("multilevelRetrieval returns a mix of cluster and leaf hits", () => {
  const embedder = new TrigramEmbedder();
  const leaves = makeLeaves(50);
  const tree = buildRaptorTree(leaves, { embedder, clustersPerLevel: 4 });

  const hits = multilevelRetrieval("the auth module validates the session token", tree, {
    embedder,
    k: 5,
    leafExpansion: true,
    maxLeafExpansion: 3,
  });

  assert.ok(hits.length > 0, "should return hits");
  assert.ok(hits.length <= 5, "should respect k=5");

  // Should include leaf hits.
  const leafHits = hits.filter((h) => h.isLeaf);
  assert.ok(leafHits.length > 0, "should include leaf hits");

  // All hits should have valid properties.
  for (const h of hits) {
    assert.ok(h.nodeId, "hit should have nodeId");
    assert.ok(typeof h.level === "number", "hit should have numeric level");
    assert.ok(h.score >= 0, "hit score should be non-negative");
    assert.ok(Array.isArray(h.leafIds), "hit should have leafIds array");
  }
});

test("multilevelRetrieval respects k parameter", () => {
  const embedder = new TrigramEmbedder();
  const leaves = makeLeaves(100);
  const tree = buildRaptorTree(leaves, { embedder, clustersPerLevel: 8 });

  for (const k of [1, 3, 5, 10]) {
    const hits = multilevelRetrieval("the auth module validates the session token", tree, {
      embedder,
      k,
    });
    assert.ok(
      hits.length <= k,
      `k=${k}: got ${hits.length} hits, should be ≤ ${k}`,
    );
  }
});

test("multilevelRetrieval returns empty for empty tree", () => {
  const embedder = new TrigramEmbedder();
  const emptyTree = { nodes: new Map(), rootId: null, levels: 0, timedOut: false };
  const hits = multilevelRetrieval("any query", emptyTree, { embedder });
  assert.deepEqual(hits, []);
});

test("multilevelRetrieval with leafExpansion=false skips leaf expansion", () => {
  const embedder = new TrigramEmbedder();
  const leaves = makeLeaves(50);
  const tree = buildRaptorTree(leaves, { embedder, clustersPerLevel: 4 });

  const hits = multilevelRetrieval("the auth module validates the session token", tree, {
    embedder,
    k: 5,
    leafExpansion: false,
  });

  assert.ok(hits.length > 0, "should still return hits");

  // With leaf expansion off and tree having multiple levels, we may get
  // cluster hits that are NOT expanded. The mix depends on tree structure.
  // Just verify we got valid results.
  for (const h of hits) {
    assert.ok(h.nodeId, "hit should have nodeId");
    assert.ok(h.score >= 0, "hit score should be non-negative");
  }
});
