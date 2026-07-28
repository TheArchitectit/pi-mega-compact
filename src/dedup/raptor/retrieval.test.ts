/**
 * retrieval.test.ts — unit tests for the reverse-index parent lookup.
 *
 * Verifies that buildChildParentIndex (retrieval.ts) produces the same
 * parent for each leaf as the old linear-scan semantics:
 *   [...tree.nodes.values()].find(n => n.children.includes(lid))
 *
 * Uses a hand-built tree with a known structure so the comparison is
 * deterministic and independent of the tree builder.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChildParentIndex } from "./retrieval.js";
import type { RaptorTree, RaptorNode } from "./tree.js";

/** Build a minimal hand-crafted RaptorTree with 2 levels of internal nodes. */
function handBuiltTree(): RaptorTree {
  // 8 leaves (leaf_0..leaf_7) under 2 level-1 nodes, under 1 root.
  const r1_0: RaptorNode = {
    id: "r1_0",
    level: 1,
    parentId: null, // will be set by builder in production, but not needed here
    children: ["leaf_0", "leaf_1", "leaf_2", "leaf_3"],
    summary: "cluster A",
    embedding: [1, 0, 0],
    qualityMarker: "low",
    tokenEstimate: 10,
  };
  const r1_1: RaptorNode = {
    id: "r1_1",
    level: 1,
    parentId: null,
    children: ["leaf_4", "leaf_5", "leaf_6", "leaf_7"],
    summary: "cluster B",
    embedding: [0, 1, 0],
    qualityMarker: "low",
    tokenEstimate: 10,
  };
  const root: RaptorNode = {
    id: "root",
    level: 2,
    parentId: null,
    children: [
      "leaf_0", "leaf_1", "leaf_2", "leaf_3",
      "leaf_4", "leaf_5", "leaf_6", "leaf_7",
    ],
    summary: "root summary",
    embedding: [0.5, 0.5, 0],
    qualityMarker: "low",
    tokenEstimate: 20,
  };
  const nodes = new Map<string, RaptorNode>([
    ["r1_0", r1_0],
    ["r1_1", r1_1],
    ["root", root],
  ]);
  return { nodes, rootId: "root", levels: 3, timedOut: false };
}

test("buildChildParentIndex: index-derived parent matches linear-scan parent for each leaf", () => {
  const tree = handBuiltTree();
  const leafIds = [
    "leaf_0", "leaf_1", "leaf_2", "leaf_3",
    "leaf_4", "leaf_5", "leaf_6", "leaf_7",
  ];

  const index = buildChildParentIndex(tree);

  for (const lid of leafIds) {
    // Old linear-scan semantics: find the first node whose children include lid.
    const linearParent = [...tree.nodes.values()].find((n) =>
      n.children.includes(lid),
    );

    // Index-derived parent.
    const indexParent = index.get(lid);

    // Both must agree.
    assert.equal(
      indexParent?.id ?? null,
      linearParent?.id ?? null,
      `leaf ${lid}: index parent (${indexParent?.id}) != linear parent (${linearParent?.id})`,
    );
  }
});

test("buildChildParentIndex: first writer wins (no overwrite for shared leaf)", () => {
  // If two internal nodes both list the same leaf id in their children, the
  // index keeps the FIRST one encountered — matching the find() semantics
  // which also returns the first match.
  const r1_0: RaptorNode = {
    id: "r1_0", level: 1, parentId: null,
    children: ["leaf_0", "leaf_1"],
    summary: "A", embedding: [1, 0], qualityMarker: "low", tokenEstimate: 5,
  };
  const r1_1: RaptorNode = {
    id: "r1_1", level: 1, parentId: null,
    children: ["leaf_0", "leaf_2"], // leaf_0 shared with r1_0
    summary: "B", embedding: [0, 1], qualityMarker: "low", tokenEstimate: 5,
  };
  const nodes = new Map<string, RaptorNode>([["r1_0", r1_0], ["r1_1", r1_1]]);
  const tree: RaptorTree = { nodes, rootId: null, levels: 2, timedOut: false };

  const index = buildChildParentIndex(tree);

  // leaf_0 appears in both r1_0 and r1_1. The index and find() both return
  // whichever comes first in iteration order.
  const linearParent = [...tree.nodes.values()].find((n) =>
    n.children.includes("leaf_0"),
  );
  const indexParent = index.get("leaf_0");
  assert.equal(
    indexParent?.id ?? null,
    linearParent?.id ?? null,
    "first-writer wins: index and linear scan agree on shared leaf",
  );
});
