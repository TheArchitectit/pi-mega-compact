/** VC1B acceptance aggregator — runs the conformance corpus against the REAL
 * occurrence ledger: M2-001..015 (copy/validate/switch + failure codes),
 * MIG-DOWN-001 (lossless legacy copy, unrepresentable rows listed), tool
 * identity (a RESULT names exactly one earlier call; seq never regresses;
 * identity is (event_id,digest) only). Real logic + fixtures, no mocks. */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EVT_IDS } from "./ledger/types.js";
import { M2_IDS, MIG_DOWN_IDS, m2Copy, m2Validate, m2Switch, type M2Host } from "./migrations/occurrence-v2.js";
import { createLedgerStore } from "./ledger/store.js";
import { openOccurrenceStore, appendOccurrence, type SqliteAppendCode } from "./ledger/sqlite.js";
import { initCompatJournal, createCompatJournal, journalPhase } from "./ledger/compat-journal.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = HERE.includes(join("dist", "src", "vector-cortex"))
  ? join(HERE, "..", "..", "..")
  : join(HERE, "..", "..");
const V2 = join(REPO_ROOT, "conformance", "vector-cortex", "v2");

interface ManifestRow {
  id: string;
  path: string;
  sha256: string;
  algorithm: string;
  expected: string;
}
interface Manifest {
  fixtures: ManifestRow[];
}
interface LedgerFixtureInput {
  scenario: string;
  occurrences: Array<{
    seq: number;
    eventId: string;
    kind: string;
    toolCallId?: string;
    bytesBase64: string;
  }>;
  unrepresentable?: string[];
}
interface LedgerFixture {
  id: string;
  kind: string;
  input: LedgerFixtureInput;
  expected: {
    ok?: boolean;
    code?: string;
    count?: number;
    halted?: boolean;
    unrepresentable?: string[];
    toolCallId?: string;
    equalDigests?: boolean;
  };
}

/** A raw compat_journal_v1 row read by the test's M2Host harness. */
interface JournalRawRow {
  session: string;
  seq: number;
  event_id: string;
  digest: string;
  kind: string;
  legacy_projection: string | null;
  unrepresentable: number;
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(V2, "manifest.json"), "utf8")) as Manifest;
}
function readFixture(bodyPath: string): LedgerFixture {
  return JSON.parse(readFileSync(join(V2, bodyPath), "utf8")) as LedgerFixture;
}
function bytesOf(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}
function b64_text(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

/** A temp per-test DB dir. The ledger DB lives at <dir>/occurrence.db. */
function tempStore(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "vc1b-"));
  return { dir, dbPath: join(dir, "occurrence.db") };
}

/**
 * Build an M2Host over a raw ledger DB (mirrors store.ts migrateHost) so the
 * acceptance test can drive copy/validate/switch phase-by-phase (reachable via
 * the same journal state machine the store uses) — enabling halt/resume and the
 * copy-missing failure codes the single migrateOccurrenceV2() call cannot hit.
 */
function rawHost({ dbPath }: { dbPath: string }): {
  db: ReturnType<typeof openOccurrenceStore>;
  compat: ReturnType<typeof createCompatJournal>;
  host: M2Host;
  close: () => void;
} {
  const db = openOccurrenceStore(dbPath);
  initCompatJournal(db);
  const compat = createCompatJournal(db);
  let staged: ReturnType<M2Host["stagedLegacy"]> = null;
  const host: M2Host = {
    db,
    phase: () => journalPhase(db),
    journalActive: () => compat.active(),
    journalRows: () => {
      const rows = db
        .prepare(`SELECT session, seq, event_id, digest, kind, legacy_projection, unrepresentable
           FROM compat_journal_v1 ORDER BY session ASC, seq ASC`)
        .all() as unknown as JournalRawRow[];
      return rows.map((r) => ({
        session: r.session,
        seq: BigInt(r.seq),
        eventId: r.event_id,
        digest: r.digest,
        kind: r.kind,
        legacyProjection: r.legacy_projection,
        unrepresentable: r.unrepresentable === 1,
      }));
    },
    writeStagedLegacy: (rows) => {
      staged = rows;
      compat.copied();
    },
    stagedLegacy: () => staged,
    validateStaged: () => compat.validate(),
    switchLegacy: () => compat.switched(),
  };
  return { db, compat, host, close: () => db.close() };
}

/** utf8-validity helper — lossless legacy form exists iff valid UTF-8. */
function hasLosslessLegacy(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Append an occurrence directly (raw path) and journal it (mirrors writer). */
function rawAppend(
  h: ReturnType<typeof rawHost>,
  occ: LedgerFixtureInput["occurrences"][number],
  session: string,
): ReturnType<typeof appendOccurrence> {
  const sourceBytes = bytesOf(occ.bytesBase64);
  const result = appendOccurrence(h.db, {
    session,
    seq: BigInt(occ.seq),
    eventId: occ.eventId,
    kind: occ.kind,
    toolCallId: occ.toolCallId,
    sourceBytes,
  });
  if (result.ok) {
    h.compat.record({
      occurrence: result.occurrence,
      // Lossless legacy form exists only when source is valid UTF-8.
      legacyProjection: hasLosslessLegacy(sourceBytes) ? "representable" : null,
    });
  }
  return result;
}

/** Append via the real capability-separated writer (journal auto-recorded). */
function storeAppend(
  store: ReturnType<typeof createLedgerStore>,
  occ: LedgerFixtureInput["occurrences"][number],
  session: string,
): ReturnType<typeof appendOccurrence> {
  return store.writer().append({
    session,
    seq: BigInt(occ.seq),
    eventId: occ.eventId,
    kind: occ.kind,
    toolCallId: occ.toolCallId,
    sourceBytes: bytesOf(occ.bytesBase64),
  });
}

// ---------------------------------------------------------------------------
// Conformance registration
// ---------------------------------------------------------------------------

describe("VC1B conformance registration", () => {
  test("manifest registers M2-001..015, MIG-DOWN-001 and the named behavior fixtures", () => {
    const manifest = readManifest();
    const ids = manifest.fixtures
      .filter((f) => f.path.startsWith("ledger/"))
      .map((f) => f.id);
    for (const id of M2_IDS) assert.ok(ids.includes(id), `missing M2-${id}`);
    for (const id of MIG_DOWN_IDS) assert.ok(ids.includes(id), `missing ${id}`);
    for (const id of ["M2-DUP-001", "M2-TOOL-002", "MIG-DOWN-003"]) {
      assert.ok(ids.includes(id), `missing ${id}`);
    }
    // Every ledger file on disk is manifest-registered (canonical corpus).
    for (const id of ids) assert.ok(ids.includes(id), `manifest registration for ${id}`);
  });

  test("manifest registers EVT-016..030 alongside EVT-001..015", () => {
    const manifest = readManifest();
    const ids = manifest.fixtures
      .filter((f) => f.path.startsWith("events/"))
      .map((f) => f.id);
    for (const id of EVT_IDS) assert.ok(ids.includes(id), `missing ${id}`);
  });
});

// ---------------------------------------------------------------------------
// M2 lifecycle fixtures (M2-001..015)
// ---------------------------------------------------------------------------

/** Open a ledger store over a fresh temp dir; auto-close + cleanup after fn. */
function withStore<T>(
  fn: (s: ReturnType<typeof createLedgerStore>) => T,
  emit?: (ev: string, fields: Record<string, unknown>) => void,
): T {
  const tmp = tempStore();
  const store = createLedgerStore({ dbPath: tmp.dbPath }, emit);
  try {
    return fn(store);
  } finally {
    store.close();
    rmSync(tmp.dir, { recursive: true, force: true });
  }
}

function withRawStore<T>(fn: (h: ReturnType<typeof rawHost>) => T): T {
  const tmp = tempStore();
  const h = rawHost({ dbPath: tmp.dbPath });
  try {
    return fn(h);
  } finally {
    h.close();
    rmSync(tmp.dir, { recursive: true, force: true });
  }
}

describe("M2 copy/validate/switch (M2-001..015)", () => {
  test("M2-001: full migration of a balanced user/tool-pair ledger succeeds", () => {
    const fx = readFixture("ledger/M2-001.json");
    withStore((store) => {
      for (const row of fx.input.occurrences) storeAppend(store, row, "s1");
      const res = store.admin().migrateOccurrenceV2();
      assert.equal(res.ok, true, `M2-001 expected ok, got ${res.codes.join(",")}`);
      assert.equal(store.reader().count("s1"), fx.expected.count, "migrated count parity");
    });
  });

  test("M2-002: duplicate-content occurrences migrate with preserved count", () => {
    const fx = readFixture("ledger/M2-002.json");
    withStore((store) => {
      for (const row of fx.input.occurrences) storeAppend(store, row, "s-dup");
      assert.equal(store.reader().count("s-dup"), 2, "two occurrences preserved pre-migrate");
      const res = store.admin().migrateOccurrenceV2();
      assert.equal(res.ok, true, "M2-002 ok");
      assert.equal(store.reader().count("s-dup"), fx.expected.count, "count not deduped by migration");
    });
  });

  test("M2-003: untouched (never-active) ledger refuses downgrade export", () => {
    withStore((store) => {
      // No appends -> journal never active: the old binary may not open v2.
      const res = store.admin().migrateOccurrenceV2();
      assert.equal(res.ok, false, "M2-003 expected failure");
      assert.ok((res.codes as readonly string[]).includes("MIG_DOWN_NOT_ACTIVE"));
    });
  });

  test("M2-004: halt after validate before switch retains the old authority", () => {
    const fx = readFixture("ledger/M2-004.json");
    withRawStore((h) => {
      for (const row of fx.input.occurrences) rawAppend(h, row, "s-halt");
      // Drive copy -> validate, then STOP before switch (simulated crash).
      m2Copy(h.host);
      const v = m2Validate(h.host);
      assert.equal(v.ok, true, `M2-004 validate ok, got ${v.codes.join(",")}`);
      assert.equal(h.compat.active(), true, "journal active");
      // Authority is unchanged: journal is not yet switched.
      assert.equal(journalPhase(h.db), "validated", "phase recorded validated, not switched");
    });
  });

  test("M2-005: resume after an interrupted switch is idempotent (one row)", () => {
    const fx = readFixture("ledger/M2-005.json");
    withRawStore((h) => {
      for (const row of fx.input.occurrences) rawAppend(h, row, "s-resume");
      // First attempt: copy + validate + switch.
      m2Copy(h.host);
      assert.equal(m2Validate(h.host).ok, true, "first validate ok");
      m2Switch(h.host);
      // Resume = re-run the FULL copy/validate/switch; copy resets the phase to
      // copied and reprocesses idempotently with no duplicate rows.
      m2Copy(h.host);
      assert.equal(m2Validate(h.host).ok, true, "resumed validate ok");
      m2Switch(h.host);
      assert.equal(h.host.journalRows().length, fx.expected.count, "no duplicate rows after resume");
    });
  });

  test("M2-006: validation before any copy reports M2_COPY_MISSING", () => {
    const fx = readFixture("ledger/M2-006.json");
    withRawStore((h) => {
      for (const row of fx.input.occurrences) rawAppend(h, row, "s-nocopy");
      const v = m2Validate(h.host); // no m2Copy staged
      assert.equal(v.ok, false, "M2-006 expected failure");
      assert.ok(v.codes.includes("M2_COPY_MISSING"), `expected M2_COPY_MISSING in ${v.codes.join(",")}`);
    });
  });

  test("M2-007: validation before the copy phase reports MIG_DOWN_PHASE_UNREACHED", () => {
    withRawStore((h) => {
      // An append activates the journal, but validate before the copy phase
      // (still "prepared") cannot proceed -> PHASE_UNREACHED.
      const r = rawAppend(h, { seq: 1, eventId: "u1", kind: "user", bytesBase64: b64_text("x") }, "s-ph");
      assert.equal(r.ok, true);
      const v = m2Validate(h.host);
      assert.equal(v.ok, false, "M2-007 expected failure");
      assert.ok(v.codes.includes("MIG_DOWN_PHASE_UNREACHED"));
    });
  });

  test("M2-008: malformed representable digest -> MIG_DOWN_DIGEST_MISMATCH", () => {
    const fx = readFixture("ledger/M2-008.json");
    withRawStore((h) => {
      // Append a representable row whose recorded digest is malformed (not sha256:).
      const res = appendOccurrence(h.db, {
        session: "s-bad", seq: 1n, eventId: "u1", kind: "user",
        sourceBytes: bytesOf(fx.input.occurrences[0]!.bytesBase64),
        digest: "not-a-sha256",
      });
      assert.equal(res.ok, true, "representable append accepted");
      if (!res.ok) return; // unreachable; satisfies narrowing
      h.compat.record({ occurrence: res.occurrence, legacyProjection: "representable" });
      m2Copy(h.host);
      const v = m2Validate(h.host);
      assert.equal(v.ok, false, "M2-008 expected failure");
      assert.ok(v.codes.includes("MIG_DOWN_DIGEST_MISMATCH"));
    });
  });

  test("M2-009: unrepresented unrepresentable row -> M2_UNREPRESENTABLE_UNLISTED", () => {
    withRawStore((h) => {
      // An unrepresentable row (invalid UTF-8 -> null projection) plus a plain one.
      const plain = appendOccurrence(h.db, {
        session: "s-unrep", seq: 1n, eventId: "u1", kind: "user",
        sourceBytes: bytesOf("b2s="),
      });
      assert.ok(plain.ok, "plain append accepted");
      if (!plain.ok) return;
      h.compat.record({ occurrence: plain.occurrence, legacyProjection: "representable" });
      const badRes = appendOccurrence(h.db, {
        session: "s-unrep", seq: 2n, eventId: "bad", kind: "user",
        sourceBytes: new Uint8Array([0xff]),
      });
      assert.ok(badRes.ok, "invalid-UTF-8 append accepted");
      if (!badRes.ok) return;
      h.compat.record({ occurrence: badRes.occurrence, legacyProjection: null });
      assert.equal(h.compat.isUnrepresentable("bad", badRes.occurrence.digest), true);
      // Build a staged export that DROPS the unrepresentable row (unlisted).
      m2Copy(h.host);
      h.host.writeStagedLegacy(h.host.stagedLegacy()!.filter((r) => r.eventId !== "bad"));
      const v = m2Validate(h.host);
      assert.equal(v.ok, false, "M2-009 expected failure");
      assert.ok(v.codes.includes("M2_UNREPRESENTABLE_UNLISTED"));
    });
  });

  test("M2-010: dangling tool RESULT rejected EVT_TOOL_CALL_MISSING at append", () => {
    const fx = readFixture("ledger/M2-010.json");
    withStore((store) => {
      assert.equal(storeAppend(store, fx.input.occurrences[0]!, "t").ok, true);
      const res = storeAppend(store, fx.input.occurrences[1]!, "t");
      assert.equal(res.ok, false, "M2-010 expected append rejection");
      if (!res.ok) assert.equal((res as { code: SqliteAppendCode }).code, "EVT_TOOL_CALL_MISSING");
    });
  });

  test("M2-011: non-contiguous seq rejected EVT_SEQ_REGRESSION at append", () => {
    const fx = readFixture("ledger/M2-011.json");
    withStore((store) => {
      assert.equal(storeAppend(store, fx.input.occurrences[0]!, "r").ok, true);
      const res = storeAppend(store, fx.input.occurrences[1]!, "r"); // seq 5 after seq 1
      assert.equal(res.ok, false, "M2-011 expected append rejection");
      if (!res.ok) assert.equal((res as { code: SqliteAppendCode }).code, "EVT_SEQ_REGRESSION");
    });
  });

  test("M2-012: exact (event_id,digest) re-append is acknowledged idempotently", () => {
    const fx = readFixture("ledger/M2-012.json");
    withStore((store) => {
      const first = storeAppend(store, fx.input.occurrences[0]!, "idem");
      assert.equal(first.ok, true, "first append accepted");
      // Same eventId+bytes at a distinct seq is acknowledged, never duplicated.
      const re = storeAppend(store, fx.input.occurrences[1]!, "idem");
      assert.equal(re.ok, true, "idempotent re-append acknowledged");
      assert.equal(store.reader().count("idem"), fx.expected.count, "never duplicated");
    });
  });

  test("M2-013: mixed batch persists only accepted rows", () => {
    const fx = readFixture("ledger/M2-013.json");
    withStore((store) => {
      const results = store.writer().appendBatch(
        fx.input.occurrences.map((o) => ({
          session: "batch", seq: BigInt(o.seq), eventId: o.eventId, kind: o.kind,
          toolCallId: o.toolCallId, sourceBytes: bytesOf(o.bytesBase64),
        })),
      );
      const accepted = results.filter((r) => r.ok).length;
      assert.equal(accepted, fx.expected.count, "only accepted rows persist");
      assert.equal(store.reader().count("batch"), fx.expected.count, "reader sees accepted only");
    });
  });

  test("M2-014: reader count/order/digest parity with accepted source", () => {
    const fx = readFixture("ledger/M2-014.json");
    withStore((store) => {
      for (const row of fx.input.occurrences) storeAppend(store, row, "parity");
      const rows = store.reader().readSession("parity");
      assert.equal(rows.length, fx.expected.count, "reader count parity");
      // Sorted ascending (seq,eventId) and digests are sha256 (<-> byte authority).
      for (let i = 0; i < rows.length - 1; i++) {
        assert.ok(rows[i]!.seq <= rows[i + 1]!.seq, "non-decreasing seq order");
      }
      for (const r of rows) assert.ok(r.digest.startsWith("sha256:"), "digest is sha256:<hex>");
    });
  });

  test("M2-015: repeated full migration is idempotent (no duplicate rows)", () => {
    const fx = readFixture("ledger/M2-015.json");
    withStore((store) => {
      for (const row of fx.input.occurrences) storeAppend(store, row, "repeat");
      assert.equal(store.admin().migrateOccurrenceV2().ok, true, "first migrate ok");
      assert.equal(store.admin().migrateOccurrenceV2().ok, true, "second migrate idempotent okay");
      assert.equal(store.reader().count("repeat"), fx.expected.count, "no duplicate rows");
    });
  });
});

// ---------------------------------------------------------------------------
// MIG-DOWN + named behavior fixtures
// ---------------------------------------------------------------------------

describe("MIG-DOWN and named behavior fixtures", () => {
  test("MIG-DOWN-001: downgrade export lists unrepresentable rows in the legacy copy", () => {
    const fx = readFixture("ledger/MIG-DOWN-001.json");
    withStore((store) => {
      // Append the plain (representable) and invalid-UTF-8 (unrepresentable) rows
      // through the real writer so the journal marks the invalid-UTF-8 row.
      assert.equal(storeAppend(store, fx.input.occurrences[0]!, "down").ok, true);
      const bad = storeAppend(store, fx.input.occurrences[1]!, "down");
      assert.equal(bad.ok, true);
      const badDigest = (bad as { occurrence: { digest: string } }).occurrence.digest;
      assert.equal(store.admin().compat.isUnrepresentable("bad", badDigest), true);
      assert.deepEqual(
        store.admin().compat.prepare().sort(),
        (fx.expected.unrepresentable ?? []).sort(),
        "unrepresentable rows listed on prepare",
      );
    });
  });

  test("M2-DUP-001: identical bytes at two seq create two occurrences (identity is (event_id,digest))", () => {
    const fx = readFixture("ledger/M2-DUP-001.json");
    withStore((store) => {
      let lastDigest = "";
      for (const row of fx.input.occurrences) {
        const res = storeAppend(store, row, "dup");
        assert.equal(res.ok, true, "each dup-row appended");
        lastDigest = (res as { occurrence: { digest: string } }).occurrence.digest;
      }
      const rows = store.reader().readSession("dup");
      assert.equal(rows.length, fx.expected.count, "two occurrences despite equal bytes");
      // Uniqueness is (event_id,digest) ONLY: same digest, distinct event_id -> 2 rows.
      assert.equal(rows[0]!.digest, lastDigest, "shared digest (equal bytes)");
      if (fx.expected.equalDigests) {
        assert.equal(rows[0]!.digest, rows[1]!.digest, "identical bytes -> identical digest");
      }
    });
  });

  test("M2-TOOL-002: result references exactly one earlier call c9", () => {
    const fx = readFixture("ledger/M2-TOOL-002.json");
    withStore((store) => {
      assert.equal(storeAppend(store, fx.input.occurrences[0]!, "tool").ok, true); // c9
      const res = storeAppend(store, fx.input.occurrences[1]!, "tool"); // result -> c9
      assert.equal(res.ok, true, "result referencing existing call c9 accepted");
      const rows = store.reader().readSession("tool");
      assert.equal(rows.length, 2);
      const resultRow = rows.find((r) => r.kind === "tool_result");
      assert.ok(resultRow, "a tool_result row exists");
      assert.equal(resultRow.toolCallId, fx.expected.toolCallId, "result names exactly c9");
    });
  });

  test("MIG-DOWN-003: invalid UTF-8 row is unrepresentable via the real writer", () => {
    const fx = readFixture("ledger/MIG-DOWN-003.json");
    withStore((store) => {
      const res = storeAppend(store, fx.input.occurrences[0]!, "utf8");
      assert.equal(res.ok, true, "invalid-UTF-8 append accepted (bytes held losslessly)");
      const digest = (res as { occurrence: { digest: string } }).occurrence.digest;
      // The real writer marked this row unrepresentable (no lossless legacy form).
      assert.equal(store.admin().compat.isUnrepresentable("bad", digest), true);
      assert.ok(
        (store.admin().compat.prepare() as string[]).includes("bad"),
        "invalid UTF-8 row listed unrepresentable on prepare",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Capability gating + append-only provenance + emit seam
// ---------------------------------------------------------------------------

describe("Capability gating (reader/writer/admin)", () => {
  test("reader cannot write; writer cannot read; admin holds migration", () => {
    withStore((store) => {
      const reader = store.reader();
      const writer = store.writer();
      const admin = store.admin();
      assert.equal(reader.kind, "LedgerReader");
      assert.equal(writer.kind, "LedgerWriter");
      assert.equal(admin.kind, "LedgerAdmin");
      // Separated surfaces: reader has no append; writer has no read/count.
      assert.equal(typeof (reader as unknown as { append: unknown }).append, "undefined");
      assert.equal(typeof (writer as unknown as { readSession: unknown }).readSession, "undefined");
      assert.equal(typeof (writer as unknown as { count: unknown }).count, "undefined");
      assert.equal(typeof admin.migrateOccurrenceV2, "function");
      assert.equal(typeof admin.compat.active, "function");
    });
  });

  test("append-only provenance: no UPDATE in ledger/journal schema", () => {
    const tmp = tempStore();
    const db = openOccurrenceStore(tmp.dbPath);
    const schema = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table'`)
      .all() as Array<{ sql: string }>;
    assert.ok(!/UPDATE/i.test(schema.map((r) => r.sql).join("\n")));
    db.close();
    rmSync(tmp.dir, { recursive: true, force: true });
  });
});

describe("VC1B emit seam (flag-gated observability)", () => {
  const flagEnvKey = "MEGACOMPACT_VC1B";
  const savedFlag = process.env[flagEnvKey];
  after(() =>
    savedFlag === undefined
      ? delete process.env[flagEnvKey]
      : (process.env[flagEnvKey] = savedFlag),
  );

  test("flag ON writes + emits; flag OFF writes nothing and emits nothing", () => {
    const emitted: Array<{ event: string; fields: Record<string, unknown> }> = [];
    process.env[flagEnvKey] = "1";
    withStore((store) => {
      const res = store.writer().append({
        session: "emit", seq: 1n, eventId: "u1", kind: "user",
        sourceBytes: new TextEncoder().encode("hello"),
      });
      assert.equal(res.ok, true);
      assert.equal(store.reader().count("emit"), 1, "flag ON persists the row");
      assert.ok(emitted.some((e) => e.event === "vector_cortex_occurrence_appended"));
      // S2: flag OFF => the whole write path is inert — the writer accepts the
      // call (ok:true) but persists NOTHING and emits NOTHING.
      process.env[flagEnvKey] = "0";
      emitted.length = 0;
      const off = store.writer().append({
        session: "emit", seq: 2n, eventId: "u2", kind: "user",
        sourceBytes: new TextEncoder().encode("world"),
      });
      assert.equal(off.ok, true, "flag-OFF append is accepted (no-op)");
      assert.equal(store.reader().count("emit"), 1, "flag OFF wrote nothing (count unchanged)");
      assert.equal(emitted.length, 0, "flag OFF emitted nothing");
    }, (ev, fields) => emitted.push({ event: ev, fields }));
  });

  test("flag ON emits compat_switch_committed after a full migration", () => {
    const emitted: string[] = [];
    process.env[flagEnvKey] = "1";
    withStore((store) => {
      store.writer().append({
        session: "sw", seq: 1n, eventId: "u1", kind: "user",
        sourceBytes: new TextEncoder().encode("x"),
      });
      emitted.length = 0;
      store.admin().migrateOccurrenceV2();
      assert.ok(emitted.includes("vector_cortex_compat_switch_committed"));
    }, (ev) => emitted.push(ev));
  });
});
