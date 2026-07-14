import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore, computeRegionHash } from "./vectorStore.js";
import {
  TrigramEmbedder,
  cosineSimilarity,
  l2Normalize,
  defaultEmbedder,
} from "./embedder.js";
import { normalizeSessionId, decompressSmart } from "./store.js";

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
    regionText:
      "user asked to investigate src/compact.ts assistant added truncate helper",
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
  assert.equal(s.search("sess_dup", "anything", 10).length, 1);
});

test("dedup cascade: summaryHash catches same-topic incremental compactions", () => {
  const s = store();
  const r1 = s.add({
    sessionId: "sess_sh",
    summary: "step 1",
    topicSummary: "User working on auth module refactor in src/auth.ts.",
    regionText: "first region text for step 1",
    timestamp: 100,
  });
  // Different regionText (incremental compaction adds messages), same topicSummary
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
  // Timestamp should be updated to the newer one
  assert.equal(r2.checkpoint.timestamp, 200);
});

test("dedup cascade: summaryHash dedup still stores only one checkpoint", () => {
  const s = store();
  const summary = "same summary for both adds";
  const ts = "some topic summary that is identical";
  s.add({ sessionId: "sess_sh2", summary, topicSummary: ts, regionText: "region a", timestamp: 1 });
  s.add({ sessionId: "sess_sh2", summary, topicSummary: ts, regionText: "region b", timestamp: 2 });
  assert.equal(s.stats("sess_sh2").checkpointCount, 1);
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
  assert.equal(s.dedupe("sess_sent", hash), true);
  assert.equal(s.dedupe("sess_sent", "deadbeef"), false);
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
  const hits = s.search(
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
  assert.equal(s.wasInjected("sess_inj", r.checkpoint.checkpointId), false);
  s.markInjected("sess_inj", r.checkpoint.checkpointId);
  assert.equal(s.wasInjected("sess_inj", r.checkpoint.checkpointId), true);
});

test("normalizeSessionId handles null, prefixed, and uuid forms", () => {
  assert.match(normalizeSessionId("sess_abc"), /^sess_/);
  assert.equal(normalizeSessionId("sess_abc"), "sess_abc");
  assert.match(
    normalizeSessionId("550e8400-e29b-41d4-a716-446655440000"),
    /^sess_[0-9a-f]{16}$/,
  );
  assert.match(normalizeSessionId(undefined), /^sess_[0-9a-f]{16}$/);
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
  const dir = join(baseTmp, `run-${counter++}`);
  const s1 = new VectorStore({ dedupSim: 0.9, stateDir: dir });
  s1.add({
    sessionId: "sess_persist",
    summary: "persisted",
    regionText: "persist region text",
    timestamp: 1,
  });
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

test("stats reports counts, last checkpoint, and dedup rate", () => {
  const s = store();
  s.add({
    sessionId: "sess_stats",
    summary: "alpha",
    regionText: "region alpha text",
    tokenEstimate: 500,
    timestamp: 1,
  });
  s.add({
    sessionId: "sess_stats",
    summary: "beta",
    regionText: "region beta text",
    tokenEstimate: 700,
    timestamp: 2,
  });
  const st1 = s.stats("sess_stats");
  assert.equal(st1.checkpointCount, 2);
  assert.equal(st1.lastCheckpointId, "chkpt_002");
  assert.equal(st1.totalTokenEstimate, 1200);
  assert.equal(st1.injectedCount, 0);
  assert.equal(st1.dedupHitRate, 0);

  s.markInjected("sess_stats", "chkpt_001");
  const st2 = s.stats("sess_stats");
  assert.equal(st2.injectedCount, 1);
  assert.ok(Math.abs(st2.dedupHitRate - 0.5) < 1e-9);
});

test("tokensSaved = original − stored per session; deduped add saves the whole region", () => {
  const s = store();
  // Two genuinely new checkpoints. saved = original − stored.
  //   cp1: orig 2000, stored 500 → saved 1500
  //   cp2: orig 3000, stored 700 → saved 2300
  s.add({ sessionId: "sess_saved", summary: "alpha", regionText: "region alpha text", tokenEstimate: 500, originalTokenEstimate: 2000, timestamp: 1 });
  s.add({ sessionId: "sess_saved", summary: "beta", regionText: "region beta text", tokenEstimate: 700, originalTokenEstimate: 3000, timestamp: 2 });
  const st = s.stats("sess_saved");
  assert.equal(st.totalTokenEstimate, 1200, "Σ stored summaries");
  assert.equal(st.originalTokens, 5000, "Σ original region tokens");
  assert.equal(st.tokensSaved, 3800, "per-session saved = Σ(original − stored) = 1500 + 2300");
  assert.equal(st.dedupCollapsed, 0);
  assert.equal(st.dedupAttempts, 2);

  // A third add that dedups onto an existing region: whole original region (2000)
  // is discarded (nothing new stored) → repo saved grows by the full original,
  // dedupCollapsed bumps, and no new checkpoint row is created.
  const deduped = s.add({ sessionId: "sess_saved", summary: "alpha", regionText: "region alpha text", tokenEstimate: 500, originalTokenEstimate: 2000, timestamp: 3 });
  assert.ok(deduped.deduped, "identical region should dedup");
  const st3 = s.stats("sess_saved");
  // Per-session DB sum only covers stored rows (deduped adds create no row), so
  // the per-session figure is unchanged; the deduped save lands in the repo meta.
  assert.equal(st3.tokensSaved, 3800, "per-session DB sum unchanged by deduped add");
  assert.equal(st3.dedupCollapsed, 1, "deduped collapse counted");
  assert.equal(st3.dedupAttempts, 3);
  // Repo cumulative counter DID capture the deduped region's full original size.
  assert.equal(s.repoStats().tokensSaved, 3800 + 2000, "repo saved includes deduped original");
});

test("repoStats aggregates every session + counts deduped original tokens", () => {
  const dir = join(baseTmp, `repo-${counter++}`);
  const a = new VectorStore({ dedupSim: 0.9, stateDir: dir });
  const b = new VectorStore({ dedupSim: 0.9, stateDir: dir }); // same disk store, diff instance
  a.add({ sessionId: "sess_a", summary: "alpha", regionText: "region alpha text", tokenEstimate: 500, originalTokenEstimate: 2000, timestamp: 1 });
  b.add({ sessionId: "sess_b", summary: "beta", regionText: "region beta text", tokenEstimate: 700, originalTokenEstimate: 3000, timestamp: 2 });

  const repo = a.repoStats();
  assert.equal(repo.checkpointCount, 2, "checkpoints across both sessions");
  assert.equal(repo.sessionCount, 2, "two distinct sessions");
  assert.equal(repo.totalTokenEstimate, 1200, "Σ stored");
  assert.equal(repo.originalTokens, 5000, "Σ original");
  assert.equal(repo.tokensSaved, 3800, "repo saved = Σ(original − stored) = 1500 + 2300");
  assert.equal(repo.dedupCollapsed, 0);

  // A deduped add into sess_a: whole original region saved, no new row.
  const deduped = a.add({ sessionId: "sess_a", summary: "alpha", regionText: "region alpha text", tokenEstimate: 500, originalTokenEstimate: 2000, timestamp: 3 });
  assert.ok(deduped.deduped);
  const repo2 = a.repoStats();
  assert.equal(repo2.tokensSaved, 3800 + 2000, "deduped collapse adds full original region to repo saved");
  assert.equal(repo2.dedupCollapsed, 1);
  assert.equal(repo2.checkpointCount, 2, "still two stored checkpoints");
});

test("computeRegionHash normalizes whitespace before hashing", () => {
  const h1 = computeRegionHash("foo  bar");
  const h2 = computeRegionHash("foo bar");
  const h3 = computeRegionHash("  foo   bar  ");
  assert.equal(h1, h2, "double space and single space should hash the same");
  assert.equal(h2, h3, "leading/trailing spaces should hash the same");
  // Sanity: different content still hashes differently.
  assert.notEqual(h1, computeRegionHash("foo baz"));
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
  assert.equal(s.stats("sess_ws").checkpointCount, 1, "only one checkpoint stored");
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
  // most recent (current) is chkpt_003, also about compact.ts but clearly
  // distinct content so L1 near-dup dedup does not collapse it.
  s.add({
    sessionId: "sess_top",
    summary: "current",
    regionText: "fix the buffer overflow in src/compact.ts by adding a bounds check before truncate",
    timestamp: 3,
  });
  const hits = s.topSimilar("sess_top", 10);
  assert.equal(hits.length, 2); // two other checkpoints
  // The compact.ts checkpoint should rank above the guitar checkpoint
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
  const hits = s.topSimilar("sess_self", 5);
  assert.equal(hits.length, 1);
  assert.notEqual(hits[0].checkpoint.checkpointId, "chkpt_002"); // not the current
});

test("topSimilar returns empty for sessions with 0 or 1 checkpoints", () => {
  const s = store();
  assert.deepEqual(s.topSimilar("sess_none", 5), []);
  s.add({
    sessionId: "sess_one",
    summary: "solo",
    regionText: "only checkpoint",
    timestamp: 1,
  });
  assert.deepEqual(s.topSimilar("sess_one", 5), []);
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
  const hits = s.topSimilar("sess_limit", 2);
  assert.equal(hits.length, 2);
});

test("stats on empty session returns zeros and nulls", () => {
  const s = store();
  const st = s.stats("sess_empty");
  assert.equal(st.checkpointCount, 0);
  assert.equal(st.lastCheckpointId, undefined);
  assert.equal(st.totalTokenEstimate, 0);
  assert.equal(st.dedupHitRate, 0);
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
  assert.equal(s.list("sess_l0").length, 1);
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
  const cp = s.list("sess_l0ts")[0];
  assert.equal(cp.contentHash?.length, 64);
  assert.equal(cp.contentHash2?.length, 64);
  assert.equal(cp.contentHashVersion, 1);
  assert.equal(cp.timestamp, 99);
});

test("compressed_original roundtrips through versioned compression", () => {
  const s = store();
  const raw = "raw region text preserved for audit and replay";
  s.add({ sessionId: "sess_co", summary: "x", regionText: raw, timestamp: 1 });
  const cp = s.list("sess_co")[0];
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
  // One word inserted + different case/whitespace → L0 content-hash differs,
  // but the text is a near-duplicate caught by the L1 trigram verify.
  const r2 = s.add({
    sessionId: "sess_l1",
    summary: "user reviewed the auth module and merged the pull request",
    regionText: "  USER   reviewed the authentication module and merged the pull request now ",
    timestamp: 2,
  });
  assert.equal(r1.deduped, false);
  assert.equal(r2.deduped, true);
  assert.equal(r2.reason, "l1MinHash");
  assert.equal(s.list("sess_l1").length, 1);
});

test("L1 does NOT falsely dedup genuinely different content", () => {
  const s = store();
  s.add({ sessionId: "sess_l1b", summary: "a", regionText: "the database migration added three indexes", timestamp: 1 });
  const r2 = s.add({ sessionId: "sess_l1b", summary: "b", regionText: "the frontend added a dark mode toggle", timestamp: 2 });
  assert.equal(r2.deduped, false);
  assert.equal(s.list("sess_l1b").length, 2);
});

test("cleanup", () => {
  rmSync(baseTmp, { recursive: true, force: true });
});
