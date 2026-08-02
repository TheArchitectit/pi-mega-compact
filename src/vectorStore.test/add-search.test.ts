/**
 * add-search.test.ts — add+search, dedup basics, sentinel, near-dup collapse,
 * markInjected, sequential IDs, persistence, corrupt file.
 * Split from src/vectorStore.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { VectorStore, computeRegionHash, vectorDedupe, vectorWasInjected, vectorMarkInjected, vectorSearch } from "../vectorStore.js";
import { store, nextDir } from "./_helpers.js";

test("add then search returns the planted checkpoint top-1", () => {
  const s = store();
  s.add({
    sessionId: "sess_abc",
    summary: "Investigated src/compact.ts and added truncation.",
    regionText:
      "user asked to investigate src/compact.ts assistant added truncate helper",
    keyDecisions: ["add truncate helper"],
    filesModified: ["src/compact.ts"],
    tokenEstimate: 1200,
    timestamp: 1000,
  });
  const hits = vectorSearch(s, "sess_abc", "src/compact.ts truncate helper", 3);
  assert.equal(hits.length, 1);
  assert.ok(hits[0].score > 0.5);
  assert.equal(hits[0].checkpoint.summary.includes("src/compact.ts"), true);
});

test("dedup by regionHash: identical region is not double-stored", () => {
  const s = store();
  const region = "the same conversation region text";
  const r1 = s.add({
    sessionId: "sess_dup",
    summary: "first",
    regionText: region,
    timestamp: 1,
  });
  const r2 = s.add({
    sessionId: "sess_dup",
    summary: "second",
    regionText: region,
    timestamp: 2,
  });
  assert.equal(r1.deduped, false);
  assert.equal(r2.deduped, true);
  assert.equal(r1.checkpoint.checkpointId, r2.checkpoint.checkpointId);
  assert.equal(vectorSearch(s, "sess_dup", "anything", 10).length, 1);
});

test("dedupe() sentinel returns true for a stored region", () => {
  const s = store();
  const region = "region for sentinel test";
  const hash = computeRegionHash(region);
  s.add({
    sessionId: "sess_sent",
    summary: "x",
    regionText: region,
    timestamp: 1,
  });
  assert.equal(vectorDedupe(s,"sess_sent", hash), true);
  assert.equal(vectorDedupe(s,"sess_sent", "deadbeef"), false);
});

test("near-duplicate collapse keeps only the top of a near-identical pair", () => {
  const s = store();
  s.add({
    sessionId: "sess_nd",
    summary: "alpha",
    regionText:
      "user investigated src/compact.ts and added a truncate helper for summaries",
    timestamp: 1,
  });
  s.add({
    sessionId: "sess_nd",
    summary: "beta",
    regionText:
      "user investigated src/compact.ts and added a truncate helper for the summaries",
    timestamp: 2,
  });
  const hits = vectorSearch(s,
    "sess_nd",
    "user investigated src/compact.ts and added a truncate helper for summaries",
    5,
  );
  assert.equal(hits.length, 1);
});

test("markInjected / wasInjected track injection", () => {
  const s = store();
  const r = s.add({
    sessionId: "sess_inj",
    summary: "y",
    regionText: "inject region",
    timestamp: 1,
  });
  assert.equal(vectorWasInjected(s,"sess_inj", r.checkpoint.checkpointId), false);
  vectorMarkInjected(s,"sess_inj", r.checkpoint.checkpointId);
  assert.equal(vectorWasInjected(s,"sess_inj", r.checkpoint.checkpointId), true);
});

test("nextCheckpointId is sequential per session", () => {
  const s = store();
  const a = s.add({
    sessionId: "sess_seq",
    summary: "1",
    regionText: "r1",
    timestamp: 1,
  });
  const b = s.add({
    sessionId: "sess_seq",
    summary: "2",
    regionText: "r2",
    timestamp: 2,
  });
  assert.equal(a.checkpoint.checkpointId, "chkpt_001");
  assert.equal(b.checkpoint.checkpointId, "chkpt_002");
});

test("checkpoints survive a fresh store instance (on-disk)", () => {
  const dir = nextDir();
  const s1 = new VectorStore({ dedupSim: 0.9, stateDir: dir });
  s1.add({
    sessionId: "sess_persist",
    summary: "persisted",
    regionText: "persist region text",
    timestamp: 1,
  });
  const s2 = new VectorStore({ dedupSim: 0.9, stateDir: dir });
  const hits = vectorSearch(s2, "sess_persist", "persist region text", 3);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].checkpoint.summary, "persisted");
});

test("corrupt checkpoint file falls back to empty (no throw)", () => {
  const dir = nextDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "sess_corrupt.checkpoints.json.gz");
  writeFileSync(file, Buffer.from("not a gzip"));
  const s = new VectorStore({ dedupSim: 0.9, stateDir: dir });
  assert.equal(vectorSearch(s, "sess_corrupt", "q", 3).length, 0);
});
