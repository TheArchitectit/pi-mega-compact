/**
 * buildHistory.test.ts — S42D RAPTOR build history + freshness tests.
 *
 * No network. Real stores with temp state dirs.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../store/sqlite/utils.js";
import {
  insertBuildHistory,
  getLatestBuild,
  listBuildHistory,
  computeCoherenceScore,
  isRaptorTreeFresh,
  clearBuildHistory,
} from "./buildHistory.js";
import { runRaptor } from "./index.js";
import { VectorStore, vectorList } from "../../vectorStore.js";
import { compactSession } from "../../engine.js";
import { loadDedupConfig } from "../../config/dedup.js";
import { normalizeSessionId } from "../../store.js";
import { Logger } from "../../log.js";
import type { RaptorTree } from "./tree.js";
import type { DedupConfigShape } from "../../config/dedup.js";
import type { EngineMessage } from "../../types.js";

let tmpDir: string;
let counter = 0;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mc-bh-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function stateDir(): string {
  return join(tmpDir, `run-${counter++}`);
}

function cfg(overrides?: Record<string, unknown>): DedupConfigShape {
  return {
    ...loadDedupConfig(),
    RAPTOR_ENABLED: true,
    L0_ENABLED: false,
    L1_ENABLED: false,
    L2_ENABLED: false,
    ...overrides,
  };
}

function msg(text: string, toolName?: string): EngineMessage {
  return toolName
    ? { role: "assistant", text, toolName, input: text, output: text }
    : { role: "user", text };
}

// ─── 1. Build-history rows are created with correct metadata ──────────────

test("S42D-1: insertBuildHistory + getLatestBuild round-trip", () => {
  const sd = stateDir();
  openStore(sd); // initialize schema
  const ts = Date.now();
  const id = insertBuildHistory(
    {
      sessionId: "sess-foo",
      stateDir: sd,
      startedAt: ts - 500,
      completedAt: ts,
      nodeCount: 6,
      leafCount: 10,
      depth: 3,
      configJson: '{"budgetMs":5000}',
      coherenceScore: 0.82,
      timedOut: false,
    },
    sd,
  );
  assert.ok(id, "build id returned");
  const latest = getLatestBuild("sess-foo", sd);
  assert.ok(latest, "latest build found");
  assert.equal(latest!.sessionId, normalizeSessionId("sess-foo"));
  assert.equal(latest!.nodeCount, 6);
  assert.equal(latest!.leafCount, 10);
  assert.equal(latest!.depth, 3);
  assert.equal(latest!.coherenceScore, 0.82);
  assert.equal(latest!.timedOut, false);
  assert.equal(latest!.configJson, '{"budgetMs":5000}');
  // getLatest returns the newest by completed_at
  insertBuildHistory(
    {
      sessionId: "sess-foo",
      stateDir: sd,
      startedAt: ts + 1000,
      completedAt: ts + 2000,
      nodeCount: 7,
      leafCount: 11,
      depth: 3,
      configJson: "{}",
      coherenceScore: null,
      timedOut: true,
    },
    sd,
  );
  const newest = getLatestBuild("sess-foo", sd);
  assert.equal(newest!.nodeCount, 7);
  assert.equal(newest!.timedOut, true);
  assert.equal(newest!.coherenceScore, null);
  // listBuildHistory returns all, newest first
  const all = listBuildHistory("sess-foo", sd);
  assert.equal(all.length, 2);
  assert.equal(all[0].nodeCount, 7); // newest first
  // No history for an unknown session
  assert.equal(getLatestBuild("sess-none", sd), null);
  assert.deepEqual(listBuildHistory("sess-none", sd), []);
  // clearBuildHistory removes rows
  clearBuildHistory("sess-foo", sd);
  assert.equal(getLatestBuild("sess-foo", sd), null);
});

// ─── 2. Coherence score: 1.0 for identical, lower for diverse ───────────────

test("S42D-2: computeCoherenceScore is 1.0 for identical embeddings, lower for diverse", () => {
  const identical: RaptorTree = {
    rootId: "root",
    nodes: new Map([
      ["root", { id: "root", level: 0, parentId: null, children: ["c1", "c2"], summary: "r", embedding: [1, 0], qualityMarker: "low", tokenEstimate: 2 }],
      ["c1", { id: "c1", level: 1, parentId: "root", children: [], summary: "c1", embedding: [1, 0], qualityMarker: "low", tokenEstimate: 1 }],
      ["c2", { id: "c2", level: 1, parentId: "root", children: [], summary: "c2", embedding: [1, 0], qualityMarker: "low", tokenEstimate: 1 }],
    ]),
    levels: 2,
    timedOut: false,
  };
  assert.equal(computeCoherenceScore(identical), 1.0);
  // Diverse: orthogonal children → cosine 0
  const diverse: RaptorTree = {
    rootId: "root",
    nodes: new Map([
      ["root", { id: "root", level: 0, parentId: null, children: ["c1", "c2"], summary: "r", embedding: [1, 0], qualityMarker: "low", tokenEstimate: 2 }],
      ["c1", { id: "c1", level: 1, parentId: "root", children: [], summary: "c1", embedding: [1, 0], qualityMarker: "low", tokenEstimate: 1 }],
      ["c2", { id: "c2", level: 1, parentId: "root", children: [], summary: "c2", embedding: [0, 1], qualityMarker: "low", tokenEstimate: 1 }],
    ]),
    levels: 2,
    timedOut: false,
  };
  const diverseScore = computeCoherenceScore(diverse);
  assert.ok(diverseScore < 1.0, `diverse score < 1.0 (got ${diverseScore})`);
  assert.ok(diverseScore >= 0, "score is non-negative");
  // No internal nodes with >=2 children → 0
  const single: RaptorTree = {
    rootId: "root",
    nodes: new Map([
      ["root", { id: "root", level: 0, parentId: null, children: ["c1"], summary: "r", embedding: [1, 0], qualityMarker: "low", tokenEstimate: 1 }],
      ["c1", { id: "c1", level: 1, parentId: "root", children: [], summary: "c1", embedding: [1, 0], qualityMarker: "low", tokenEstimate: 1 }],
    ]),
    levels: 2,
    timedOut: false,
  };
  assert.equal(computeCoherenceScore(single), 0);
});

// ─── 2b. Coherence with leaf embeddings (the real-tree shape) ──────────────

test("S42D-2b: computeCoherenceScore uses leafEmbeddings for leaf children (real-tree shape)", () => {
  // Root whose children are raw leaves (the common collapse-path shape).
  // Without leafEmbeddings, leaves fall back to the root centroid → score 1.0
  // (degenerate). With true leaf embeddings, diverse leaves score < 1.0.
  const tree: RaptorTree = {
    rootId: "root",
    nodes: new Map([
      ["root", { id: "root", level: 0, parentId: null, children: ["l1", "l2"], summary: "r", embedding: [1, 0], qualityMarker: "low", tokenEstimate: 2 }],
    ]),
    levels: 1,
    timedOut: false,
  };
  // No leaf map → both leaves use root centroid [1,0] → cosine 1.0 (degenerate).
  assert.equal(computeCoherenceScore(tree), 1.0);
  // Leaf map with orthogonal leaves → cosine 0 (truly diverse).
  const leafMap = new Map([
    ["l1", [1, 0]],
    ["l2", [0, 1]],
  ]);
  const score = computeCoherenceScore(tree, leafMap);
  assert.ok(score < 1.0, `diverse leaves score < 1.0 (got ${score})`);
  assert.ok(score >= 0, "score non-negative");
  // Identical leaves via the map → 1.0
  const leafMapIdentical = new Map([
    ["l1", [1, 0]],
    ["l2", [1, 0]],
  ]);
  assert.equal(computeCoherenceScore(tree, leafMapIdentical), 1.0);
});

// ─── 3. Freshness check: recent + stable → fresh ────────────────────────────

test("S42D-3: isRaptorTreeFresh true for recent build + stable count", () => {
  const sd = stateDir();
  openStore(sd);
  insertBuildHistory(
    {
      sessionId: "sess-fresh",
      stateDir: sd,
      startedAt: Date.now() - 1000,
      completedAt: Date.now() - 500, // < 4h old
      nodeCount: 6,
      leafCount: 10,
      depth: 3,
      configJson: "{}",
      coherenceScore: 0.5,
      timedOut: false,
    },
    sd,
  );
  // 10 checkpoints, latest had 10 → within 20% → fresh
  assert.equal(isRaptorTreeFresh("sess-fresh", sd, 4, 10), true);
  // 11 checkpoints → 10% change → still fresh
  assert.equal(isRaptorTreeFresh("sess-fresh", sd, 4, 11), true);
  // 9 checkpoints → 10% change → fresh
  assert.equal(isRaptorTreeFresh("sess-fresh", sd, 4, 9), true);
});

// ─── 4. Freshness check: stale build → not fresh ────────────────────────────

test("S42D-4: isRaptorTreeFresh false for stale build (>4h old)", () => {
  const sd = stateDir();
  openStore(sd);
  const oldTs = Date.now() - 5 * 3_600_000; // 5h ago
  insertBuildHistory(
    {
      sessionId: "sess-stale",
      stateDir: sd,
      startedAt: oldTs - 1000,
      completedAt: oldTs,
      nodeCount: 6,
      leafCount: 10,
      depth: 3,
      configJson: "{}",
      coherenceScore: 0.5,
      timedOut: false,
    },
    sd,
  );
  assert.equal(isRaptorTreeFresh("sess-stale", sd, 4, 10), false);
});

// ─── 5. Freshness check: count drift > 20% → not fresh ──────────────────────

test("S42D-5: isRaptorTreeFresh false when checkpoint count changed by >20%", () => {
  const sd = stateDir();
  openStore(sd);
  insertBuildHistory(
    {
      sessionId: "sess-drift",
      stateDir: sd,
      startedAt: Date.now() - 1000,
      completedAt: Date.now() - 500,
      nodeCount: 6,
      leafCount: 10,
      depth: 3,
      configJson: "{}",
      coherenceScore: 0.5,
      timedOut: false,
    },
    sd,
  );
  // 13 checkpoints vs 10 → 30% increase → not fresh
  assert.equal(isRaptorTreeFresh("sess-drift", sd, 4, 13), false);
  // 7 checkpoints vs 10 → 30% decrease → not fresh
  assert.equal(isRaptorTreeFresh("sess-drift", sd, 4, 7), false);
});

// ─── 6. No build history → freshness false (forces build) ───────────────────

test("S42D-6: isRaptorTreeFresh false when no build history exists", () => {
  const sd = stateDir();
  openStore(sd);
  assert.equal(isRaptorTreeFresh("sess-none", sd, 4, 50), false);
  // freshnessHours=0 always false (disables the gate → always rebuild)
  insertBuildHistory(
    {
      sessionId: "sess-zero",
      stateDir: sd,
      startedAt: Date.now() - 100,
      completedAt: Date.now() - 50,
      nodeCount: 1,
      leafCount: 5,
      depth: 1,
      configJson: "{}",
      coherenceScore: 0.5,
      timedOut: false,
    },
    sd,
  );
  assert.equal(isRaptorTreeFresh("sess-zero", sd, 0, 5), false);
});

// ─── 7. runRaptor records build history end-to-end ──────────────────────────

test("S42D-7: runRaptor records a build-history row on real build", () => {
  const sd = stateDir();
  const s = new VectorStore({ dedupSim: 0.9, stateDir: sd, config: cfg() });
  const sid = "bh-e2e";
  // Seed 12 checkpoints and build a tree.
  for (let i = 1; i <= 12; i++) {
    compactSession(
      {
        sessionId: sid,
        messages: [
          msg(`build-history test checkpoint ${i} alpha beta`),
          msg(`ack ${i}`, "Edit"),
       	],
        keepFrom: 2,
        timestamp: i + 1,
      },
      s,
    );
  }
  const nsid = normalizeSessionId(sid);
  const all = vectorList(s, nsid);
  const leaves = all.map((cp) => ({
    id: cp.checkpointId,
    messages: [],
    sourceText: cp.normalizedText ?? cp.summary ?? cp.regionHash,
    embedding: cp.embedding,
  }));
  const tree = runRaptor(leaves, {
    stateDir: sd,
    sessionId: nsid,
    logger: new Logger(),
  });
  assert.ok(tree, "tree built");
  const latest = getLatestBuild(nsid, sd);
  assert.ok(latest, "build history recorded by runRaptor");
  assert.equal(latest!.leafCount, leaves.length);
  assert.equal(latest!.depth, tree!.levels);
  assert.equal(latest!.timedOut, tree!.timedOut);
  assert.equal(latest!.nodeCount, tree!.nodes.size);
  assert.ok(
    latest!.coherenceScore !== null && latest!.coherenceScore >= 0,
    "coherence score recorded",
  );
  // The freshness gate should now report fresh for the same checkpoint count.
  assert.equal(
    isRaptorTreeFresh(nsid, sd, 4, all.length),
    true,
    "tree is fresh immediately after build",
  );
});
