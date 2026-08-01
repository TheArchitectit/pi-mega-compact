/**
 * incremental.test.ts — tests for the incremental RAPTOR tree update (Sprint 26, #7).
 *
 * Real stores, real embedder. No mocks.
 * - buildTree → add N leaves → incrementally update → verify new leaves covered,
 *   old leaves preserved.
 * - Fallback: no existing tree → incremental returns null (=full rebuild fallback).
 * - Early-out: no new leaves → returns existing tree unmodified.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrigramEmbedder } from "../../embedder.js";
import { buildRaptorTree, type Leaf, type RaptorTree } from "./tree.js";
import { incrementRaptorTree } from "./incremental.js";
import { runRaptor } from "./index.js";
import { Logger } from "../../log.js";
import {
  saveRaptorTree,
  listRaptorNodes,
  clearRaptorNodes,
  closeStore,
} from "../../store/sqlite.js";
import type { EngineMessage } from "../../types.js";

// Reuse test helpers from raptor.test.ts style.
const baseTmp = mkdtempSync(join(tmpdir(), "mc-incr-"));
const embedder = new TrigramEmbedder();

function msg(text: string): EngineMessage {
  return { role: "user", text };
}

function makeLeaves(n: number, offset = 0): Leaf[] {
  const leaves: Leaf[] = [];
  for (let i = 0; i < n; i++) {
    const idx = offset + i;
    const text = `topic ${idx % 5}: service ${idx} checks the auth token and refreshes the upstream cache`;
    leaves.push({
      id: `leaf_${idx}`,
      messages: [msg(text)],
      sourceText: text,
      embedding: embedder.embed(text),
    });
  }
  return leaves;
}

function coveredLeafIds(tree: RaptorTree): Set<string> {
  const ids = new Set<string>();
  for (const n of tree.nodes.values()) {
    for (const c of n.children) ids.add(c);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Scaffolding helpers
// ---------------------------------------------------------------------------

let stateDir: string;
let sessionId: string;

test.beforeEach(() => {
  stateDir = mkdtempSync(join(baseTmp, "test-"));
  sessionId = "incremental-test-session";
  // Ensure empty state to start.
  clearRaptorNodes(sessionId, stateDir);
});

test.afterEach(() => {
  try {
    closeStore(stateDir);
  } catch {
    // OK: store may already be closed.
  }
  try {
    rmSync(stateDir, { recursive: true, force: true });
  } catch {
    // Windows / permission races.
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("incremental adds new leaves to existing tree and preserves old ones", () => {
  // 1. Build initial tree with 8 leaves.
  const leaves = makeLeaves(8);
  const tree = buildRaptorTree(leaves, {
    embedder,
    clustersPerLevel: 3,
  });
  assert.ok(tree, "initial tree must not be null");
  assert.ok(tree.nodes.size > 0, "initial tree must have nodes");
  saveRaptorTree(sessionId, tree, Date.now(), stateDir);

  const initialCovered = coveredLeafIds(tree);
  assert.equal(initialCovered.size, 8, "all 8 leaves must be covered");

  // 2. Create 4 new leaves (offset=10 so ids don't collide).
  const newLeaves = makeLeaves(4, 10);

  // 3. Run incremental update.
  const updated = incrementRaptorTree(leaves, newLeaves, {
    embedder,
    stateDir,
    sessionId,
  });

  assert.ok(updated, "incremental update must return a tree");
  assert.ok(updated.nodes.size >= tree.nodes.size, "node count must not decrease");

  const updatedCovered = coveredLeafIds(updated);

  // Old leaves must still be covered.
  for (const id of initialCovered) {
    assert.ok(
      updatedCovered.has(id),
      `old leaf ${id} must still be covered after incremental update`,
    );
  }

  // New leaves must now be covered.
  for (const l of newLeaves) {
    assert.ok(
      updatedCovered.has(l.id),
      `new leaf ${l.id} must be covered after incremental update`,
    );
  }

  // Verify persistence: read back from store.
  const stored = listRaptorNodes(sessionId, stateDir);
  assert.ok(stored.length >= tree.nodes.size, "stored node count must not decrease");
});

test("incremental returns null when tree is empty (fallback)", () => {
  const leaves = makeLeaves(4);
  const newLeaves = makeLeaves(2, 10);

  // No tree persisted → incremental should return null.
  const result = incrementRaptorTree(leaves, newLeaves, {
    embedder,
    stateDir,
    sessionId,
  });

  assert.equal(result, null, "must return null when no existing tree");
});

test("incremental returns existing tree when no new leaves", () => {
  const leaves = makeLeaves(6);
  const tree = buildRaptorTree(leaves, { embedder, clustersPerLevel: 3 });
  saveRaptorTree(sessionId, tree, Date.now(), stateDir);

  // Pass same leaves as both existing and new → no truly new leaves.
  const result = incrementRaptorTree(leaves, leaves, {
    embedder,
    stateDir,
    sessionId,
  });

  assert.ok(result, "must return a tree when no new leaves");
  const covered = coveredLeafIds(result);
  assert.equal(covered.size, 6, "all 6 existing leaves must be covered");
});

test("incremental does not break when all leaves are already covered (empty new set)", () => {
  const leaves = makeLeaves(5);
  const tree = buildRaptorTree(leaves, { embedder, clustersPerLevel: 2 });
  saveRaptorTree(sessionId, tree, Date.now(), stateDir);

  // Existing leaves = all leaves, new leaves = empty.
  const result = incrementRaptorTree(leaves, [], {
    embedder,
    stateDir,
    sessionId,
  });

  assert.ok(result, "must return tree when new set is empty");
  assert.ok(result.nodes.size > 0, "returned tree must have nodes");
});

test("full rebuild fallback via runRaptor when incremental of null", () => {
  // runRaptor with MEGACOMPACT_RAPTOR_INCREMENTAL=1 but no existing tree
  // should build the tree from scratch.
  const leaves = makeLeaves(6);
  const saved = process.env.MEGACOMPACT_RAPTOR_INCREMENTAL;
  process.env.MEGACOMPACT_RAPTOR_INCREMENTAL = "1";
  try {
    const tree = runRaptor(leaves, {
      embedder,
      stateDir,
      sessionId,
      logger: new Logger({ enabled: false }),
    });
    assert.ok(tree, "runRaptor must build a tree on first call");
    assert.ok(tree.nodes.size > 0, "tree must have nodes");

    // Read back from store.
    const stored = listRaptorNodes(sessionId, stateDir);
    assert.ok(stored.length > 0, "nodes must be persisted");
  } finally {
    if (saved === undefined) {
      delete process.env.MEGACOMPACT_RAPTOR_INCREMENTAL;
    } else {
      process.env.MEGACOMPACT_RAPTOR_INCREMENTAL = saved;
    }
  }
});

test("incremental after full rebuild: second call adds more leaves via incremental", () => {
  // First: build tree via runRaptor (full rebuild).
  const firstLeaves = makeLeaves(6);
  const logger = new Logger({ enabled: false });
  const saved = process.env.MEGACOMPACT_RAPTOR_INCREMENTAL;
  process.env.MEGACOMPACT_RAPTOR_INCREMENTAL = "1";

  try {
    const firstTree = runRaptor(firstLeaves, {
      embedder,
      stateDir,
      sessionId,
      logger,
    });
    assert.ok(firstTree, "first build must succeed");
    assert.ok(firstTree.nodes.size > 0);

    // Second: add 4 new leaves via incremental.
    const moreLeaves = makeLeaves(4, 10);

    const secondTree = incrementRaptorTree(firstLeaves, moreLeaves, {
      embedder,
      stateDir,
      sessionId,
      builtAt: Date.now(),
    });

    assert.ok(secondTree, "second incremental update must succeed");
    const covered = coveredLeafIds(secondTree);
    for (const l of moreLeaves) {
      assert.ok(covered.has(l.id), `new leaf ${l.id} must be covered`);
    }
    for (const l of firstLeaves) {
      assert.ok(covered.has(l.id), `old leaf ${l.id} must still be covered`);
    }
  } finally {
    if (saved === undefined) {
      delete process.env.MEGACOMPACT_RAPTOR_INCREMENTAL;
    } else {
      process.env.MEGACOMPACT_RAPTOR_INCREMENTAL = saved;
    }
  }
});
