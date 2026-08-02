/**
 * dedup-top.test.ts — dedup cascade, summaryHash, whitespace dedup, L0/L1 dedup,
 * topSimilar, compressed_original roundtrip, cleanup.
 * Split from src/vectorStore.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { vectorStats, vectorList, vectorTopSimilar } from "../vectorStore.js";
import { decompressSmart } from "../store.js";
import { store, baseTmp } from "./_helpers.js";

test("dedup cascade: summaryHash catches same-topic incremental compactions", () => {
  const s = store();
  const r1 = s.add({
    sessionId: "sess_sh",
    summary: "step 1",
    topicSummary: "User working on auth module refactor in src/auth.ts.",
    regionText: "first region text for step 1",
    timestamp: 100,
  });
  const r2 = s.add({
    sessionId: "sess_sh",
    summary: "step 2",
    topicSummary: "User working on auth module refactor in src/auth.ts.",
    regionText: "second region text for step 2 with additional messages",
    timestamp: 200,
  });
  assert.equal(r1.deduped, false);
  assert.equal(r2.deduped, true);
  assert.equal(r2.reason, "summaryHash");
  assert.equal(r1.checkpoint.checkpointId, r2.checkpoint.checkpointId);
  assert.equal(r2.checkpoint.timestamp, 200);
});

test("dedup cascade: summaryHash dedup still stores only one checkpoint", () => {
  const s = store();
  const summary = "same summary for both adds";
  const ts = "some topic summary that is identical";
  s.add({ sessionId: "sess_sh2", summary, topicSummary: ts, regionText: "region a", timestamp: 1 });
  s.add({ sessionId: "sess_sh2", summary, topicSummary: ts, regionText: "region b", timestamp: 2 });
  assert.equal(vectorStats(s,"sess_sh2").checkpointCount, 1);
});

test("whitespace-variant region is deduplicated", () => {
  const s = store();
  const r1 = s.add({
    sessionId: "sess_ws",
    summary: "first",
    regionText: "user  changed  config.ts",
    timestamp: 1,
  });
  assert.equal(r1.deduped, false);
  const r2 = s.add({
    sessionId: "sess_ws",
    summary: "second",
    regionText: "user changed config.ts",
    timestamp: 2,
  });
  assert.equal(r2.deduped, true, "whitespace-variant should be deduplicated");
  assert.equal(vectorStats(s,"sess_ws").checkpointCount, 1, "only one checkpoint stored");
});

test("topSimilar returns n most similar checkpoints to the current (most recent)", () => {
  const s = store();
  s.add({
    sessionId: "sess_top",
    summary: "guitar",
    regionText: "play a song on the guitar",
    timestamp: 1,
  });
  s.add({
    sessionId: "sess_top",
    summary: "compact",
    regionText: "fix bug in src/compact.ts truncation",
    timestamp: 2,
  });
  s.add({
    sessionId: "sess_top",
    summary: "current",
    regionText: "fix the buffer overflow in src/compact.ts by adding a bounds check before truncate",
    timestamp: 3,
  });
  const hits = vectorTopSimilar(s,"sess_top", 10);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].checkpoint.summary, "compact");
  assert.equal(hits[1].checkpoint.summary, "guitar");
  assert.ok(hits[0].score >= hits[1].score);
});

test("topSimilar excludes the current checkpoint itself", () => {
  const s = store();
  s.add({
    sessionId: "sess_self",
    summary: "a",
    regionText: "alpha region text one",
    timestamp: 1,
  });
  s.add({
    sessionId: "sess_self",
    summary: "b",
    regionText: "alpha region text two",
    timestamp: 2,
  });
  const hits = vectorTopSimilar(s,"sess_self", 5);
  assert.equal(hits.length, 1);
  assert.notEqual(hits[0].checkpoint.checkpointId, "chkpt_002");
});

test("topSimilar returns empty for sessions with 0 or 1 checkpoints", () => {
  const s = store();
  assert.deepEqual(vectorTopSimilar(s,"sess_none", 5), []);
  s.add({
    sessionId: "sess_one",
    summary: "solo",
    regionText: "only checkpoint",
    timestamp: 1,
  });
  assert.deepEqual(vectorTopSimilar(s,"sess_one", 5), []);
});

test("topSimilar respects the n limit", () => {
  const s = store();
  const regions = [
    "the compiler optimized the hot loop with loop unrolling",
    "the database added a covering index to speed up queries",
    "the frontend introduced a virtualized list for large tables",
    "the api added rate limiting using a token bucket algorithm",
    "the worker pool now backpressures when the queue is overloaded",
  ];
  for (let i = 0; i < regions.length; i++) {
    s.add({
      sessionId: "sess_limit",
      summary: `c${i + 1}`,
      regionText: regions[i],
      timestamp: i + 1,
    });
  }
  const hits = vectorTopSimilar(s,"sess_limit", 2);
  assert.equal(hits.length, 2);
});

// --- Sprint 9: L0 content-addressable dedup -------------------------------

test("L0 content-hash dedup: identical content under different regionText collapses to one row", () => {
  const s = store();
  const r1 = s.add({
    sessionId: "sess_l0",
    summary: "fix the parser",
    regionText: "user asked to fix the parser assistant patched src/parse.ts",
    timestamp: 1,
  });
  const r2 = s.add({
    sessionId: "sess_l0",
    summary: "fix the parser",
    regionText: "  user   asked to fix the parser   assistant patched src/parse.ts  ",
    timestamp: 2,
  });
  assert.equal(r1.deduped, false);
  assert.equal(r2.deduped, true);
  assert.equal(r2.reason, "contentHash");
  assert.equal(vectorList(s,"sess_l0").length, 1);
});

test("L0 content-hash dedup stores both hash fields and bumps timestamp on hit", () => {
  const s = store();
  const region = "the quick brown fox jumps over the lazy dog";
  s.add({ sessionId: "sess_l0ts", summary: "first", regionText: region, timestamp: 10 });
  const r2 = s.add({
    sessionId: "sess_l0ts",
    summary: "second",
    regionText: region,
    timestamp: 99,
  });
  assert.equal(r2.deduped, true);
  assert.equal(r2.reason, "contentHash");
  const cp = vectorList(s,"sess_l0ts")[0];
  assert.equal(cp.contentHash?.length, 64);
  assert.equal(cp.contentHash2?.length, 64);
  assert.equal(cp.contentHashVersion, 1);
  assert.equal(cp.timestamp, 99);
});

test("compressed_original roundtrips through versioned compression", () => {
  const s = store();
  const raw = "raw region text preserved for audit and replay";
  s.add({ sessionId: "sess_co", summary: "x", regionText: raw, timestamp: 1 });
  const cp = vectorList(s,"sess_co")[0];
  assert.ok(cp.compressedOriginal instanceof Buffer);
  const restored = decompressSmart(cp.compressedOriginal as Buffer).toString("utf-8");
  assert.equal(restored, raw);
});

test("summaryHash is now full 64-hex SHA-256", () => {
  const s = store();
  const ts = "topic summary for same-topic incremental compaction";
  const r1 = s.add({
    sessionId: "sess_sh64",
    summary: "a",
    topicSummary: ts,
    regionText: "region alpha",
    timestamp: 1,
  });
  assert.equal(r1.checkpoint.summaryHash?.length, 64);
  const r2 = s.add({
    sessionId: "sess_sh64",
    summary: "b",
    topicSummary: ts,
    regionText: "region bravo",
    timestamp: 2,
  });
  assert.equal(r2.deduped, true);
  assert.equal(r2.reason, "summaryHash");
});

// --- Sprint 11: L1 MinHash/LSH near-duplicate dedup ------------------------

test("L1 catches a one-word-diff near-duplicate that L0 misses", () => {
  const s = store();
  const r1 = s.add({
    sessionId: "sess_l1",
    summary: "user reviewed the auth module and merged the pull request",
    regionText: "user reviewed the authentication module and merged the pull request",
    timestamp: 1,
  });
  const r2 = s.add({
    sessionId: "sess_l1",
    summary: "user reviewed the auth module and merged the pull request",
    regionText: "  USER   reviewed the authentication module and merged the pull request now ",
    timestamp: 2,
  });
  assert.equal(r1.deduped, false);
  assert.equal(r2.deduped, true);
  assert.equal(r2.reason, "l1MinHash");
  assert.equal(vectorList(s,"sess_l1").length, 1);
});

test("L1 does NOT falsely dedup genuinely different content", () => {
  const s = store();
  s.add({ sessionId: "sess_l1b", summary: "a", regionText: "the database migration added three indexes", timestamp: 1 });
  const r2 = s.add({ sessionId: "sess_l1b", summary: "b", regionText: "the frontend added a dark mode toggle", timestamp: 2 });
  assert.equal(r2.deduped, false);
  assert.equal(vectorList(s,"sess_l1b").length, 2);
});

test("cleanup", () => {
  rmSync(baseTmp, { recursive: true, force: true });
});
