/**
 * vector-cortex/cortex/sqlite.test.ts — VC3A cortex SQLite store tests.
 *
 * Covers the additive derived-record schema keyed `(source_high_water,
 * algorithm_version, id)` with parameterized inserts and immutable records:
 * CTX-KEY-002 (same id at different algorithm versions stays distinct), the
 * idempotent-ack / conflict immutability rules, the deterministic single root
 * digest (CTX-REBUILD-003: shuffled insertion yields an identical root digest),
 * the generation rebuild + active-pointer switch, and the real storage-failure
 * (SQLITE_FULL-class) path. No mocks — every assert runs against a real isolated
 * SQLite store.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openCortexStore,
  insertCortexRecord,
  readCortexRecords,
  readCortexRecord,
  countCortexRecords,
  generationRootDigest,
  rebuildCortexGeneration,
  activeGeneration,
  listCortexGenerations,
  maxSourceHighWater,
  setStoreReadOnly,
  cortexDigest,
} from "./sqlite.js";

/** A unique scratch db handle. */
function openScratch(tag: string) {
  const dir = mkdtempSync(join(tmpdir(), `vc3a-sqlite-${tag}-`));
  const db = openCortexStore(join(dir, "cortex.db"));
  return { db, cleanup: () => { try { db.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); } };
}

function input(id: string, opts: { hw?: bigint; av?: number; kind?: string; bytes?: string } = {}) {
  const bytes = new TextEncoder().encode(opts.bytes ?? `payload-${id}`);
  return {
    sourceHighWater: opts.hw ?? 1n,
    algorithmVersion: opts.av ?? 1,
    id,
    kind: opts.kind ?? "semantic",
    payloadBytes: bytes,
  };
}

describe("CTX keying", () => {
  test("CTX-KEY-002: the same id at different algorithm versions remains DISTINCT", () => {
    const { db, cleanup } = openScratch("key002");
    try {
      const v1 = insertCortexRecord(db, input("r1", { av: 1 }));
      assert.equal(v1.ok, true);
      const v2 = insertCortexRecord(db, input("r1", { av: 2 }));
      assert.equal(v2.ok, true);
      // Same id, different algorithm version -> two distinct records coexist.
      assert.equal(countCortexRecords(db), 2, "distinct records per algorithm version");
      const byV1 = readCortexRecord(db, 1n, 1, "r1");
      const byV2 = readCortexRecord(db, 1n, 2, "r1");
      assert.ok(byV1 && byV2, "both algorithm-version records present");
      assert.equal(byV1?.algorithmVersion, 1);
      assert.equal(byV2?.algorithmVersion, 2);
    } finally {
      cleanup();
    }
  });

  test("the same id at different sourceHighWater also remains distinct", () => {
    const { db, cleanup } = openScratch("keyhw");
    try {
      assert.equal(insertCortexRecord(db, input("r1", { hw: 1n })).ok, true);
      assert.equal(insertCortexRecord(db, input("r1", { hw: 2n })).ok, true);
      assert.equal(countCortexRecords(db), 2);
    } finally {
      cleanup();
    }
  });

  test("exact key + exact digest is an idempotent ack (no duplicate row)", () => {
    const { db, cleanup } = openScratch("idem");
    try {
      const a = insertCortexRecord(db, input("r1"));
      assert.equal(a.ok, true);
      const b = insertCortexRecord(db, input("r1"));
      assert.equal(b.ok, true);
      assert.equal(countCortexRecords(db), 1, "idempotent ack creates no duplicate");
      if (a.ok && b.ok) assert.equal(b.record.payloadDigest, a.record.payloadDigest);
    } finally {
      cleanup();
    }
  });

  test("exact key + different digest is a CTX_KEY_CONFLICT (immutable records never mutate)", () => {
    const { db, cleanup } = openScratch("conflict");
    try {
      assert.equal(insertCortexRecord(db, input("r1")).ok, true);
      const c = insertCortexRecord(db, input("r1", { bytes: "mutated" }));
      assert.equal(c.ok, false);
      if (!c.ok) assert.equal(c.code, "CTX_KEY_CONFLICT");
      assert.equal(countCortexRecords(db), 1, "conflict never mutates the accepted record");
    } finally {
      cleanup();
    }
  });

  test("records sort ascending by (sourceHighWater, algorithmVersion, id)", () => {
    const { db, cleanup } = openScratch("sort");
    try {
      insertCortexRecord(db, input("b", { hw: 2n, av: 1 }));
      insertCortexRecord(db, input("a", { hw: 1n, av: 2 }));
      insertCortexRecord(db, input("c", { hw: 1n, av: 1 }));
      const rows = readCortexRecords(db);
      assert.deepEqual(rows.map((r) => `${r.sourceHighWater}:${r.algorithmVersion}:${r.id}`), [
        "1:1:c",
        "1:2:a",
        "2:1:b",
      ]);
    } finally {
      cleanup();
    }
  });
});

describe("CTX rebuild + root digest", () => {
  test("CTX-REBUILD-003: shuffled insert order yields an identical single root digest", () => {
    const { db: db1, cleanup: c1 } = openScratch("rebuild1");
    const { db: db2, cleanup: c2 } = openScratch("rebuild2");
    try {
      // Same record SET inserted in different orders across two real stores.
      const a = { ...input("a", { hw: 1n }), payloadBytes: new TextEncoder().encode("payload-a"), sourceHighWater: 1n };
      const b = { ...input("b", { hw: 2n, av: 2 }), payloadBytes: new TextEncoder().encode("payload-b"), sourceHighWater: 2n, algorithmVersion: 2 };
      const c = { ...input("c", { hw: 3n, av: 1 }), payloadBytes: new TextEncoder().encode("payload-c"), sourceHighWater: 3n };
      for (const r of [a, b, c]) assert.equal(insertCortexRecord(db1, r).ok, true);
      for (const r of [c, b, a]) assert.equal(insertCortexRecord(db2, r).ok, true);

      const root1 = generationRootDigest(readCortexRecords(db1));
      const root2 = generationRootDigest(readCortexRecords(db2));
      assert.equal(root1, root2, "root digest is order-independent");
      assert.match(root1, /^[0-9a-f]{64}$/);

      // Rebuild produces a generation with that identical root digest.
      const g1 = rebuildCortexGeneration(db1);
      const g2 = rebuildCortexGeneration(db2);
      assert.equal(g1.ok, true);
      assert.equal(g2.ok, true);
      if (g1.ok && g2.ok) {
        assert.equal(g1.generation.rootDigest, root1);
        assert.equal(g2.generation.rootDigest, root1);
      }
    } finally {
      c1();
      c2();
    }
  });

  test("rebuild sorts keys and switches the active generation; prior evidence is never deleted", () => {
    const { db, cleanup } = openScratch("gens");
    try {
      insertCortexRecord(db, input("a"));
      const g1 = rebuildCortexGeneration(db);
      assert.equal(g1.ok, true);
      if (!g1.ok) return;
      insertCortexRecord(db, input("b"));
      const g2 = rebuildCortexGeneration(db);
      assert.equal(g2.ok, true);
      if (!g2.ok) return;
      assert.notEqual(g1.generation.id, g2.generation.id);
      assert.equal(g1.generation.recordCount, 1);
      assert.equal(g2.generation.recordCount, 2);
      // Active pointer is the latest; both generations retained as evidence.
      assert.equal(activeGeneration(db)?.id, g2.generation.id);
      assert.equal(listCortexGenerations(db).length, 2);
      // Derived frontier is the max sourceHighWater across records.
      assert.equal(maxSourceHighWater(db), g2.generation.sourceHighWater);
    } finally {
      cleanup();
    }
  });

  test("rebuild of UNCHANGED inputs REUSES the identical generation (no duplicate rows)", () => {
    const { db, cleanup } = openScratch("idsame");
    try {
      insertCortexRecord(db, input("a"));
      insertCortexRecord(db, input("b"));
      insertCortexRecord(db, input("c"));
      const g1 = rebuildCortexGeneration(db);
      assert.equal(g1.ok, true);
      if (!g1.ok) return;
      // Same accepted set, no record changes -> identical rootDigest + recordCount.
      const g2 = rebuildCortexGeneration(db);
      assert.equal(g2.ok, true);
      if (!g2.ok) return;
      // The idempotent rebuild reuses the SAME generation row (activates it),
      // never appends a fresh duplicate. One generation row, not gen-1, gen-2, ...
      assert.equal(g2.generation.id, g1.generation.id, "unchanged rebuild reuses the generation");
      assert.equal(g2.generation.rootDigest, g1.generation.rootDigest);
      assert.equal(listCortexGenerations(db).length, 1, "no generation bloat on unchanged rebuild");
      assert.equal(activeGeneration(db)?.id, g1.generation.id);
    } finally {
      cleanup();
    }
  });

  test("rebuild rejects a record whose stored payload digest does not match its bytes", () => {
    const { db, cleanup } = openScratch("badpay");
    try {
      // A record is inserted with an explicit digest that does NOT match its
      // payload bytes (simulating an authority-corruption injection at the
      // insert seam). Rebuild must refuse it with CTX_PAYLOAD_DIGEST_MISMATCH.
      const bad = { ...input("r1"), payloadDigest: "sha256:" + "0".repeat(64) };
      assert.notEqual(cortexDigest(bad.payloadBytes), bad.payloadDigest);
      assert.equal(insertCortexRecord(db, bad).ok, true, "insert trusts the caller digest");
      const rebuilt = rebuildCortexGeneration(db);
      assert.equal(rebuilt.ok, false);
      if (!rebuilt.ok) assert.equal(rebuilt.code, "CTX_PAYLOAD_DIGEST_MISMATCH");
    } finally {
      cleanup();
    }
  });
});

describe("CTX storage failure (SQLITE_FULL-class) is non-fatal", () => {
  test("a store that refuses writes returns CTX_APPEND_FAILED and reads still work", () => {
    const { db, cleanup } = openScratch("storage");
    try {
      assert.equal(insertCortexRecord(db, input("ok")).ok, true);
      setStoreReadOnly(db, true);
      const failed = insertCortexRecord(db, input("bad"));
      assert.equal(failed.ok, false);
      if (!failed.ok) assert.equal(failed.code, "CTX_APPEND_FAILED");
      // Reads still work in the read-only state.
      assert.equal(countCortexRecords(db), 1);
      assert.equal(readCortexRecords(db).length, 1);
      setStoreReadOnly(db, false);
      // Recovered store accepts writes again.
      assert.equal(insertCortexRecord(db, input("more")).ok, true);
      assert.equal(countCortexRecords(db), 2);
    } finally {
      cleanup();
    }
  });
});
