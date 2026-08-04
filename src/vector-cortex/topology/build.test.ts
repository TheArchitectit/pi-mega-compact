/**
 * vector-cortex/topology/build.test.ts — deterministic topology builder tests.
 *
 * Covers the three named VC3B assertions and the core build invariants:
 *   TOP-K-001      seventeenth eligible neighbor is excluded (per source/head cap 16);
 *   TOP-TIE-002    equal scores sort target IDs by unsigned bytes;
 *   TOP-KIND-003   dependency has one direction, contradiction has two.
 * Plus the unique failure injection: one head's NaN rejects only its own edge
 * (TOP_SCORE_NONFINITE) without poisoning other heads (no self-edge/NaN).
 *
 * Real logic, no mocks (no-mock-data/no-stubs memory).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTopology } from "./build.js";
import { graphDigest, buildTopologyGraph } from "./index.js";
import { TOP_K } from "./types.js";
import type { TopologyCandidate } from "./types.js";

function candidates(rows: Array<[string, string, string, number, "dependency" | "contradiction"]>): TopologyCandidate[] {
  return rows.map(([source, target, head, score, kind]) => ({
    source,
    target,
    head,
    score,
    kind,
  }));
}

const BASE = {
  sessionId: "s1",
  sourceHighWater: 5n,
  threshold: 0.3,
};

describe("TOP-K-001: seventeenth eligible neighbor is excluded", () => {
  test("keeps exactly top-k=16 and drops the 17th for one source/head", () => {
    const rows: Array<[string, string, string, number, "dependency" | "contradiction"]> = [];
    // 18 eligible neighbors, all above threshold, scores 1.0..1.0 with distinct targets.
    for (let i = 0; i < 18; i++) {
      rows.push(["src", `t${String(i).padStart(2, "0")}`, "h1", 1.0, "dependency"]);
    }
    const res = buildTopology({ ...BASE, candidates: candidates(rows) });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    const out = res.topology.edges;
    const fromSrc = out.filter((e) => e.source === "src" && e.head === "h1");
    assert.equal(fromSrc.length, TOP_K, "capped at top-k=16");
    // The 17th (lowest target id after byte sort) must be excluded.
    const kept = new Set(fromSrc.map((e) => e.target));
    assert.equal(kept.has("t00"), true, "lowest-id eligible target kept (tie by target id)");
    assert.equal(kept.has("t16"), false, "17th eligible target excluded");
    assert.equal(kept.has("t17"), false, "18th eligible target excluded");
  });
});

describe("TOP-TIE-002: equal scores sort target IDs by unsigned bytes", () => {
  test("tie-break is target-id byte order ascending, not insertion order", () => {
    // Insert in reverse byte order to prove the sort is by target bytes, not input.
    const rows: Array<[string, string, string, number, "dependency" | "contradiction"]> = [
      ["src", "z", "h1", 0.9, "dependency"],
      ["src", "a", "h1", 0.9, "dependency"],
      ["src", "m", "h1", 0.9, "dependency"],
      ["src", "b", "h1", 0.9, "dependency"],
    ];
    const res = buildTopology({ ...BASE, candidates: candidates(rows) });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    const targets = res.topology.edges
      .filter((e) => e.source === "src" && e.head === "h1")
      .map((e) => e.target);
    assert.deepEqual(targets, ["a", "b", "m", "z"], "ties sorted by unsigned target-id bytes");
  });

  test("score precedence dominates byte order at the top-k boundary", () => {
    // 16 tie targets at score 1.0 (byte-order ids t00..t15) PLUS one target t16
    // with a HIGHER score 2.0. Score-descending selection must keep the 2.0 edge
    // (boundary-relevant) and drop the tie that sorts last by target bytes
    // (t15). If pure byte order mistakenly governed the boundary, t16 would be
    // the one excluded.
    const rows: Array<[string, string, string, number, "dependency" | "contradiction"]> = [];
    for (let i = 0; i < 16; i++) {
      rows.push(["src", `t${String(i).padStart(2, "0")}`, "h1", 1.0, "dependency"]);
    }
    rows.push(["src", "t16", "h1", 2.0, "dependency"]);
    const res = buildTopology({ ...BASE, candidates: candidates(rows) });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    const kept = new Set(
      res.topology.edges
        .filter((e) => e.source === "src" && e.head === "h1")
        .map((e) => e.target),
    );
    assert.equal(kept.size, TOP_K, "kept exactly top-k");
    assert.equal(kept.has("t16"), true, "higher score kept across the boundary");
    assert.equal(kept.has("t15"), false, "the last tie (t15) dropped so t16 could fit");
    assert.equal(kept.has("t00"), true, "lowest-id tie retained");
  });
});

describe("TOP-KIND-003: dependency one direction, contradiction two", () => {
  test("dependency edge emits a single directed record", () => {
    const res = buildTopology({ ...BASE, candidates: candidates([["a", "b", "dep", 0.8, "dependency"]]) });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    const edges = res.topology.edges;
    assert.equal(edges.length, 1, "dependency: one directed record");
    assert.equal(edges[0].direction, "dependency");
    assert.equal(edges[0].source, "a");
    assert.equal(edges[0].target, "b");
  });

  test("contradiction edge emits a symmetric PAIRED record set", () => {
    const res = buildTopology({ ...BASE, candidates: candidates([["a", "b", "contra", 0.8, "contradiction"]]) });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    const edges = res.topology.edges;
    assert.equal(edges.length, 2, "contradiction: symmetric pair");
    const a2b = edges.find((e) => e.source === "a" && e.target === "b");
    const b2a = edges.find((e) => e.source === "b" && e.target === "a");
    assert.ok(a2b && b2a, "both directions present");
    assert.equal(a2b.direction, "contradiction");
    assert.equal(b2a.direction, "contradiction");
    assert.equal(a2b.score, b2a.score, "pair shares the same score");
  });
});

describe("failure injection: non-finite score rejects in isolation (TOP_SCORE_NONFINITE)", () => {
  test("one head's NaN rejects only its own edge; other heads unaffected", () => {
    const rows: Array<[string, string, string, number, "dependency" | "contradiction"]> = [
      ["src", "a", "h1", 0.9, "dependency"],
      ["src", "b", "h1", 0.8, "dependency"],
      ["src", "badTarget", "hNaN", Number.NaN, "dependency"],
      ["src", "c", "h2", 0.95, "dependency"],
    ];
    const res = buildTopology({ ...BASE, candidates: candidates(rows) });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    // The NaN edge was rejected, not silently kept.
    const rejected = res.rejected.find((r) => r.head === "hNaN");
    assert.ok(rejected, "NaN edge surfaced as a rejection");
    assert.equal(rejected?.code, "TOP_SCORE_NONFINITE");
    // Other heads remain intact.
    const fromSrc = res.topology.edges.filter((e) => e.source === "src");
    assert.ok(fromSrc.every((e) => Number.isFinite(e.score)), "no non-finite score survives");
    assert.ok(fromSrc.some((e) => e.target === "a"), "h1 dependency kept");
    assert.ok(fromSrc.some((e) => e.target === "c"), "h2 dependency kept");
  });

  test("Infinity and -Infinity are also rejected as TOP_SCORE_NONFINITE", () => {
    const rows: Array<[string, string, string, number, "dependency" | "contradiction"]> = [
      ["src", "x", "h1", Number.POSITIVE_INFINITY, "dependency"],
      ["src", "y", "h1", Number.NEGATIVE_INFINITY, "dependency"],
    ];
    const res = buildTopology({ ...BASE, candidates: candidates(rows) });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    assert.equal(res.rejected.length, 2, "both infinities rejected");
    assert.ok(res.rejected.every((r) => r.code === "TOP_SCORE_NONFINITE"));
    assert.equal(res.topology.edgeCount, 0, "no edges from rejected candidates");
  });
});

describe("self-edge removal and threshold", () => {
  test("self edges are rejected as TOP_SELF_EDGE and never emitted", () => {
    const res = buildTopology({
      ...BASE,
      candidates: candidates([
        ["a", "a", "h1", 0.9, "dependency"],
        ["a", "b", "h1", 0.9, "dependency"],
      ]),
    });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    const self = res.rejected.find((r) => r.code === "TOP_SELF_EDGE");
    assert.ok(self, "self-edge rejection surfaced");
    assert.ok(res.topology.edges.every((e) => e.source !== e.target), "no self edge emitted");
    assert.equal(res.topology.edges.length, 1);
  });

  test("scores at or below the calibrated threshold are dropped", () => {
    const res = buildTopology({
      ...BASE,
      threshold: 0.5,
      candidates: candidates([
        ["a", "b", "h1", 0.5, "dependency"], // exactly at threshold -> dropped
        ["a", "c", "h1", 0.49, "dependency"], // below -> dropped
        ["a", "d", "h1", 0.51, "dependency"], // above -> kept
      ]),
    });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    const targets = res.topology.edges.map((e) => e.target);
    assert.deepEqual(targets, ["d"], "only strictly-above-threshold candidate kept");
  });
});

describe("graph digest order-independence", () => {
  test("identical candidate sets in different input order yield an identical digest", () => {
    const rows: Array<[string, string, string, number, "dependency" | "contradiction"]> = [
      ["a", "b", "h1", 0.9, "dependency"],
      ["b", "c", "h2", 0.8, "contradiction"],
      ["c", "d", "h1", 0.7, "dependency"],
    ];
    const d1 = graphDigestFrom([...rows].reverse());
    const d2 = graphDigestFrom(rows);
    assert.equal(d1, d2, "digest ignores input order");
  });

  test("digest is stable across the mandated 1,000 runs", () => {
    const rows: Array<[string, string, string, number, "dependency" | "contradiction"]> = [
      ["a", "b", "h1", 0.9, "dependency"],
      ["b", "c", "h2", 0.8, "contradiction"],
      ["c", "d", "h1", 0.7, "dependency"],
    ];
    const first = graphDigestFrom(rows);
    for (let i = 0; i < 1000; i++) {
      assert.equal(graphDigestFrom(rows), first, `run ${i} stabilizes digest`);
    }
  });
});

function graphDigestFrom(
  order: Array<[string, string, string, number, "dependency" | "contradiction"]>,
): string {
  const c = candidates(order);
  const res = buildTopologyGraph({ ...BASE, candidates: c });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error("unreachable");
  return res.topology.generationDigest;
}

describe("emit seam", () => {
  test("vector_cortex_topology_built and _edge_rejected are emitted on the seam", () => {
    const events: string[] = [];
    buildTopologyGraph(
      {
        ...BASE,
        candidates: candidates([
          ["a", "b", "h1", 0.9, "dependency"],
          ["a", "a", "h1", 0.9, "dependency"], // self -> rejected
          ["x", "y", "hNaN", Number.NaN, "dependency"], // NaN -> rejected
        ]),
      },
      (event) => events.push(event),
    );
    assert.ok(events.includes("vector_cortex_topology_built"), "built event emitted");
    assert.ok(
      events.filter((e) => e === "vector_cortex_topology_edge_rejected").length >= 2,
      "rejection events emitted per rejected edge",
    );
  });
});

describe("graphDigest determinism over format", () => {
  test("graphDigest is a stable sha256 prefix and order-independent at the helper level", () => {
    const rows: Array<[string, string, string, number, "dependency" | "contradiction"]> = [
      ["b", "a", "h1", 0.9, "dependency"],
      ["a", "b", "h1", 0.9, "dependency"],
    ];
    const res1 = buildTopology({ ...BASE, candidates: candidates(rows) });
    const res2 = buildTopology({ ...BASE, candidates: candidates([...rows].reverse()) });
    assert.equal(res1.ok && res2.ok, true);
    if (!res1.ok || !res2.ok) throw new Error("unreachable");
    assert.equal(graphDigest(res1.topology), graphDigest(res2.topology));
    assert.match(graphDigest(res1.topology), /^sha256:[0-9a-f]{64}$/);
  });
});

describe("TOP-MAX-004: collapsed duplicates keep the maximum score (Q01)", () => {
  test("duplicate directed edge with different scores keeps the higher one", () => {
    const res = buildTopology({
      ...BASE,
      candidates: candidates([
        ["a", "b", "h1", 0.5, "dependency"],
        ["a", "b", "h1", 0.9, "dependency"],
      ]),
    });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    assert.equal(res.topology.edgeCount, 1, "duplicate directed edge collapses to one");
    assert.equal(res.topology.edges[0].score, 0.9, "higher score wins, not lower");
  });

  test("contradiction a↔b with different scores keeps the higher score, not byte order", () => {
    // Scores differ (0.5 vs 0.9); the higher-score record must claim the pair
    // regardless of which end is "source" (byte order would otherwise pick 0.5).
    const res = buildTopology({
      ...BASE,
      candidates: candidates([
        ["b", "a", "h2", 0.9, "contradiction"],
        ["a", "b", "h1", 0.5, "contradiction"],
      ]),
    });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    assert.equal(res.topology.edgeCount, 2, "one symmetric direction pair");
    for (const e of res.topology.edges) {
      assert.equal(e.score, 0.9, "higher-score score retained on both records");
    }
  });

  test("a score duplicate survives any input permutation (deterministic digest)", () => {
    const rows: Array<[string, string, string, number, "dependency" | "contradiction"]> = [
      ["a", "b", "h1", 0.5, "dependency"],
      ["a", "b", "h1", 0.9, "dependency"],
      ["c", "d", "h2", 0.4, "contradiction"],
      ["d", "c", "h2", 0.8, "contradiction"],
    ];
    const r1 = buildTopologyGraph({ ...BASE, candidates: candidates(rows) });
    const r2 = buildTopologyGraph({ ...BASE, candidates: candidates([...rows].reverse()) });
    assert.equal(r1.ok && r2.ok, true);
    if (!r1.ok || !r2.ok) throw new Error("unreachable");
    assert.equal(graphDigest(r1.topology), graphDigest(r2.topology), "digest ignores input order");
    for (const e of r1.topology.edges) {
      assert.notEqual(e.source, e.target, "no self edge");
      assert.ok(Number.isFinite(e.score), "no non-finite score");
    }
  });
});

type Row = [string, string, string, number, "dependency" | "contradiction"];

describe("TOP-K-005: top-k boundary kind tie-break is input-order independent (Q01)", () => {
  test("tied dep/contra at the 16th slot keeps the same winner under any input order", () => {
    // 15 clearly-above-threshold neighbors plus a TIED (t15, score 0.5) dep/contra
    // pair. The pair ties on (score, target) within the (s, h1) group, so before
    // the Q01 `kind` tie-break the top-k=16 cutoff resolved by JS stable order =
    // input order, flipping which kind survives (dependency emits 1 edge,
    // contradiction emits 2) and changing the digest. The fix breaks the tie by
    // kind bytes ('contradiction' < 'dependency'), so the outcome is fixed.
    const high: Row[] = [];
    for (let i = 0; i < 15; i++) {
      high.push(["s", `t${String(i).padStart(2, "0")}`, "h1", 0.6, "dependency"]);
    }
    const depRow: Row = ["s", "t15", "h1", 0.5, "dependency"];
    const contraRow: Row = ["s", "t15", "h1", 0.5, "contradiction"];
    const depFirst = [...high, depRow, contraRow];
    const contraFirst = [...high, contraRow, depRow];
    const r1 = buildTopologyGraph({ ...BASE, candidates: candidates(depFirst) });
    const r2 = buildTopologyGraph({ ...BASE, candidates: candidates(contraFirst) });
    assert.equal(r1.ok && r2.ok, true);
    if (!r1.ok || !r2.ok) throw new Error("unreachable");
    assert.equal(graphDigest(r1.topology), graphDigest(r2.topology), "digest ignores input order at the kind tie");
    assert.equal(r1.topology.edgeCount, r2.topology.edgeCount, "edge count is input-order independent");
    const k1 = r1.topology.edges.filter((e) => e.target === "t15").map((e) => e.direction);
    const k2 = r2.topology.edges.filter((e) => e.target === "t15").map((e) => e.direction);
    assert.deepEqual(k1, k2, "surviving tied edge's direction is deterministic");
  });
});

describe("TOP-K-006: separator-bearing ids are rejected as TOP_FRAMING_SEP (Q04)", () => {
  test("a candidate id containing | or ~ is rejected in isolation without poisoning others", () => {
    const res = buildTopology({
      ...BASE,
      candidates: candidates([
        ["a|b", "c", "h1", 0.9, "dependency"],
        ["d", "e~f", "h1", 0.9, "dependency"],
        ["a", "b", "h1", 0.9, "dependency"],
      ]),
    });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    const codes = res.rejected.map((r) => r.code);
    assert.equal(codes.filter((c) => c === "TOP_FRAMING_SEP").length, 2, "both separator ids rejected");
    assert.equal(res.topology.edgeCount, 1, "clean candidate survives");
    for (const n of res.topology.nodes) {
      assert.equal(/[|~]/.test(n.id), false, `no separator in node id ${n.id}`);
    }
    for (const e of res.topology.edges) {
      assert.equal(/[|~]/.test(e.source) || /[|~]/.test(e.target) || /[|~]/.test(e.head), false, "no separator in edge");
    }
  });
});
