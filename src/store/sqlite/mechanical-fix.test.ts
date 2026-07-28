/**
 * mechanical-fix.test.ts — focused unit tests for the SQLite-side mechanical-fix
 * batch: safeJson (utils.ts), storeStats numeric MAX + dedup_status filter
 * (stats.ts), addTokensSaved CAST AS REAL (meta.ts), evictMemoryLru named
 * @param bindings (memories.ts). Pi-agnostic; uses isolated state dirs (G7).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { safeJson, closeStore } from "./utils.js";
import { storeStats } from "./stats.js";
import { upsertCheckpoint, setDedupStatus } from "./checkpoints.js";
import { addTokensSaved, getTokensSaved } from "./meta.js";
import { addMemory, listMemories } from "./memories.js";
import type { StoredCheckpoint } from "../../store.js";

function makeCp(id: string, sessionId: string): StoredCheckpoint {
  return {
    checkpointId: id,
    sessionId,
    summary: `summary-${id}`,
    keyDecisions: [],
    nextSteps: [],
    filesModified: [],
    tokenEstimate: 100,
    regionHash: `hash-${id}`,
    embedding: [],
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// safeJson (utils.ts)
// ---------------------------------------------------------------------------

describe("mechanical-fix: safeJson (utils.ts)", () => {
  it("returns fallback on null, undefined, empty, and corrupt JSON", () => {
    assert.deepEqual(safeJson<string[]>(null, []), []);
    assert.deepEqual(safeJson<string[]>(undefined, []), []);
    assert.deepEqual(safeJson<string[]>("", []), []);
    assert.deepEqual(safeJson<string[]>("not json", ["fb"]), ["fb"]);
    assert.deepEqual(safeJson<string[]>('["a","b"]', []), ["a", "b"]);
    assert.equal(safeJson<number>(null, 42), 42);
    assert.deepEqual(safeJson<Record<string, number>>('{"k":1}', {}), { k: 1 });
  });
});

// ---------------------------------------------------------------------------
// storeStats (stats.ts) — numeric MAX(id) + dedup_status filter
// ---------------------------------------------------------------------------

describe("mechanical-fix: storeStats (stats.ts)", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "mc-mech-stats-"));
    process.env.MEGACOMPACT_STATE_DIR = dir;
  });
  after(() => {
    closeStore(dir);
    delete process.env.MEGACOMPACT_STATE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns numerically-max checkpoint id (not lexicographic) for 100+ checkpoints", () => {
    const sid = "sess_stats";
    // Insert chkpt_001..chkpt_100 (100 checkpoints) + chkpt_999 + chkpt_1000.
    // Numeric max = 1000 → "chkpt_1000"; lexicographic max would be "chkpt_999"
    // (because '9' > '1' at position 6 when comparing 8 vs 9-char strings).
    for (let i = 1; i <= 100; i++) {
      upsertCheckpoint(makeCp(`chkpt_${String(i).padStart(3, "0")}`, sid), dir);
    }
    upsertCheckpoint(makeCp("chkpt_999", sid), dir);
    upsertCheckpoint(makeCp("chkpt_1000", sid), dir);

    const s = storeStats(sid, dir);
    assert.equal(s.checkpointCount, 102);
    assert.equal(s.lastCheckpointId, "chkpt_1000");
    assert.equal(s.lastSummary, "summary-chkpt_1000");
  });

  it("excludes dedup_status='removed' rows from counts", () => {
    const sid = "sess_dedup";
    upsertCheckpoint(makeCp("chkpt_001", sid), dir);
    upsertCheckpoint(makeCp("chkpt_002", sid), dir);
    setDedupStatus("chkpt_001", sid, "removed", dir);
    const s = storeStats(sid, dir);
    assert.equal(s.checkpointCount, 1);
    assert.equal(s.lastCheckpointId, "chkpt_002");
  });
});

// ---------------------------------------------------------------------------
// addTokensSaved (meta.ts) — CAST AS REAL preserves fractional values
// ---------------------------------------------------------------------------

describe("mechanical-fix: addTokensSaved (meta.ts)", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "mc-mech-meta-"));
    process.env.MEGACOMPACT_STATE_DIR = dir;
  });
  after(() => {
    closeStore(dir);
    delete process.env.MEGACOMPACT_STATE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("preserves fractional values (CAST AS REAL, not INTEGER)", () => {
    addTokensSaved(10.5, dir);
    assert.equal(getTokensSaved(dir), 10.5);
    addTokensSaved(10.5, dir);
    // With INTEGER: CAST("10.5" AS INTEGER)=10, 10+10.5=20.5.
    // With REAL: CAST("10.5" AS REAL)=10.5, 10.5+10.5=21.
    assert.equal(getTokensSaved(dir), 21);
  });
});

// ---------------------------------------------------------------------------
// evictMemoryLru (memories.ts) — named @param bindings
// ---------------------------------------------------------------------------

describe("mechanical-fix: evictMemoryLru (memories.ts)", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "mc-mech-mem-"));
    process.env.MEGACOMPACT_STATE_DIR = dir;
    process.env.MEGACOMPACT_MEMORY_MAX_ROWS = "3";
  });
  after(() => {
    closeStore(dir);
    delete process.env.MEGACOMPACT_STATE_DIR;
    delete process.env.MEGACOMPACT_MEMORY_MAX_ROWS;
    rmSync(dir, { recursive: true, force: true });
  });

  it("evicts oldest rows past cap (repo-scoped, @repo named binding)", () => {
    const repo = "test-repo";
    for (let i = 0; i < 5; i++) {
      addMemory({ content: `memory-${i}` }, repo, dir);
    }
    const memories = listMemories(repo, 100, dir);
    assert.equal(memories.length, 3);
    // Oldest two (memory-0, memory-1) evicted; memory-2, 3, 4 survive.
    const contents = memories.map((m) => m.content).sort();
    assert.deepEqual(contents, ["memory-2", "memory-3", "memory-4"]);
  });

  it("handles null-repo scope (repo IS NULL branch, @over only)", () => {
    for (let i = 0; i < 4; i++) {
      addMemory({ content: `nullmem-${i}` }, null, dir);
    }
    // listMemories(null, ...) returns ALL rows (no repo filter); narrow to
    // null-repo rows to verify the IS NULL eviction branch in isolation.
    const nullMemories = listMemories(null, 100, dir).filter((m) => m.repo === null);
    assert.equal(nullMemories.length, 3);
    // Oldest (nullmem-0) evicted.
    const contents = nullMemories.map((m) => m.content).sort();
    assert.deepEqual(contents, ["nullmem-1", "nullmem-2", "nullmem-3"]);
  });
});
