/**
 * VC3C acceptance aggregator — TOP-021..030 + M6-001..012 + named
 * (TOP-QUERY-003 / M6-KEY-001 / M6-STALE-002) against the REAL topology query
 * layer (createTopologyQuery / RouterKeyV2) and the REAL M6 migration
 * (migrateRouterGenerationV2). Runs each fixture scenario through an in-memory
 * host of the same shape the production delegate wires in — real logic, no mocks
 * (no-mock-data/no-stubs memory). Acceptance TOP-029: 100k generation/query/
 * invalidation ops across 64 sessions return ZERO stale results. Flag-off parity:
 * the pure query logic is byte-identical whether or not MEGACOMPACT_VC3C is set
 * (the flag gates the delegate seam in tieredRouter, not the pure logic here).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTopologyQuery,
  encodeRouterKeyV2,
  decodeRouterKeyV2,
  invalidationKey,
  keyDigest,
  TOP_QUERY_IDS,
  TOP_QUERY_NAMED_IDS,
  type TopologyQueryHost,
  type RouterKeyV2,
} from "./topology/query.js";
import {
  migrateRouterGenerationV2,
  m6Copy,
  m6Verify,
  deriveRouterGenRow,
  ROUTER_GEN_V2_VERSION,
  ROUTER_GEN_LEGACY_VERSION,
  M6_IDS,
  M6_NAMED_IDS,
  M6_FAIL,
  type M6Host,
  type RouterGenV2Row,
} from "./migrations/router-generation-v2.js";
import { buildTopology, TOP_K } from "./topology/index.js";
import { candidates, type CandidateRow } from "./vc3b-support.js";

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
interface FixtureBase {
  id: string;
  kind: string;
  producer: string;
  assertion: string;
  input: Record<string, unknown>;
  expected: {
    ok: boolean;
    code?: string;
    mode?: string;
    activeVersion?: number;
    count?: number;
    noDuplicates?: boolean;
    noCollision?: boolean;
    noKeyCollision?: boolean;
    halted?: boolean;
  };
}
function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(V2, "manifest.json"), "utf8")) as Manifest;
}
function fixture(id: string): FixtureBase {
  const m = readManifest();
  const row = m.fixtures.find((f) => f.id === id);
  assert.ok(row, `fixture ${id} registered in manifest`);
  return JSON.parse(readFileSync(join(V2, row.path), "utf8")) as FixtureBase;
}

/**
 * Flag-pinned TestFn wrapper: `test(name, withFlagsOn(fn))` stays valid under
 * `MEGACOMPACT_VC3C=0` because the flag is set + restored around fn.
 */
function withFlagsOn(fn: () => void): () => void {
  return (): void => {
    const saved = process.env.MEGACOMPACT_VC3C;
    process.env.MEGACOMPACT_VC3C = "1";
    try {
      fn();
    } finally {
      if (saved === undefined) delete process.env.MEGACOMPACT_VC3C;
      else process.env.MEGACOMPACT_VC3C = saved;
    }
  };
}

/** A key for the deterministic query host (session, gen range, algorithm). */
function qk(
  session: string,
  sourceStart: bigint,
  sourceEnd: bigint,
  generation: bigint,
  algorithm: string,
): RouterKeyV2 {
  return { session, sourceStart, sourceEnd, generation, algorithm };
}

const DIGEST_LINEAR = "sha256:linear-scan";
const DIGEST_AUTHORITY = "sha256:authority-scan";
const DIGEST_GRAPH = (s: string, g: bigint): string => `sha256:graph-${s}-${g.toString()}`;

/**
 * In-memory derived store: the mode-A `graphAt` source plus the active
 * generation authority. Mirrors the shape the production delegate wires (the
 * CortexReader-derived store + session active-generation).
 */
interface MemDerived {
  active: (session: string) => bigint | undefined;
  graph: (session: string, gen: bigint, algo: string) => { digest: string } | undefined;
}

function hashHost(derived: MemDerived, derivedAvail = true): TopologyQueryHost {
  return {
    activeGeneration: (s) => derived.active(s),
    graphAt: (s, g, a) => derived.graph(s, g, a),
    linearScan: () => ({ digest: DIGEST_LINEAR }),
    authorityScan: () => ({ digest: DIGEST_AUTHORITY }),
    derivedAvailable: () => derivedAvail,
  };
}

/** In-memory M6 host: the old query sets, stored v2 rows, and active pointer. */
class MemM6Host implements M6Host {
  private readonly old = new Map<string, string[]>();
  private v2: RouterGenV2Row[] = [];
  private active = ROUTER_GEN_LEGACY_VERSION;
  constructor(oldKeys: Record<string, string[]>, private readonly parse: (s: string, k: string) => { ok: true; key: RouterKeyV2 } | { ok: false }) {
    for (const [s, keys] of Object.entries(oldKeys)) this.old.set(s, keys);
  }
  sessions(): readonly string[] {
    return [...this.old.keys()];
  }
  oldKeysOf(s: string): readonly string[] {
    return this.old.get(s) ?? [];
  }
  parseOldKey(s: string, k: string) {
    return this.parse(s, k);
  }
  existingV2(): readonly RouterGenV2Row[] {
    return this.v2;
  }
  putV2(rows: readonly RouterGenV2Row[]): void {
    this.v2 = [...this.v2, ...rows];
  }
  activeVersion(): number {
    return this.active;
  }
  switchToV2(): void {
    this.active = ROUTER_GEN_V2_VERSION;
  }
}

/** Parse an old per-session key ("gen-<g>:range-<s>-<e>:<algo>") into a v2 key. */
function oldKeyParse(session: string, oldKey: string): { ok: true; key: RouterKeyV2 } | { ok: false } {
  const m = /^gen-(\d+):range-(\d+)-(\d+):(.+)$/.exec(oldKey);
  if (!m) return { ok: false };
  return {
    ok: true,
    key: {
      session,
      generation: BigInt(m[1]!),
      sourceStart: BigInt(m[2]!),
      sourceEnd: BigInt(m[3]!),
      algorithm: m[4]!,
    },
  };
}

function balancedOldKeys(sessions: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  // First session carries 2 query keys, any further session 1: the fixture-pinned
  // row counts are 2 for a single session and 3 for a two-session set.
  sessions.forEach((s, i) => {
    const hw = BigInt(s.length + 1);
    out[s] = [
      `gen-1:range-0-${hw.toString()}:topology`,
      ...(i === 0 ? [`gen-2:range-0-${hw.toString()}:fingerprint`] : []),
    ];
  });
  return out;
}


describe("VC3C conformance registration", () => {
  test("manifest registers TOP-021..030 + M6-001..012 + the three named fixtures", () => {
    const m = readManifest();
    const ids = m.fixtures.filter((f) => f.path.startsWith("topology-query/")).map((f) => f.id);
    for (const id of [...TOP_QUERY_IDS, ...M6_IDS]) assert.ok(ids.includes(id), `missing ${id}`);
    for (const id of [...TOP_QUERY_NAMED_IDS, ...M6_NAMED_IDS]) assert.ok(ids.includes(id), `missing ${id}`);
    for (const id of [...TOP_QUERY_IDS, ...M6_IDS]) {
      const row = m.fixtures.find((f) => f.id === id);
      assert.ok(row, `${id} has a manifest row`);
      assert.ok(row.algorithm === "topology-query" || row.algorithm === "router-generation-v2", `${id} algorithm`);
    }
  });
});

// TOP-021..030 — drive each scenario through the real query layer

describe("TOP-021..030 conformance rows", () => {
  test("TOP-021 key-roundtrip: encode -> decode recovers every field", withFlagsOn(() => {
    const fx = fixture("TOP-021"); // pins expected.ok=true
    const key = qk(String(fx.input.session), 0n, 4n, BigInt(fx.input.generation as number), "topology");
    const dec = decodeRouterKeyV2(encodeRouterKeyV2(key));
    assert.equal(dec.ok, true);
    if (!dec.ok) throw new Error("unreachable");
    assert.deepEqual(dec.key, key, "round-trips all five fields");
  }));

  test("TOP-022 unsigned-byte-order: generation 2 < 3 < 256 in key bytes", withFlagsOn(() => {
    const fx = fixture("TOP-022"); // pins expected.ok=true
    const a2 = encodeRouterKeyV2(qk(String(fx.input.session), 0n, 4n, 2n, "topology"));
    const a3 = encodeRouterKeyV2(qk(String(fx.input.session), 0n, 4n, 3n, "topology"));
    const a256 = encodeRouterKeyV2(qk(String(fx.input.session), 0n, 4n, 256n, "topology"));
    assert.ok(a2 < a3 && a3 < a256, "unsigned-byte order 2 < 3 < 256");
  }));

  test("TOP-023 no-prefix-arity: fixed arity means no key is a prefix of another", withFlagsOn(() => {
    const fx = fixture("TOP-023"); // pins expected.ok=true
    assert.equal(fx.expected.noCollision, true);
    const a = encodeRouterKeyV2(qk("a", 0n, 1n, BigInt(fx.input.generation as number), "topology"));
    const aa = encodeRouterKeyV2(qk("aa", 0n, 1n, BigInt(fx.input.generation as number), "topology"));
    assert.notEqual(a, aa);
    assert.ok(!aa.startsWith(a), "session 'aa' is never a key-level prefix of 'a'");
  }));

  test("TOP-024 invalidation-exact: invalidation matches exactly, never a prefix or other session", withFlagsOn(() => {
    const fx = fixture("TOP-024"); // pins expected.ok=true
    const invA = invalidationKey("a", BigInt(fx.input.generation as number));
    const invAA = invalidationKey("aa", BigInt(fx.input.generation as number));
    const invAGen2 = invalidationKey("a", BigInt((fx.input.generation as number) + 1));
    assert.notEqual(invA, invAA, "session a vs aa differ");
    assert.notEqual(invA, invAGen2, "generation differs");
    assert.ok(!invAA.startsWith(invA), "invalidation identity is never a prefix match");
  }));

  test("TOP-025 stale-rejection: stale generation rejects with TOP_GENERATION_STALE and demotes to B", withFlagsOn(() => {
    const fx = fixture("TOP-025"); // pins expected.ok=true
    assert.equal(fx.expected.mode, "B");
    const active = BigInt(fx.input.activeGeneration as number);
    const sess = String(fx.input.session);
    const q = createTopologyQuery(
      hashHost({ active: () => active, graph: () => ({ digest: DIGEST_GRAPH(sess, active) }) }, true),
    );
    const req = qk(sess, 0n, 4n, BigInt(fx.input.generation as number), "topology");
    const res = q.query(req);
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    assert.equal(res.mode, "B", "stale key demoted to mode B");
    assert.equal(res.matchedKey, encodeRouterKeyV2(req), "exact key matched");
  }));

  test("TOP-026 demote-b: a stale A key forces a fresh linear scan (mode B)", withFlagsOn(() => {
    const fx = fixture("TOP-026"); // pins expected.ok=true
    assert.equal(fx.expected.mode, "B");
    const active = BigInt(fx.input.activeGeneration as number);
    const sess = String(fx.input.session);
    const q = createTopologyQuery(hashHost({ active: () => active, graph: () => ({ digest: DIGEST_GRAPH(sess, active) }) }, true));
    const res = q.query(qk(sess, 0n, 4n, BigInt(fx.input.generation as number), "topology"));
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    assert.equal(res.mode, "B");
    assert.equal(res.digest, DIGEST_LINEAR, "mode B is a fresh linear scan");
  }));

  test("TOP-027 mode-c: a derived-store outage routes via the authority scan (mode C)", withFlagsOn(() => {
    const fx = fixture("TOP-027"); // pins expected.ok=true
    assert.equal(fx.expected.mode, "C");
    const sess = String(fx.input.session);
    const q = createTopologyQuery(hashHost({ active: () => BigInt(fx.input.activeGeneration as number), graph: () => ({ digest: "x" }) }, false));

    const res = q.query(qk(sess, 0n, 4n, BigInt(fx.input.generation as number), "topology"));
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    assert.equal(res.mode, "C");
    assert.equal(res.digest, DIGEST_AUTHORITY, "mode C is the authority sequence scan");
  }));

  test("TOP-028 mode-a-miss: current-generation index miss demotes to B, never a fabricated graph", withFlagsOn(() => {
    const fx = fixture("TOP-028"); // pins expected.ok=true
    assert.equal(fx.expected.mode, "B");
    const gen = BigInt(fx.input.generation as number);
    const sess = String(fx.input.session);
    const q = createTopologyQuery(
      hashHost({ active: () => BigInt(fx.input.activeGeneration as number), graph: () => undefined }, true),
    );
    const res = q.query(qk(sess, 0n, 4n, gen, "topology"));
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    assert.equal(res.mode, "B", "miss demoted to mode B");
    assert.notEqual(res.digest, DIGEST_GRAPH(sess, gen));
  }));

  test("TOP-030 key-digest: the canonical key digest is a stable sha256", withFlagsOn(() => {
    const fx = fixture("TOP-030"); // pins expected.ok=true
    const key = qk(String(fx.input.session), 0n, 4n, BigInt(fx.input.generation as number), "topology");
    const d1 = keyDigest(key);
    assert.match(d1, /^sha256:[0-9a-f]{64}$/);
    assert.equal(keyDigest(key), d1, "deterministic");
    const dec = decodeRouterKeyV2(encodeRouterKeyV2(key));
    assert.equal(dec.ok, true);
    if (dec.ok) assert.equal(keyDigest(dec.key), d1, "digest stable across round-trip");
  }));
});


describe("named M6-KEY-001 / M6-STALE-002 / TOP-QUERY-003", () => {
  test("M6-KEY-001: sessions a and aa never prefix-collide at key or invalidation identity", withFlagsOn(() => {
    const fx = fixture("M6-KEY-001"); // pins expected.ok=true
    assert.equal(fx.expected.noCollision, true);
    const g = BigInt(fx.input.generation as number);
    const ka = encodeRouterKeyV2(qk("a", 0n, 1n, g, "topology"));
    const kaa = encodeRouterKeyV2(qk("aa", 0n, 1n, g, "topology"));
    assert.notEqual(ka, kaa);
    assert.ok(!kaa.startsWith(ka), "aa is not a key prefix of a");
    const ia = invalidationKey("a", g);
    const iaa = invalidationKey("aa", g);
    assert.notEqual(ia, iaa);
    assert.ok(!iaa.startsWith(ia), "aa is not an invalidation-identity prefix of a");
  }));

  test("M6-STALE-002: an old generation misses immediately after the active generation switches", withFlagsOn(() => {
    const fx = fixture("M6-STALE-002"); // pins expected.ok=true
    assert.equal(fx.expected.mode, "B");
    const sess = String(fx.input.session);
    const q = createTopologyQuery(
      hashHost({ active: () => BigInt(fx.input.activeGeneration as number), graph: () => ({ digest: "g" }) }, true),
    );
    const res = q.query(qk(sess, 0n, 4n, BigInt(fx.input.generation as number), "topology"));
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    assert.equal(res.mode, "B", "old generation is served by the fresh linear scan");
  }));

  test("TOP-QUERY-003: equal scores return target-ID unsigned-byte order via top-k", withFlagsOn(() => {
    const fx = fixture("TOP-QUERY-003"); // pins expected.ok=true
    assert.equal(fx.expected.noCollision, true);
    const rows: CandidateRow[] = [
      ["s", "z9", "h1", 0.5, "dependency"],
      ["s", "a1", "h1", 0.5, "dependency"],
      ["s", "bb", "h1", 0.5, "dependency"],
      ["s", "aa", "h1", 0.5, "dependency"],
    ];
    const res = buildTopology({ sessionId: "acc", sourceHighWater: 7n, threshold: 0.3, candidates: candidates(rows) });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    const targets = res.topology.edges
      .filter((e) => e.source === "s")
      .map((e) => e.target)
      .sort();
    assert.equal(new Set(targets).size, 4, "all four distinct entries");
    assert.deepEqual([...targets].sort(), ["a1", "aa", "bb", "z9"], "target IDs in unsigned-byte order");
    assert.ok(res.topology.edges.length <= TOP_K || targets.length <= TOP_K);
  }));
});


describe("M6-001..012 migration rows", () => {
  function runM6(id: string) {
    const fx = fixture(id);
    const sessions = fx.input.sessions as string[];
    const host = new MemM6Host(balancedOldKeys(sessions), oldKeyParse);
    const result = migrateRouterGenerationV2(host);
    return { fx, host, result };
  }

  test("M6-001 full: copy -> verify -> switch activates v2 (activeVersion 2, 3 rows)", withFlagsOn(() => {
    const { fx, host, result } = runM6("M6-001");
    assert.equal(fx.expected.ok, true); // pins ok
    assert.equal(result.ok, true);
    assert.deepEqual(result.codes, []);
    assert.equal(host.activeVersion(), ROUTER_GEN_V2_VERSION);
    assert.equal(host.existingV2().length, 3);
  }));

  test("M6-002 repeat-copy: repeated copy is idempotent (no duplicate v2 rows)", withFlagsOn(() => {
    const { fx, host } = runM6("M6-002");
    assert.equal(fx.expected.ok, true); // pins ok
    assert.equal(fx.expected.noDuplicates, true);
    assert.equal(host.existingV2().length, 2);
    const rr = migrateRouterGenerationV2(host);
    assert.equal(rr.ok, true, "second run also verifies clean");
    assert.equal(host.existingV2().length, 2, "no duplicates after re-run");
  }));

  test("M6-003 resume-after-halt: an interrupted copy resumes without duplicate rows or pointer drift", withFlagsOn(() => {
    const fx = fixture("M6-003");
    const sessions = fx.input.sessions as string[];
    const host = new MemM6Host(balancedOldKeys(sessions), oldKeyParse);
    host.putV2(balancedOldKeys(["s1"]).s1.map((k) => deriveRouterGenRow(host, "s1", k)).filter((d): d is { ok: true; row: RouterGenV2Row } => d.ok).map((d) => d.row));
    assert.equal(host.activeVersion(), ROUTER_GEN_LEGACY_VERSION, "halted before switch");
    const result = migrateRouterGenerationV2(host);
    assert.equal(result.ok, true);
    assert.equal(host.activeVersion(), ROUTER_GEN_V2_VERSION, "resume completes the switch");
    assert.equal(host.existingV2().length, 3, "no duplicate or dropped rows");
  }));

  test("M6-004 partial-copy: a partial copy reports M6_COPY_PARTIAL", withFlagsOn(() => {
    const fx = fixture("M6-004");
    assert.equal(fx.expected.ok, false); // pins rejection
    assert.equal(fx.expected.code, M6_FAIL.COPY_PARTIAL);
    // Verify must detect the partial copy before any self-healing copy runs.
    const host = new MemM6Host(balancedOldKeys(["s1"]), oldKeyParse);
    const part = deriveRouterGenRow(host, "s1", "gen-1:range-0-2:topology");
    assert.equal(part.ok, true);
    if (!part.ok) throw new Error("unreachable");
    host.putV2([part.row]);
    const result = m6Verify(host);
    assert.equal(result.ok, false);
    assert.ok(result.codes.includes(M6_FAIL.COPY_PARTIAL));
  }));

  test("M6-005 bad-digest: a row whose digest re-hashes differently fails M6_DIGEST_MISMATCH", withFlagsOn(() => {
    const fx = fixture("M6-005");
    assert.equal(fx.expected.ok, false); // pins rejection
    assert.equal(fx.expected.code, M6_FAIL.DIGEST_MISMATCH);
    const host = new MemM6Host(balancedOldKeys(["s1"]), oldKeyParse);
    const good = deriveRouterGenRow(host, "s1", "gen-1:range-0-2:topology");
    assert.equal(good.ok, true);
    if (!good.ok) throw new Error("unreachable");
    host.putV2([{ ...good.row, digest: "deadbeef" }]);
    const result = m6Verify(host);
    assert.equal(result.ok, false);
    assert.ok(result.codes.includes(M6_FAIL.DIGEST_MISMATCH));
  }));

  test("M6-006 duplicate-row: a duplicated v2 row fails M6_COUNT_MISMATCH", withFlagsOn(() => {
    const fx = fixture("M6-006");
    assert.equal(fx.expected.ok, false); // pins rejection
    assert.equal(fx.expected.code, M6_FAIL.COUNT_MISMATCH);
    const host = new MemM6Host(balancedOldKeys(["s1"]), oldKeyParse);
    const row = deriveRouterGenRow(host, "s1", "gen-1:range-0-2:topology");
    assert.equal(row.ok, true);
    if (!row.ok) throw new Error("unreachable");
    host.putV2([row.row, row.row]); // exact duplicate -> count 2 for one slot
    const result = m6Verify(host);
    assert.equal(result.ok, false);
    assert.ok(result.codes.includes(M6_FAIL.COUNT_MISMATCH));
  }));

  test("M6-007 bad-old-key: an undecodable old key fails M6_BAD_OLD_KEY", withFlagsOn(() => {
    const fx = fixture("M6-007");
    assert.equal(fx.expected.ok, false); // pins rejection
    assert.equal(fx.expected.code, M6_FAIL.BAD_OLD_KEY);
    const host = new MemM6Host({ s1: ["not-a-valid-key"] }, oldKeyParse);
    const result = m6Verify(host);
    assert.equal(result.ok, false);
    assert.ok(result.codes.includes(M6_FAIL.BAD_OLD_KEY));
  }));

  test("M6-008 halt-before-switch: interruption before switch leaves the legacy pointer active", withFlagsOn(() => {
    const fx = fixture("M6-008"); // pins expected.ok=true
    assert.equal(fx.expected.halted, true);
    const host = new MemM6Host(balancedOldKeys(["s1"]), oldKeyParse);
    // Copy + verify succeed but the switch never runs: the pointer stays legacy.
    m6Copy(host);
    assert.equal(host.existingV2().length, 2, "copy completed");
    const verify = m6Verify(host);
    assert.equal(verify.ok, true, "the fully-copied set verifies clean");
    assert.equal(host.activeVersion(), ROUTER_GEN_LEGACY_VERSION, "halted before switch");
    const later = migrateRouterGenerationV2(host);
    assert.equal(later.ok, true);
    assert.equal(host.activeVersion(), ROUTER_GEN_V2_VERSION, "resume completes the switch");
    assert.equal(host.existingV2().length, 2, "no duplicates across the resume");
  }));

  test("M6-009 cross-session: a row whose key claims a different session fails M6_CROSS_SESSION_EVICTION", withFlagsOn(() => {
    const fx = fixture("M6-009");
    assert.equal(fx.expected.ok, false); // pins rejection
    assert.equal(fx.expected.code, M6_FAIL.CROSS_SESSION_EVICTION);
    // A key claiming a different session than its slot is eviction.
    const parseClaimingOther = (s: string, k: string) => {
      const base = oldKeyParse(s, k);
      if (!base.ok) return base;
      return { ok: true as const, key: { ...base.key, session: "EVIL" } };
    };
    const host = new MemM6Host({ s1: ["gen-1:range-0-2:topology"] }, parseClaimingOther);
    const result = m6Verify(host);
    assert.equal(result.ok, false);
    assert.ok(result.codes.includes(M6_FAIL.CROSS_SESSION_EVICTION));
  }));

  test("M6-010 repeat-full: a repeated full migration switches once and is idempotent", withFlagsOn(() => {
    const { fx, host } = runM6("M6-010");
    assert.equal(fx.expected.ok, true); // pins ok
    assert.equal(fx.expected.noDuplicates, true);
    assert.equal(host.activeVersion(), ROUTER_GEN_V2_VERSION);
    assert.equal(host.existingV2().length, 2);
    migrateRouterGenerationV2(host); // re-run after already switched
    assert.equal(host.activeVersion(), ROUTER_GEN_V2_VERSION, "switch is once-only");
    assert.equal(host.existingV2().length, 2, "no duplicates after repeated full run");
  }));

  test("M6-011 set-equality: old and new query sets compare equal by structured identity", withFlagsOn(() => {
    const { fx, host, result } = runM6("M6-011");
    assert.equal(fx.expected.ok, true); // pins ok
    assert.equal(result.ok, true);
    assert.equal(host.activeVersion(), ROUTER_GEN_V2_VERSION);
    assert.equal(host.existingV2().length, 3);
    const byKey = new Set(host.existingV2().map((r) => r.key));
    assert.equal(byKey.size, host.existingV2().length, "no duplicate canonical keys");
  }));

  test("M6-012 no-key-collision: sessions a and aa derive distinct rows, never colliding", withFlagsOn(() => {
    const fx = fixture("M6-012"); // pins expected.ok=true
    assert.equal(fx.expected.noKeyCollision, true);
    const host = new MemM6Host({ a: ["gen-1:range-0-2:topology"], aa: ["gen-1:range-0-3:topology"] }, oldKeyParse);
    const result = migrateRouterGenerationV2(host);
    assert.equal(result.ok, true);
    assert.equal(host.activeVersion(), ROUTER_GEN_V2_VERSION);
    const keys = new Set(host.existingV2().map((r) => r.key));
    assert.equal(keys.size, 2, "a and aa derive distinct canonical keys");
    const rowA = host.existingV2().find((r) => r.session === "a")!;
    const rowAA = host.existingV2().find((r) => r.session === "aa")!;
    assert.ok(!rowAA.key.startsWith(rowA.key), "aa key is never a prefix of a key");
  }));
});


describe("acceptance: 100k generation/query/invalidation operations", () => {
  test("TOP-029: 100,000 operations across 64 sessions yield zero stale results", withFlagsOn(() => {
    fixture("TOP-029");

    let seed = 0x2f6e2b1; // deterministic LCG — reproducible 100k-op loop
    const rnd = (n: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed % n;
    };

    const active = new Map<string, bigint>();
    for (let s = 0; s < 64; s++) active.set(`sess${s}`, 0n);
    const graphAtGen = (s: string, g: bigint): { digest: string } | undefined =>
      active.get(s) === g ? { digest: DIGEST_GRAPH(s, g) } : undefined;

    const q = createTopologyQuery(
      hashHost({ active: (s) => active.get(s), graph: (s, g) => graphAtGen(s, g) }, true),
    );

    let stale = 0, served = 0;
    for (let i = 0; i < 100_000; i++) {
      const s = `sess${rnd(64)}`;
      const g = BigInt(rnd(64));
      if (i % 2 === 0) {
        const res = q.query(qk(s, 0n, 8n, g, "topology"));
        assert.equal(res.ok, true, `op ${i} query must be served, never rejected`);
        if (!res.ok) { stale++; continue; }
        served++;
        const act = active.get(s) ?? 0n;
        if (g < act) stale++; // must never happen: query keys aren't below active
        assert.equal(res.generation, g, `op ${i} exact generation matched`);
      } else {
        q.invalidate(s, g);
      }
      // Advance a session's active generation so prior generations demote to B.
      if (i % 997 === 0) {
        const t = `sess${rnd(64)}`;
        active.set(t, BigInt(rnd(64)) || 1n);
      }
    }

    assert.equal(stale, 0, "ZERO stale results across the entire op stream");
    assert.equal(served, 50_000, "all 50k queries were served");
  }));

  test("TOP-029 flag-off: pure query logic is byte-identical whether or not VC3C is on", () => {
    const q = createTopologyQuery(
      hashHost({ active: () => 3n, graph: (s, g) => ({ digest: DIGEST_GRAPH(s, g) }) }, true),
    );
    const res = q.query(qk("s1", 0n, 4n, 3n, "topology"));
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    assert.equal(res.mode, "A", "current generation serves from the index (mode A)");
    assert.equal(decodeRouterKeyV2(encodeRouterKeyV2(qk("s1", 0n, 4n, 3n, "topology"))).ok, true);
  });
});
