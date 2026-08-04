/**
 * heal/closure-opt.test.ts — VC6A optimizer unit tests.
 *
 * Drives `optimizeClosure` (deterministic transitive reduction over the
 * already-mandatory VC4C closure) against the REAL reconstruct module. Pure,
 * no mocks, no storage, no network.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ClosureGraph } from "../reconstruct/types.js";
import { closeSelection } from "../reconstruct/closure.js";
import { optimizeClosure, traversalSavings, restoreHints } from "./closure-opt.js";

function node(id: string, anchor = false): ClosureGraph["nodes"][number] {
  return { id, kind: "synthetic", tokenEstimate: 1, ...(anchor ? { anchor: true } : {}) };
}
function edge(from: string, to: string, kind: "depends" | "tool-pair" | "contradicts" = "depends"): ClosureGraph["edges"][number] {
  return { from, to, kind };
}

function run(graph: ClosureGraph, seeds: string[]) {
  const conservative = closeSelection({ graph, seeds });
  assert.ok(conservative.selected.length > 0, "closure should select something");
  const proof = optimizeClosure({ graph, conservative });
  return { conservative, proof };
}

describe("VC6A closure-opt: selected set is unchanged", () => {
  it("never edits the closed selection (flag-invariant)", () => {
    const graph: ClosureGraph = {
      sessionId: "s",
      nodes: [node("a"), node("b"), node("c")],
      edges: [edge("a", "b"), edge("b", "c"), edge("a", "c")],
    };
    const { conservative, proof } = run(graph, ["c"]);
    assert.deepEqual([...proof.selected].sort(), [...conservative.selected].sort());
  });

  it("optimizes the same selected set across id orderings (deterministic)", () => {
    const mk = (ordered: boolean): ClosureGraph => {
      const ids = ordered ? ["a", "b", "c", "d"] : ["d", "b", "a", "c"];
      return {
        sessionId: "s",
        nodes: ids.map((id) => node(id)),
        edges: [
          edge("a", "b"),
          edge("b", "c"),
          edge("c", "d"),
          edge("a", "c"),
          edge("a", "d"),
          edge("b", "d"),
        ],
      };
    };
    const p1 = run(mk(true), ["d"]).proof;
    const p2 = run(mk(false), ["d"]).proof;
    assert.deepEqual(p1.rows, p2.rows);
    assert.deepEqual(p1.removedEdges, p2.removedEdges);
    assert.deepEqual(p1.retainedEdges, p2.retainedEdges);
  });
});

describe("VC6A closure-opt: transitive reduction", () => {
  it("removes a->c when a->b->c exists (HEAL-REDUCE-001)", () => {
    const graph: ClosureGraph = {
      sessionId: "s",
      nodes: [node("a"), node("b"), node("c")],
      edges: [edge("a", "b"), edge("b", "c"), edge("a", "c")],
    };
    const { proof } = run(graph, ["c"]);
    const removed = proof.removedEdges.map((e) => `${e.from}->${e.to}`);
    assert.ok(removed.includes("a->c"), "a->c should be removed");
    assert.equal(proof.removedEdges.length, 1);
    assert.equal(proof.retainedEdges.length, 2);
    // The removed row carries a witness.
    const row = proof.rows.find((r) => r.decision === "removed");
    assert.equal(row?.via, "b");
  });

  it("removes every shortcut in a long chain (HEAL-012)", () => {
    const graph: ClosureGraph = {
      sessionId: "s",
      nodes: [node("a"), node("b"), node("c"), node("d"), node("e")],
      edges: [
        edge("a", "b"),
        edge("b", "c"),
        edge("c", "d"),
        edge("d", "e"),
        edge("a", "c"),
        edge("a", "d"),
        edge("b", "d"),
      ],
    };
    const { proof } = run(graph, ["e"]);
    assert.equal(proof.removedEdges.length, 3);
    assert.equal(proof.retainedEdges.length, 4);
  });

  it("keeps a non-transitive tree's edges (no false removal)", () => {
    // c depends on b and d; b depends on a. No edge is implied by another, so the
    // reduction retains all three (contrast with HEAL-003 where adding the a->c
    // shortcut makes the triangle reducible).
    const graph: ClosureGraph = {
      sessionId: "s",
      nodes: [node("a"), node("b"), node("c"), node("d")],
      edges: [edge("b", "c"), edge("d", "c"), edge("a", "b")],
    };
    const { proof } = run(graph, ["c"]);
    assert.equal(proof.removedEdges.length, 0, "no edge is transitively implied");
    assert.equal(proof.retainedEdges.length, 3);
  });
});

describe("VC6A closure-opt: protected edges are never removed", () => {
  it("retains a tool-pair edge despite an alternate path (HEAL-PROTECT-002)", () => {
    const graph: ClosureGraph = {
      sessionId: "s",
      nodes: [node("call"), node("result"), node("pre")],
      edges: [edge("call", "result", "tool-pair"), edge("pre", "call"), edge("pre", "result")],
    };
    const { proof } = run(graph, ["result"]);
    const removed = proof.removedEdges;
    const toolPairRemoved = removed.some((e) => e.kind === "tool-pair");
    assert.equal(toolPairRemoved, false, "tool-pair edge must survive");
    const tpRow = proof.rows.find((r) => r.kind === "tool-pair");
    assert.equal(tpRow?.decision, "retained");
    assert.equal(tpRow?.reason, "tool-pair");
  });

  it("retains an anchor-touching edge despite an alternate path", () => {
    const graph: ClosureGraph = {
      sessionId: "s",
      nodes: [node("a"), node("b", true), node("c")],
      edges: [edge("a", "b"), edge("c", "b"), edge("a", "c")],
    };
    const { proof } = run(graph, ["b", "c"]);
    const anchorEdges = proof.rows.filter((r) => r.reason === "anchor");
    assert.equal(anchorEdges.length, 2, "both anchor-touching edges retained");
    assert.equal(proof.removedEdges.length, 0);
  });

  it("retains a contradicts edge", () => {
    // a is seeded; x is pulled (a depends on x) and y is a seeded contradiction.
    const graph: ClosureGraph = {
      sessionId: "s",
      nodes: [node("a"), node("x"), node("y")],
      edges: [edge("x", "a"), edge("y", "a", "contradicts")],
    };
    const { proof } = run(graph, ["a", "y"]);
    const contra = proof.rows.find((r) => r.kind === "contradicts");
    assert.equal(contra?.decision, "retained");
    assert.equal(contra?.reason, "contradiction");
  });

  it("retains a sole dependency edge even when a sibling path reaches the node", () => {
    const graph: ClosureGraph = {
      sessionId: "s",
      nodes: [node("a"), node("b"), node("c")],
      edges: [edge("a", "b"), edge("c", "a")],
    };
    const { proof } = run(graph, ["b", "c"]);
    // Both edges into `a` are sole (the only edge from their dependent) → both kept.
    assert.equal(proof.removedEdges.length, 0);
    const sole = proof.rows.filter((r) => r.reason === "sole-dependency");
    assert.equal(sole.length, 2);
  });
});

describe("VC6A closure-opt: metrics + restore hints", () => {
  it("traversalSavings is in [0,1] and zero for a minimal graph", () => {
    const graph: ClosureGraph = {
      sessionId: "s",
      nodes: [node("a"), node("b")],
      edges: [edge("a", "b")],
    };
    const { proof } = run(graph, ["b"]);
    assert.equal(traversalSavings(proof), 0);
  });

  it("traversalSavings is positive when an edge is removed", () => {
    const graph: ClosureGraph = {
      sessionId: "s",
      nodes: [node("a"), node("b"), node("c")],
      edges: [edge("a", "b"), edge("b", "c"), edge("a", "c")],
    };
    const { proof } = run(graph, ["c"]);
    assert.ok(traversalSavings(proof) > 0);
    assert.equal(proof.optimizedTraversals, proof.retainedEdges.length);
  });

  it("restoreHints are reader-only identity (no source bytes)", () => {
    const graph: ClosureGraph = {
      sessionId: "s",
      nodes: [node("a"), node("b"), node("c")],
      edges: [edge("a", "b"), edge("b", "c"), edge("a", "c")],
    };
    const { conservative, proof } = run(graph, ["c"]);
    const hints = restoreHints(proof, graph);
    assert.equal(hints.length, conservative.selected.length);
    for (const h of hints) {
      assert.ok(typeof h.nodeId === "string");
      assert.ok(["anchor", "tool-pair", "contradiction", "sole-dependency", "no-alternate-path"].includes(h.reason));
    }
  });
});
