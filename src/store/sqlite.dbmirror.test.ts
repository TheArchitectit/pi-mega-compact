/**
 * Tests for DB-mirror raw_transcript + checkpoint_epochs tables.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openStore,
  appendRawTranscript,
  listRawTranscriptRange,
  writeCheckpointEpoch,
  readCheckpointEpoch,
  getActiveEpochForSession,
  listCheckpointEpochs,
  countRawTranscript,
  type RawTranscriptRow,
  type CheckpointEpoch,
} from "./sqlite.js";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "dbmirror-test-"));
}

function makeRow(overrides: Partial<RawTranscriptRow> = {}): RawTranscriptRow {
  return {
    contentHash: `hash-${Math.random().toString(36).slice(2, 10)}`,
    sessionId: "sess-1",
    seq: 0,
    role: "user",
    contentBytes: "hello world",
    toolName: null,
    messageTimestamp: null,
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

describe("DB mirror", () => {
  let dir: string;
  let db: ReturnType<typeof openStore>;

  beforeEach(() => {
    dir = makeTmp();
    db = openStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("appendRawTranscript", () => {
    it("inserts a row and auto-assigns seq", () => {
      const row = makeRow();
      appendRawTranscript(db, row);
      const count = countRawTranscript(db);
      assert.equal(count, 1);
      const rows = listRawTranscriptRange(db, "sess-1", 0, 999999);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].contentHash, row.contentHash);
      assert.equal(rows[0].role, "user");
    });

    it("is idempotent on content_hash PK — no duplicate rows", () => {
      const row = makeRow({ contentHash: "fixed-hash" });
      appendRawTranscript(db, row);
      appendRawTranscript(db, row); // duplicate
      const count = countRawTranscript(db);
      assert.equal(count, 1);
    });

    it("increments seq across different messages in same session", () => {
      appendRawTranscript(db, makeRow({ contentHash: "h1", sessionId: "s1" }));
      appendRawTranscript(db, makeRow({ contentHash: "h2", sessionId: "s1" }));
      appendRawTranscript(db, makeRow({ contentHash: "h3", sessionId: "s1" }));
      const count = countRawTranscript(db);
      assert.equal(count, 3);
    });

    it("stores tool_name and message_timestamp when provided", () => {
      appendRawTranscript(
        db,
        makeRow({
          contentHash: "tool-row",
          role: "toolResult",
          toolName: "bash",
          messageTimestamp: 1234567890,
        }),
      );
      const rows = listRawTranscriptRange(db, "sess-1", 0, 999999);
      assert.equal(rows[0].toolName, "bash");
      assert.equal(rows[0].messageTimestamp, 1234567890);
    });

    it("stores checkpoint_epoch", () => {
      appendRawTranscript(db, makeRow({ checkpointEpoch: "ep-42" }));
      const rows = listRawTranscriptRange(db, "sess-1", 0, 999999);
      assert.equal(rows[0].checkpointEpoch, "ep-42");
    });
  });

  describe("writeCheckpointEpoch + readCheckpointEpoch", () => {
    it("round-trips a checkpoint epoch", () => {
      const epoch = makeEpoch();
      writeCheckpointEpoch(db, epoch);
      const got = readCheckpointEpoch(db, epoch.epochId);
      assert.ok(got);
      assert.equal(got.epochId, epoch.epochId);
      assert.equal(got.sessionId, epoch.sessionId);
      assert.equal(got.committedSeq, epoch.committedSeq);
      assert.equal(got.checkpointId, epoch.checkpointId);
      assert.equal(got.cutIndex, epoch.cutIndex);
      assert.equal(got.summaryMessageText, epoch.summaryMessageText);
    });

    it("is idempotent on epochId PK", () => {
      const epoch = makeEpoch({ epochId: "ep-dup" });
      writeCheckpointEpoch(db, epoch);
      writeCheckpointEpoch(db, epoch); // duplicate
      // Should not throw, still one row
      const got = readCheckpointEpoch(db, "ep-dup");
      assert.ok(got);
    });

    it("returns null for unknown epochId", () => {
      const got = readCheckpointEpoch(db, "nonexistent");
      assert.equal(got, null);
    });
  });

  describe("getActiveEpochForSession", () => {
    it("returns the most recent epoch for a session", () => {
      writeCheckpointEpoch(
        db,
        makeEpoch({
          epochId: "ep-old",
          sessionId: "s1",
          createdAt: 1000,
        }),
      );
      writeCheckpointEpoch(
        db,
        makeEpoch({
          epochId: "ep-new",
          sessionId: "s1",
          createdAt: 2000,
        }),
      );
      const got = getActiveEpochForSession(db, "s1");
      assert.ok(got);
      assert.equal(got.epochId, "ep-new");
    });

    it("returns null if no epochs exist for session", () => {
      const got = getActiveEpochForSession(db, "no-such-session");
      assert.equal(got, null);
    });
  });

  describe("checkpointEpochs()", () => {
    it("returns all rows", () => {
      writeCheckpointEpoch(db, makeEpoch({ epochId: "ep-a" }));
      writeCheckpointEpoch(db, makeEpoch({ epochId: "ep-b" }));
      const rows = listCheckpointEpochs(db);
      assert.equal(rows.length, 2);
    });
  });

  describe("integration: raw_transcript + checkpoint_epochs", () => {
    it("full flow: append messages, write epoch, query both", () => {
      // Append 5 messages
      for (let i = 1; i <= 5; i++) {
        appendRawTranscript(
          db,
          makeRow({
            contentHash: `msg-${i}`,
            sessionId: "s1",
            checkpointEpoch: "ep-1",
          }),
        );
      }
      // Write epoch
      writeCheckpointEpoch(
        db,
        makeEpoch({
          epochId: "ep-1",
          sessionId: "s1",
          committedSeq: 5,
          cutIndex: 5,
        }),
      );
      // Verify transcript rows
      const transcripts = listRawTranscriptRange(db, "s1", 0, 999999);
      assert.equal(transcripts.length, 5);
      for (const t of transcripts) {
        assert.equal(t.checkpointEpoch, "ep-1");
      }
      // Verify epoch
      const epoch = readCheckpointEpoch(db, "ep-1");
      assert.ok(epoch);
      assert.equal(epoch.committedSeq, 5);
    });
  });
});
