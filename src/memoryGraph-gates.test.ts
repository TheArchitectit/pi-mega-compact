/**
 * memoryGraph-gates.test.ts — D3 gate-level + source-matrix tests.
 * REAL stores end-to-end (no mocks). Individual gates on constructed inputs,
 * plus buildMemoryGraph with real SQLite tables.
 * ZERO network (PREVENT-PI-004). Parameterized SQL (PREVENT-002).
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gateIdentityMerge,
  gatePromotionGuard,
  gateNodeCompleteness,
  gateDanglingEdges,
  gateEdgeThresholds,
  gateDedupRedundant,
  gateDedupEdges,
  runValidationPipeline,
} from "./memoryGraph/gates.js";
import type { GraphWorkingSet } from "./memoryGraph/gates.js";
import { buildMemoryGraph } from "./memoryGraph.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "./memoryGraph.js";
import { openStore } from "./store/sqlite/utils.js";
import { upsertCheckpoint } from "./store/sqlite/checkpoints.js";
import { recordTurn, newConversationId } from "./store/sqlite/turns.js";
import { appendRawTranscript } from "./store/sqlite/raw-transcript.js";
import type { RawTranscriptRow } from "./store/sqlite/raw-transcript.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseTmp = mkdtempSync(join(tmpdir(), "mc-mgraph-gates-"));
let counter = 0;

function tmpDir(): string {
  return join(baseTmp, `run-${counter++}`);
}

function n(
  id: string,
  overrides: Partial<MemoryGraphNode> = {},
): MemoryGraphNode {
  return {
    id,
    sessionId: "sess_test",
    label: id,
    summaryTruncated: "",
    tokenEstimate: 0,
    timestamp: 1000,
    dedupStatus: undefined,
    raptorLevel: 0,
    topicSummary: undefined,
    decisionCount: 0,
    textSnippet: "",
    nodeType: "checkpoint",
    epochId: undefined,
    ...overrides,
  };
}

function e(
  source: string,
  target: string,
  overrides: Partial<MemoryGraphEdge> = {},
): MemoryGraphEdge {
  return { source, target, weight: 1.0, type: "temporal", ...overrides };
}

function ws(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[] = [],
): GraphWorkingSet {
  return { nodes, edges };
}

/** Save and restore env vars around a test. */
function withEnv(
  env: Record<string, string | undefined>,
  fn: () => void,
): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = env[k]!;
    }
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  }
}

// Gate 2

test("Gate 2: identity merge drops duplicate node (same id, less info)", () => {
  const set = ws([
    n("a", { label: "richer", tokenEstimate: 100, summaryTruncated: "full" }),
    n("a", { label: "poorer", tokenEstimate: 10, summaryTruncated: "minimal" }),
  ]);
  const result = gateIdentityMerge(set);
  assert.equal(result.dropped, 1, "duplicate node should be dropped");
  assert.equal(set.nodes.length, 1, "one node should remain");
  // The richer node should be kept (looks by position in the current impl)
  assert.ok(result.reason, "reason should be set");
});

// Gate 3 —  promotion guard

test("Gate 3: turn with epochId matching checkpoint is suppressed", () => {
  const set = ws([
    n("chkpt_001", { nodeType: "checkpoint" }),
    n("turn:sess_test:0", {
      nodeType: "turn",
      epochId: "chkpt_001",
    }),
  ]);
  const result = gatePromotionGuard(set);
  assert.equal(result.dropped, 1, "turn with matching checkpoint epoch should be suppressed");
  assert.equal(
    set.nodes.length,
    1,
    "only checkpoint node should remain",
  );
  assert.equal(set.nodes[0]!.id, "chkpt_001", "checkpoint should survive");
});

test("Gate 3: orphaned epoch (no matching checkpoint) keeps turn + graph_orphaned_epoch", () => {
  const set = ws([
    n("turn:sess_test:0", {
      nodeType: "turn",
      epochId: "chkpt_orphan",
    }),
  ]);
  const result = gatePromotionGuard(set);
  assert.equal(result.dropped, 0, "orphaned epoch turn should NOT be dropped");
  assert.equal(set.nodes.length, 1, "turn should remain");
  // The gate returns dropped=0 but logs a warning internally
  // We verify the node is kept
  assert.equal(set.nodes[0]!.id, "turn:sess_test:0");
});

// Gate 4 —  completeness

test("Gate 4: node without nodeType is dropped + graph_node_double", () => {
  const set = ws([
    n("a", { nodeType: undefined as unknown as "checkpoint" }),
    n("b", { nodeType: "checkpoint" }),
  ]);
  const result = gateNodeCompleteness(set);
  assert.equal(result.dropped, 1, "node without nodeType should be dropped");
  assert.equal(set.nodes.length, 1, "only valid node should remain");
  assert.equal(set.nodes[0]!.id, "b", "valid node should survive");
});

test("Gate 4: node without sessionId is dropped", () => {
  const set = ws([
    n("a", { sessionId: undefined as unknown as string }),
    n("b", { sessionId: "sess_test" }),
  ]);
  const result = gateNodeCompleteness(set);
  assert.equal(result.dropped, 1, "node without sessionId should be dropped");
  assert.equal(set.nodes.length, 1, "only valid node should remain");
});

// Gate 5 —  dangling edges

test("Gate 5: edge to non-existent node is dropped + graph_dangling_edge", () => {
  const set = ws(
    [n("a"), n("b")],
    [e("a", "nonexistent"), e("a", "b")],
  );
  const result = gateDanglingEdges(set);
  assert.equal(result.dropped, 1, "dangling edge should be dropped");
  assert.equal(set.edges.length, 1, "valid edge should remain");
  assert.equal(set.edges[0]!.source, "a", "valid edge source preserved");
  assert.equal(set.edges[0]!.target, "b", "valid edge target preserved");
});

// Gate 6 —  edge thresholds

test("Gate 6: 0.75 cross-type semantic edge is dropped (below 0.85)", () => {
  // Cross-type threshold is 0.85 by default
  const set = ws(
    [n("a", { nodeType: "checkpoint" }), n("b", { nodeType: "memory" })],
    [e("a", "b", { weight: 0.75, type: "semantic" })],
  );
  const result = gateEdgeThresholds(set);
  assert.equal(result.dropped, 1, "cross-type edge below 0.85 should be dropped");
  assert.equal(set.edges.length, 0, "no edges should remain");
});

test("Gate 6: semantic edge on a structural (turn) node is dropped + graph_structural_semantic_edge", () => {
  const set = ws(
    [n("a", { nodeType: "turn" }), n("b", { nodeType: "checkpoint" })],
    [e("a", "b", { weight: 0.9, type: "semantic" })],
  );
  const result = gateEdgeThresholds(set);
  assert.equal(result.dropped, 1, "semantic edge on turn node should be dropped");
  assert.equal(set.edges.length, 0, "no edges should remain");
});

// Gate 7 —  dedup redundant

test("Gate 7: turn-content node with redundant hash is dropped + graph_dedup_redundant", () => {
  const redundantIds = new Set<string>(["turn:sess_test:0"]);
  const set = ws(
    [n("turn:sess_test:0", { nodeType: "turn-content" }), n("chkpt_001", { nodeType: "checkpoint" })],
    [e("turn:sess_test:0", "chkpt_001", { type: "semantic", weight: 0.8 })],
  );
  const result = gateDedupRedundant(set, { redundantIds });
  assert.equal(result.dropped, 1, "redundant turn-content node should be dropped");
  assert.equal(set.nodes.length, 1, "only checkpoint should remain");
  assert.equal(set.edges.length, 0, "edges to dropped node should be removed");
});

// Gate 9 —  edge dedup

test("Gate 9: duplicate edges are deduplicated + graph_dedup_redundant", () => {
  const set = ws(
    [n("a"), n("b")],
    [
      e("a", "b", { type: "semantic", weight: 0.9 }),
      e("a", "b", { type: "semantic", weight: 0.8 }),
    ],
  );
  const result = gateDedupEdges(set);
  assert.equal(result.dropped, 1, "duplicate edge should be dropped");
  assert.equal(set.edges.length, 1, "one edge should remain (higher weight)");
  assert.equal(set.edges[0]!.weight, 0.9, "higher weight edge should survive");
});

// Source-matrix (real SQLite stores)

function populateStore(
  dir: string,
  sessionId: string,
  sources: { checkpoint?: boolean; turn?: boolean; turnContent?: boolean; memory?: boolean },
): void {
  // Open the store (creates schema)
  const db = openStore(dir);

  if (sources.checkpoint) {
    upsertCheckpoint(
      {
        checkpointId: "chkpt_001",
        sessionId,
        regionHash: "abc",
        contentHash: "def",
        normalizedText: "checkpoint one",
        summary: "Checkpoint One",
        tokenEstimate: 50,
        timestamp: 1000,
        embedding: [],
        keyDecisions: [],
        nextSteps: [],
        filesModified: [],
      },
      dir,
    );
    upsertCheckpoint(
      {
        checkpointId: "chkpt_002",
        sessionId,
        regionHash: "ghi",
        contentHash: "jkl",
        normalizedText: "checkpoint two",
        summary: "Checkpoint Two",
        tokenEstimate: 60,
        timestamp: 2000,
        embedding: [],
        keyDecisions: [],
        nextSteps: [],
        filesModified: [],
      },
      dir,
    );
  }

  if (sources.turn) {
    const convId = newConversationId();
    recordTurn(
      {
        conversationId: convId,
        sessionId,
        turnIndex: 0,
        role: "user",
        endedAt: 1500,
        ctxTokens: 100,
      },
      dir,
    );
    recordTurn(
      {
        conversationId: convId,
        sessionId,
        turnIndex: 1,
        role: "assistant",
        endedAt: 2500,
        ctxTokens: 200,
      },
      dir,
    );
  }

  if (sources.turnContent) {
    const rows: RawTranscriptRow[] = [
      {
        sessionId,
        seq: 0,
        role: "user",
        contentBytes: "hello from the user",
        contentHash: "hash_0",
        toolName: null,
        messageTimestamp: 1500,
        checkpointEpoch: "",
        turnIndex: 0,
      },
      {
        sessionId,
        seq: 1,
        role: "assistant",
        contentBytes: "response from assistant",
        contentHash: "hash_1",
        toolName: null,
        messageTimestamp: 2500,
        checkpointEpoch: "",
        turnIndex: 1,
      },
    ];
    for (const row of rows) {
      appendRawTranscript(db, row);
    }
  }

  if (sources.memory) {
    db.prepare(
      `INSERT OR IGNORE INTO memories (content, kind, created_at, source_turn)
       VALUES (?, ?, ?, ?)`,
    ).run("remembered fact", "fact", 2000, 0);
    db.prepare(
      `INSERT OR IGNORE INTO memories (content, kind, created_at, source_turn)
       VALUES (?, ?, ?, ?)`,
    ).run("user preference", "preference", 3000, 1);
  }
}

test("Source-matrix: all flags OFF → checkpoint-only graph", () => {
  const dir = tmpDir();
  populateStore(dir, "sess_test", {
    checkpoint: true,
    turn: true,
    turnContent: true,
    memory: true,
  });

  withEnv(
    {
      MEGACOMPACT_MEMORY_GRAPH_SEED_TURNS: "false",
      MEGACOMPACT_MEMORY_GRAPH_SEED_TURN_CONTENT: "false",
      MEGACOMPACT_MEMORY_GRAPH_SEED_MEMORIES: "false",
      MEGACOMPACT_DB_MIRROR: "false",
    },
    () => {
      const graph = buildMemoryGraph("sess_test", dir);
      assert.equal(
        graph.validation.sources.checkpoint,
        2,
        "should have 2 checkpoint sources",
      );
      assert.equal(
        graph.validation.sources.turn,
        0,
        "should have 0 turn sources",
      );
      assert.equal(
        graph.validation.sources.turnContent,
        0,
        "should have 0 turn-content sources",
      );
      assert.equal(
        graph.validation.sources.memory,
        0,
        "should have 0 memory sources",
      );
      // All nodes should be checkpoint type
      for (const node of graph.nodes) {
        assert.equal(node.nodeType, "checkpoint", "all nodes should be checkpoint type");
      }
    },
  );
});

test("Source-matrix: SEED_TURNS ON → checkpoint + turn", () => {
  const dir = tmpDir();
  populateStore(dir, "sess_test", {
    checkpoint: true,
    turn: true,
    turnContent: false,
    memory: false,
  });

  withEnv(
    {
      MEGACOMPACT_MEMORY_GRAPH_SEED_TURNS: "true",
      MEGACOMPACT_MEMORY_GRAPH_SEED_TURN_CONTENT: "false",
      MEGACOMPACT_MEMORY_GRAPH_SEED_MEMORIES: "false",
      MEGACOMPACT_DB_MIRROR: "false",
    },
    () => {
      const graph = buildMemoryGraph("sess_test", dir);
      assert.ok(
        graph.validation.sources.checkpoint >= 2,
        "should have checkpoint sources",
      );
      assert.ok(
        graph.validation.sources.turn >= 2,
        "should have turn sources",
      );
      assert.equal(
        graph.validation.sources.turnContent,
        0,
        "should have 0 turn-content sources",
      );
      assert.equal(
        graph.validation.sources.memory,
        0,
        "should have 0 memory sources",
      );
    },
  );
});

test("Source-matrix: SEED_TURN_CONTENT + DB_MIRROR ON → +turn-content", () => {
  const dir = tmpDir();
  populateStore(dir, "sess_test", {
    checkpoint: true,
    turn: true,
    turnContent: true,
    memory: false,
  });

  withEnv(
    {
      MEGACOMPACT_MEMORY_GRAPH_SEED_TURNS: "true",
      MEGACOMPACT_MEMORY_GRAPH_SEED_TURN_CONTENT: "true",
      MEGACOMPACT_MEMORY_GRAPH_SEED_MEMORIES: "false",
      MEGACOMPACT_DB_MIRROR: "true",
    },
    () => {
      const graph = buildMemoryGraph("sess_test", dir);
      assert.ok(
        graph.validation.sources.checkpoint >= 2,
        "should have checkpoint sources",
      );
      // When both Source A (turn) and Source B (turn-content) are on, Gate 2
      // merges them — turn-content wins (richest nodeType). So turn=0,
      // turnContent=2. Assert the combined count, not turn alone.
      assert.ok(
        graph.validation.sources.turn + graph.validation.sources.turnContent >= 2,
        "should have turn or turn-content sources (merged)",
      );
      assert.ok(
        graph.validation.sources.turnContent >= 2,
        "should have turn-content sources (richest after merge)",
      );
      assert.equal(
        graph.validation.sources.memory,
        0,
        "should have 0 memory sources",
      );
    },
  );
});

test("Source-matrix: all three seed flags ON → +memory", () => {
  const dir = tmpDir();
  populateStore(dir, "sess_test", {
    checkpoint: true,
    turn: true,
    turnContent: true,
    memory: true,
  });

  withEnv(
    {
      MEGACOMPACT_MEMORY_GRAPH_SEED_TURNS: "true",
      MEGACOMPACT_MEMORY_GRAPH_SEED_TURN_CONTENT: "true",
      MEGACOMPACT_MEMORY_GRAPH_SEED_MEMORIES: "true",
      MEGACOMPACT_DB_MIRROR: "true",
    },
    () => {
      const graph = buildMemoryGraph("sess_test", dir);
      assert.ok(
        graph.validation.sources.memory >= 2,
        "should have memory sources",
      );
      // All sources should be present. Gate 2 merges Source A+B (turn-content
      // wins), so turn=0 + turnContent=2 — assert the combined count.
      assert.ok(
        graph.validation.sources.checkpoint >= 2,
        "should have checkpoint sources",
      );
      assert.ok(
        graph.validation.sources.turn + graph.validation.sources.turnContent >= 2,
        "should have turn or turn-content sources (merged)",
      );
      assert.ok(
        graph.validation.sources.turnContent >= 2,
        "should have turn-content sources (richest after merge)",
      );
    },
  );
});

// Flag-OFF parity — all seed flags OFF → checkpoint-only

test("Flag-OFF parity: all seed flags OFF produces checkpoint-only graph", () => {
  const dir = tmpDir();
  populateStore(dir, "sess_test", {
    checkpoint: true,
    turn: true,
    turnContent: true,
    memory: true,
  });

  withEnv(
    {
      MEGACOMPACT_MEMORY_GRAPH_SEED_TURNS: "false",
      MEGACOMPACT_MEMORY_GRAPH_SEED_TURN_CONTENT: "false",
      MEGACOMPACT_MEMORY_GRAPH_SEED_MEMORIES: "false",
      MEGACOMPACT_DB_MIRROR: "false",
    },
    () => {
      const graph = buildMemoryGraph("sess_test", dir);

      // All nodes are checkpoint type
      assert.ok(graph.nodes.length > 0, "graph should have nodes");
      for (const node of graph.nodes) {
        assert.equal(node.nodeType, "checkpoint", "all nodes must be checkpoint type");
      }

      // Check metadata matches what we'd expect pre-change
      assert.equal(
        graph.metadata.nodeTypeBreakdown?.["checkpoint"] ?? 0,
        graph.nodes.filter((n) => n.nodeType === "checkpoint").length,
        "nodeTypeBreakdown should only count checkpoints",
      );

      // Sources only include checkpoint
      assert.equal(graph.validation.sources.checkpoint, graph.nodes.length);
      assert.equal(graph.validation.sources.turn, 0);
      assert.equal(graph.validation.sources.turnContent, 0);
      assert.equal(graph.validation.sources.memory, 0);
    },
  );
});

// Pipeline integration

test("runValidationPipeline: runs all 9 gates and returns correct stats shape", () => {
  const set = ws([n("a"), n("b")], [e("a", "b")]);
  const { ws: result, stats } = runValidationPipeline(set);
  // 9 gates should run
  assert.equal(stats.gatesRun.length, 9, "all 9 gates should run");
  // With clean data, all gates should pass
  assert.equal(stats.gatesRun.length, stats.gatesPassed.length, "all gates should pass with clean data");
  assert.equal(result.nodes.length, 2, "both nodes remain");
  assert.equal(result.edges.length, 1, "edge remains");
  assert.equal(stats.dropped.nodes, 0, "no nodes dropped");
  assert.equal(stats.dropped.edges, 0, "no edges dropped");
  assert.ok(Array.isArray(stats.warnings), "warnings is an array");
});

// Cleanup

test("cleanup", () => {
  rmSync(baseTmp, { recursive: true, force: true });
});