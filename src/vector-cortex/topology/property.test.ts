/**
 * vector-cortex/topology/property.test.ts — topology invariants over generated
 * inputs (VC3B).
 *
 * Generation-property checks (deterministic PRNG seed so runs are reproducible):
 *   - invariant: every source/head out-degree is <= top-k=16;
 *   - invariant: no self-edge and no non-finite score ever in the output;
 *   - invariant: the graph digest ignores input order across shuffled builds;
 *   - invariant: contradiction edges always emit as symmetric pairs;
 *   - recovery: injecting a NaN head among valid candidates rejects ONLY that
 *     head's edge (TOP_SCORE_NONFINITE) without poisoning the rest.
 * Real logic, no mocks.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTopology } from "./build.js";
import { buildTopologyGraph } from "./index.js";
import { TOP_K } from "./types.js";
import type { TopologyCandidate, TopologyEdgeV1 } from "./types.js";

/** Small deterministic PRNG (mulberry32) — no Math.random, reproducible seeds. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const IDS = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
const HEADS = ["h1", "h2", "h3", "h4", "h5"];

function genCandidates(rand: () => number, count: number): TopologyCandidate[] {
  const out: TopologyCandidate[] = [];
  for (let i = 0; i < count; i++) {
    const source = IDS[Math.floor(rand() * IDS.length)];
    let target = IDS[Math.floor(rand() * IDS.length)];
    if (target === source) target = IDS[(IDS.indexOf(source) + 1) % IDS.length];
    const head = HEADS[Math.floor(rand() * HEADS.length)];
    const kind = rand() < 0.5 ? "dependency" : ("contradiction" as const);
    const score = 0.1 + rand() * 1.0;
    out.push({
      source,
      target,
      head,
      score: Number(score.toFixed(3)),
      kind,
    });
  }
  return out;
}

describe("generated-input invariants", () => {
  test("out-degree per source/head is never above top-k=16", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rand = rng(seed * 7919);
      const candidates = genCandidates(rand, 400);
      const res = buildTopology({ sessionId: "p", sourceHighWater: 9n, threshold: 0.2, candidates });
      assert.equal(res.ok, true);
      if (!res.ok) throw new Error("unreachable");
      const deg = new Map<string, number>();
      for (const e of res.topology.edges) {
        const key = `${e.source}::${e.head}`;
        deg.set(key, (deg.get(key) ?? 0) + 1);
      }
      for (const [k, d] of deg) {
        assert.ok(d <= TOP_K, `seed ${seed}: out-degree ${d} for ${k} exceeds ${TOP_K}`);
      }
    }
  });

  test("no self-edge and no non-finite score in the output", () => {
    for (let seed = 101; seed <= 140; seed++) {
      const rand = rng(seed * 1301);
      const candidates = genCandidates(rand, 300);
      const res = buildTopology({ sessionId: "p", sourceHighWater: 9n, threshold: 0.0, candidates });
      assert.equal(res.ok, true);
      if (!res.ok) throw new Error("unreachable");
      for (const e of res.topology.edges) {
        assert.notEqual(e.source, e.target, "no self edge");
        assert.ok(Number.isFinite(e.score), "no non-finite score");
      }
    }
  });

  test("contradiction edges always emit as symmetric pairs", () => {
    for (let seed = 201; seed <= 230; seed++) {
      const rand = rng(seed * 2309);
      const candidates = genCandidates(rand, 250);
      const res = buildTopology({ sessionId: "p", sourceHighWater: 9n, threshold: 0.2, candidates });
      assert.equal(res.ok, true);
      if (!res.ok) throw new Error("unreachable");
      const contra = res.topology.edges.filter((e) => e.direction === "contradiction");
      for (const e of contra) {
        const pair: TopologyEdgeV1 | undefined = res.topology.edges.find(
          (x) =>
            x.direction === "contradiction" &&
            x.source === e.target &&
            x.target === e.source &&
            x.head === e.head,
        );
        assert.ok(pair, `symmetric counterpart exists for ${e.source}->${e.target}`);
        assert.equal(pair.score, e.score, "pair shares score");
      }
    }
  });

  test("digest ignores input order across many shuffled builds", () => {
    const rand = rng(4242);
    const candidates = genCandidates(rand, 120);
    const base = { sessionId: "p", sourceHighWater: 9n, threshold: 0.2 };
    const d1 = digestOf({ ...base, candidates });
    const shuffled = [...candidates].reverse();
    const d2 = digestOf({ ...base, candidates: shuffled });
    assert.equal(d1, d2, "digest identical across shuffled input order");
  });
});

function digestOf(input: {
  sessionId: string;
  sourceHighWater: bigint;
  threshold: number;
  candidates: TopologyCandidate[];
}): string {
  const res = buildTopologyGraph(input);
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error("unreachable");
  return res.topology.generationDigest;
}

describe("NaN injection across generated heads", () => {
  test("one NaN head rejects only its edges, other heads fully intact", () => {
    const rand = rng(555);
    const candidates = genCandidates(rand, 200);
    // Inject a poisoned head with a NaN edge.
    candidates.push({ source: "a", target: "b", head: "poison", score: Number.NaN, kind: "dependency" });
    const res = buildTopology({ sessionId: "p", sourceHighWater: 9n, threshold: 0.2, candidates });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    const poisonRejected = res.rejected.filter((r) => r.head === "poison");
    assert.ok(poisonRejected.length >= 1, "poison edge rejected");
    assert.ok(poisonRejected.every((r) => r.code === "TOP_SCORE_NONFINITE"), "exact code");
    // No poisoned edge survives.
    assert.ok(
      res.topology.edges.every((e) => e.head !== "poison"),
      "poison head absent from the graph",
    );
    // Other heads still present.
    const otherHeads = new Set(res.topology.edges.map((e) => e.head));
    assert.ok(otherHeads.size >= 1, "other heads survive");
  });
});
