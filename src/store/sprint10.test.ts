import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "../vectorStore.js";
import { normalize } from "../dedup/normalize.js";
import { openBloom, closeBloom } from "./bloom.js";
import { backfillContentHashes, isBackfillComplete } from "./backfill.js";
import { checkSessionIntegrity, checkAllIntegrity } from "./integrity.js";
import { openStore, closeStore, upsertCheckpoint, saveSessionState, loadSessionState } from "./sqlite.js";
import type { StoredCheckpoint } from "../store.js";

const baseTmp = mkdtempSync(join(tmpdir(), "mc-s10-"));

let counter = 0;
function store(opts: { dedupSim?: number } = {}) {
  const dir = join(baseTmp, `run-${counter++}`);
  return { s: new VectorStore({ dedupSim: opts.dedupSim ?? 0.9, stateDir: dir }), dir };
}

// --- L0 normalization upgrade (case/whitespace/ANSI collapse) --------------

test("Sprint 10 L0: case/whitespace/ANSI variants dedup to one row", () => {
  const { s } = store();
  const variants = ["user reviewed the auth module and merged the PR", "  USER   REVIEWED the AUTH module and MERGED the PR ", "USER REVIEWED THE AUTH MODULE AND MERGED THE PR"];
  let added = 0;
  for (const v of variants) {
    const r = s.add({ sessionId: "sess_norm", summary: "x", regionText: v, timestamp: added + 1 });
    if (!r.deduped) added++;
  }
  assert.equal(s.list("sess_norm").length, 1);
});

test("normalize case-folds so Foo/foo/FOO are equal", () => {
  assert.equal(normalize("Foo Bar"), normalize("foo bar"));
  assert.equal(normalize("FOO BAR"), normalize("foo bar"));
});

test("normalize strips ANSI before hashing", () => {
  assert.equal(normalize("err\x1b[31m fatal\x1b[0m"), normalize("err fatal"));
});

// --- Bloom accelerator ------------------------------------------------------

test("bloom miss short-circuits the scan; hit is confirmed by query", () => {
  const { s, dir } = store();
  const raw = "the region text under test for bloom behavior";
  s.add({ sessionId: "sess_bloom", summary: "x", regionText: raw, timestamp: 1 });
  const bloom = openBloom(dir);
  // content_hash for `raw` is present → hit path must confirm via query and dedup.
  assert.equal(bloom.maybeHas("this-key-is-not-present"), false); // definitive miss
  const r2 = s.add({ sessionId: "sess_bloom", summary: "x", regionText: raw, timestamp: 2 });
  assert.equal(r2.deduped, true);
  assert.equal(r2.reason, "contentHash");
});

test("bloom persists to disk and reloads warm", () => {
  const dir = join(baseTmp, `run-${counter++}`);
  const s1 = new VectorStore({ stateDir: dir });
  s1.add({ sessionId: "sess_persist", summary: "x", regionText: "persisted region", timestamp: 1 });
  closeBloom(dir); // evict cache so the next open reads from disk
  const s2 = new VectorStore({ stateDir: dir });
  const r = s2.add({ sessionId: "sess_persist", summary: "x", regionText: "persisted region", timestamp: 2 });
  assert.equal(r.deduped, true);
});

// --- Atomic write + QA #13 timeout degrade ---------------------------------

test("duplicate add is idempotent (no partial rows, single checkpoint)", () => {
  const { s } = store();
  const raw = "idempotent region content for atomicity check";
  const a = s.add({ sessionId: "sess_atom", summary: "x", regionText: raw, timestamp: 1 });
  const b = s.add({ sessionId: "sess_atom", summary: "x", regionText: raw, timestamp: 2 });
  assert.equal(a.deduped, false);
  assert.equal(b.deduped, true);
  assert.equal(s.list("sess_atom").length, 1);
});

// --- Backfill orchestrator -------------------------------------------------

test("backfill populates null content_hash rows and is idempotent", () => {
  const dir = join(baseTmp, `run-${counter++}`);
  openStore(dir);
  // Seed two rows with null content_hash via direct upsert (simulating legacy data).
  const cp = (id: string, summary: string): StoredCheckpoint => ({
    checkpointId: id,
    sessionId: "sess_bf",
    summary,
    keyDecisions: [],
    nextSteps: [],
    filesModified: [],
    tokenEstimate: 0,
    regionHash: "r",
    embedding: [0, 0, 0],
    timestamp: 1,
  });
  upsertCheckpoint(cp("chkpt_001", "alpha summary"), dir);
  upsertCheckpoint(cp("chkpt_002", "beta summary"), dir);

  const r1 = backfillContentHashes(dir);
  assert.equal(r1.updated, 2);
  assert.equal(r1.processed, 2);
  assert.equal(isBackfillComplete(dir), true);

  // Second run is a no-op (idempotent): no rows left to process.
  const r2 = backfillContentHashes(dir);
  assert.equal(r2.processed, 0);
});

test("backfill resolves a content_hash collision keeping the oldest row", () => {
  const dir = join(baseTmp, `run-${counter++}`);
  openStore(dir);
  // Both rows share the same normalized summary → same content_hash.
  const cp = (id: string): StoredCheckpoint => ({
    checkpointId: id,
    sessionId: "sess_dup",
    summary: "identical normalized summary text",
    keyDecisions: [],
    nextSteps: [],
    filesModified: [],
    tokenEstimate: 0,
    regionHash: "r",
    embedding: [0, 0, 0],
    timestamp: 1,
  });
  upsertCheckpoint(cp("chkpt_001"), dir);
  upsertCheckpoint(cp("chkpt_002"), dir);
  const r = backfillContentHashes(dir);
  assert.equal(r.duplicatesResolved, 1);
  assert.equal(r.updated, 1);
});

// --- Integrity checks ------------------------------------------------------

test("integrity flags a tampered storedRegionHashes set", () => {
  const dir = join(baseTmp, `run-${counter++}`);
  const s = new VectorStore({ stateDir: dir });
  s.add({ sessionId: "sess_int", summary: "x", regionText: "integrity region one", timestamp: 1 });
  s.add({ sessionId: "sess_int", summary: "y", regionText: "integrity region two", timestamp: 2 });
  const okReport = checkSessionIntegrity("sess_int", dir);
  assert.equal(okReport.ok, true); // consistent after normal adds

  // Simulate tampering: the sentinel stores a region hash the checkpoints lack.
  const db = openStore(dir);
  db.prepare(
    "UPDATE session_state SET stored_region_hashes = ? WHERE session_id = ?",
  ).run(JSON.stringify(["deadbeefcafe0000"]), "sess_int");
  const tampered = checkSessionIntegrity("sess_int", dir);
  assert.equal(tampered.ok, false);
  assert.equal(tampered.regionHashMismatch, true);
});

test("integrity detects an orphan injectedCheckpointId", () => {
  const dir = join(baseTmp, `run-${counter++}`);
  const s = new VectorStore({ stateDir: dir });
  s.add({ sessionId: "sess_orphan", summary: "x", regionText: "orphan region", timestamp: 1 });
  // Manually inject a dangling id into session state (SQLite-backed).
  const st = loadSessionState("sess_orphan", dir);
  st.injectedCheckpointIds.push("chkpt_999");
  saveSessionState("sess_orphan", st, dir);
  const report = checkSessionIntegrity("sess_orphan", dir);
  assert.equal(report.ok, false);
  assert.deepEqual(report.orphanInjectedIds, ["chkpt_999"]);
});

test("checkAllIntegrity covers every session", () => {
  const dir = join(baseTmp, `run-${counter++}`);
  const s = new VectorStore({ stateDir: dir });
  s.add({ sessionId: "sess_a", summary: "x", regionText: "a region", timestamp: 1 });
  s.add({ sessionId: "sess_b", summary: "y", regionText: "b region", timestamp: 1 });
  const reports = checkAllIntegrity(dir);
  assert.equal(reports.length, 2);
  assert.ok(reports.every((r: { ok: boolean }) => r.ok));
});

// --- schema migration (v0.4.2: original_token_estimate) -------------------

test("Sprint 10 migration: pre-0.4.2 db gains original_token_estimate and repoStats works", () => {
  const dir = join(baseTmp, `run-${counter++}`);
  // Simulate a v0.4.1-era store: openStore() builds the full current schema,
  // then drop the original_token_estimate column that 0.4.2 added. CREATE TABLE
  // IF NOT EXISTS is a no-op on an existing table, which is exactly why the
  // shipped v0.4.2 crashed at runtime on old repos ("no such column").
  const db = openStore(dir);
  db.exec("ALTER TABLE context_chunks DROP COLUMN original_token_estimate;");
  closeStore(dir);

  // Re-open through the real code path — must ALTER the column in, not crash.
  const vs = new VectorStore({ dedupSim: 0.9, stateDir: dir });
  vs.add({
    sessionId: "sess_mig",
    summary: "legacy region",
    regionText: "some region text to compact",
    tokenEstimate: 100,
    originalTokenEstimate: 500,
    timestamp: 1,
  });
  const repo = vs.repoStats();
  // No "no such column" crash = migration succeeded; totals reflect the new col.
  assert.equal(repo.checkpointCount, 1);
  assert.equal(repo.originalTokens, 500, "originalTokens read from migrated column");
  // Re-open a second time to prove idempotency (column already exists).
  closeStore(dir);
  const vs2 = new VectorStore({ dedupSim: 0.9, stateDir: dir });
  assert.equal(vs2.repoStats().originalTokens, 500, "stable across re-open");
});

// --- cleanup ---------------------------------------------------------------

test("Sprint 10 cleanup", () => {
  closeStore(baseTmp);
  rmSync(baseTmp, { recursive: true, force: true });
});
