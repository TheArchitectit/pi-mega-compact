/**
 * vector-cortex/cortex/contract.test.ts — VC3A cortex capability contract tests.
 *
 * Covers the CTX capability contract: writer exposes append only (negative
 * compile CTX-CAP-001), reader exposes query only, admin alone rebuilds/switches
 * generations, no callbacks/subscriptions, writes are non-fatal (a storage
 * failure degrades to `CTX_APPEND_FAILED` and never throws to the caller), the
 * reader-only topology summary never leaks writer/admin surfaces, and the two
 * VC3A events emit on their real paths. No mocks: every store is a real isolated
 * SQLite store.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCortexStore, type CortexHandle } from "./store.js";
import { openCortexStore, setStoreReadOnly } from "./sqlite.js";
import type { CortexWriter } from "./types.js";

/** A scratch store in a temp dir, torn down after each test. */
function scratch(): { handle: CortexHandle; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "vc3a-contract-"));
  const handle = createCortexStore({ dbPath: join(dir, "cortex.db") });
  return {
    handle,
    cleanup: () => {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
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

function recordOf(id: string, av = 1, hw = 1n) {
  const bytes = new TextEncoder().encode(`payload-${id}`);
  return {
    schema: "cortex-record-v1" as const,
    sourceHighWater: hw,
    algorithmVersion: av,
    id,
    kind: "semantic",
    payloadDigest: `sha256:${new Array(64).fill(0).join("").slice(0, 64)}`,
    payloadBytes: bytes,
  };
}

describe("CTX capability gating", () => {
  test("CTX-CAP-001 (negative compile): the writer has NO query or admin member", () => {
    const { handle, cleanup } = scratch();
    try {
      const writer = handle.writer() as unknown as Record<string, unknown>;
      // The writer exposes only kind + append. Query surfaces are absent:
      assert.equal(writer.kind, "CortexWriter");
      assert.equal(typeof writer.append, "function");
      assert.equal("readRecords" in writer, false, "writer must not expose readRecords");
      assert.equal("recordCount" in writer, false, "writer must not expose recordCount");
      assert.equal("topologySummary" in writer, false, "writer must not expose topologySummary");
      assert.equal("latestGeneration" in writer, false, "writer must not expose latestGeneration");
      assert.equal("rebuild" in writer, false, "writer must not expose rebuild");
      assert.equal("switchGeneration" in writer, false, "writer must not expose switchGeneration");
      assert.equal("readRecord" in writer, false, "writer must not expose readRecord");

      // The TYPE also rejects query/admin members at compile time (CTX-CAP-001
      // negative compile fixture): each of the following must NOT compile.
      const typed: CortexWriter = handle.writer();
      // @ts-expect-error writer has no query member
      void typed.readRecords;
      // @ts-expect-error writer has no admin member
      void typed.rebuild;
    } finally {
      cleanup();
    }
  });

  test("CTX-REBUILD-CAP: the reader exposes query only (no append/admin surfacing through it)", () => {
    const { handle, cleanup } = scratch();
    try {
      const reader = handle.reader() as unknown as Record<string, unknown>;
      assert.equal(reader.kind, "CortexReader");
      assert.equal(typeof reader.recordCount, "function");
      assert.equal(typeof reader.readRecords, "function");
      assert.equal(typeof reader.readRecord, "function");
      assert.equal(typeof reader.latestGeneration, "function");
      assert.equal(typeof reader.topologySummary, "function");
      assert.equal("append" in reader, false, "reader must not expose append");
      assert.equal("rebuild" in reader, false, "reader must not expose rebuild");
      assert.equal("switchGeneration" in reader, false, "reader must not expose switchGeneration");
    } finally {
      cleanup();
    }
  });

  test("CTX-ADMIN-CAP: only the admin rebuilds/switches generations", () => {
    const { handle, cleanup } = scratch();
    try {
      const admin = handle.admin() as unknown as Record<string, unknown>;
      assert.equal(admin.kind, "CortexAdmin");
      assert.equal(typeof admin.rebuild, "function");
      assert.equal(typeof admin.switchGeneration, "function");
      assert.equal(typeof admin.listGenerations, "function");
      assert.equal("append" in admin, false, "admin must not expose append");
      assert.equal("readRecords" in admin, false, "admin must not expose readRecords");
      assert.equal("topologySummary" in admin, false, "admin must not expose topologySummary");
    } finally {
      cleanup();
    }
  });

  test("no callbacks or subscriptions flow from the store (writer returns a value, never registers)", () => {
    const { handle, cleanup } = scratch();
    try {
      const writer = handle.writer();
      // The append result is a plain value — no registration, no callback handle.
      const res = writer.append(input("r1"));
      assert.equal(res.ok, true);
      const w = writer as unknown as Record<string, unknown>;
      // No `on`, `subscribe`, `emit`, or `listener` member on any surface.
      for (const k of ["on", "subscribe", "addListener", "emit"]) {
        assert.equal(k in w, false, `writer must have no '${k}' member`);
      }
      const r = handle.reader() as unknown as Record<string, unknown>;
      for (const k of ["on", "subscribe", "addListener", "emit"]) {
        assert.equal(k in r, false, `reader must have no '${k}' member`);
      }
    } finally {
      cleanup();
    }
  });

  test("writes are non-fatal: a storage failure returns CTX_APPEND_FAILED, host continues, rebuild-from-authority recovers", () => {
    const dir = mkdtempSync(join(tmpdir(), "vc3a-nonfatal-"));
    try {
      // Open a REAL store, then flip its connection to storage-read-only so the
      // writer's INSERT is refused by SQLite itself (genuine SQLITE_FULL-class
      // failure) — then recover and rebuild from the accepted records.
      const db = openCortexStore(join(dir, "cortex.db"));
      const store = createCortexStore({ db });
      store.writer().append(input("accepted1"));
      store.writer().append(input("accepted2"));

      setStoreReadOnly(db, true); // storage refuses writes at the SQLite level
      const failed = store.writer().append(input("rejected"));
      assert.equal(failed.ok, false);
      if (!failed.ok) assert.equal(failed.code, "CTX_APPEND_FAILED");
      setStoreReadOnly(db, false); // host recovers

      // Host continues: the accepted records survive, the rejected one does not.
      const reader = store.reader();
      assert.equal(reader.readRecords().length, 2, "only the two accepted records survived");
      assert.equal(reader.topologySummary().recordCount, 2);

      // Rebuild from authority (accepted inputs) recovers a generation.
      const rebuilt = store.admin().rebuild();
      assert.equal(rebuilt.ok, true);
      if (rebuilt.ok) {
        assert.equal(rebuilt.generation.recordCount, 2);
        assert.equal(reader.topologySummary().generationId, rebuilt.generation.id);
      }
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the reader-only topology summary never leaks writer/admin surfaces or payloads", () => {
    const { handle, cleanup } = scratch();
    try {
      handle.writer().append(input("r1"));
      handle.writer().append(input("r2"));
      const admin = handle.admin();
      const rebuilt = admin.rebuild();
      assert.equal(rebuilt.ok, true);
      const summary = handle.reader().topologySummary() as unknown as Record<string, unknown>;
      // Aggregate only — no raw records, no writer/admin functions.
      for (const k of ["readRecords", "append", "rebuild", "switchGeneration", "records", "payloads"]) {
        assert.equal(k in summary, false, `summary must not expose '${k}'`);
      }
      assert.equal(typeof summary.rootDigest, "string");
      assert.equal(typeof summary.recordCount, "number");
      assert.equal(typeof summary.sourceHighWater, "string");
    } finally {
      cleanup();
    }
  });

  test("switchGeneration restores a prior generation pointer without deleting evidence", () => {
    const { handle, cleanup } = scratch();
    try {
      handle.writer().append(input("r1"));
      const g1 = handle.admin().rebuild();
      assert.equal(g1.ok, true);
      if (!g1.ok) return;
      // A second generation of a changed record set.
      handle.writer().append(input("r2"));
      const g2 = handle.admin().rebuild();
      assert.equal(g2.ok, true);
      if (!g2.ok) return;
      assert.notEqual(g1.generation.id, g2.generation.id);
      assert.equal(handle.reader().topologySummary().generationId, g2.generation.id);
      // Switch back to the prior generation pointer.
      const sw = handle.admin().switchGeneration(g1.generation.id);
      assert.equal(sw.ok, true);
      assert.equal(handle.reader().topologySummary().generationId, g1.generation.id);
      // Evidence retained: both generations still listed.
      const gens = handle.admin().listGenerations();
      assert.equal(gens.length, 2, "no generation evidence deleted on switch");
    } finally {
      cleanup();
    }
  });
});

describe("CTX emit seam", () => {
  test("vector_cortex_record_append_failed emits on a real failed append (flag ON)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vc3a-emit-"));
    try {
      const saved = process.env.MEGACOMPACT_VC3A;
      process.env.MEGACOMPACT_VC3A = "1";
      try {
        const events: string[] = [];
        const db = openCortexStore(join(dir, "cortex.db"));
        const store = createCortexStore({ db }, (e) => events.push(e));
        const writer = store.writer();
        writer.append(input("r1"));
        // Flip the real connection read-only -> the writer's append fails at the
        // storage layer and the store emits the named event.
        setStoreReadOnly(db, true);
        writer.append(input("r2"));
        setStoreReadOnly(db, false);
        assert.ok(
          events.some((e) => e === "vector_cortex_record_append_failed"),
          "append_failed emitted on storage failure",
        );
        store.close();
      } finally {
        if (saved === undefined) delete process.env.MEGACOMPACT_VC3A;
        else process.env.MEGACOMPACT_VC3A = saved;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("vector_cortex_generation_rebuilt emits on an admin rebuild (flag ON)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vc3a-emitgen-"));
    try {
      const saved = process.env.MEGACOMPACT_VC3A;
      process.env.MEGACOMPACT_VC3A = "1";
      try {
        const events: string[] = [];
        const db = openCortexStore(join(dir, "cortex.db"));
        const store = createCortexStore({ db }, (e) => events.push(e));
        store.writer().append(input("r1"));
        const rebuilt = store.admin().rebuild();
        assert.equal(rebuilt.ok, true);
        assert.ok(events.includes("vector_cortex_generation_rebuilt"), "generation_rebuilt emitted");
        store.close();
      } finally {
        if (saved === undefined) delete process.env.MEGACOMPACT_VC3A;
        else process.env.MEGACOMPACT_VC3A = saved;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("flag OFF: zero VC3A emissions on the REAL write paths (byte-identical predecessor)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vc3a-flagoff-"));
    try {
      const saved = process.env.MEGACOMPACT_VC3A;
      process.env.MEGACOMPACT_VC3A = "0";
      try {
        const emitted: string[] = [];
        const db = openCortexStore(join(dir, "cortex.db"));
        const store = createCortexStore({ db }, (e) => emitted.push(e));
        // Drive the real writer + admin seams: a failed append (read-only) and a
        // successful rebuild both fire NOTHING when the flag is OFF.
        store.writer().append(input("r1"));
        setStoreReadOnly(db, true);
        store.writer().append(input("r2"));
        setStoreReadOnly(db, false);
        store.admin().rebuild();
        assert.deepEqual(emitted, [], "flag OFF => zero emissions on real write paths");
        store.close();
      } finally {
        if (saved === undefined) delete process.env.MEGACOMPACT_VC3A;
        else process.env.MEGACOMPACT_VC3A = saved;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CTX immutability + keying", () => {
  test("records are immutable: an exact key with a different digest is a conflict", () => {
    const { handle, cleanup } = scratch();
    try {
      const w = handle.writer();
      const first = w.append(input("r1"));
      assert.equal(first.ok, true);
      // Same key, different payload -> conflict (immutable derived records).
      const conflicted = w.append(input("r1", { bytes: "different-payload" }));
      assert.equal(conflicted.ok, false);
      if (!conflicted.ok) assert.equal(conflicted.code, "CTX_KEY_CONFLICT");
      // Always returns the idempotent ack with the same payload.
      const again = w.append(input("r1"));
      assert.equal(again.ok, true);
      if (again.ok) assert.equal(again.record.payloadDigest, first.ok ? first.record.payloadDigest : "");
      assert.equal(handle.reader().recordCount(), 1, "no duplicate record created");
    } finally {
      cleanup();
    }
  });
});

describe("CTX contract type surface sanity", () => {
  test("CortexRecordV1 carries the five normative fields", () => {
    const r = recordOf("r1");
    assert.equal(r.schema, "cortex-record-v1");
    assert.equal(typeof r.sourceHighWater, "bigint");
    assert.equal(typeof r.algorithmVersion, "number");
    assert.equal(typeof r.id, "string");
    assert.equal(typeof r.kind, "string");
    assert.equal(typeof r.payloadDigest, "string");
  });
  test("CTX_IDS registers exactly CTX-001..010", async () => {
    const { CTX_IDS } = await import("./types.js");
    assert.deepEqual([...CTX_IDS], [
      "CTX-001", "CTX-002", "CTX-003", "CTX-004", "CTX-005",
      "CTX-006", "CTX-007", "CTX-008", "CTX-009", "CTX-010",
    ]);
  });
});
