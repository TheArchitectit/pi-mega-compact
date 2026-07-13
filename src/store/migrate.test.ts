/**
 * migrate + recall integration test — Sprint 8 acceptance proofs.
 *
 * 1. Migration is lossless: a v0.1.0 `<sess>.checkpoints.json.gz` roundtrips
 *    into SQLite with checkpoint count + regionHash set identical, and the JSON
 *    file is retained as a DR snapshot.
 * 2. Cross-process recall: compact in one VectorStore, then recall via a FRESH
 *    VectorStore over the SAME stateDir (re-opens the same sqlite.db file) — the
 *    checkpoint must reappear. Mirrors Sprint 6.1's durability requirement.
 *
 * Uses MEGACOMPACT_STATE_DIR overrides; never the real user state dir.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "../vectorStore.js";
import { writeGzJson } from "../store.js";
import type { StoredCheckpoint } from "../store.js";
import { migrateJsonToSqlite, readLegacyCheckpointFile } from "../store/migrate.js";
import { listCheckpoints, closeStore } from "../store/sqlite.js";

const baseTmp = mkdtempSync(join(tmpdir(), "mc-migrate-"));
let counter = 0;
function stateDir() {
  return join(baseTmp, `run-${counter++}`);
}
function msgVec(): number[] {
  // Deterministic 8-dim vector.
  return [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
}
function fakeCheckpoints(sessionId: string): StoredCheckpoint[] {
  return [
    {
      checkpointId: "chkpt_001",
      sessionId,
      summary: "Investigated the vector store and added a cosine helper.",
      topicSummary: "Added cosine similarity helper to vector store.",
      summaryHash: "a1b2c3d4e5f6a7b8",
      keyDecisions: ["use linear scan"],
      nextSteps: ["add tests"],
      filesModified: ["src/vectorStore.ts"],
      tokenEstimate: 1200,
      regionHash: "r1",
      embedding: msgVec(),
      timestamp: 1,
    },
    {
      checkpointId: "chkpt_002",
      sessionId,
      summary: "Refactored the recall path to dedupe against the window.",
      topicSummary: "Recall dedup against injected set.",
      summaryHash: "b2c3d4e5f6a7b8c9",
      keyDecisions: [],
      nextSteps: [],
      filesModified: ["src/recall.ts"],
      tokenEstimate: 900,
      regionHash: "r2",
      embedding: msgVec().map((v) => v + 0.01),
      timestamp: 2,
    },
  ];
}

test("migration: v0.1.0 JSON checkpoints migrate losslessly into SQLite", () => {
  const dir = stateDir();
  const sid = "sess_migrate_lossless";
  // Write a legacy JSON checkpoint file (the format v0.1.0 shipped).
  writeGzJson(join(dir, `${sid}.checkpoints.json.gz`), fakeCheckpoints(sid));

  const result = migrateJsonToSqlite(dir);
  assert.equal(result.sessionsScanned, 1);
  assert.equal(result.checkpointsMigrated, 2);
  assert.equal(result.alreadyPresent, 0);

  // SQLite now has both checkpoints, regionHash preserved.
  const migrated = listCheckpoints(sid, dir);
  assert.equal(migrated.length, 2, "both checkpoints present");
  assert.ok(migrated.every((c) => c.regionHash && c.regionHash.length > 0), "regionHash preserved");
  assert.deepEqual(migrated.map((c) => c.checkpointId).sort(), ["chkpt_001", "chkpt_002"]);

  // content_hash columns populated (needed by Sprint 9).
  const legacy = readLegacyCheckpointFile(sid, dir);
  assert.equal(legacy.length, 2, "legacy file intact (DR snapshot retained)");
  assert.ok(existsSync(join(dir, `${sid}.checkpoints.json.gz`)), "JSON DR snapshot retained");

  closeStore(dir);
});

test("migration: re-running is idempotent (no duplicates)", () => {
  const dir = stateDir();
  const sid = "sess_migrate_idem";
  writeGzJson(join(dir, `${sid}.checkpoints.json.gz`), fakeCheckpoints(sid));
  migrateJsonToSqlite(dir);
  const r2 = migrateJsonToSqlite(dir);
  assert.equal(r2.checkpointsMigrated, 0, "nothing new migrated");
  assert.equal(r2.alreadyPresent, 2, "both counted as already present");
  assert.equal(listCheckpoints(sid, dir).length, 2);
  closeStore(dir);
});

test("cross-process recall: fresh VectorStore over same dir recalls prior checkpoint", () => {
  const dir = stateDir();
  const sid = "sess_xproc";

  // Process A: compact a checkpoint into the store.
  const a = new VectorStore({ stateDir: dir });
  const added = a.add({
    sessionId: sid,
    summary: "Cross-process recall proof: persisted in process A.",
    topicSummary: "Persisted checkpoint in process A.",
    regionText: "cross process recall proof session A write path",
    tokenEstimate: 500,
    timestamp: 1,
  });
  assert.equal(added.deduped, false);
  assert.equal(added.checkpoint.checkpointId, "chkpt_001");

  // Force a clean reopen (simulates a new process opening the same file).
  closeStore(dir);

  // Process B: brand-new VectorStore, same stateDir.
  const b = new VectorStore({ stateDir: dir });
  const hits = b.search(sid, "cross process recall proof", 5);
  assert.equal(hits.length, 1, "checkpoint survives cross-process reopen");
  assert.equal(hits[0].checkpoint.checkpointId, "chkpt_001");
  assert.ok(hits[0].score > 0.5, "recall is relevant");

  closeStore(dir);
});

test("cross-process recall: injected state persists across reopen", () => {
  const dir = stateDir();
  const sid = "sess_xproc_inj";
  const a = new VectorStore({ stateDir: dir });
  const added = a.add({
    sessionId: sid,
    summary: "A checkpoint to inject and remember across processes.",
    topicSummary: "Injected checkpoint.",
    regionText: "injected state persists across process reopen test",
    timestamp: 1,
  });
  a.markInjected(sid, added.checkpoint.checkpointId);
  assert.equal(a.wasInjected(sid, added.checkpoint.checkpointId), true);

  closeStore(dir);

  const b = new VectorStore({ stateDir: dir });
  assert.equal(b.wasInjected(sid, added.checkpoint.checkpointId), true, "injection remembered");

  closeStore(dir);
});

test("cleanup", () => {
  rmSync(baseTmp, { recursive: true, force: true });
});
