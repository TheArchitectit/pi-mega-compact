import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMemoryOps } from "./memoryOps.js";
import { addMemory, listMemories } from "./store/sqlite.js";

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

test("cleanup memops", () => {
  rmSync(baseTmp, { recursive: true, force: true });
});
