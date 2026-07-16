import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMemoryOps } from "./memoryOps.js";
import {
  addMemory,
  listMemories,
  replaceMemory,
  referenceMemory,
  MEMORY_MAX_CHARS,
  MEMORY_MAX_ROWS,
} from "./store/sqlite.js";

const baseTmp = mkdtempSync(join(tmpdir(), "mc-memops-"));

test("applyMemoryOps: ADD inserts a new memory", async () => {
  const dir = join(baseTmp, "add");
  await applyMemoryOps(
    [{ op: "add", memory: { content: "we use node:sqlite as the store", category: "decision", sourceTurn: 0 } }],
    dir,
  );
  const rows = listMemories(null, 50, dir);
  assert.ok(rows.some((m) => /node:sqlite/.test(m.content)), "added memory present");
  assert.equal(rows[0].category, "decision", "category persisted");
});

test("applyMemoryOps: ADD is idempotent (no duplicate)", async () => {
  const dir = join(baseTmp, "dup");
  const op = { op: "add" as const, memory: { content: "threshold is 50k", category: "decision", sourceTurn: 0 } };
  await applyMemoryOps([op], dir);
  await applyMemoryOps([op], dir);
  const rows = listMemories(null, 50, dir);
  assert.equal(rows.filter((m) => /threshold is 50k/.test(m.content)).length, 1, "no duplicate");
});

test("applyMemoryOps: REPLACE updates the matching memory", async () => {
  const dir = join(baseTmp, "replace");
  addMemory({ content: "the threshold is 50k", category: "decision" }, null, dir);
  await applyMemoryOps(
    [{ op: "replace", targetContent: "the threshold is 50k", memory: { content: "the threshold is 100k", category: "decision", sourceTurn: 2 } }],
    dir,
  );
  const rows = listMemories(null, 50, dir);
  assert.ok(rows.some((m) => /100k/.test(m.content)), "replaced content present");
  assert.ok(!rows.some((m) => /50k/.test(m.content)), "old content gone");
});

test("applyMemoryOps: REMOVE deletes the matching memory", async () => {
  const dir = join(baseTmp, "remove");
  addMemory({ content: "obsolete note", category: "note" }, null, dir);
  await applyMemoryOps([{ op: "remove", content: "obsolete note" }], dir);
  const rows = listMemories(null, 50, dir);
  assert.ok(!rows.some((m) => /obsolete note/.test(m.content)), "removed");
});

test("S24: addMemory truncates content to MEMORY_MAX_CHARS", () => {
  const dir = join(baseTmp, "cap");
  const big = "x".repeat(MEMORY_MAX_CHARS + 5000);
  const id = addMemory({ content: big, category: "note" }, null, dir);
  const rows = listMemories(null, 50, dir);
  const row = rows.find((m) => m.id === id);
  assert.ok(row, "row present");
  assert.ok(row!.content.length <= MEMORY_MAX_CHARS + 12, "content capped (incl. marker)");
  assert.ok(row!.content.endsWith("…[truncated]"), "marker appended");
});

test("S24: replaceMemory also truncates oversized content", () => {
  const dir = join(baseTmp, "capreplace");
  const id = addMemory({ content: "short", category: "note" }, null, dir);
  const big = "y".repeat(MEMORY_MAX_CHARS + 1000);
  replaceMemory(id, { content: big }, dir);
  const rows = listMemories(null, 50, dir);
  const row = rows.find((m) => m.id === id);
  assert.ok(row, "row present");
  assert.ok(row!.content.length <= MEMORY_MAX_CHARS + 12, "replaced content capped");
  assert.ok(row!.content.endsWith("…[truncated]"), "marker appended");
});

test("S24: addMemory evicts LRU rows past MEMORY_MAX_ROWS per repo", () => {
  const dir = join(baseTmp, "lru");
  const n = MEMORY_MAX_ROWS;
  const seeds = n - 2;
  for (let i = 0; i < seeds; i++) addMemory({ content: `seed-${i}`, category: "note" }, null, dir);
  const keep1 = addMemory({ content: "keep-recent-1", category: "note" }, null, dir);
  const keep2 = addMemory({ content: "keep-recent-2", category: "note" }, null, dir);
  // Mark the two as referenced so the LRU eviction spares them (they get a
  // higher last_referenced than the un-referenced seeds).
  assert.ok(referenceMemory(keep1, dir), "reference keep1");
  assert.ok(referenceMemory(keep2, dir), "reference keep2");
  // Insert 3 more — 3 over the cap across the inserts. The two referenced rows
  // must survive; only un-referenced (oldest) seeds should be evicted.
  addMemory({ content: "new-1", category: "note" }, null, dir);
  addMemory({ content: "new-2", category: "note" }, null, dir);
  addMemory({ content: "new-3", category: "note" }, null, dir);
  const rows = listMemories(null, 1000, dir);
  assert.equal(rows.length, n, "row count clamped to MEMORY_MAX_ROWS");
  assert.ok(rows.some((m) => /keep-recent-1/.test(m.content)), "referenced row survived");
  assert.ok(rows.some((m) => /keep-recent-2/.test(m.content)), "referenced row survived");
  assert.ok(rows.some((m) => /new-3/.test(m.content)), "newest row present");
  const seedRows = rows.filter((m) => /seed-/.test(m.content));
  // 3 rows were evicted (the inserts pushed 3 past the cap); all evicted rows
  // must be un-referenced seeds — the referenced rows survived above.
  assert.equal(seedRows.length, seeds - 3, "exactly 3 oldest un-referenced seeds evicted");
  assert.ok(!seedRows.some((m) => /seed-0/.test(m.content)), "oldest un-referenced seed evicted");
});

test("cleanup memops", () => {
  rmSync(baseTmp, { recursive: true, force: true });
});
