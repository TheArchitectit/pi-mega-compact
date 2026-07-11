import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore, computeRegionHash } from "./vectorStore.js";
import { TrigramEmbedder, cosineSimilarity, l2Normalize, defaultEmbedder } from "./embedder.js";
import { normalizeSessionId } from "./store.js";

const baseTmp = mkdtempSync(join(tmpdir(), "mc-test-"));

// Each store() gets its own isolated state dir passed explicitly (no global
// env var) so parallel/concurrent tests never share on-disk checkpoints.
let counter = 0;
function store(opts: { dedupSim?: number } = {}) {
  const dir = join(baseTmp, `run-${counter++}`);
  return new VectorStore({ dedupSim: opts.dedupSim ?? 0.9, stateDir: dir });
}

test("cleanup temp dir", () => {
  assert.ok(baseTmp.startsWith(tmpdir()));
});

test("embedder is deterministic and normalized", () => {
  const e = defaultEmbedder();
  const a = e.embed("compact the session context");
  const b = e.embed("compact the session context");
  assert.deepEqual(a, b);
  const n = l2Normalize(a);
  const mag = Math.sqrt(n.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(mag - 1) < 1e-9);
});

test("cosine similarity is 1 for identical, <1 for different", () => {
  const e = new TrigramEmbedder();
  const a = e.embed("read src/server.ts and fix the bug");
  const b = e.embed("read src/server.ts and fix the bug");
  const c = e.embed("play a song on the guitar");
  assert.ok(Math.abs(cosineSimilarity(a, b) - 1) < 1e-9);
  assert.ok(cosineSimilarity(a, c) < 1);
});

test("add then search returns the planted checkpoint top-1", () => {
  const s = store();
  s.add({
    sessionId: "sess_abc",
    summary: "Investigated src/compact.ts and added truncation.",
    regionText: "user asked to investigate src/compact.ts assistant added truncate helper",
    keyDecisions: ["add truncate helper"],
    filesModified: ["src/compact.ts"],
    tokenEstimate: 1200,
    timestamp: 1000,
  });
  const hits = s.search("sess_abc", "src/compact.ts truncate helper", 3);
  assert.equal(hits.length, 1);
  assert.ok(hits[0].score > 0.5);
  assert.equal(hits[0].checkpoint.summary.includes("src/compact.ts"), true);
});

test("dedup by regionHash: identical region is not double-stored", () => {
  const s = store();
  const region = "the same conversation region text";
  const r1 = s.add({ sessionId: "sess_dup", summary: "first", regionText: region, timestamp: 1 });
  const r2 = s.add({ sessionId: "sess_dup", summary: "second", regionText: region, timestamp: 2 });
  assert.equal(r1.deduped, false);
  assert.equal(r2.deduped, true);
  assert.equal(r1.checkpoint.checkpointId, r2.checkpoint.checkpointId);
  assert.equal(s.search("sess_dup", "anything", 10).length, 1);
});

test("dedupe() sentinel returns true for a stored region", () => {
  const s = store();
  const region = "region for sentinel test";
  const hash = computeRegionHash(region);
  s.add({ sessionId: "sess_sent", summary: "x", regionText: region, timestamp: 1 });
  assert.equal(s.dedupe("sess_sent", hash), true);
  assert.equal(s.dedupe("sess_sent", "deadbeef"), false);
});

test("near-duplicate collapse keeps only the top of a near-identical pair", () => {
  const s = store();
  s.add({ sessionId: "sess_nd", summary: "alpha", regionText: "user investigated src/compact.ts and added a truncate helper for summaries", timestamp: 1 });
  s.add({ sessionId: "sess_nd", summary: "beta", regionText: "user investigated src/compact.ts and added a truncate helper for the summaries", timestamp: 2 });
  const hits = s.search("sess_nd", "user investigated src/compact.ts and added a truncate helper for summaries", 5);
  assert.equal(hits.length, 1);
});

test("markInjected / wasInjected track injection", () => {
  const s = store();
  const r = s.add({ sessionId: "sess_inj", summary: "y", regionText: "inject region", timestamp: 1 });
  assert.equal(s.wasInjected("sess_inj", r.checkpoint.checkpointId), false);
  s.markInjected("sess_inj", r.checkpoint.checkpointId);
  assert.equal(s.wasInjected("sess_inj", r.checkpoint.checkpointId), true);
});

test("normalizeSessionId handles null, prefixed, and uuid forms", () => {
  assert.match(normalizeSessionId("sess_abc"), /^sess_/);
  assert.equal(normalizeSessionId("sess_abc"), "sess_abc");
  assert.match(normalizeSessionId("550e8400-e29b-41d4-a716-446655440000"), /^sess_[0-9a-f]{16}$/);
  assert.match(normalizeSessionId(undefined), /^sess_[0-9a-f]{16}$/);
});

test("nextCheckpointId is sequential per session", () => {
  const s = store();
  const a = s.add({ sessionId: "sess_seq", summary: "1", regionText: "r1", timestamp: 1 });
  const b = s.add({ sessionId: "sess_seq", summary: "2", regionText: "r2", timestamp: 2 });
  assert.equal(a.checkpoint.checkpointId, "chkpt_001");
  assert.equal(b.checkpoint.checkpointId, "chkpt_002");
});

test("checkpoints survive a fresh store instance (on-disk)", () => {
  const dir = join(baseTmp, `run-${counter++}`);
  const s1 = new VectorStore({ dedupSim: 0.9, stateDir: dir });
  s1.add({ sessionId: "sess_persist", summary: "persisted", regionText: "persist region text", timestamp: 1 });
  const s2 = new VectorStore({ dedupSim: 0.9, stateDir: dir }); // new instance, same disk state
  const hits = s2.search("sess_persist", "persist region text", 3);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].checkpoint.summary, "persisted");
});

test("corrupt checkpoint file falls back to empty (no throw)", () => {
  const dir = join(baseTmp, `run-${counter++}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "sess_corrupt.checkpoints.json.gz");
  writeFileSync(file, Buffer.from("not a gzip"));
  const s = new VectorStore({ dedupSim: 0.9, stateDir: dir });
  assert.equal(s.search("sess_corrupt", "q", 3).length, 0);
});

test("cleanup", () => {
  rmSync(baseTmp, { recursive: true, force: true });
});
