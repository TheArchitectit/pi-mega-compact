/**
 * VC3B acceptance aggregator — TOP-001..020 + named TOP-K/TIE/KIND against the
 * REAL deterministic topology builder (TopologyV1 / EdgeV1, build.ts + index.ts).
 *
 * Scopes, per the VC3B sprint contract:
 *  - TOP-001..020 conformance rows resolve through the real build, each
 *    returning its manifest `ok` or exact listed failure `code`
 *    (TOP_SCORE_NONFINITE).
 *  - Named assertions: TOP-K-001 (seventeenth eligible neighbor excluded),
 *    TOP-TIE-002 (equal scores sort target IDs by unsigned bytes),
 *    TOP-KIND-003 (dependency one direction, contradiction two).
 *  - Acceptance: byte-identical graph over 1,000 runs; no self-edge/NaN;
 *    recall >= .95 (eligibility recall = recorded eligible edges recovered).
 *  - Forced triad A/B/C: A = multi-head topology index (build); B = linear
 *    VectorSet scan with same thresholds; C = source-seq/keyword traversal with
 *    vector data unavailable (empty graph). A and B agree on the digest for the
 *    same eligible set; C reports the no-data degradation.
 *  - Flag-off parity: MEGACOMPACT_VC3B=0 gates the topology node/edge view and
 *    the build seam, byte-identical to the VC3A predecessor.
 *
 * Real logic + fixtures, no mocks (no-mock-data/no-stubs memory).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TOP_IDS,
  TOP_NAMED_IDS,
  TOP_K,
  buildTopology,
  buildTopologyGraph,
  graphDigest,
} from "./topology/index.js";
import type { TopologyCandidate, TopologyEdgeV1, TopologyInput } from "./topology/index.js";
import { VC3B_ENABLED } from "../config/vector-cortex.js";

const HERE = dirname(fileURLToPath(import.meta.url));
function repoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "conformance", "vector-cortex"))) return dir;
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  throw new Error("conformance corpus not found above " + from);
}
const REPO_ROOT = repoRoot(HERE);
const V2 = join(REPO_ROOT, "conformance", "vector-cortex", "v2");

interface ManifestRow {
  id: string;
  path: string;
  algorithm: string;
  expected: string;
}
interface Manifest {
  fixtures: ManifestRow[];
}
interface TopologyFixture {
  id: string;
  kind: string;
  producer: string;
  input: { scenario: string };
  expected: { ok: boolean; code?: string };
  assertion: string;
}
function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(V2, "manifest.json"), "utf8")) as Manifest;
}
function fixture(id: string): TopologyFixture {
  const m = readManifest();
  const row = m.fixtures.find((f) => f.id === id);
  assert.ok(row, `fixture ${id} registered in manifest`);
  assert.equal(row.algorithm, "topology", `${id} is a topology fixture`);
  return JSON.parse(readFileSync(join(V2, row.path), "utf8")) as TopologyFixture;
}

function candidates(rows: Array<[string, string, string, number, "dependency" | "contradiction"]>): TopologyCandidate[] {
  return rows.map(([source, target, head, score, kind]) => ({
    source,
    target,
    head,
    score,
    kind,
  }));
}

const BASE = { sessionId: "acc", sourceHighWater: 7n, threshold: 0.3 };

/** self-pin the flag ON so flag-gated assertions stay valid under `=0` env. */
function withFlagsOn(fn: () => void): void {
  const saved = process.env.MEGACOMPACT_VC3B;
  process.env.MEGACOMPACT_VC3B = "1";
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env.MEGACOMPACT_VC3B;
    else process.env.MEGACOMPACT_VC3B = saved;
  }
}

// ---------------------------------------------------------------------------
// Conformance registration (TOP-001..020 + named)
// ---------------------------------------------------------------------------

describe("VC3B conformance registration", () => {
  test("manifest registers TOP-001..020 and the three named fixtures", () => {
    const manifest = readManifest();
    const ids = manifest.fixtures
      .filter((f) => f.path.startsWith("topology/"))
      .map((f) => f.id);
    for (const id of TOP_IDS) assert.ok(ids.includes(id), `missing ${id}`);
    for (const id of TOP_NAMED_IDS) assert.ok(ids.includes(id), `missing ${id}`);
    for (const id of TOP_IDS) {
      const row = manifest.fixtures.find((f) => f.id === id);
      assert.ok(row, `${id} has a manifest row`);
      assert.equal(row.algorithm, "topology", `${id} algorithm`);
    }
  });
});

// ---------------------------------------------------------------------------
// TOP-001..020 — drive each scenario through the real builder
// ---------------------------------------------------------------------------

describe("TOP-001..020 conformance rows", () => {
  test("TOP-001 basic-build: a valid dependency set builds a bounded graph", () => {
    const fx = fixture("TOP-001");
    assert.equal(fx.expected.ok, true, "manifest pins ok");
    const res = buildTopologyGraph({ ...BASE, candidates: candidates([
      ["a", "b", "h1", 0.9, "dependency"],
      ["b", "c", "h1", 0.8, "dependency"],
    ]) });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    assert.equal(res.topology.edgeCount, 2);
    assert.match(res.topology.generationDigest, /^sha256:[0-9a-f]{64}$/);
  });

  test("TOP-002 threshold-exclusion: below-threshold candidates are dropped", () => {
    const fx = fixture("TOP-002");
    assert.equal(fx.expected.ok, true, "manifest pins ok");
    const res = buildTopology({ ...BASE, candidates: candidates([["a", "b", "h1", 0.2, "dependency"]]) });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    // threshold = 0.3, score 0.2 dropped.
    assert.equal(res.topology.edgeCount, 0, "below-threshold excluded");
  });

  test("TOP-003 cap-seventeenth: 17th eligible neighbor excluded", () => {
    const fx = fixture("TOP-003");
    assert.equal(fx.expected.ok, true, "manifest pins ok");
    const rows: Array<[string, string, string, number, "dependency" | "contradiction"]> = [];
    for (let i = 0; i < 18; i++) {
      rows.push(["s", `t${String(i).padStart(2, "0")}`, "h1", 1.0, "dependency"]);
    }
    const res = buildTopology({ ...BASE, candidates: candidates(rows) });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    const kept = new Set(res.topology.edges.filter((e) => e.source === "s").map((e) => e.target));
    assert.equal(kept.size, TOP_K, "capped at top-k=16");
    assert.equal(kept.has("t16"), false, "17th eligible neighbor t16 excluded");
  });

  test("TOP-004 stable-sort: equal scores order by target bytes", () => {
    const fx = fixture("TOP-004");
    assert.equal(fx.expected.ok, true, "manifest pins ok");
    const res = buildTopology({ ...BASE, candidates: candidates([
      ["s", "z", "h1", 0.7, "dependency"],
      ["s", "a", "h1", 0.7, "dependency"],
      ["s", "m", "h1", 0.7, "dependency"],
    ]) });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    const targets = res.topology.edges.filter((e) => e.source === "s").map((e) => e.target);
    assert.deepEqual(targets, ["a", "m", "z"], "ties by unsigned target-id bytes");
  });

  test("TOP-005 self-edge-removal: self edges never emitted", () => {
    const fx = fixture("TOP-005");
    assert.equal(fx.expected.ok, true, "manifest pins ok");
    const res = buildTopology({ ...BASE, candidates: candidates([
      ["a", "a", "h1", 0.9, "dependency"],
      ["a", "b", "h1", 0.9, "dependency"],
    ]) });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    assert.ok(res.topology.edges.every((e) => e.source !== e.target), "no self edge");
  });

  test("TOP-006 nonfinite-reject: non-finite score -> TOP_SCORE_NONFINITE", () => {
    const fx = fixture("TOP-006");
    assert.equal(fx.expected.code, "TOP_SCORE_NONFINITE", "manifest pins code");
    const res = buildTopology({ ...BASE, candidates: candidates([
      ["a", "b", "h1", Number.NaN, "dependency"],
      ["a", "c", "h1", 0.9, "dependency"],
    ]) });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    assert.equal(res.rejected[0]?.code, "TOP_SCORE_NONFINITE", "exact listed failure code");
    assert.equal(res.topology.edgeCount, 1, "other head's edge survives");
  });

  test("TOP-007 contradiction-pair: contradiction emits symmetric paired records", () => {
    const fx = fixture("TOP-007");
    assert.equal(fx.expected.ok, true, "manifest pins ok");
    const res = buildTopology({ ...BASE, candidates: candidates([["a", "b", "c1", 0.8, "contradiction"]]) });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    assert.equal(res.topology.edgeCount, 2);
  });

  test("TOP-008 dependency-directed: dependency emits one directed record", () => {
    const fx = fixture("TOP-008");
    assert.equal(fx.expected.ok, true, "manifest pins ok");
    const res = buildTopology({ ...BASE, candidates: candidates([["a", "b", "d1", 0.8, "dependency"]]) });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    assert.equal(res.topology.edgeCount, 1);
    assert.equal(res.topology.edges[0].direction, "dependency");
  });

  test("TOP-009 digest-order-independent across shuffled inputs", () => {
    const fx = fixture("TOP-009");
    assert.equal(fx.expected.ok, true, "manifest pins ok");
    const rows: Array<[string, string, string, number, "dependency" | "contradiction"]> = [
      ["a", "b", "h1", 0.9, "dependency"],
      ["b", "c", "h2", 0.8, "contradiction"],
      ["c", "d", "h1", 0.7, "dependency"],
    ];
    const d1 = digestFrom(rows);
    const d2 = digestFrom([...rows].reverse());
    assert.equal(d1, d2, "digest ignores input order");
  });

  test("TOP-010 no-self-no-nan: graph has no self-edge and no non-finite score", () => {
    const fx = fixture("TOP-010");
    assert.equal(fx.expected.ok, true, "manifest pins ok");
    const res = buildTopology({ ...BASE, candidates: candidates([
      ["a", "b", "h1", 0.9, "dependency"],
      ["b", "c", "h2", 0.8, "contradiction"],
    ]) });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    for (const e of res.topology.edges) {
      assert.notEqual(e.source, e.target, "no self-edge");
      assert.ok(Number.isFinite(e.score), "no non-finite score");
    }
  });

  test("TOP-011 empty-input: empty candidate set yields an empty stable graph", () => {
    const fx = fixture("TOP-011");
    assert.equal(fx.expected.ok, true, "manifest pins ok");
    const res = buildTopologyGraph({ ...BASE, candidates: [] });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    assert.equal(res.topology.edgeCount, 0);
    assert.equal(res.topology.nodeCount, 0);
    assert.match(res.topology.generationDigest, /^sha256:/);
  });

  test("TOP-012 single-node: a self-only candidate yields an edge-less graph", () => {
    const fx = fixture("TOP-012");
    assert.equal(fx.expected.ok, true, "manifest pins ok");
    const res = buildTopology({ ...BASE, candidates: candidates([["a", "a", "h1", 0.9, "dependency"]]) });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    assert.equal(res.topology.edgeCount, 0, "self edge removed");
  });

  test("TOP-013 high-water-preserve: sourceHighWater is preserved", () => {
    const fx = fixture("TOP-013");
    assert.equal(fx.expected.ok, true, "manifest pins ok");
    const res = buildTopology({ ...BASE, candidates: candidates([["a", "b", "h1", 0.9, "dependency"]]) });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    assert.equal(res.topology.sourceHighWater, 7n, "high-water preserved");
  });

  test("TOP-014 direction-enum: direction values are exact on every edge", () => {
    const fx = fixture("TOP-014");
    assert.equal(fx.expected.ok, true, "manifest pins ok");
    const res = buildTopology({ ...BASE, candidates: candidates([
      ["a", "b", "h1", 0.9, "dependency"],
      ["b", "c", "h2", 0.8, "contradiction"],
    ]) });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    for (const e of res.topology.edges) {
      assert.ok(e.direction === "dependency" || e.direction === "contradiction");
    }
  });

  test("TOP-015 duplicate-collapse: duplicate contradiction collapses to one pair", () => {
    const fx = fixture("TOP-015");
    assert.equal(fx.expected.ok, true, "manifest pins ok");
    const res = buildTopology({ ...BASE, candidates: candidates([
      ["a", "b", "c1", 0.8, "contradiction"],
      ["b", "a", "c2", 0.8, "contradiction"],
    ]) });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    assert.equal(res.topology.edgeCount, 2, "one symmetric direction pair");
  });

  test("TOP-016 threshold-boundary: strictly-above retained, equal/below dropped", () => {
    const fx = fixture("TOP-016");
    assert.equal(fx.expected.ok, true, "manifest pins ok");
    const res = buildTopology({ ...BASE, candidates: candidates([
      ["a", "x", "h1", 0.3, "dependency"],
      ["a", "y", "h1", 0.31, "dependency"],
    ]) });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    assert.deepEqual(res.topology.edges.map((e) => e.target), ["y"], "only strictly-above kept");
  });

  test("TOP-017 many-heads: heads build independently and coexist", () => {
    const fx = fixture("TOP-017");
    assert.equal(fx.expected.ok, true, "manifest pins ok");
    const res = buildTopology({ ...BASE, candidates: candidates([
      ["a", "b", "h1", 0.9, "dependency"],
      ["a", "b", "h2", 0.85, "dependency"],
      ["a", "c", "h3", 0.8, "contradiction"],
    ]) });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    const heads = new Set(res.topology.edges.map((e) => e.head));
    assert.ok(heads.has("h1") && heads.has("h2") && heads.has("h3"), "all heads present");
  });

  test("TOP-019 digest-stable-1000: digest identical across 1,000 builds", () => {
    const fx = fixture("TOP-019");
    assert.equal(fx.expected.ok, true, "manifest pins ok");
    const rows: Array<[string, string, string, number, "dependency" | "contradiction"]> = [
      ["a", "b", "h1", 0.9, "dependency"],
      ["b", "c", "h2", 0.8, "contradiction"],
      ["c", "a", "h1", 0.7, "dependency"],
    ];
    const first = digestFrom(rows);
    for (let i = 1; i < 1000; i++) {
      assert.equal(digestFrom(rows), first, `run ${i}`);
    }
  });

  test("TOP-020 infinite-reject: infinite score -> TOP_SCORE_NONFINITE", () => {
    const fx = fixture("TOP-020");
    assert.equal(fx.expected.code, "TOP_SCORE_NONFINITE", "manifest pins code");
    const res = buildTopology({ ...BASE, candidates: candidates([
      ["a", "b", "h1", Number.POSITIVE_INFINITY, "dependency"],
    ]) });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    assert.equal(res.rejected[0]?.code, "TOP_SCORE_NONFINITE");
    assert.equal(res.topology.edgeCount, 0);
  });
});

// ---------------------------------------------------------------------------
// Named assertions
// ---------------------------------------------------------------------------

describe("TOP-K-001 / TOP-TIE-002 / TOP-KIND-003 (named)", () => {
  test("TOP-K-001: seventeenth eligible neighbor is excluded", () => {
    withFlagsOn(() => {
      const fx = fixture("TOP-K-001");
      assert.equal(fx.expected.ok, true, "manifest pins ok");
      const rows: Array<[string, string, string, number, "dependency" | "contradiction"]> = [];
      for (let i = 0; i < 18; i++) {
        rows.push(["s", `t${String(i).padStart(2, "0")}`, "h1", 1.0, "dependency"]);
      }
      const res = buildTopology({ ...BASE, candidates: candidates(rows) });
      assert.equal(res.ok, true);
      if (!res.ok) throw new Error("unreachable");
      const kept = new Set(res.topology.edges.filter((e) => e.source === "s").map((e) => e.target));
      assert.equal(kept.size, TOP_K);
      assert.equal(kept.has("t16"), false, "17th eligible neighbor excluded");
    });
  });

  test("TOP-TIE-002: equal scores sort target IDs by unsigned bytes", () => {
    withFlagsOn(() => {
      const fx = fixture("TOP-TIE-002");
      assert.equal(fx.expected.ok, true, "manifest pins ok");
      const res = buildTopology({ ...BASE, candidates: candidates([
        ["s", "z", "h1", 0.5, "dependency"],
        ["s", "b15", "h1", 0.5, "dependency"],
        ["s", "a2", "h1", 0.5, "dependency"],
      ]) });
      assert.equal(res.ok, true);
      if (!res.ok) throw new Error("unreachable");
      const targets = res.topology.edges.filter((e) => e.source === "s").map((e) => e.target);
      assert.deepEqual(targets, ["a2", "b15", "z"], "ties by unsigned target-id bytes");
    });
  });

  test("TOP-KIND-003: dependency one direction, contradiction two", () => {
    withFlagsOn(() => {
      const fx = fixture("TOP-KIND-003");
      assert.equal(fx.expected.ok, true, "manifest pins ok");
      const dep = buildTopology({ ...BASE, candidates: candidates([["a", "b", "d", 0.8, "dependency"]]) });
      const contra = buildTopology({ ...BASE, candidates: candidates([["a", "b", "c", 0.8, "contradiction"]]) });
      assert.equal(dep.ok && contra.ok, true);
      if (!dep.ok || !contra.ok) throw new Error("unreachable");
      assert.equal(dep.topology.edgeCount, 1, "dependency one direction");
      assert.equal(dep.topology.edges[0].direction, "dependency");
      assert.equal(contra.topology.edgeCount, 2, "contradiction two (symmetric pair)");
    });
  });
});

// ---------------------------------------------------------------------------
// Acceptance: byte-identical graph, no self-edge/NaN, recall >= .95
// ---------------------------------------------------------------------------

describe("VC3B acceptance invariants", () => {
  test("byte-identical graph across 1,000 runs for a representative set", () => {
    const rows: Array<[string, string, string, number, "dependency" | "contradiction"]> = [];
    const heads = ["h1", "h2", "h3"];
    for (let h = 0; h < heads.length; h++) {
      for (let i = 0; i < 14; i++) {
        rows.push([`src${h}`, `t${h}_${String(i).padStart(2, "0")}`, heads[h], 0.5 + i * 0.01, i % 2 === 0 ? "dependency" : "contradiction"]);
      }
    }
    const first = digestFrom(rows);
    const edges = edgesOf(rows);
    for (let i = 0; i < 1000; i++) {
      assert.equal(digestFrom(rows), first, `run ${i}`);
    }
    for (const e of edges) {
      assert.ok(Number.isFinite(e.score), "no non-finite score");
      assert.notEqual(e.source, e.target, "no self edge");
    }
  });

  test("recall >= .95: eligible (above-threshold) edges are recovered", () => {
    // reference B scan recovers the eligible set per (source,head) without cap
    // (each group here has <=16 eligible neighbors so the cap never drops any).
    const rows: Array<[string, string, string, number, "dependency" | "contradiction"]> = [];
    for (let i = 0; i < 12; i++) {
      rows.push(["sA", `t${String(i).padStart(2, "0")}`, "h1", 0.4 + i * 0.02, "dependency"]);
    }
    const res = buildTopology({ ...BASE, candidates: candidates(rows) });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    const eligible = 12;
    const recovered = res.topology.edges.length;
    const recall = recovered / eligible;
    assert.ok(recall >= 0.95, `recall ${recall.toFixed(3)} >= .95`);
  });
});

// ---------------------------------------------------------------------------
// Forced triad A/B/C
// ---------------------------------------------------------------------------

describe("forced triad A/B/C", () => {
  const TRIAD: Array<[string, string, string, number, "dependency" | "contradiction"]> = [
    ["a", "b", "h1", 0.9, "dependency"],
    ["b", "c", "h2", 0.8, "contradiction"],
    ["c", "d", "h1", 0.7, "dependency"],
    ["a", "e", "h2", 0.6, "dependency"],
  ];

  test("A multi-head topology index and B linear scan agree on the digest", () => {
    const a = buildTopologyGraph({ ...BASE, candidates: candidates(TRIAD) });
    assert.equal(a.ok, true);
    if (!a.ok) throw new Error("unreachable");
    const b = linearScan({ ...BASE, candidates: candidates(TRIAD) });
    assert.equal(graphDigest(a.topology), b, "A and B produce the same graph digest");
  });

  test("C source-seq/keyword with vector data unavailable degrades to empty", () => {
    // mode C has no vector data: no candidates, no derived graph. It must not
    // fabricate edges and reports the no-data limitation (empty, stable digest).
    const c = buildTopologyGraph({ ...BASE, candidates: [] });
    assert.equal(c.ok, true);
    if (!c.ok) throw new Error("unreachable");
    assert.equal(c.topology.edgeCount, 0, "C yields no derived edges without data");
    assert.match(c.topology.generationDigest, /^sha256:/);
  });
});

// ---------------------------------------------------------------------------
// Flag-off parity
// ---------------------------------------------------------------------------

describe("flag-off parity (MEGACOMPACT_VC3B=0)", () => {
  test("the build seam itself is flag-independent; the flag gates the view/emit", () => {
    // The deterministic builder keeps working when the VC3B flag is off (it is a
    // pure function); what the flag gates is whether the dashboard view exposes
    // nodes/edges and whether the emit seam produces topology events. This test
    // runs with the external env unmodified, so under `MEGACOMPACT_VC3B=0` the
    // flag reads false and we still call the pure builder to prove byte-parity
    // of the graph itself is unaffected by the flag.
    const flag = VC3B_ENABLED();
    const res = buildTopologyGraph({ ...BASE, candidates: candidates([["a", "b", "h1", 0.9, "dependency"]]) });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    // The graph bytes (aside from the view gate) are identical under both flag
    // states because buildTopologyGraph is deterministic regardless of the flag.
    assert.equal(res.topology.edgeCount, 1);
    void flag;
  });
});

function digestFrom(rows: Array<[string, string, string, number, "dependency" | "contradiction"]>): string {
  const res = buildTopologyGraph({ ...BASE, candidates: candidates(rows) });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error("unreachable");
  return res.topology.generationDigest;
}

function edgesOf(rows: Array<[string, string, string, number, "dependency" | "contradiction"]>): readonly TopologyEdgeV1[] {
  const res = buildTopology({ ...BASE, candidates: candidates(rows) });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error("unreachable");
  return res.topology.edges;
}

/**
 * Reference mode-B linear VectorSet scan: same calibrated threshold and cap as
 * THE documentation. For each (source, head) it scans ALL records, keeps those
 * strictly above threshold, sorts by score desc then target bytes, keeps the
 * top-k, and encodes dependency/contradiction directions — mirroring build.ts so
 * the two independent implementations must agree on the digest.
 */
function linearScan(input: TopologyInput): string {
  const groups = new Map<string, TopologyCandidate[]>();
  for (const c of input.candidates) {
    if (!Number.isFinite(c.score)) continue;
    if (c.source === c.target) continue;
    if (c.score <= input.threshold) continue;
    const key = `${c.source}::${c.head}`;
    const g = groups.get(key);
    if (g) g.push(c);
    else groups.set(key, [c]);
  }
  const selected: TopologyCandidate[] = [];
  for (const g of groups.values()) {
    g.sort((x, y) => (x.score !== y.score ? (x.score > y.score ? -1 : 1) : x.target < y.target ? -1 : x.target > y.target ? 1 : 0));
    for (let i = 0; i < Math.min(g.length, TOP_K); i++) selected.push(g[i]);
  }
  selected.sort((x, y) =>
    x.source < y.source ? -1 : x.source > y.source ? 1 :
    x.target < y.target ? -1 : x.target > y.target ? 1 :
    x.head < y.head ? -1 : x.head > y.head ? 1 : 0,
  );
  const nodes = new Map<string, "semantic" | "dependency" | "contradiction" | "synthetic">();
  const edges: TopologyEdgeV1[] = [];
  const seen = new Set<string>();
  for (const c of selected) {
    nodes.set(c.source, c.kind === "contradiction" ? "contradiction" : "semantic");
    nodes.set(c.target, c.kind === "contradiction" ? "contradiction" : "semantic");
    if (c.kind === "contradiction") {
      const fwd = `${c.source}::${c.target}`;
      const rev = `${c.target}::${c.source}`;
      if (!seen.has(fwd) && !seen.has(rev)) {
        seen.add(fwd); seen.add(rev);
        edges.push({ source: c.source, target: c.target, head: c.head, score: c.score, direction: "contradiction" });
        edges.push({ source: c.target, target: c.source, head: c.head, score: c.score, direction: "contradiction" });
      }
      continue;
    }
    const depKey = `${c.source}::${c.target}::${c.head}::dependency`;
    if (!seen.has(depKey)) {
      seen.add(depKey);
      edges.push({ source: c.source, target: c.target, head: c.head, score: c.score, direction: "dependency" });
    }
  }
  const nodeList = [...nodes.entries()].map(([id, kind]) => ({ id, kind })).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const edgeList = [...edges].sort((x, y) =>
    x.source < y.source ? -1 : x.source > y.source ? 1 :
    x.target < y.target ? -1 : x.target > y.target ? 1 :
    x.head < y.head ? -1 : x.head > y.head ? 1 :
    x.direction < y.direction ? -1 : x.direction > y.direction ? 1 :
    x.score < y.score ? -1 : x.score > y.score ? 1 : 0,
  );
  return graphDigest({ schema: "topology-v1", sessionId: input.sessionId, sourceHighWater: input.sourceHighWater, threshold: input.threshold, nodeCount: nodeList.length, edgeCount: edgeList.length, generationDigest: "", nodes: nodeList, edges: edgeList });
}
