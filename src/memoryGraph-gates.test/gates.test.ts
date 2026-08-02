/**
 * gates.test.ts — Gate 2–9 individual gate-level tests on constructed inputs.
 * Split from src/memoryGraph-gates.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  gateIdentityMerge,
  gatePromotionGuard,
  gateNodeCompleteness,
  gateDanglingEdges,
  gateEdgeThresholds,
  gateDedupRedundant,
  gateDedupEdges,
} from "../memoryGraph/gates.js";
import { n, e, ws } from "./_helpers.js";

test("Gate 2: identity merge drops duplicate node (same id, less info)", () => {
  const set = ws([
    n("a", { label: "richer", tokenEstimate: 100, summaryTruncated: "full" }),
    n("a", { label: "poorer", tokenEstimate: 10, summaryTruncated: "minimal" }),
  ]);
  const result = gateIdentityMerge(set);
  assert.equal(result.dropped, 1, "duplicate node should be dropped");
  assert.equal(set.nodes.length, 1, "one node should remain");
  assert.ok(result.reason, "reason should be set");
});

test("Gate 3: turn with epochId matching checkpoint is suppressed", () => {
  const set = ws([
    n("chkpt_001", { nodeType: "checkpoint" }),
    n("turn:sess_test:0", { nodeType: "turn", epochId: "chkpt_001" }),
  ]);
  const result = gatePromotionGuard(set);
  assert.equal(result.dropped, 1, "turn with matching checkpoint epoch should be suppressed");
  assert.equal(set.nodes.length, 1, "only checkpoint node should remain");
  assert.equal(set.nodes[0]!.id, "chkpt_001", "checkpoint should survive");
});

test("Gate 3: orphaned epoch (no matching checkpoint) keeps turn + graph_orphaned_epoch", () => {
  const set = ws([
    n("turn:sess_test:0", { nodeType: "turn", epochId: "chkpt_orphan" }),
  ]);
  const result = gatePromotionGuard(set);
  assert.equal(result.dropped, 0, "orphaned epoch turn should NOT be dropped");
  assert.equal(set.nodes.length, 1, "turn should remain");
  assert.equal(set.nodes[0]!.id, "turn:sess_test:0");
});

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

test("Gate 5: edge to non-existent node is dropped + graph_dangling_edge", () => {
  const set = ws([n("a"), n("b")], [e("a", "nonexistent"), e("a", "b")]);
  const result = gateDanglingEdges(set);
  assert.equal(result.dropped, 1, "dangling edge should be dropped");
  assert.equal(set.edges.length, 1, "valid edge should remain");
  assert.equal(set.edges[0]!.source, "a", "valid edge source preserved");
  assert.equal(set.edges[0]!.target, "b", "valid edge target preserved");
});

test("Gate 6: 0.75 cross-type semantic edge is dropped (below 0.85)", () => {
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
