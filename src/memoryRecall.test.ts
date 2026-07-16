import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recallMemories } from "./memoryRecall.js";
import { addMemory, getMemory } from "./store/sqlite.js";

const baseTmp = mkdtempSync(join(tmpdir(), "mc-memrec-"));

function biGramEmbedder() {
  // Deterministic test embedder — bigger dim + binary encoding so two semantically
  // related strings have higher cosine than unrelated ones.
  const dim = 64;
  return {
    dim,
    embed(text: string): number[] {
      const v = new Array(dim).fill(0);
      const norm = text.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
      for (let i = 0; i < norm.length - 1; i++) {
        const idx = ((norm.charCodeAt(i) * 31 + norm.charCodeAt(i + 1)) >>> 0) % dim;
        v[idx] = 1;
      }
      return v;
    },
  };
}

test("recallMemories: ranks relevant memory above unrelated", async () => {
  const dir = join(baseTmp, "rank");
  addMemory({ content: "we use sqlite for the durable store", category: "decision" }, null, dir);
  addMemory({ content: "the threshold is 100 thousand tokens", category: "decision" }, null, dir);
  addMemory({ content: "katz says hi", category: "note" }, null, dir);
  const hits = await recallMemories("what store do we use?", dir, {
    embedder: biGramEmbedder(),
    topK: 3,
    minSimilarity: 0.0,
  });
  assert.ok(hits.length >= 2, "finds relevant");
  assert.ok(/sqlite/.test(hits[0].memory.content), "top hit is sqlite one");
  assert.ok(!/katz/.test(hits[0].memory.content), "unrelated not on top");
});

test("recallMemories: marks referenced hits (last_referenced updated)", async () => {
  const dir = join(baseTmp, "ref");
  addMemory({ content: "policy is local-only", category: "rule" }, null, dir);
  const hits = await recallMemories("local-only policy", dir, { embedder: biGramEmbedder() });
  assert.ok(hits.length >= 1);
  const fresh = getMemory(hits[0].memory.id, dir);
  assert.ok(fresh && fresh.lastReferenced && fresh.lastReferenced > 0, "lastReferenced set");
});

test("recallMemories: empty store returns []", async () => {
  const dir = join(baseTmp, "empty");
  const hits = await recallMemories("anything", dir, { embedder: biGramEmbedder() });
  assert.deepEqual(hits, []);
});

test("recallMemories: decision category beats fact category at equal similarity", async () => {
  const dir = join(baseTmp, "category");
  // Two memories that share many bigrams with the query — both will have very
  // similar cosine. The decision category should win because of categoryWeight.
  addMemory({ content: "we use redis for cache" }, null, dir);
  const aId = addMemory({ content: "we use redis as primary cache key", category: "fact" }, null, dir);
  const dId = addMemory({ content: "we use redis as primary cache layer", category: "decision" }, null, dir);
  const hits = await recallMemories("redis cache layer", dir, {
    embedder: biGramEmbedder(),
    topK: 3,
    minSimilarity: 0.0,
  });
  assert.ok(hits.length >= 2);
  assert.equal(hits[0].memory.id, dId, "decision-tagged memory outranks fact-tagged");
  assert.notEqual(hits[0].memory.id, aId, "top is the decision row, not the unknown-category row");
});

test("recallMemories: fresher reference beats older at equal similarity", async () => {
  const dir = join(baseTmp, "recency");
  const aId = addMemory({ content: "we use redis for cache", category: "fact" }, null, dir);
  const bId = addMemory({ content: "we use redis for cache layer", category: "fact" }, null, dir);
  // Backdate aId so its last_referenced is older; bId stays fresh.
  const { openStore, closeStore } = await import("./store/sqlite.js");
  const db = openStore(dir);
  const longAgo = Math.floor(Date.now() / 1000) - 30 * 86_400; // 30d
  db.prepare("UPDATE memories SET last_referenced = ? WHERE id = ?").run(longAgo, aId);
  // closeStore evicts the cached handle — calling db.close() directly would
  // leave a stale closed DB in the openStore cache and break subsequent
  // callers (the "database is not open" failure under parallel runs).
  closeStore(dir);
  const hits = await recallMemories("redis cache layer", dir, {
    embedder: biGramEmbedder(),
    topK: 3,
    minSimilarity: 0.0,
  });
  assert.ok(hits.length >= 2);
  assert.equal(hits[0].memory.id, bId, "freshly-referenced memory outranks 30-day-old one");
});

test("cleanup memrec", () => {
  rmSync(baseTmp, { recursive: true, force: true });
});

// ---- S24: cross-repo memory recall (PGlite mirror) ---------------------------
test("recallMemoriesAndInline: surfaces a memory saved in ANOTHER repo via cross-repo index", async () => {
  // Isolate the global PGlite index to a temp dir shared by both "repos".
  process.env.MEGACOMPACT_INDEX_DIR = join(baseTmp, "xrepo-index");
  const repoA = join(baseTmp, "repo-a");
  const repoB = join(baseTmp, "repo-b");
  try {
    // repoA owns a decision about the store backend.
    const { applyMemoryOps } = await import("./memoryOps.js");
    await applyMemoryOps(
      [{ op: "add", memory: { content: "we standardized on node:sqlite for the store backend", category: "decision", sourceTurn: 0 } }],
      repoA,
    );
    // repoB is a fresh session with NO local memory about the store backend.
    const { recallMemoriesAndInline } = await import("./recall.js");
    const res = await recallMemoriesAndInline({
      query: "what store backend do we use?",
      stateDir: repoB,
      limit: 5,
      crossRepo: true,
      crossRepoCosine: 0.3,
    });
    assert.ok(!res.empty, "cross-repo recall found the other repo's memory");
    assert.ok(/node:sqlite/.test(res.block), "the node:sqlite decision was recalled from repo A");
    assert.ok(res.report.some((r) => /from /.test(r)), "report labels the memory as cross-repo");
  } finally {
    const { closeMemoryIndex } = await import("./store/memoryIndex.js");
    await closeMemoryIndex();
    delete process.env.MEGACOMPACT_INDEX_DIR;
  }
});

test("recallMemoriesAndInline: cross-repo disabled when MEGACOMPACT_PGLITE_DISABLED", async () => {
  process.env.MEGACOMPACT_INDEX_DIR = join(baseTmp, "xrepo-index-off");
  process.env.MEGACOMPACT_PGLITE_DISABLED = "true";
  const repoA = join(baseTmp, "repo-a2");
  const repoB = join(baseTmp, "repo-b2");
  try {
    const { applyMemoryOps } = await import("./memoryOps.js");
    await applyMemoryOps(
      [{ op: "add", memory: { content: "we standardized on node:sqlite for the store backend", category: "decision", sourceTurn: 0 } }],
      repoA,
    );
    const { recallMemoriesAndInline } = await import("./recall.js");
    const res = await recallMemoriesAndInline({
      query: "what store backend do we use?",
      stateDir: repoB,
      limit: 5,
      crossRepo: true,
    });
    // Index disabled → no cross-repo hit; repoB has no local memory → empty.
    assert.equal(res.empty, true, "cross-repo recall degrades to empty when disabled");
  } finally {
    delete process.env.MEGACOMPACT_PGLITE_DISABLED;
    delete process.env.MEGACOMPACT_INDEX_DIR;
  }
});
