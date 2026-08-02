/**
 * source-matrix.test.ts — Source-matrix tests (real SQLite stores) + flag-OFF parity.
 * Split from src/memoryGraph-gates.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { buildMemoryGraph } from "../memoryGraph.js";
import { tmpDir, populateStore, withEnv } from "./_helpers.js";

test("Source-matrix: all flags OFF → checkpoint-only graph", () => {
  const dir = tmpDir();
  populateStore(dir, "sess_test", { checkpoint: true, turn: true, turnContent: true, memory: true });
  withEnv(
    {
      MEGACOMPACT_MEMORY_GRAPH_SEED_TURNS: "false",
      MEGACOMPACT_MEMORY_GRAPH_SEED_TURN_CONTENT: "false",
      MEGACOMPACT_MEMORY_GRAPH_SEED_MEMORIES: "false",
      MEGACOMPACT_DB_MIRROR: "false",
    },
    () => {
      const graph = buildMemoryGraph("sess_test", dir);
      assert.equal(graph.validation.sources.checkpoint, 2, "should have 2 checkpoint sources");
      assert.equal(graph.validation.sources.turn, 0, "should have 0 turn sources");
      assert.equal(graph.validation.sources.turnContent, 0, "should have 0 turn-content sources");
      assert.equal(graph.validation.sources.memory, 0, "should have 0 memory sources");
      for (const node of graph.nodes) {
        assert.equal(node.nodeType, "checkpoint", "all nodes should be checkpoint type");
      }
    },
  );
});

test("Source-matrix: SEED_TURNS ON → checkpoint + turn", () => {
  const dir = tmpDir();
  populateStore(dir, "sess_test", { checkpoint: true, turn: true, turnContent: false, memory: false });
  withEnv(
    {
      MEGACOMPACT_MEMORY_GRAPH_SEED_TURNS: "true",
      MEGACOMPACT_MEMORY_GRAPH_SEED_TURN_CONTENT: "false",
      MEGACOMPACT_MEMORY_GRAPH_SEED_MEMORIES: "false",
      MEGACOMPACT_DB_MIRROR: "false",
    },
    () => {
      const graph = buildMemoryGraph("sess_test", dir);
      assert.ok(graph.validation.sources.checkpoint >= 2, "should have checkpoint sources");
      assert.ok(graph.validation.sources.turn >= 2, "should have turn sources");
      assert.equal(graph.validation.sources.turnContent, 0, "should have 0 turn-content sources");
      assert.equal(graph.validation.sources.memory, 0, "should have 0 memory sources");
    },
  );
});

test("Source-matrix: SEED_TURN_CONTENT + DB_MIRROR ON → +turn-content", () => {
  const dir = tmpDir();
  populateStore(dir, "sess_test", { checkpoint: true, turn: true, turnContent: true, memory: false });
  withEnv(
    {
      MEGACOMPACT_MEMORY_GRAPH_SEED_TURNS: "true",
      MEGACOMPACT_MEMORY_GRAPH_SEED_TURN_CONTENT: "true",
      MEGACOMPACT_MEMORY_GRAPH_SEED_MEMORIES: "false",
      MEGACOMPACT_DB_MIRROR: "true",
    },
    () => {
      const graph = buildMemoryGraph("sess_test", dir);
      assert.ok(graph.validation.sources.checkpoint >= 2, "should have checkpoint sources");
      assert.ok(
        graph.validation.sources.turn + graph.validation.sources.turnContent >= 2,
        "should have turn or turn-content sources (merged)",
      );
      assert.ok(graph.validation.sources.turnContent >= 2, "should have turn-content sources (richest after merge)");
      assert.equal(graph.validation.sources.memory, 0, "should have 0 memory sources");
    },
  );
});

test("Source-matrix: all three seed flags ON → +memory", () => {
  const dir = tmpDir();
  populateStore(dir, "sess_test", { checkpoint: true, turn: true, turnContent: true, memory: true });
  withEnv(
    {
      MEGACOMPACT_MEMORY_GRAPH_SEED_TURNS: "true",
      MEGACOMPACT_MEMORY_GRAPH_SEED_TURN_CONTENT: "true",
      MEGACOMPACT_MEMORY_GRAPH_SEED_MEMORIES: "true",
      MEGACOMPACT_DB_MIRROR: "true",
    },
    () => {
      const graph = buildMemoryGraph("sess_test", dir);
      assert.ok(graph.validation.sources.memory >= 2, "should have memory sources");
      assert.ok(graph.validation.sources.checkpoint >= 2, "should have checkpoint sources");
      assert.ok(
        graph.validation.sources.turn + graph.validation.sources.turnContent >= 2,
        "should have turn or turn-content sources (merged)",
      );
      assert.ok(graph.validation.sources.turnContent >= 2, "should have turn-content sources (richest after merge)");
    },
  );
});

test("Flag-OFF parity: all seed flags OFF produces checkpoint-only graph", () => {
  const dir = tmpDir();
  populateStore(dir, "sess_test", { checkpoint: true, turn: true, turnContent: true, memory: true });
  withEnv(
    {
      MEGACOMPACT_MEMORY_GRAPH_SEED_TURNS: "false",
      MEGACOMPACT_MEMORY_GRAPH_SEED_TURN_CONTENT: "false",
      MEGACOMPACT_MEMORY_GRAPH_SEED_MEMORIES: "false",
      MEGACOMPACT_DB_MIRROR: "false",
    },
    () => {
      const graph = buildMemoryGraph("sess_test", dir);
      assert.ok(graph.nodes.length > 0, "graph should have nodes");
      for (const node of graph.nodes) {
        assert.equal(node.nodeType, "checkpoint", "all nodes must be checkpoint type");
      }
      assert.equal(
        graph.metadata.nodeTypeBreakdown?.["checkpoint"] ?? 0,
        graph.nodes.filter((nnode) => nnode.nodeType === "checkpoint").length,
        "nodeTypeBreakdown should only count checkpoints",
      );
      assert.equal(graph.validation.sources.checkpoint, graph.nodes.length);
      assert.equal(graph.validation.sources.turn, 0);
      assert.equal(graph.validation.sources.turnContent, 0);
      assert.equal(graph.validation.sources.memory, 0);
    },
  );
});
