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

test("cleanup memrec", () => {
  rmSync(baseTmp, { recursive: true, force: true });
});
