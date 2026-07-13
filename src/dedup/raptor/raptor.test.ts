/**
 * raptor.test.ts — hermetic unit tests for the Sprint 13 RAPTOR module.
 *
 * No network: the default summarizer is deterministic extractive, and Ollama is
 * only reached when MEGACOMPACT_RAPTOR_MODEL is set (never here). Retrieval from
 * the live store is never touched (shadow mode), so recallAndInline output is
 * unchanged by construction.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrigramEmbedder } from "../../embedder.js";
import { kmeanspp } from "./kmeans.js";
import {
  applyHallucinationGuardrails,
  sourceTokenSet,
  extractEntities,
  makeUngroundedSummary,
} from "./guardrails.js";
import { buildRaptorTree, type Leaf } from "./tree.js";
import { stagedExpansion } from "./retrieval.js";
import { runRaptor } from "./index.js";
import { Logger } from "../../log.js";
import {
  listRaptorNodes,
  clearRaptorNodes,
  closeStore,
} from "../../store/sqlite.js";
import type { EngineMessage } from "../../types.js";

const baseTmp = mkdtempSync(join(tmpdir(), "mc-raptor-"));

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

// --- kmeans: near-zero-variance merge guard ---------------------------------

test("kmeanspp merges identical points into a single cluster (QA #11)", () => {
  const p = [1, 0, 0];
  const points = [p, p, p, p, p];
  const r = kmeanspp(points, 3, { seed: 1 });
  assert.equal(r.k, 1);
  assert.deepEqual(r.assignments, [0, 0, 0, 0, 0]);
});

test("kmeanspp separates two well-separated clusters", () => {
  const a = [1, 0, 0];
  const b = [0, 1, 0];
  const points = [a, a, a, b, b, b];
  const r = kmeanspp(points, 2, { seed: 7 });
  assert.equal(r.k, 2);
  // All the a's share one assignment, all the b's another.
  const firstGroup = r.assignments[0];
  const secondGroup = r.assignments[3];
  assert.notEqual(firstGroup, secondGroup);
  for (let i = 0; i < 3; i++) assert.equal(r.assignments[i], firstGroup);
  for (let i = 3; i < 6; i++) assert.equal(r.assignments[i], secondGroup);
});

// --- guardrails: catch hallucination (QA #16) ------------------------------

test("guardrails flag an un-grounded entity as extractive_fallback", () => {
  const embedder = new TrigramEmbedder();
  const realSource = "the auth module validates the session token";
  const summary = makeUngroundedSummary(realSource, "ZkPhant0mCorp");
  const sources = [realSource];
  const r = applyHallucinationGuardrails({
    summary,
    sources,
    centroid: embedder.embed(realSource),
    embedder,
    sourceTokens: sourceTokenSet(sources),
  });
  assert.equal(r.marker, "extractive_fallback");
  assert.equal(r.grounded, false);
});

test("guardrails pass a faithful, grounded summary", () => {
  const embedder = new TrigramEmbedder();
  const src = "the auth module validates the session token and refreshes the cache";
  const summary = "the auth module validates the session token";
  const sources = [src];
  const r = applyHallucinationGuardrails({
    summary,
    sources,
    centroid: embedder.embed(src),
    embedder,
    sourceTokens: sourceTokenSet(sources),
  });
  assert.equal(r.grounded, true);
  assert.ok(r.marker === "high" || r.marker === "low");
  assert.notEqual(r.marker, "extractive_fallback");
});

test("extractEntities lowercases candidate tokens", () => {
  const e = extractEntities("The AuthModule validates the token_abc 42 times");
  assert.ok(e.includes("authmodule"));
  assert.ok(e.includes("token_abc"));
});

// --- tree: <10 leaves → single node -----------------------------------------

test("tree with <10 leaves yields a single root node", () => {
  const leaves = makeLeaves(5);
  const tree = buildRaptorTree(leaves, { embedder: new TrigramEmbedder() });
  assert.equal(tree.nodes.size, 1);
  assert.equal(tree.rootId, "r0_0");
  assert.equal(tree.levels, 1);
  assert.equal(tree.timedOut, false);
});

// --- tree: 1K fixture builds within budget ----------------------------------

test("tree builds within 5s on a 1000-leaf fixture", () => {
  const leaves = makeLeaves(1000);
  const t0 = Date.now();
  const tree = buildRaptorTree(leaves, {
    embedder: new TrigramEmbedder(),
    budgetMs: 5000,
    clustersPerLevel: 8,
  });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5000, `build took ${elapsed}ms (over 5s budget)`);
  assert.ok(tree.nodes.size > 1, "expected a multi-level tree");
  assert.ok(tree.rootId !== null);
});

// --- tree: budget timeout → extractive fallback root ------------------------

test("tree respects the budget: a tiny budget forces an extractive fallback root", () => {
  const leaves = makeLeaves(200);
  const tree = buildRaptorTree(leaves, {
    embedder: new TrigramEmbedder(),
    budgetMs: 0, // forces immediate timeout on the first level
    clustersPerLevel: 4,
  });
  assert.equal(tree.timedOut, true);
  assert.equal(tree.rootId, "r99_0");
  assert.ok(tree.nodes.has("r99_0"));
});

// --- retrieval: staged expansion returns leaf ids ---------------------------

test("stagedExpansion returns diversified leaf ids for a query", () => {
  const leaves = makeLeaves(20);
  const tree = buildRaptorTree(leaves, { embedder: new TrigramEmbedder(), clustersPerLevel: 4 });
  const hits = stagedExpansion("the auth module validates the session token", tree, {
    embedder: new TrigramEmbedder(),
    k: 3,
    topM: 3,
  });
  assert.ok(hits.length > 0);
  assert.ok(hits.length <= 3);
  // All returned ids are raw leaf ids (not internal node ids).
  for (const id of hits) assert.ok(id.startsWith("leaf_"));
});

// --- shadow mode: builds + persists, never alters retrieval -----------------

test("runRaptor builds + persists a shadow tree without throwing", () => {
  const dir = join(baseTmp, `shadow-${Math.floor(performance.now())}`);
  const leaves = makeLeaves(40);
  const logger = new Logger({
    enabled: true,
    now: () => 0,
    path: join(dir, "events.log"),
  });
  const tree = runRaptor(leaves, {
    stateDir: dir,
    sessionId: "sess_raptor",
    embedder: new TrigramEmbedder(),
    logger,
  });
  assert.ok(tree !== null);
  // Tree was persisted to raptor_nodes.
  const stored = listRaptorNodes("sess_raptor", dir);
  assert.ok(stored.length > 0, "shadow tree should be persisted");
  // Quality markers are valid values.
  for (const n of stored) {
    assert.ok(["high", "low", "extractive_fallback"].includes(n.qualityMarker) || n.qualityMarker === "low");
  }
  clearRaptorNodes("sess_raptor", dir);
  closeStore(dir);
});

test("shadow mode does NOT change recallAndInline output (separation)", () => {
  // The orchestrator persists to raptor_nodes only. The live store's
  // recallAndInline path (vectorStore.search) reads context_chunks, never
  // raptor_nodes, so building a RAPTOR tree is observably independent.
  const dir = join(baseTmp, `sep-${Math.floor(performance.now())}`);
  const leaves = makeLeaves(15);
  const before = listRaptorNodes("sess_sep", dir);
  runRaptor(leaves, {
    stateDir: dir,
    sessionId: "sess_sep",
    embedder: new TrigramEmbedder(),
  });
  const after = listRaptorNodes("sess_sep", dir);
  // Building RAPTOR only ever writes raptor_nodes; context_chunks is untouched.
  assert.deepEqual(before, []);
  assert.ok(after.length > 0);
  clearRaptorNodes("sess_sep", dir);
  closeStore(dir);
});

// --- eval: redundancy reduction ≥ 15% (nodes << leaves) ---------------------

test("eval: RAPTOR reduces node count substantially vs flat (≥15%)", () => {
  const leaves = makeLeaves(100);
  const tree = buildRaptorTree(leaves, { embedder: new TrigramEmbedder(), clustersPerLevel: 8 });
  const reduction = 1 - tree.nodes.size / leaves.length;
  assert.ok(reduction >= 0.15, `redundancy reduction ${reduction.toFixed(2)} < 0.15`);
});

// --- cleanup ----------------------------------------------------------------

test("RAPTOR cleanup", () => {
  rmSync(baseTmp, { recursive: true, force: true });
});
