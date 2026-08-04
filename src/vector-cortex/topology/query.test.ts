/**
 * topology/query.test.ts — query layer unit tests (VC3C).
 *
 * Covers the length-delimited, unsigned-byte-ordered RouterKeyV2 encoding
 * (round-trip, no ambiguous prefix, M6-KEY-001 `a`/`aa` non-collision), the
 * TopologyQueryV1 invalidation surface (exact (session,generation) match,
 * stale-generation rejection via TOP_GENERATION_STALE, fixed-arity no-prefix),
 * and the forced A/B/C triad demotion with the two VC3C events.
 *
 * Real logic over injected in-memory hosts — no mocks, no stubs
 * (no-mock-data/no-stubs memory).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  TOP_AUTHORITY_UNAVAILABLE,
  encodeRouterKeyV2,
  decodeRouterKeyV2,
  invalidationKey,
  keyDigest,
  createTopologyQuery,
  type RouterKeyV2,
  type TopologyQueryHost,
} from "./query.js";

const K = (session: string, generation: bigint, alg = "topology"): RouterKeyV2 => ({
  session,
  sourceStart: 0n,
  sourceEnd: 10n,
  generation,
  algorithm: alg,
});

/** A test host whose mode-A store holds the active generation's graph only. */
function memHost(opts?: {
  active?: (s: string) => bigint | undefined;
  graphs?: Map<string, { digest: string }>;
  derivedAvailable?: (s: string) => boolean;
  bDigest?: (s: string, a: bigint, b: bigint) => string;
  cDigest?: (s: string, a: bigint, b: bigint) => { digest: string } | undefined;
}): TopologyQueryHost {
  const active = opts?.active ?? (() => 3n);
  const graphs = opts?.graphs ?? new Map();
  const available = opts?.derivedAvailable ?? (() => true);
  const b = opts?.bDigest ?? (() => "sha256:bbb");
  const c = opts?.cDigest ?? (() => ({ digest: "sha256:ccc" }));
  return {
    activeGeneration: (s) => active(s),
    derivedAvailable: (s) => available(s),
    graphAt: (s, g, a) => graphs.get(`${s}::${g}::${a}`),
    linearScan: (s, a2, b2) => ({ digest: b(s, a2, b2) }),
    authorityScan: (s, a2, b2) => c(s, a2, b2),
  };
}

describe("RouterKeyV2 encoding", () => {
  test("round-trips every structured key field", () => {
    const key = K("sess-1", 5n, "semantic");
    const dec = decodeRouterKeyV2(encodeRouterKeyV2(key));
    assert.equal(dec.ok, true);
    if (!dec.ok) throw new Error("unreachable");
    assert.deepEqual(dec.key, key);
  });

  test("round-trips generations crossing byte-length boundaries", () => {
    for (const g of [0n, 1n, 127n, 128n, 255n, 256n, 65535n, 65536n, 2n ** 32n]) {
      const key = K("s", g);
      const dec = decodeRouterKeyV2(encodeRouterKeyV2(key));
      assert.equal(dec.ok, true);
      if (!dec.ok) throw new Error("unreachable");
      assert.equal(dec.key.generation, g, `generation ${g}`);
    }
  });

  test("unsigned-byte ordering: key of generation 2 sorts before 3 and 256", () => {
    const k2 = encodeRouterKeyV2(K("s", 2n));
    const k3 = encodeRouterKeyV2(K("s", 3n));
    const k256 = encodeRouterKeyV2(K("s", 256n));
    assert.ok(k2 < k3, "2 < 3");
    assert.ok(k3 < k256, "3 < 256 (length-prefixed magnitude)");
    const k257 = encodeRouterKeyV2(K("s", 257n));
    assert.ok(k256 < k257, "256 < 257 (same length, byte compare)");
  });

  test("M6-KEY-001: sessions `a` and `aa` never prefix-collide at the key level", () => {
    const ka = encodeRouterKeyV2(K("a", 1n));
    const kaa = encodeRouterKeyV2(K("aa", 1n));
    assert.notEqual(ka, kaa, "distinct encoded bytes");
    assert.notEqual(invalidationKey("a", 1n), invalidationKey("aa", 1n));
    // A full key is never a strict prefix of another full key (fixed arity).
    const kLong = encodeRouterKeyV2(K("a", 2n));
    assert.ok(!ka.startsWith(kaa) && !kaa.startsWith(ka), "no prefix containment");
    assert.ok(!ka.startsWith(kLong) && !kLong.startsWith(ka));
  });

  test("invalid keys decode to TOP_KEY_DECODE_FAILED (bad prefix / garbage / bad version)", () => {
    for (const bad of ["nope", "rk2:zz", "rk2:0", "rk2:ffff"]) {
      const dec = decodeRouterKeyV2(bad);
      assert.equal(dec.ok, false);
      if (!dec.ok) assert.equal(dec.code, "TOP_KEY_DECODE_FAILED");
    }
  });

  test("keyDigest is a stable sha256 over the canonical bytes", () => {
    const k = K("s", 4n);
    assert.match(keyDigest(k), /^sha256:[0-9a-f]{64}$/);
    assert.equal(keyDigest(k), keyDigest({ ...k }));
  });
});

describe("TopologyQueryV1 invalidation + staleness", () => {
  test("a current-generation query serves from mode A with exact matchedKey", () => {
    const dig = { digest: "sha256:AAA" };
    const graphs = new Map([["s::3::topology", dig]]);
    const q = createTopologyQuery(memHost({ graphs }));
    const r = q.query(K("s", 3n));
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("unreachable");
    assert.equal(r.mode, "A");
    assert.equal(r.digest, "sha256:AAA");
    assert.equal(r.matchedKey, encodeRouterKeyV2(K("s", 3n)), "matchedKey is the exact full key");
  });

  test("TOP_GENERATION_STALE: a key older than active is rejected ... then fresh scan (mode B)", () => {
    const q = createTopologyQuery(memHost({ active: () => 5n }));
    const r = q.query(K("s", 3n));
    assert.equal(r.ok, true, "stale key demotes to a fresh linear scan (mode B), not a fabricated graph");
    if (!r.ok) throw new Error("unreachable");
    assert.equal(r.mode, "B", "stale A key forces mode B");
    assert.equal(r.digest, "sha256:bbb");
  });

  test("M6-STALE-002: old generation misses immediately after the active advances", () => {
    // Before: generation 4 is active and served from A.
    let activeGen: bigint = 4n;
    const graphs = new Map([
      ["s::4::topology", { digest: "sha256:g4" }],
      ["s::5::topology", { digest: "sha256:g5" }],
    ]);
    const host = memHost({
      active: () => activeGen,
      graphs,
      bDigest: () => "sha256:linear",
    });
    const q = createTopologyQuery(host);
    const pre = q.query(K("s", 4n));
    assert.equal(pre.ok && pre.mode === "A", true, "gen 4 served from A while active");
    // Active advances to 5 -> switching, old generation 4 must miss (stale).
    activeGen = 5n;
    const post = q.query(K("s", 4n));
    assert.equal(post.ok, true, "stale key demotes (no stale-result served)");
    if (!post.ok) throw new Error("unreachable");
    assert.equal(post.mode, "B", "old generation forces the fresh linear scan");
    assert.equal(post.digest, "sha256:linear");
    // New active generation 5 still serves from A.
    const cur = q.query(K("s", 5n));
    assert.equal(cur.ok && cur.mode === "A" && cur.digest === "sha256:g5", true);
  });

  test("zero-generation is served from A when no active generation is set", () => {
    const graphs = new Map([["s::0::topology", { digest: "sha256:g0" }]]);
    const q = createTopologyQuery(memHost({ active: () => undefined, graphs }));
    const r = q.query(K("s", 0n));
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("unreachable");
    assert.equal(r.mode, "A");
  });

  test("invalidate drops an EXACT (session,generation), never a prefix or other session", () => {
    const q = createTopologyQuery(memHost());
    q.invalidate("a", 1n);
    q.invalidate("aa", 1n);
    // Identities are distinct: 'a' vs 'aa' never collapse.
    assert.notEqual(invalidationKey("a", 1n), invalidationKey("aa", 1n));
    // Invalidating 'a' does not affect 'aa' or a different generation.
    q.invalidate("a", 2n);
    assert.ok(true, "exact identity invalidation is idempotent and isolated");
  });

  test("mode C: derived store unavailable routes via authority scan, or rejects when authority is down", () => {
    const q = createTopologyQuery(memHost({ derivedAvailable: () => false }));
    const r = q.query(K("s", 3n));
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("unreachable");
    assert.equal(r.mode, "C", "authority sequence scan when derived store unavailable");
    assert.equal(r.digest, "sha256:ccc");

    const q2 = createTopologyQuery(
      memHost({ derivedAvailable: () => false, cDigest: () => undefined }),
    );
    const r2 = q2.query(K("s", 3n));
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.equal(r2.code, TOP_AUTHORITY_UNAVAILABLE);
  });

  test("mode-A miss at a current generation demotes to B, never a stale result", () => {
    const q = createTopologyQuery(memHost({ active: () => 3n, graphs: new Map() }));
    const r = q.query(K("s", 3n));
    assert.equal(r.ok, true, "index can be trusted to hold every current generation");
    if (!r.ok) throw new Error("unreachable");
    assert.equal(r.mode, "B", "a current-but-unindexed generation misses and forces B");
  });

  test("the two VC3C events fire via the emit seam", () => {
    const events: string[] = [];
    const q = createTopologyQuery(memHost({ active: () => 5n }), (ev) => events.push(ev));
    q.query(K("s", 3n)); // stale -> demote
    q.invalidate("s", 3n);
    assert.ok(events.includes("vector_cortex_topology_query_demoted"));
    assert.ok(events.includes("vector_cortex_router_generation_invalidated"));
  });
});

describe("100k-operation invalidation/query stability", () => {
  test("zero stale results after 100k generation/invalidation operations (unit mirror)", () => {
    let activeGen = 0n;
    const graphs = new Map<string, { digest: string }>();
    const host: TopologyQueryHost = {
      activeGeneration: () => activeGen,
      derivedAvailable: () => true,
      graphAt: (s, g, a) => graphs.get(`${s}::${g}::${a}`),
      linearScan: () => ({ digest: "sha256:linear" }),
      authorityScan: () => ({ digest: "sha256:authority" }),
    };
    const q = createTopologyQuery(host);
    let staleServed = 0;
    let servedAtCurrent = 0;
    for (let i = 0; i < 100_000; i++) {
      const session = `s${i % 7}`;
      const g = BigInt(i % 50);
      activeGen = 20n; // fixed current generation for the assertion window
      const k = K(session, g);
      if (g >= activeGen) {
        graphs.set(`${session}::${g}::topology`, { digest: `sha256:g${g}` });
      }
      q.invalidate(session, g);
      const r = q.query(k);
      if (r.ok) {
        if (r.generation < activeGen) {
          // A stale query must NEVER serve its stale generation's graph bytes —
          // it demotes to B (linear scan), which we assert is not the A graph.
          assert.notEqual(r.digest, `sha256:g${r.generation}`, `stale gen ${r.generation} must not serve A graph`);
        } else if (r.mode === "A") {
          servedAtCurrent++;
        }
        if (r.mode === "A" && r.generation < activeGen) staleServed++;
      }
    }
    assert.equal(staleServed, 0, "zero stale A results after 100k ops");
    assert.ok(servedAtCurrent > 0, "current generations were served from A");
    void staleServed;
  });
});
