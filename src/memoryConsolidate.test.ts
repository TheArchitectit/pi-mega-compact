import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consolidateMemories } from "./memory.js";
import { addMemory, listMemories } from "./store/sqlite.js";

const baseTmp = mkdtempSync(join(tmpdir(), "mc-consolidate-"));

test("consolidateMemories: merges near-duplicate memories (one kept, one removed)", async () => {
  const dir = join(baseTmp, "merge");
  // Two near-identical memories — same topic, minor wording drift.
  addMemory({ content: "we use node:sqlite as the store", category: "decision" }, null, dir);
  addMemory({ content: "we use node:sqlite for our store", category: "decision" }, null, dir);

  const merged = await consolidateMemories(dir);
  assert.equal(merged, 1, "one merge was performed");

  const rows = listMemories(null, 50, dir);
  // Exactly one of the two near-dupes survives.
  assert.equal(rows.length, 1, "exactly one memory remains after merge");
  assert.match(rows[0].content, /node:sqlite.*store/i, "survivor mentions node:sqlite + store");
});

test("consolidateMemories: leaves unrelated memories alone", async () => {
  const dir = join(baseTmp, "noop");
  addMemory({ content: "we use node:sqlite as the store", category: "decision" }, null, dir);
  addMemory({ content: "the gpt-5 release is on hold pending benchmark results", category: "note" }, null, dir);

  const merged = await consolidateMemories(dir);
  assert.equal(merged, 0, "no merges on unrelated memories");

  const rows = listMemories(null, 50, dir);
  assert.equal(rows.length, 2, "both memories survive");
});

test("consolidateMemories: empty store returns 0 and changes nothing", async () => {
  const dir = join(baseTmp, "empty");
  const merged = await consolidateMemories(dir);
  assert.equal(merged, 0, "no merges on empty store");
  assert.equal(listMemories(null, 50, dir).length, 0, "store still empty");
});

test("cleanup memops", () => {
  rmSync(baseTmp, { recursive: true, force: true });
});
