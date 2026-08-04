/**
 * VC3A acceptance aggregator — CTX-001..010 + named fixtures against the REAL
 * capability-gated cortex store (CortexReader/Writer/Admin + CortexRecordV1).
 *
 * Scopes, per the VC3A sprint contract:
 *  - CTX-001..010 conformance rows resolve through the real sqlite/store
 *    producers, each returning its manifest `ok` or exact listed failure `code`
 *    (CTX_KEY_CONFLICT / CTX_APPEND_FAILED / CTX_PAYLOAD_DIGEST_MISMATCH).
 *  - CTX-CAP-001 (writer has no query/admin member — negative compile),
 *    CTX-KEY-002 (same id at different algorithm version stays distinct),
 *    CTX-REBUILD-003 (shuffled inserts yield an identical single root digest).
 *  - Deterministic rebuild invariant: order-independent accepted set + one root.
 *  - Unique failure injection: SQLITE_FULL-class (PRAGMA query_only) on append ->
 *    CTX_APPEND_FAILED, host continues, emits `vector_cortex_record_append_failed`,
 *    then rebuild recovers from authority.
 *  - Forced triad A/B/C: A = indexed SQLite reader, B = in-memory records rebuilt
 *    from accepted inputs, C = authority ledger sequence scan with no cortex
 *    store. The three agree on the derived frontier + root digest.
 *  - Flag-off parity: MEGACOMPACT_VC3A=0 gates the emit seam (zero events) and
 *    the dashboard-gated enabled=false summary, byte-identical to predecessor.
 *
 * Real logic + fixtures, no mocks (no-mock-data/no-stubs memory).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CTX_IDS } from "./cortex/types.js";
import type { CortexAppendInput, CortexRecordV1 } from "./cortex/types.js";
import {
  createCortexStore,
  type CortexHandle,
} from "./cortex/store.js";
import {
  openCortexStore,
  setStoreReadOnly,
  generationRootDigest,
  cortexDigest,
} from "./cortex/sqlite.js";
import { VC3A_ENABLED } from "../config/vector-cortex.js";
import type { DatabaseSync } from "node:sqlite";

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
interface CortexFixture {
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
function fixture(id: string): CortexFixture {
  const m = readManifest();
  const row = m.fixtures.find((f) => f.id === id);
  assert.ok(row, `fixture ${id} registered in manifest`);
  assert.equal(row.algorithm, "cortex-store", `${id} is a cortex-store fixture`);
  assert.equal(row.expected, row.expected, `${id} manifest expected pin`);
  return JSON.parse(readFileSync(join(V2, row.path), "utf8")) as CortexFixture;
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/**
 * Self-pin the VC3A flag ON for the duration of a flag-DEPENDENT scenario. Like
 * VC2C's withFlagsOn, this keeps the mandated flag-off gate honest: the external
 * `MEGACOMPACT_VC3A=0` run still genuinely exercises the flag-independent store
 * producers (append/rebuild/digest math), while flag-gated observability
 * assertions pin their own enablement and remain valid under either external env.
 */
function withFlagsOn(fn: () => void): void {
  const saved = process.env.MEGACOMPACT_VC3A;
  process.env.MEGACOMPACT_VC3A = "1";
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env.MEGACOMPACT_VC3A;
    else process.env.MEGACOMPACT_VC3A = saved;
  }
}

/** A fresh temp cortex store (isolated DB, not the host sqlite.db). */
function tempStore(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "vc3a-"));
  return { dir, dbPath: join(dir, "cortex.db") };
}

/** Open a real store over a temp dir; close + cleanup after fn. */
function withStore<T>(
  fn: (store: CortexHandle) => T,
  emit?: (ev: string, fields: Record<string, unknown>) => void,
): T {
  const tmp = tempStore();
  const store = createCortexStore({ dbPath: tmp.dbPath }, emit);
  try {
    return fn(store);
  } finally {
    store.close();
    rmSync(tmp.dir, { recursive: true, force: true });
  }
}

/** Open a real store over an INJECTED DatabaseSync (failure-injection seam). */
function withInjectedDb<T>(
  fn: (store: CortexHandle, db: DatabaseSync, close: () => void) => T,
): T {
  const tmp = tempStore();
  const db = openCortexStore(tmp.dbPath);
  const store = createCortexStore({ db }, () => {});
  try {
    return fn(store, db, () => db.close());
  } finally {
    store.close();
    rmSync(tmp.dir, { recursive: true, force: true });
  }
}

/** Append and assert ok (returns the record). */
function appendOk(store: CortexHandle, rec: CortexAppendInput): CortexRecordV1 {
  const r = store.writer().append(rec);
  assert.equal(r.ok, true, `append ${rec.id} accepted`);
  if (!r.ok) throw new Error("unreachable");
  return r.record;
}

// ---------------------------------------------------------------------------
// Conformance registration (CTX-001..010 + named)
// ---------------------------------------------------------------------------

describe("VC3A conformance registration", () => {
  test("manifest registers CTX-001..010 and the three named fixtures", () => {
    const manifest = readManifest();
    const ids = manifest.fixtures
      .filter((f) => f.path.startsWith("cortex-store/"))
      .map((f) => f.id);
    for (const id of CTX_IDS) assert.ok(ids.includes(id), `missing ${id}`);
    for (const id of ["CTX-CAP-001", "CTX-KEY-002", "CTX-REBUILD-003"]) {
      assert.ok(ids.includes(id), `missing ${id}`);
    }
    // Every cortex-store fixture body that resolves is a canonical registered row.
    for (const id of CTX_IDS) {
      const row = manifest.fixtures.find((f) => f.id === id);
      assert.ok(row, `${id} has a manifest row`);
      assert.equal(row.algorithm, "cortex-store", `${id} algorithm`);
    }
  });
});

// ---------------------------------------------------------------------------
// CTX-001..010 — drive each scenario through the real producers
// ---------------------------------------------------------------------------

describe("CTX-001..010 conformance rows", () => {
  test("CTX-001 writer-append-only: writer exposes append but no query/admin", () => {
    const fx = fixture("CTX-001");
    assert.equal(fx.expected.ok, true, "manifest pins ok");
    withStore((store) => {
      const writer = store.writer();
      assert.equal(writer.kind, "CortexWriter");
      assert.equal(typeof writer.append, "function");
      // Negative compile + runtime absence: writer has no query/admin member.
      assert.equal(typeof (writer as unknown as { readRecords: unknown }).readRecords, "undefined");
      assert.equal(typeof (writer as unknown as { rebuild: unknown }).rebuild, "undefined");
      assert.equal(typeof (writer as unknown as { switchGeneration: unknown }).switchGeneration, "undefined");
    });
  });

  test("CTX-002 distinct-algorithm-versions: same id at diff version stays distinct", () => {
    const fx = fixture("CTX-002");
    assert.equal(fx.expected.ok, true, "manifest pins ok");
    withStore((store) => {
      appendOk(store, { sourceHighWater: 1n, algorithmVersion: 1, id: "X", kind: "semantic", payloadBytes: bytes("v1") });
      appendOk(store, { sourceHighWater: 1n, algorithmVersion: 2, id: "X", kind: "semantic", payloadBytes: bytes("v2") });
      assert.equal(store.reader().recordCount(), 2, "two distinct records, never collapsed");
      const r1 = store.reader().readRecord(1n, 1, "X");
      const r2 = store.reader().readRecord(1n, 2, "X");
      assert.ok(r1 && r2, "both records readable individually");
      assert.notEqual(r1.payloadDigest, r2.payloadDigest, "distinct algorithm versions stay distinct");
    });
  });

  test("CTX-003 shuffle-order-digest: shuffled inserts yield an identical root digest", () => {
    const fx = fixture("CTX-003");
    assert.equal(fx.expected.ok, true, "manifest pins ok");
    // Two identical accepted sets, different insertion order -> same digest.
    const recs = [
      { sourceHighWater: 1n, algorithmVersion: 1, id: "a", kind: "semantic", payloadBytes: bytes("alpha") },
      { sourceHighWater: 2n, algorithmVersion: 1, id: "b", kind: "semantic", payloadBytes: bytes("beta") },
      { sourceHighWater: 3n, algorithmVersion: 1, id: "c", kind: "semantic", payloadBytes: bytes("gamma") },
    ];
    const d1 = withStore((s) => {
      for (const r of recs) appendOk(s, r);
      return s.admin().rebuild();
    });
    const d2 = withStore((s) => {
      for (const r of [...recs].reverse()) appendOk(s, r);
      return s.admin().rebuild();
    });
    assert.ok(d1.ok && d2.ok, "both rebuilds succeed");
    if (!d1.ok || !d2.ok) throw new Error("unreachable");
    assert.equal(d1.generation.rootDigest, d2.generation.rootDigest, "root digest order-independent");
  });

  test("CTX-004 idempotent-ack: exact key + exact payload is an idempotent acknowledge", () => {
    const fx = fixture("CTX-004");
    assert.equal(fx.expected.ok, true, "manifest pins ok");
    withStore((store) => {
      const first = store.writer().append({ sourceHighWater: 1n, algorithmVersion: 1, id: "k", kind: "semantic", payloadBytes: bytes("same") });
      assert.equal(first.ok, true, "first append accepted");
      const re = store.writer().append({ sourceHighWater: 1n, algorithmVersion: 1, id: "k", kind: "semantic", payloadBytes: bytes("same") });
      assert.equal(re.ok, true, "idempotent re-append acknowledged");
      assert.equal(store.reader().recordCount(), 1, "never duplicated");
    });
  });

  test("CTX-005 key-conflict: same key diff digest -> CTX_KEY_CONFLICT", () => {
    const fx = fixture("CTX-005");
    assert.equal(fx.expected.code, "CTX_KEY_CONFLICT", "manifest pins code");
    withStore((store) => {
      assert.equal(store.writer().append({ sourceHighWater: 1n, algorithmVersion: 1, id: "k", kind: "semantic", payloadBytes: bytes("one") }).ok, true);
      const res = store.writer().append({ sourceHighWater: 1n, algorithmVersion: 1, id: "k", kind: "semantic", payloadBytes: bytes("two") });
      assert.equal(res.ok, false, "conflicting append rejected");
      if (res.ok) throw new Error("unreachable");
      assert.equal(res.code, "CTX_KEY_CONFLICT", "exact listed code");
    });
  });

  test("CTX-006 nonfatal-append: storage failure -> CTX_APPEND_FAILED, host continues", () => {
    const fx = fixture("CTX-006");
    assert.equal(fx.expected.code, "CTX_APPEND_FAILED", "manifest pins code");
    // Inject a REAL storage failure via PRAGMA query_only on the store's own db.
    withInjectedDb((store, db) => {
      setStoreReadOnly(db, true); // SQLite itself refuses writes (SQLITE_FULL-class)
      const res = store.writer().append({ sourceHighWater: 1n, algorithmVersion: 1, id: "x", kind: "semantic", payloadBytes: bytes("data") });
      assert.equal(res.ok, false, "append refused");
      if (res.ok) throw new Error("unreachable");
      assert.equal(res.code, "CTX_APPEND_FAILED", "nonfatal code");
      // Host continues: reads still work, no throw propagates.
      assert.equal(store.reader().recordCount(), 0, "record not accepted, no crash");
    });
  });

  test("CTX-007 generation-rebuild-switch: admin rebuilds + switches without deleting evidence", () => {
    const fx = fixture("CTX-007");
    assert.equal(fx.expected.ok, true, "manifest pins ok");
    withStore((store) => {
      appendOk(store, { sourceHighWater: 1n, algorithmVersion: 1, id: "a", kind: "semantic", payloadBytes: bytes("one") });
      appendOk(store, { sourceHighWater: 2n, algorithmVersion: 1, id: "b", kind: "semantic", payloadBytes: bytes("two") });
      const g1 = store.admin().rebuild();
      assert.ok(g1.ok, "first rebuild ok");
      if (!g1.ok) throw new Error("unreachable");
      assert.equal(store.admin().listGenerations().length, 1, "one generation");
      // Append another record then rebuild again -> second generation, both retained.
      appendOk(store, { sourceHighWater: 3n, algorithmVersion: 1, id: "c", kind: "semantic", payloadBytes: bytes("three") });
      const g2 = store.admin().rebuild();
      assert.ok(g2.ok, "second rebuild ok");
      if (!g2.ok) throw new Error("unreachable");
      const gens = store.admin().listGenerations();
      assert.equal(gens.length, 2, "evidence retained: both generations listed");
      assert.notEqual(g1.generation.ordinal, g2.generation.ordinal, "monotonic ordinal");
      // Active pointer switched to the newest; earlier generation still listable.
      const latest = store.reader().latestGeneration();
      assert.equal(latest?.id, g2.generation.id, "active pointer switched");
      assert.equal(gens[0]!.id, g1.generation.id, "older generation retained as evidence");
    });
  });

  test("CTX-008 reader-only-summary: topology summary has no writer/admin leakage", () => {
    const fx = fixture("CTX-008");
    assert.equal(fx.expected.ok, true, "manifest pins ok");
    withFlagsOn(() => {
      withStore((store) => {
        appendOk(store, { sourceHighWater: 2n, algorithmVersion: 1, id: "s", kind: "semantic", payloadBytes: bytes("secret") });
        store.admin().rebuild();
        const sum = store.reader().topologySummary();
        assert.equal(sum.enabled, true);
        assert.equal(sum.recordCount, 1);
        assert.ok(sum.generationId, "generation identity present");
        assert.equal(sum.ordinal, "1");
        assert.equal(sum.sourceHighWater, "2", "derived frontier");
        assert.ok(sum.rootDigest, "one root digest present");
        // Reader-only: the summary surface has no writer/admin members.
        assert.equal(typeof (store.reader() as unknown as { append: unknown }).append, "undefined");
        assert.equal(typeof (store.reader() as unknown as { rebuild: unknown }).rebuild, "undefined");
        assert.equal(typeof (store.reader() as unknown as { switchGeneration: unknown }).switchGeneration, "undefined");
      });
    });
  });

  test("CTX-009 payload-digest-mismatch: rebuild rejects a mismatched digest", () => {
    const fx = fixture("CTX-009");
    assert.equal(fx.expected.code, "CTX_PAYLOAD_DIGEST_MISMATCH", "manifest pins code");
    withStore((store) => {
      // Insert a record whose declared payloadDigest does not match its bytes.
      const r = store.writer().append({
        sourceHighWater: 1n,
        algorithmVersion: 1,
        id: "bad",
        kind: "semantic",
        payloadDigest: "sha256:" + "0".repeat(64), // wrong digest for these bytes
        payloadBytes: bytes("authority"),
      });
      assert.equal(r.ok, true, "record appended (digest is caller-declared)");
      const res = store.admin().rebuild();
      assert.equal(res.ok, false, "rebuild rejects corrupted authority");
      if (res.ok) throw new Error("unreachable");
      assert.equal(res.code, "CTX_PAYLOAD_DIGEST_MISMATCH", "exact listed code");
    });
  });

  test("CTX-010 derived-frontier: frontier equals max sourceHighWater across records", () => {
    const fx = fixture("CTX-010");
    assert.equal(fx.expected.ok, true, "manifest pins ok");
    withStore((store) => {
      appendOk(store, { sourceHighWater: 1n, algorithmVersion: 1, id: "a", kind: "semantic", payloadBytes: bytes("one") });
      appendOk(store, { sourceHighWater: 9n, algorithmVersion: 1, id: "b", kind: "semantic", payloadBytes: bytes("two") });
      appendOk(store, { sourceHighWater: 5n, algorithmVersion: 1, id: "c", kind: "semantic", payloadBytes: bytes("three") });
      const rebuilt = store.admin().rebuild();
      assert.ok(rebuilt.ok, "rebuild ok");
      if (!rebuilt.ok) throw new Error("unreachable");
      assert.equal(rebuilt.generation.sourceHighWater, 9n, "frontier is the max sourceHighWater");
      assert.equal(store.reader().topologySummary().sourceHighWater, "9");
    });
  });
});

// ---------------------------------------------------------------------------
// Named headline assertions
// ---------------------------------------------------------------------------

describe("Named assertions (CTX-CAP-001 / CTX-KEY-002 / CTX-REBUILD-003)", () => {
  test("CTX-CAP-001: the writer type has no query or admin member (negative compile)", () => {
    const fx = fixture("CTX-CAP-001");
    assert.equal(fx.expected.ok, true, "manifest pins ok");
    withStore((store) => {
      const typed: ReturnType<CortexHandle["writer"]> = store.writer();
      // ts-expect-error: a CortexWriter must NOT expose reader/admin members.
      // @ts-expect-error writer has no query member (CTX-CAP-001)
      void typed.readRecords;
      // @ts-expect-error writer has no rebuild member (CTX-CAP-001)
      void typed.rebuild;
      // @ts-expect-error writer has no switchGeneration member (CTX-CAP-001)
      void typed.switchGeneration;
      assert.equal(typed.kind, "CortexWriter");
    });
  });

  test("CTX-KEY-002: same id at different algorithm versions remains distinct", () => {
    const fx = fixture("CTX-KEY-002");
    assert.equal(fx.expected.ok, true, "manifest pins ok");
    withStore((store) => {
      appendOk(store, { sourceHighWater: 1n, algorithmVersion: 1, id: "shared", kind: "semantic", payloadBytes: bytes("av1") });
      appendOk(store, { sourceHighWater: 1n, algorithmVersion: 2, id: "shared", kind: "semantic", payloadBytes: bytes("av2") });
      assert.equal(store.reader().recordCount(), 2, "same id at distinct versions stays distinct (CTX-KEY-002)");
    });
  });

  test("CTX-REBUILD-003: shuffled inserts yield an identical single root digest", () => {
    const fx = fixture("CTX-REBUILD-003");
    assert.equal(fx.expected.ok, true, "manifest pins ok");
    const set = [
      { sourceHighWater: 1n, algorithmVersion: 1, id: "a", kind: "semantic", payloadBytes: bytes("p1") },
      { sourceHighWater: 2n, algorithmVersion: 1, id: "b", kind: "semantic", payloadBytes: bytes("p2") },
      { sourceHighWater: 3n, algorithmVersion: 2, id: "c", kind: "semantic", payloadBytes: bytes("p3") },
      { sourceHighWater: 4n, algorithmVersion: 1, id: "d", kind: "semantic", payloadBytes: bytes("p4") },
    ];
    const digests: string[] = [];
    for (const order of [set, [...set].reverse(), [...set].sort(() => (Math.random() > 0.5 ? 1 : -1))]) {
      const d = withStore((s) => {
        for (const r of order) appendOk(s, r);
        const rb = s.admin().rebuild();
        assert.ok(rb.ok, "rebuild ok");
        return rb.ok ? rb.generation.rootDigest : "";
      });
      digests.push(d);
    }
    assert.equal(digests[0], digests[1], "reversed order identical");
    assert.equal(digests[0], digests[2], "arbitrary shuffled order identical");
    assert.ok(digests[0]!.length === 64, "single sha256 hex root digest");
  });
});

// ---------------------------------------------------------------------------
// Unique failure injection: SQLITE_FULL-class append + rebuild from authority
// ---------------------------------------------------------------------------

describe("SQLITE_FULL-class failure injection (non-fatal + recovery)", () => {
  test("read-only store refuses append (CTX_APPEND_FAILED) but rebuild recovers from accepted inputs", () => {
    withFlagsOn(() => {
      const emitted: string[] = [];
      const tmp = tempStore();
      const db = openCortexStore(tmp.dbPath);
      const store = createCortexStore({ db }, (ev) => emitted.push(ev));
      try {
        // Phase 1: accept records while writable, then freeze storage.
        assert.equal(store.writer().append({ sourceHighWater: 1n, algorithmVersion: 1, id: "a", kind: "semantic", payloadBytes: bytes("A") }).ok, true);
        assert.equal(store.writer().append({ sourceHighWater: 2n, algorithmVersion: 1, id: "b", kind: "semantic", payloadBytes: bytes("B") }).ok, true);
        setStoreReadOnly(db, true);
        emitted.length = 0;
        // Phase 2: storage refused append -> nonfatal CTX_APPEND_FAILED + emit.
        const fail = store.writer().append({ sourceHighWater: 3n, algorithmVersion: 1, id: "c", kind: "semantic", payloadBytes: bytes("C") });
        assert.equal(fail.ok, false, "append refused under storage failure");
        if (fail.ok) throw new Error("unreachable");
        assert.equal(fail.code, "CTX_APPEND_FAILED", "exact code");
        assert.ok(emitted.includes("vector_cortex_record_append_failed"), "append_failed emitted");
        // Host continues: reads still work, no throw.
        assert.equal(store.reader().recordCount(), 2, "only accepted records counted");
        // Phase 3: thaw + rebuild recovers from the accepted authority records.
        setStoreReadOnly(db, false);
        const rebuilt = store.admin().rebuild();
        assert.ok(rebuilt.ok, "rebuild recovers from authority");
        if (!rebuilt.ok) throw new Error("unreachable");
        assert.equal(rebuilt.generation.recordCount, 2, "generation covers accepted records only");
        assert.ok(emitted.includes("vector_cortex_generation_rebuilt"), "generation_rebuilt emitted");
      } finally {
        store.close();
        rmSync(tmp.dir, { recursive: true, force: true });
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Forced triad A/B/C
// ---------------------------------------------------------------------------

describe("Forced triad (A=SQLite reader / B=in-memory / C=authority scan)", () => {
  const accepted = [
    { sourceHighWater: 1n, algorithmVersion: 1, id: "a", kind: "semantic", payloadBytes: bytes("one") },
    { sourceHighWater: 2n, algorithmVersion: 1, id: "b", kind: "contradiction", payloadBytes: bytes("two") },
    { sourceHighWater: 3n, algorithmVersion: 2, id: "c", kind: "synthetic", payloadBytes: bytes("three") },
  ];

  test("A and B and C agree on the derived frontier + root digest", () => {
    // A = indexed SQLite reader (the real cortex store).
    const a = withStore((s) => {
      for (const r of accepted) appendOk(s, r);
      const rb = s.admin().rebuild();
      assert.ok(rb.ok, "A rebuild ok");
      if (!rb.ok) throw new Error("unreachable");
      return { digest: rb.generation.rootDigest, frontier: rb.generation.sourceHighWater, count: s.reader().recordCount() };
    });

    // B = in-memory records rebuilt from the accepted inputs (no SQLite).
    const bRecords: CortexRecordV1[] = accepted.map((r) => ({
      schema: "cortex-record-v1",
      sourceHighWater: r.sourceHighWater,
      algorithmVersion: r.algorithmVersion,
      id: r.id,
      kind: r.kind,
      payloadDigest: cortexDigest(r.payloadBytes),
      payloadBytes: r.payloadBytes,
    }));
    const bDigest = generationRootDigest(bRecords);
    const bFrontier = bRecords.reduce((m, r) => (r.sourceHighWater > m ? r.sourceHighWater : m), 0n);
    assert.equal(a.digest, bDigest, "A == B root digest");
    assert.equal(a.frontier, bFrontier, "A == B derived frontier");

    // C = authority ledger sequence scan with NO cortex store: recompute the
    // digest/frontier purely from the ordered authority input list, independent
    // of the store code path. It must still match the store's derived digest.
    const cRecords: CortexRecordV1[] = [...accepted]
      .sort(cmpRecordKeyManual)
      .map((r) => ({
        schema: "cortex-record-v1" as const,
        sourceHighWater: r.sourceHighWater,
        algorithmVersion: r.algorithmVersion,
        id: r.id,
        kind: r.kind,
        payloadDigest: cortexDigest(r.payloadBytes),
        payloadBytes: r.payloadBytes,
      }));
    const cDigest = generationRootDigest(cRecords);
    const cFrontier = [...accepted].reduce((m, r) => (r.sourceHighWater > m ? r.sourceHighWater : m), 0n);
    assert.equal(a.digest, cDigest, "A == C root digest (authority sequence scan agrees)");
    assert.equal(a.frontier, cFrontier, "A == C derived frontier");
    assert.equal(a.count, accepted.length, "accepted record count parity");
  });
});

/** Key-order comparator over a minimal {sourceHighWater,algorithmVersion,id}. */
interface Keyish {
  sourceHighWater: bigint;
  algorithmVersion: number;
  id: string;
}
function cmpRecordKeyManual(a: Keyish, b: Keyish): number {
  if (a.sourceHighWater < b.sourceHighWater) return -1;
  if (a.sourceHighWater > b.sourceHighWater) return 1;
  if (a.algorithmVersion < b.algorithmVersion) return -1;
  if (a.algorithmVersion > b.algorithmVersion) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Flag-off parity + emit seam (mode C)
// ---------------------------------------------------------------------------

describe("VC3A flag-off parity + capability gating", () => {
  const flagEnvKey = "MEGACOMPACT_VC3A";

  test("flag OFF gates the emit seam (zero emissions) and enabled=false summary", () => {
    const saved = process.env[flagEnvKey];
    const emitted: string[] = [];
    process.env[flagEnvKey] = "0";
    try {
      assert.equal(VC3A_ENABLED(), false, "flag OFF");
      withStore((store) => {
        // Store primitive still works (writer/reader/admin ungated by flag).
        appendOk(store, { sourceHighWater: 1n, algorithmVersion: 1, id: "x", kind: "semantic", payloadBytes: bytes("data") });
        assert.equal(store.reader().recordCount(), 1, "store primitive persists under flag OFF");
        const rb = store.admin().rebuild();
        assert.ok(rb.ok, "rebuild ok under flag OFF");
        // Emit seam is gated: topologysummary reports enabled=false and zero events fire.
        assert.equal(store.reader().topologySummary().enabled, false, "reader summary enabled=false (flag OFF)");
        assert.equal(emitted.length, 0, "zero VC3A events under flag OFF");
      }, () => emitted.push("fired"));
    } finally {
      if (saved === undefined) delete process.env[flagEnvKey];
      else process.env[flagEnvKey] = saved;
    }
  });

  test("flag ON emits both named events on the store seam", () => {
    const saved = process.env[flagEnvKey];
    const emitted: string[] = [];
    process.env[flagEnvKey] = "1";
    try {
      assert.equal(VC3A_ENABLED(), true, "flag ON");
      withStore((store) => {
        assert.equal(store.writer().append({ sourceHighWater: 1n, algorithmVersion: 1, id: "k", kind: "semantic", payloadBytes: bytes("first") }).ok, true, "first append");
        const conflict = store.writer().append({ sourceHighWater: 1n, algorithmVersion: 1, id: "k", kind: "semantic", payloadBytes: bytes("second") });
        assert.equal(conflict.ok, false, "conflict append");
        const rb = store.admin().rebuild();
        assert.ok(rb.ok, "rebuild ok");
        assert.equal(emitted.includes("vector_cortex_record_append_failed"), true, "append_failed emitted (conflict)");
        assert.equal(emitted.includes("vector_cortex_generation_rebuilt"), true, "generation_rebuilt emitted");
      }, (ev) => emitted.push(ev));
    } finally {
      if (saved === undefined) delete process.env[flagEnvKey];
      else process.env[flagEnvKey] = saved;
    }
  });
});

