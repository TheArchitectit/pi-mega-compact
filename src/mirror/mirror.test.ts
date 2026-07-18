/**
 * mirror.test.ts — S27 DB-mirror integration tests.
 *
 * Pi-agnostic: no pi runtime imports (src/ invariant).
 *
 * NOTE: raw_transcript has PRIMARY KEY (content_hash, session_id), so
 * duplicate content in the same session is silently dropped by INSERT OR IGNORE.
 * Tests are designed around this constraint.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { openStore, closeStore } from "../../src/store/sqlite.js";
import {
  writeCheckpointEpoch,
  listCheckpointEpochs,
  appendRawTranscript,
  listRawTranscriptRange,
  upsertDedupMirror,
  getDedupRatio,
  getDedupMirrorStats,
  countRawTranscript,
} from "../../src/store/sqlite.js";
import { epochIdFor } from "../../src/mirror/epoch.js";
import { dedupTranscript } from "../../src/mirror/dedup.js";
import { computeContentDigest } from "../../src/dedup/digest.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "mirror-test-"));
}

/**
 * Build a valid RawTranscriptRow using the canonical content hash from
 * computeContentDigest (matches what dedupTranscript uses).
 */
function mkRow(
  sessionId: string,
  seq: number, // ignored by appendRawTranscript (auto-assigned)
  role: "user" | "assistant",
  content: string,
) {
  const { contentHash } = computeContentDigest(content);
  return {
    contentHash,
    sessionId,
    seq,
    role,
    contentBytes: content,
    toolName: null as string | null,
    messageTimestamp: Date.now() as number | null,
    checkpointEpoch: "",
  };
}

describe("S27 DB-mirror", () => {
  it("epochIdFor is deterministic", () => {
    assert.equal(epochIdFor("cp-abc-123"), epochIdFor("cp-abc-123"));
    assert.notEqual(epochIdFor("cp-abc-123"), epochIdFor("cp-abc-456"));
    const id = epochIdFor("cp-abc-123");
    assert.ok(id.startsWith("epoch:"));
    assert.ok(id.length > 6);
  });

  it("writeCheckpointEpoch + listCheckpointEpochs round-trips", () => {
    const dir = tmp();
    const db: DatabaseSync = openStore(dir);

    writeCheckpointEpoch(db, {
      epochId: "epoch-test-001",
      sessionId: "sess-abc",
      startedSeq: 0,
      committedSeq: 100,
      checkpointId: "cp-test-001",
      cutIndex: 100,
      summaryMessageText: "Test summary",
      createdAt: Date.now(),
    });

    const rows = listCheckpointEpochs(db);
    assert.ok(rows.length >= 1);
    assert.equal(rows[0].epochId, "epoch-test-001");
    assert.equal(rows[0].sessionId, "sess-abc");
    assert.equal(rows[0].checkpointId, "cp-test-001");

    closeStore(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  it("appendRawTranscript + listRawTranscriptRange round-trips (unique content)", () => {
    const dir = tmp();
    const db: DatabaseSync = openStore(dir);

    // Use unique content for each row to avoid PK collision
    appendRawTranscript(db, mkRow("sess-abc", 0, "user", "first message"));
    appendRawTranscript(db, mkRow("sess-abc", 1, "assistant", "second message"));
    appendRawTranscript(db, mkRow("sess-abc", 2, "user", "third message"));

    // seq is auto-assigned: 1, 2, 3
    const rows = listRawTranscriptRange(db, "sess-abc", 0, 10);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].contentBytes, "first message");
    assert.equal(rows[0].seq, 1);
    assert.equal(rows[1].contentBytes, "second message");
    assert.equal(rows[1].seq, 2);
    assert.equal(rows[2].contentBytes, "third message");
    assert.equal(rows[2].seq, 3);

    // Range filter: [2..3]
    const rows2 = listRawTranscriptRange(db, "sess-abc", 2, 3);
    assert.equal(rows2.length, 2);
    assert.equal(rows2[0].contentBytes, "second message");
    assert.equal(rows2[1].contentBytes, "third message");

    closeStore(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  it("upsertDedupMirror increments ref_count for duplicate content", () => {
    const dir = tmp();
    const db: DatabaseSync = openStore(dir);

    const isNew1 = upsertDedupMirror(db, "hash-aaa", "Hello", 0);
    assert.equal(isNew1, true);

    const isNew2 = upsertDedupMirror(db, "hash-aaa", "Hello", 1);
    assert.equal(isNew2, false);

    const stats = getDedupMirrorStats(db);
    assert.equal(stats.rowCount, 1);
    assert.equal(stats.avgRefCount, 2);

    closeStore(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  it("dedupTranscript deduplicates cross-session content via dedup_mirror", () => {
    const dir = tmp();
    const db: DatabaseSync = openStore(dir);

    // Insert same content in TWO different sessions (raw_transcript PK allows this)
    appendRawTranscript(db, mkRow("sess-a", 0, "user", "shared hello"));
    appendRawTranscript(db, mkRow("sess-a", 1, "assistant", "shared world"));
    appendRawTranscript(db, mkRow("sess-a", 2, "user", "unique A"));
    appendRawTranscript(db, mkRow("sess-b", 0, "user", "shared hello"));
    appendRawTranscript(db, mkRow("sess-b", 1, "assistant", "shared world"));
    appendRawTranscript(db, mkRow("sess-b", 2, "user", "unique B"));

    // Dedup session A: 3 rows, all new → deduped=0
    const dedupedA = dedupTranscript(db, "sess-a", 0, 10);
    assert.equal(dedupedA, 0);

    // Dedup session B: 3 rows, but 2 already in dedup_mirror → deduped=2
    const dedupedB = dedupTranscript(db, "sess-b", 0, 10);
    assert.equal(dedupedB, 2);

    // dedup_mirror has 4 unique hashes: shared-hello, shared-world, unique-A, unique-B
    const stats = getDedupMirrorStats(db);
    assert.equal(stats.rowCount, 4);
    assert.ok(stats.avgRefCount > 1);

    closeStore(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  it("getDedupRatio reflects dedup savings", () => {
    const dir = tmp();
    const db: DatabaseSync = openStore(dir);

    // Two sessions with identical content → cross-session dedup
    for (let i = 0; i < 3; i++) {
      appendRawTranscript(db, mkRow("sess-x", i, "user", "same content"));
      appendRawTranscript(db, mkRow("sess-y", i, "user", "same content"));
    }
    // Each session has 1 row (PK dedup within session), so 1 row each
    // sess-x: 1 row, sess-y: 1 row

    dedupTranscript(db, "sess-x", 0, 10);
    dedupTranscript(db, "sess-y", 0, 10);

    // For sess-x: totalBytes = LENGTH("same content") = 12, uniqueBytes = 12 → ratio 1.0
    const { totalBytes, uniqueBytes, ratio } = getDedupRatio(db, "sess-x");
    assert.ok(totalBytes > 0);
    assert.ok(uniqueBytes > 0);
    assert.ok(ratio >= 1.0);

    closeStore(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  it("full pipeline: append + dedup + epoch", () => {
    const dir = tmp();
    const db: DatabaseSync = openStore(dir);

    // Insert 5 unique rows
    const contents = ["alpha", "bravo", "charlie", "delta", "echo"];
    for (let i = 0; i < contents.length; i++) {
      appendRawTranscript(
        db,
        mkRow("sess-pipe", i, i % 2 === 0 ? "user" : "assistant", contents[i]),
      );
    }

    const total = countRawTranscript(db);
    assert.ok(total >= 5);

    // Dedup: all 5 unique → deduped = 0
    const deduped = dedupTranscript(db, "sess-pipe", 0, 100);
    assert.equal(deduped, 0);

    // Mirror should have 5 unique hashes
    const stats = getDedupMirrorStats(db);
    assert.equal(stats.rowCount, 5);

    // Write checkpoint epoch
    writeCheckpointEpoch(db, {
      epochId: "epoch-integration",
      sessionId: "sess-pipe",
      startedSeq: 0,
      committedSeq: 100,
      checkpointId: "cp-integration",
      cutIndex: 5,
      summaryMessageText: "Integration test summary",
      createdAt: Date.now(),
    });

    const epochs = listCheckpointEpochs(db);
    assert.ok(epochs.length >= 1);
    assert.equal(epochs[0].epochId, "epoch-integration");

    const rows = listRawTranscriptRange(db, "sess-pipe", 0, 100);
    assert.equal(rows.length, 5);

    closeStore(dir);
    rmSync(dir, { recursive: true, force: true });
  });
});
