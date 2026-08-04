/**
 * heal/proof.test.ts — VC6A proof verifier unit tests.
 *
 * Drives `verifyProof` / `selectHealMode` against the REAL reconstruct module.
 * The verifier REPLAYS reductions against the conservative oracle; it does not
 * trust the proof. Pure, no mocks, no storage, no network.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ClosureGraph, ClosureResult } from "../reconstruct/types.js";
import { closeSelection } from "../reconstruct/closure.js";
import { optimizeClosure } from "./closure-opt.js";
import { verifyProof, selectHealMode, legacyFallback } from "./proof.js";

function node(id: string, anchor = false): ClosureGraph["nodes"][number] {
  return { id, kind: "synthetic", tokenEstimate: 1, ...(anchor ? { anchor: true } : {}) };
}
function edge(from: string, to: string, kind: "depends" | "tool-pair" | "contradicts" = "depends"): ClosureGraph["edges"][number] {
  return { from, to, kind };
}

function setup(graph: ClosureGraph, seeds: string[]): { graph: ClosureGraph; conservative: ClosureResult; proof: ReturnType<typeof optimizeClosure> } {
  const conservative = closeSelection({ graph, seeds });
  return { graph, conservative, proof: optimizeClosure({ graph, conservative }) };
}

describe("VC6A proof: valid proof verifies", () => {
  it("a genuine optimized proof verifies cleanly (mode A)", () => {
    const graph: ClosureGraph = {
      sessionId: "s",
      nodes: [node("a"), node("b"), node("c")],
      edges: [edge("a", "b"), edge("b", "c"), edge("a", "c")],
    };
    const { conservative, proof } = setup(graph, ["c"]);
    const v = verifyProof(proof, conservative, graph);
    assert.equal(v.ok, true);
    const outcome = selectHealMode(proof, conservative, graph);
    assert.equal(outcome.mode, "A");
    assert.deepEqual([...outcome.selected].sort(), [...conservative.selected].sort());
  });

  it("verification is idempotent (replay twice yields same verdict)", () => {
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
    const { conservative, proof } = setup(graph, ["e"]);
    assert.deepEqual(verifyProof(proof, conservative, graph), verifyProof(proof, conservative, graph));
  });
});

describe("VC6A proof: selected-set divergence", () => {
  it("returns HEAL_PROOF_SET_MISMATCH when a selected node is dropped", () => {
    const graph: ClosureGraph = {
      sessionId: "s",
      nodes: [node("a"), node("b"), node("c")],
      edges: [edge("a", "b"), edge("b", "c")],
    };
    const { conservative, proof } = setup(graph, ["c"]);
    const tampered = { ...proof, selected: proof.selected.filter((id) => id !== "a") };
    const v = verifyProof(tampered, conservative, graph);
    assert.equal(v.ok, false);
    assert.ok(v.codes.includes("HEAL_PROOF_SET_MISMATCH"));
    // Falls back to mode B (conservative).
    const outcome = selectHealMode(tampered, conservative, graph);
    assert.equal(outcome.mode, "B");
    assert.deepEqual([...outcome.selected].sort(), [...conservative.selected].sort());
  });
});

describe("VC6A proof: incomplete proof (dropped row)", () => {
  it("returns HEAL_PROOF_INCOMPLETE when a considered-edge row is omitted", () => {
    const graph: ClosureGraph = {
      sessionId: "s",
      nodes: [node("a"), node("b"), node("c")],
      edges: [edge("a", "b"), edge("b", "c"), edge("a", "c")],
    };
    const { conservative, proof } = setup(graph, ["c"]);
    const tampered = { ...proof, rows: proof.rows.slice(0, proof.rows.length - 1) };
    const v = verifyProof(tampered, conservative, graph);
    assert.equal(v.ok, false);
    assert.ok(v.codes.includes("HEAL_PROOF_INCOMPLETE"));
  });
});

describe("VC6A proof: tampered witness", () => {
  it("returns HEAL_PROOF_WITNESS_INVALID when a removal's via is dropped", () => {
    const graph: ClosureGraph = {
      sessionId: "s",
      nodes: [node("a"), node("b"), node("c")],
      edges: [edge("a", "b"), edge("b", "c"), edge("a", "c")],
    };
    const { conservative, proof } = setup(graph, ["c"]);
    // Strip the `via` off the removal row.
    const tampered = {
      ...proof,
      rows: proof.rows.map((r) => (r.decision === "removed" ? { ...r, via: undefined } : r)),
    };
    const v = verifyProof(tampered, conservative, graph);
    assert.equal(v.ok, false);
    assert.ok(v.codes.includes("HEAL_PROOF_WITNESS_INVALID"));
  });

  it("returns HEAL_PROOF_WITNESS_INVALID when a retained edge is forced removed with no detour", () => {
    // Bare chain a->b->c (seed c): neither edge has an alternate path. Forcing
    // a->b to "removed" with a non-existent witness yields no valid detour.
    const graph: ClosureGraph = {
      sessionId: "s",
      nodes: [node("a"), node("b"), node("c")],
      edges: [edge("a", "b"), edge("b", "c")],
    };
    const { conservative, proof } = setup(graph, ["c"]);
    const tampered = {
      ...proof,
      rows: proof.rows.map((r) =>
        r.from === "a" && r.to === "b" ? { ...r, decision: "removed" as const, via: "z" } : r,
      ),
    };
    const v = verifyProof(tampered, conservative, graph);
    assert.equal(v.ok, false);
    assert.ok(v.codes.includes("HEAL_PROOF_WITNESS_INVALID"));
  });
});

describe("VC6A proof: protected-removed tamper", () => {
  it("returns HEAL_PROOF_PROTECTED_REMOVED if a tool-pair edge is marked removed", () => {
    // call->result is a tool-pair; call->mid->result gives it a real detour so the
    // witness check passes and the tamper is caught at the protection layer.
    const graph: ClosureGraph = {
      sessionId: "s",
      nodes: [node("call"), node("result"), node("mid")],
      edges: [edge("call", "result", "tool-pair"), edge("call", "mid"), edge("mid", "result")],
    };
    const { conservative, proof } = setup(graph, ["result"]);
    const tampered = {
      ...proof,
      rows: proof.rows.map((r) =>
        r.kind === "tool-pair" ? { ...r, decision: "removed" as const, via: "mid" } : r,
      ),
    };
    const v = verifyProof(tampered, conservative, graph);
    assert.equal(v.ok, false);
    assert.ok(v.codes.includes("HEAL_PROOF_PROTECTED_REMOVED"));
  });

  it("returns HEAL_PROOF_PROTECTED_REMOVED if an anchor edge is marked removed", () => {
    // anchor->b with anchor->mid->b detour; the anchor edge is protected even
    // though the detour exists, and the verifier must see the graph to know it.
    const graph: ClosureGraph = {
      sessionId: "s",
      nodes: [node("anchor", true), node("b"), node("mid")],
      edges: [edge("anchor", "b"), edge("anchor", "mid"), edge("mid", "b")],
    };
    const { conservative, proof } = setup(graph, ["b"]);
    const tampered = {
      ...proof,
      rows: proof.rows.map((r) =>
        r.from === "anchor" && r.to === "b" && r.kind === "depends"
          ? { ...r, decision: "removed" as const, via: "mid" }
          : r,
      ),
    };
    const v = verifyProof(tampered, conservative, graph);
    assert.equal(v.ok, false);
    assert.ok(v.codes.includes("HEAL_PROOF_PROTECTED_REMOVED"));
  });
});

describe("VC6A proof: legacy fallback (mode C)", () => {
  it("legacyFallback states semantic loss and routes to mode C", () => {
    const graph: ClosureGraph = {
      sessionId: "s",
      nodes: [node("a"), node("b")],
      edges: [edge("a", "b")],
    };
    const conservative = closeSelection({ graph, seeds: ["b"] });
    const outcome = legacyFallback(conservative, "HEAL_CLOSURE_REJECTED");
    assert.equal(outcome.mode, "C");
    assert.equal(outcome.semanticLossStated, true);
    assert.ok(outcome.codes.includes("HEAL_CLOSURE_REJECTED"));
  });
});
