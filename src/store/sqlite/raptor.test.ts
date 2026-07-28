/**
 * raptor.test.ts — regression tests for RAPTOR node persistence.
 *
 * Covers:
 *   1. saveRaptorTree atomicity (withTx + openStore nesting safety): rebuilding
 *      a DIFFERENT tree for the same session leaves no stale nodes from the
 *      first tree.
 *   2. listRaptorNodes robustness: corrupt `children` JSON in a row does not
 *      throw and that row's children come back as [].
 *
 * No network. Uses node:sqlite directly via openStore.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, closeStore } from "./utils.js";
import { saveRaptorTree, listRaptorNodes, type StoredRaptorNode } from "./raptor.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mc-raptor-persist-"));
});

afterEach(() => {
  closeStore(tmpDir);
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Build a simple tree map with the minimal shape saveRaptorTree expects. */
function makeTree(nodeSpecs: { id: string; level: number; children: string[] }[]) {
  const nodes = new Map();
  for (const spec of nodeSpecs) {
    nodes.set(spec.id, {
      id: spec.id,
      level: spec.level,
      parentId: spec.level === 0 ? null : "root",
      children: spec.children,
      summary: `summary for ${spec.id}`,
      embedding: [1, 0, 0],
      qualityMarker: "low",
      tokenEstimate: 10,
    });
  }
  return { nodes };
}

// ── Test 1: rebuild + save a different tree → no stale nodes ──────────────────

test("saveRaptorTree: rebuilding a different tree for the same session leaves no stale nodes", () => {
  const sid = "sess_replace";
  const builtAt1 = 1000;
  const builtAt2 = 2000;

  // Tree A: nodes alpha, beta, root.
  const treeA = makeTree([
    { id: "alpha", level: 1, children: ["leaf_0", "leaf_1"] },
    { id: "beta", level: 1, children: ["leaf_2", "leaf_3"] },
    { id: "root", level: 2, children: ["leaf_0", "leaf_1", "leaf_2", "leaf_3"] },
  ]);

  saveRaptorTree(sid, treeA, builtAt1, tmpDir);

  const afterA = listRaptorNodes(sid, tmpDir);
  assert.equal(afterA.length, 3, "tree A has 3 nodes");
  assert.deepEqual(
    afterA.map((n) => n.id).sort(),
    ["alpha", "beta", "root"],
    "tree A node ids match",
  );

  // Tree B: completely different nodes gamma, delta, root.
  const treeB = makeTree([
    { id: "gamma", level: 1, children: ["leaf_4", "leaf_5"] },
    { id: "delta", level: 1, children: ["leaf_6", "leaf_7"] },
    { id: "root", level: 2, children: ["leaf_4", "leaf_5", "leaf_6", "leaf_7"] },
  ]);

  saveRaptorTree(sid, treeB, builtAt2, tmpDir);

  const afterB = listRaptorNodes(sid, tmpDir);
  assert.equal(afterB.length, 3, "tree B has 3 nodes (stale A nodes gone)");

  // No stale node ids from tree A survive.
  const idsAfterB = new Set(afterB.map((n) => n.id));
  assert.ok(!idsAfterB.has("alpha"), "stale node alpha is gone");
  assert.ok(!idsAfterB.has("beta"), "stale node beta is gone");
  assert.ok(idsAfterB.has("gamma"), "new node gamma present");
  assert.ok(idsAfterB.has("delta"), "new node delta present");
  assert.ok(idsAfterB.has("root"), "root present (upserted, not duplicated)");

  // builtAt was updated to the new timestamp.
  for (const n of afterB) {
    assert.equal(n.builtAt, builtAt2, `node ${n.id} builtAt updated to tree B timestamp`);
  }
});

// ── Test 2: corrupt children JSON → no throw, children = [] ──────────────────

test("listRaptorNodes: corrupt children JSON does not throw and returns []", () => {
  const sid = "sess_corrupt";
  const builtAt = 5000;

  const tree = makeTree([
    { id: "good", level: 1, children: ["leaf_0", "leaf_1"] },
    { id: "bad", level: 1, children: ["leaf_2", "leaf_3"] },
    { id: "root", level: 2, children: ["leaf_0", "leaf_1", "leaf_2", "leaf_3"] },
  ]);

  saveRaptorTree(sid, tree, builtAt, tmpDir);

  // Corrupt the `children` JSON for the "bad" row directly in SQLite.
  const db = openStore(tmpDir);
  db.prepare(
    "UPDATE raptor_nodes SET children = ? WHERE session_id = ? AND id = ?",
  ).run("{not valid json", sid, "bad");

  // listRaptorNodes must not throw.
  let nodes: StoredRaptorNode[];
  assert.doesNotThrow(() => {
    nodes = listRaptorNodes(sid, tmpDir);
  }, "listRaptorNodes must not throw on corrupt children JSON");

  const badNode = nodes!.find((n) => n.id === "bad");
  assert.ok(badNode, "bad node still present");
  assert.deepEqual(badNode!.children, [], "corrupt children parsed to []");

  // The good node is unaffected.
  const goodNode = nodes!.find((n) => n.id === "good");
  assert.ok(goodNode, "good node present");
  assert.deepEqual(
    goodNode!.children,
    ["leaf_0", "leaf_1"],
    "good node children intact",
  );
});
