/**
 * Tests for S27 Task 10 DB maintenance primitives.
 *
 * Covers getDbStats, pruneOldRows, checkpointWal, vacuumDb, integrityCheck,
 * reconcileDedupMirror, autoMaintain. All against a tmp SQLite store.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openStore,
  appendRawTranscript,
  writeCheckpointEpoch,
  upsertDedupMirror,
  updateRawTranscriptRef,
  getDbStats,
  pruneOldRows,
  checkpointWal,
  vacuumDb,
  integrityCheck,
  reconcileDedupMirror,
  autoMaintain,
  type RawTranscriptRow,
  type CheckpointEpoch,
} from "./sqlite.js";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "dbmaint-test-"));
}

function makeRow(overrides: Partial<RawTranscriptRow> = {}): RawTranscriptRow {
  return {
    contentHash: `hash-${Math.random().toString(36).slice(2, 10)}`,
    sessionId: "sess-1",
    seq: 0,
    role: "user",
    contentBytes: "hello world",
    toolName: null,
    messageTimestamp: Date.now(),
    checkpointEpoch: "epoch-1",
    ...overrides,
  };
}

function makeEpoch(overrides: Partial<CheckpointEpoch> = {}): CheckpointEpoch {
  return {
    epochId: `epoch-${Math.random().toString(36).slice(2, 10)}`,
    sessionId: "sess-1",
    startedSeq: 0,
    committedSeq: 10,
    checkpointId: "cp-1",
    cutIndex: 10,
    summaryMessageText: "test summary",
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("DB maintenance primitives (S27 Task 10)", () => {
  let dir: string;
  let db: ReturnType<typeof openStore>;

  beforeEach(() => {
    dir = makeTmp();
    db = openStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("getDbStats", () => {
    it("returns zero counts on an empty store", () => {
      const s = getDbStats(dir);
      assert.equal(s.tableCounts.raw_transcript, 0);
      assert.equal(s.tableCounts.checkpoint_epochs, 0);
      assert.equal(s.tableCounts.dedup_mirror, 0);
      // main DB file exists (schema was written)
      assert.ok(s.dbBytes > 0);
      assert.ok(s.pageSize > 0);
      assert.ok(s.pageCount > 0);
    });

    it("counts rows after inserts", () => {
      appendRawTranscript(db, makeRow());
      appendRawTranscript(db, makeRow());
      const s = getDbStats(dir);
      assert.equal(s.tableCounts.raw_transcript, 2);
    });
  });

  describe("pruneOldRows", () => {
    it("deletes nothing when all rows are recent", () => {
      appendRawTranscript(db, makeRow({ messageTimestamp: Date.now() }));
      const r = pruneOldRows(dir, 30);
      assert.equal(r.affected, 0);
    });

    it("deletes raw_transcript rows older than the cutoff", () => {
      const oldTs = Date.now() - 31 * 86_400_000;
      appendRawTranscript(db, makeRow({ messageTimestamp: oldTs }));
      appendRawTranscript(db, makeRow({ messageTimestamp: Date.now() }));
      const r = pruneOldRows(dir, 30);
      assert.equal(r.affected, 1);
      assert.equal(getDbStats(dir).tableCounts.raw_transcript, 1);
    });

    it("deletes checkpoint_epochs older than the cutoff", () => {
      const oldTs = Date.now() - 40 * 86_400_000;
      writeCheckpointEpoch(db, makeEpoch({ createdAt: oldTs }));
      writeCheckpointEpoch(db, makeEpoch({ createdAt: Date.now() }));
      const r = pruneOldRows(dir, 30);
      assert.equal(r.affected, 1);
      assert.equal(getDbStats(dir).tableCounts.checkpoint_epochs, 1);
    });
  });

  describe("integrityCheck", () => {
    it("returns ['ok'] on a healthy DB", () => {
      const lines = integrityCheck(dir);
      assert.deepEqual(lines, ["ok"]);
    });
  });

  describe("checkpointWal", () => {
    it("runs without error and reports checkpointed frames", () => {
      const r = checkpointWal(dir);
      assert.ok(r.summary.includes("wal_checkpoint(TRUNCATE)"));
    });
  });

  describe("vacuumDb", () => {
    it("rebuilds the DB file", () => {
      appendRawTranscript(db, makeRow());
      const r = vacuumDb(dir);
      assert.ok(r.summary.includes("VACUUM"));
      // DB file still exists after vacuum
      assert.ok(statSync(join(dir, "sqlite.db")).size > 0);
    });
  });

  describe("reconcileDedupMirror", () => {
    it("fixes ref_count drift and deletes orphans", () => {
      // Insert a dedup_mirror row with ref_count = 5 (drift: actual refs = 1).
      const hash = "hash-recon-1";
      upsertDedupMirror(db, hash, "content-bytes-1", 0);
      // Force a drift: bump ref_count without a matching raw_transcript row.
      db.prepare("UPDATE dedup_mirror SET ref_count = 5 WHERE content_hash = ?").run(hash);
      // Insert one raw_transcript row pointing at it. appendRawTranscript auto-
      // assigns seq = MAX(seq)+1 = 1 for the first row in this session.
      appendRawTranscript(db, makeRow({ contentHash: "rt-recon-1" }));
      updateRawTranscriptRef(db, "sess-1", 1, hash);

      const r = reconcileDedupMirror(dir);
      // ref_count should now be 1 (one raw_transcript row points at it).
      const dm = db
        .prepare("SELECT ref_count FROM dedup_mirror WHERE content_hash = ?")
        .get(hash) as { ref_count: number } | undefined;
      assert.equal(dm?.ref_count, 1);
      assert.equal(r.fixedRefCount, 1);
    });

    it("deletes orphan dedup_mirror rows (no raw_transcript refs)", () => {
      // Insert a dedup_mirror row with ref_count > 0 but NO raw_transcript ref.
      const hash = "hash-orphan-1";
      upsertDedupMirror(db, hash, "orphan-content", 0);
      db.prepare("UPDATE dedup_mirror SET ref_count = 3 WHERE content_hash = ?").run(hash);

      const r = reconcileDedupMirror(dir);
      const exists = db
        .prepare("SELECT 1 FROM dedup_mirror WHERE content_hash = ?")
        .get(hash);
      assert.equal(exists, undefined);
      assert.ok(r.orphansDeleted > 0);
    });
  });

  describe("autoMaintain", () => {
    it("runs best-effort and returns a summary string", () => {
      appendRawTranscript(db, makeRow());
      const result = autoMaintain(dir);
      assert.ok(typeof result === "string");
      assert.ok(result.startsWith("auto-maintain:"));
    });

    it("reports nothing to do on a fresh empty DB", () => {
      const result = autoMaintain(dir);
      assert.equal(result, "auto-maintain: nothing to do");
    });
  });
});
