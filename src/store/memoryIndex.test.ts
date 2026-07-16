import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultEmbedder } from "../embedder.js";
import {
  upsertMemoryEmbedding,
  searchMemoriesAsync,
  initMemoryIndex,
  closeMemoryIndex,
  isMemoryIndexDisabled,
} from "./memoryIndex.js";

const baseTmp = mkdtempSync(join(tmpdir(), "mc-memidx-"));

test("memoryIndex: disabled when MEGACOMPACT_PGLITE_DISABLED", async () => {
  process.env.MEGACOMPACT_PGLITE_DISABLED = "true";
  try {
    assert.equal(isMemoryIndexDisabled(), true, "kill-switch honored");
    const hits = await searchMemoriesAsync(defaultEmbedder().embed("anything"), { k: 3 });
    assert.deepEqual(hits, [], "search returns [] when disabled");
  } finally {
    delete process.env.MEGACOMPACT_PGLITE_DISABLED;
  }
});

test("memoryIndex: cross-repo upsert + NN search returns the right repo's memory", async () => {
  // Isolate the global PGlite dir so concurrent test runs don't collide.
  process.env.MEGACOMPACT_INDEX_DIR = join(baseTmp, "index");
  const repoA = "/tmp/repo-a";
  const repoB = "/tmp/repo-b";
  try {
    await initMemoryIndex();
    // Two memories in different repos, with clearly distinct content so their
    // trigram embeddings separate.
    const vecA = defaultEmbedder().embed("We standardized on node:sqlite for the store backend");
    const vecB = defaultEmbedder().embed("The deployment target is a raspberry pi in the closet");
    await upsertMemoryEmbedding(repoA, 1, "We standardized on node:sqlite for the store backend", vecA);
    await upsertMemoryEmbedding(repoB, 7, "The deployment target is a raspberry pi in the closet", vecB);

    // Query close to A's content → top hit should be A's memory, not B's.
    const q = defaultEmbedder().embed("standardized node:sqlite store backend choice");
    const hits = await searchMemoriesAsync(q, { k: 3 });
    assert.ok(hits.length >= 1, "at least one hit");
    assert.equal(hits[0].repoId, repoA, "nearest neighbor is repo A");
    assert.equal(hits[0].memoryId, 1, "correct memory id");
    assert.ok(hits[0].score > 0.5, "high cosine for the matching memory");

    // Scope to repoB only → A must not appear.
    const scoped = await searchMemoriesAsync(q, { k: 3, repoId: repoB });
    assert.ok(scoped.every((h) => h.repoId === repoB), "scoped search stays within repoB");
  } finally {
    await closeMemoryIndex();
    delete process.env.MEGACOMPACT_INDEX_DIR;
  }
});

test("memoryIndex: cleanup", () => {
  rmSync(baseTmp, { recursive: true, force: true });
});
