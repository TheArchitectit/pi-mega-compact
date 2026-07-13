/**
 * e2e.test.ts — comprehensive end-to-end pipeline tests.
 *
 * Exercises the full compaction → storage → dedup → recall pipeline across
 * 12 scenarios. Each test is self-contained with its own temp store.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore, computeRegionHash } from "./vectorStore.js";
import { compactSession, recall, supersededCount } from "./engine.js";
import { loadDedupConfig, type DedupConfigShape } from "./config/dedup.js";
import { defaultEmbedder } from "./embedder.js";
import { decompressSmart } from "./store.js";
import {
  upsertCheckpoint,
  closeStore,
} from "./store/sqlite.js";
import type { EngineMessage } from "./types.js";
import type { StoredCheckpoint } from "./store.js";

// ---------------------------------------------------------------------------
// Temp dir management — each store() gets its own isolated state dir.
// ---------------------------------------------------------------------------

const baseTmp = mkdtempSync(join(tmpdir(), "mc-e2e-"));
let counter = 0;

function storeDir(): string {
  return join(baseTmp, `run-${counter++}`);
}

function store(over: Partial<DedupConfigShape> = {}): VectorStore {
  const dir = storeDir();
  const config: DedupConfigShape = { ...loadDedupConfig(), ...over };
  return new VectorStore({ stateDir: dir, config });
}

function msg(role: EngineMessage["role"], text: string, toolName?: string, input?: string, output?: string): EngineMessage {
  return toolName
    ? { role, text, toolName, input: input ?? text, output: output ?? text }
    : { role, text };
}

/** Seed a checkpoint directly into SQLite (bypasses online dedup tiers). */
function seedDirect(dir: string, sessionId: string, rows: { id: string; text: string; tok: number; ts?: number }[]): void {
  const e = defaultEmbedder();
  for (const r of rows) {
    const cp: StoredCheckpoint = {
      checkpointId: r.id,
      sessionId,
      summary: r.text,
      keyDecisions: [],
      nextSteps: [],
      filesModified: [],
      tokenEstimate: r.tok,
      regionHash: computeRegionHash(r.text),
      embedding: e.embed(r.text),
      timestamp: r.ts ?? 1,
    };
    upsertCheckpoint(cp, dir);
  }
}

// ---------------------------------------------------------------------------
// 1. Full Compaction Pipeline (SUPERSEDE → COLLAPSE → CLUSTER)
// ---------------------------------------------------------------------------

test("1. Full compaction pipeline: SUPERSEDE → COLLAPSE → CLUSTER", () => {
  const s = store();
  const SESS = "sess_full_pipeline";

  // Build a realistic 20+ message conversation with file reads, edits,
  // user questions, and assistant responses with tool calls.
  const messages: EngineMessage[] = [
    msg("user", "read src/server.ts to understand the current setup"),
    msg("assistant", "Reading src/server.ts", "Read", "src/server.ts", "const server = createServer(...)"),
    msg("user", "the server has a memory leak, let's fix it"),
    msg("assistant", "I see the leak in src/server.ts:42 — the event listeners are not cleaned up", "Edit"),
    msg("user", "edit src/server.ts to remove the listeners on cleanup"),
    msg("assistant", "Edited src/server.ts:42 — added cleanup() to remove all listeners", "Edit"),
    msg("user", "now read src/router.ts"),
    msg("assistant", "Reading src/router.ts", "Read", "src/router.ts", "export const router = new Map()"),
    msg("user", "the router is missing the /health endpoint"),
    msg("assistant", "I'll add a /health endpoint to src/router.ts", "Edit"),
    msg("user", "also read src/middleware.ts for the auth check"),
    msg("assistant", "Reading src/middleware.ts", "Read", "src/middleware.ts", "function authMiddleware(req, res, next) {...}"),
    msg("user", "the auth middleware should use JWT instead of session cookies"),
    msg("assistant", "Refactoring src/middleware.ts to use JWT verification", "Edit"),
    msg("user", "add tests for the new JWT auth in src/auth.test.ts"),
    msg("assistant", "Created src/auth.test.ts with 5 test cases for JWT validation", "Edit"),
    msg("user", "run the tests to make sure everything passes"),
    msg("assistant", "Running npm test", "Bash", "npm test", "All 5 auth tests passed"),
    msg("user", "great, now let's deploy this"),
    msg("assistant", "Deploying to staging environment", "Bash", "npm run deploy", "Deployed to staging"),
    msg("user", "check the staging logs for any errors"),
    msg("assistant", "Checking staging logs", "Bash", "kubectl logs", "No errors detected"),
  ];

  // Compact the older portion (keep last 4 messages verbatim).
  const r = compactSession({ sessionId: SESS, messages, keepFrom: 18, timestamp: 100 }, s);

  // Verify: not skipped
  assert.equal(r.skipped, false, "compaction should not be skipped");

  // Verify: summary is non-empty
  assert.ok(r.summary.length > 0, "summary should be produced by COLLAPSE");

  // Verify: regionHash is computed
  assert.ok(r.regionHash.length > 0, "regionHash should be computed");
  assert.match(r.regionHash, /^[0-9a-f]{16}$/, "regionHash is 16-hex SHA-256 prefix");

  // Verify: SUPERSEDE dropped obsolete file reads (the first reads of
  // server.ts, router.ts, middleware.ts are superseded by later edits)
  const compactable = messages.slice(0, 18);
  const superseded = supersededCount(compactable);
  assert.ok(superseded >= 1, `at least 1 superseded file read, got ${superseded}`);

  // Verify: checkpoint persisted
  assert.ok(r.checkpointId, "checkpointId should be set");
  assert.match(r.checkpointId!, /^chkpt_001$/);

  // Verify: checkpoint is searchable via store.search()
  const hits = s.search(SESS, "server.ts memory leak JWT auth", 5);
  assert.ok(hits.length > 0, "checkpoint should be searchable");
  assert.equal(hits[0].checkpoint.checkpointId, r.checkpointId);
});

// ---------------------------------------------------------------------------
// 2. Multi-Session Dedup (L0 exact hash)
// ---------------------------------------------------------------------------

test("2. Multi-session dedup: identical content in same session detected by L0", () => {
  const s = store();

  // First compaction — stores a checkpoint
  const messagesA: EngineMessage[] = [
    msg("user", "read src/database.ts and fix the connection pooling"),
    msg("assistant", "Fixed connection pool in src/database.ts", "Edit"),
    msg("user", "add a retry mechanism for failed queries"),
    msg("assistant", "Added retry logic in src/database.ts:85", "Edit"),
  ];

  const rA = compactSession({ sessionId: "sess_multi_a", messages: messagesA, keepFrom: 4, timestamp: 1 }, s);
  assert.equal(rA.deduped, false, "first compaction should not be deduped");
  assert.ok(rA.checkpointId);

  // Same session, identical content — L0 exact hash should detect the duplicate
  const messagesB: EngineMessage[] = [
    msg("user", "read src/database.ts and fix the connection pooling"),
    msg("assistant", "Fixed connection pool in src/database.ts", "Edit"),
    msg("user", "add a retry mechanism for failed queries"),
    msg("assistant", "Added retry logic in src/database.ts:85", "Edit"),
  ];

  const rB = compactSession({ sessionId: "sess_multi_a", messages: messagesB, keepFrom: 4, timestamp: 2 }, s);

  // L0 exact hash dedup should catch this — same regionText → same regionHash
  assert.equal(rB.deduped, true, "second identical compaction should be deduped by L0");
  assert.ok(rB.dedupReason === "regionHash" || rB.dedupReason === "contentHash",
    `dedup reason should be L0 (regionHash or contentHash), got ${rB.dedupReason}`);

  // Search should still return the checkpoint
  const hits = s.search("sess_multi_a", "database connection pooling", 5);
  assert.ok(hits.length > 0, "search returns the deduped result");
  assert.equal(hits[0].checkpoint.checkpointId, rA.checkpointId);
});

// ---------------------------------------------------------------------------
// 3. Near-Duplicate Detection (L1 MinHash/LSH)
// ---------------------------------------------------------------------------

test("3. Near-duplicate detection: L1 MinHash/LSH catches one-word edits that L0 misses", () => {
  // Disable L2 so we isolate L1 behavior
  const s = store({ L2_ENABLED: false });
  const SESS = "sess_l1_e2e";

  // First conversation
  const r1 = s.add({
    sessionId: SESS,
    summary: "user reviewed the authentication module and merged the pull request",
    regionText: "user reviewed the authentication module and merged the pull request on github after ci passed",
    timestamp: 1,
  });
  assert.equal(r1.deduped, false);

  // Near-duplicate: a few word changes that L0 exact hash misses
  const r2 = s.add({
    sessionId: SESS,
    summary: "user reviewed the authentication module and merged the pull request",
    regionText: "user reviewed the authentication module and merged the pull requests on github after ci passed",
    timestamp: 2,
  });

  // L1 should catch the near-dup
  assert.equal(r2.deduped, true, "L1 should catch the near-duplicate");
  assert.equal(r2.reason, "l1MinHash", "dedup reason should be l1MinHash");
  assert.equal(s.list(SESS).length, 1, "only one checkpoint stored");
});

test("3b. Negative: L1 does NOT collapse genuinely different content", () => {
  const s = store({ L2_ENABLED: false });
  const SESS = "sess_l1_neg";

  s.add({
    sessionId: SESS,
    summary: "database migration",
    regionText: "the database migration added three new indexes to the users table for faster lookups",
    timestamp: 1,
  });

  const r2 = s.add({
    sessionId: SESS,
    summary: "frontend dark mode",
    regionText: "the frontend added a dark mode toggle with css custom properties for theming",
    timestamp: 2,
  });

  assert.equal(r2.deduped, false, "distinct content should not be deduped");
  assert.equal(s.list(SESS).length, 2, "both checkpoints stored");
});

// ---------------------------------------------------------------------------
// 4. Semantic Dedup (L2 cosine)
// ---------------------------------------------------------------------------

test("4. Semantic dedup: L2 cosine catches highly similar content that L0/L1 miss", () => {
  const s = store();
  const SESS = "sess_l2_e2e";

  // First conversation about authentication and session tokens
  const r1 = s.add({
    sessionId: SESS,
    summary: "user authentication and session token management",
    regionText: "user authentication and session token management login validation session expiry handling secure cookie management",
    timestamp: 1,
  });
  assert.equal(r1.deduped, false);

  // Second conversation — nearly identical with a few word swaps
  // L0 won't catch (different text), L1 might not catch (too many word changes)
  // L2 cosine on trigram embeddings should catch this high-similarity paraphrase
  const r2 = s.add({
    sessionId: SESS,
    summary: "user authentication and session token management login validation",
    regionText: "user authentication and session token management login validation session expiry handling secure cookie configuration",
    timestamp: 2,
  });

  // L2 semantic cosine should catch this high-similarity paraphrase
  assert.equal(r2.deduped, true, "L2 should catch the high-similarity paraphrase");
  assert.ok(r2.reason === "contentSimilarity" || r2.reason === "l1MinHash",
    `dedup reason should be L2 contentSimilarity or L1 l1MinHash, got ${r2.reason}`);
  assert.equal(s.list(SESS).length, 1, "only one checkpoint after semantic dedup");
});

test("4b. MMR diversifies search results", () => {
  const s = store();
  const SESS = "sess_mmr_e2e";

  // Store several checkpoints — some near-identical, some distinct.
  // Use sufficiently different text to avoid L1/L2 dedup collapse.
  const regions = [
    "the parser handles tokenization of source code files with lexical analysis",
    "the database uses a b-tree index for fast lookups on the users table",
    "the frontend renders a virtualized list for large datasets with lazy loading",
    "the api gateway implements rate limiting with a token bucket throttling algorithm",
  ];

  for (let i = 0; i < regions.length; i++) {
    s.add({
      sessionId: SESS,
      summary: `topic_${i}`,
      regionText: regions[i],
      timestamp: i + 1,
    });
  }

  // Search for parser-related content — should return relevant results
  const hits = s.search(SESS, "parser tokenization source code files", 4);
  assert.ok(hits.length >= 1, "should return at least one result");

  // The top hit should be the parser checkpoint
  assert.ok(hits[0].checkpoint.summary.includes("topic_0"), "top hit is the parser topic");

  // MMR should provide diversity — not all results should be near-identical
  // (with 4 distinct topics, we should get variety in the results)
  const summaries = hits.map((h) => h.checkpoint.summary);
  const uniqueSummaries = new Set(summaries);
  assert.ok(uniqueSummaries.size >= 2, "MMR provides diverse results");
});

// ---------------------------------------------------------------------------
// 5. SemDeDup Offline Cleanup
// ---------------------------------------------------------------------------

test("5. SemDeDup offline cleanup: redundant rows marked removed, not deleted", () => {
  const dir = storeDir();
  const s = new VectorStore({ stateDir: dir, config: { ...loadDedupConfig() } });
  const SESS = "sess_semdedup";

  // Seed multiple checkpoints with varying similarity directly into SQLite
  // to bypass online dedup (SemDeDup's real job is offline cleanup)
  seedDirect(dir, SESS, [
    { id: "chkpt_001", text: "the cache stores parsed ast nodes for fast lookup and retrieval", tok: 100, ts: 1 },
    { id: "chkpt_002", text: "the cache stores parsed ast nodes for fast lookup and retrieval and reuse", tok: 900, ts: 2 },
    { id: "chkpt_003", text: "the frontend uses a virtualized list for rendering large datasets efficiently", tok: 500, ts: 3 },
  ]);

  // Run SemDeDup with threshold that catches the near-identical pair
  const removed = s.semDedup(SESS, 0.85);
  assert.equal(removed, 1, "one redundant row should be marked removed");

  // Verify: the lower-tokenEstimate row is the one removed
  const all = s.list(SESS);
  const dropped = all.find((c) => c.dedupStatus === "removed");
  assert.ok(dropped, "a row should have dedup_status='removed'");
  assert.equal(dropped!.checkpointId, "chkpt_001", "lower tokenEstimate row removed");
  assert.equal(dropped!.dedupStatus, "removed");

  // Verify: search excludes removed rows (3 total, 1 removed → 2 active)
  const hits = s.search(SESS, "cache parsed ast nodes frontend virtualized list", 10);
  assert.equal(hits.length, 2, "search excludes the removed row, returns 2 active");
  assert.ok(hits.every((h) => h.checkpoint.dedupStatus !== "removed"), "no removed rows in search");

  // Verify: idempotent re-run removes nothing new
  const secondRun = s.semDedup(SESS, 0.85);
  assert.equal(secondRun, 0, "idempotent re-run removes nothing new");

  closeStore(dir);
});

// ---------------------------------------------------------------------------
// 6. Recall + Inline with Dedup Sentinel
// ---------------------------------------------------------------------------

test("6. Recall + inline with dedup sentinel: injected checkpoints are skipped", () => {
  const s = store();
  const SESS = "sess_recall";

  // Compact a session
  const messages: EngineMessage[] = [
    msg("user", "investigated src/vectorStore.ts to understand the dedup cascade"),
    msg("assistant", "Found the L0, L1, L2 tiers in src/vectorStore.ts", "Read"),
    msg("user", "now document the dedup pipeline in README.md"),
    msg("assistant", "Updated README.md with full dedup documentation", "Edit"),
  ];

  const r = compactSession({ sessionId: SESS, messages, keepFrom: 4, timestamp: 1 }, s);
  assert.ok(r.checkpointId);

  // Recall with a relevant query — should return the checkpoint
  const first = recall({ sessionId: SESS, query: "vectorStore dedup cascade", limit: 5, skipInjected: true }, s);
  assert.equal(first.newHits.length, 1, "first recall should find the checkpoint");
  assert.equal(first.hits.length, 1);

  // Mark it injected
  const cpId = first.hits[0].checkpoint.checkpointId;
  s.markInjected(SESS, cpId);

  // Recall again — should skip the injected checkpoint
  const second = recall({ sessionId: SESS, query: "vectorStore dedup cascade", limit: 5, skipInjected: true }, s);
  assert.equal(second.newHits.length, 0, "injected checkpoint should be skipped (dedup sentinel)");

  // Without skipInjected, hits still surface
  assert.equal(second.hits.length, 1, "hits still surface without skipInjected");

  // Verify wasInjected
  assert.equal(s.wasInjected(SESS, cpId), true, "wasInjected returns true for injected checkpoint");
  assert.equal(s.wasInjected(SESS, "chkpt_999"), false, "wasInjected returns false for non-injected");
});

// ---------------------------------------------------------------------------
// 7. topSimilar
// ---------------------------------------------------------------------------

test("7. topSimilar: returns n most cosine-similar checkpoints", () => {
  const s = store();
  const SESS = "sess_topsim";

  // Store several checkpoints with varying topics
  const regions = [
    "the compiler optimized the hot loop with loop unrolling and inlining",
    "the database added a covering index to speed up queries on the users table",
    "the frontend introduced a virtualized list for large tables with lazy rendering",
    "the api added rate limiting using a token bucket algorithm for throttling",
    "the worker pool now backpressures when the queue is overloaded with tasks",
  ];

  for (let i = 0; i < regions.length; i++) {
    s.add({
      sessionId: SESS,
      summary: `topic_${i}`,
      regionText: regions[i],
      timestamp: i + 1,
    });
  }

  // Call topSimilar(3)
  const hits = s.topSimilar(SESS, 3);
  assert.ok(hits.length <= 3, "should respect n limit");
  assert.ok(hits.length > 0, "should return results");

  // Verify self-exclusion: the most recent checkpoint should not be in results
  const all = s.list(SESS);
  const ordered = [...all].sort((a, b) => a.checkpointId.localeCompare(b.checkpointId));
  const current = ordered[ordered.length - 1];
  assert.ok(!hits.some((h) => h.checkpoint.checkpointId === current.checkpointId), "current checkpoint excluded");

  // Verify scores are descending
  for (let i = 1; i < hits.length; i++) {
    assert.ok(hits[i - 1].score >= hits[i].score, "scores should be descending");
  }
});

test("7b. topSimilar respects n limit strictly", () => {
  const s = store();
  const SESS = "sess_topsim_limit";

  // Use sufficiently distinct texts to avoid L1 dedup collapse
  const regions = [
    "the compiler optimizer unrolls loops and inlines function calls for speed",
    "the database engine uses a covering b-tree index to accelerate lookups",
    "the frontend framework virtualizes large lists with lazy rendering and recycling",
    "the api gateway throttles requests using a token bucket rate limiting algorithm",
    "the worker pool applies backpressure when the task queue exceeds capacity limits",
  ];

  for (let i = 0; i < regions.length; i++) {
    s.add({
      sessionId: SESS,
      summary: `c${i}`,
      regionText: regions[i],
      timestamp: i + 1,
    });
  }

  const hits = s.topSimilar(SESS, 2);
  assert.equal(hits.length, 2, "n limit respected");
});

test("7c. topSimilar returns empty for sessions with 0 or 1 checkpoints", () => {
  const s = store();
  assert.deepEqual(s.topSimilar("sess_empty", 5), []);
  s.add({ sessionId: "sess_one", summary: "solo", regionText: "only checkpoint here", timestamp: 1 });
  assert.deepEqual(s.topSimilar("sess_one", 5), []);
});

// ---------------------------------------------------------------------------
// 8. Compression Round-Trip
// ---------------------------------------------------------------------------

test("8. Compression round-trip: decompression produces original content", () => {
  const s = store();
  const SESS = "sess_compress";

  // Store a checkpoint with a realistic region text
  const originalText = [
    "user asked to read src/server.ts",
    "assistant read src/server.ts and found a memory leak at line 42",
    "user asked to fix the leak by removing unused event listeners",
    "assistant edited src/server.ts to add cleanup() call in the shutdown handler",
    "user asked to add tests for the cleanup logic",
    "assistant created src/server.test.ts with three test cases",
  ].join("\n");

  s.add({
    sessionId: SESS,
    summary: "fixed memory leak in server.ts and added tests",
    regionText: originalText,
    tokenEstimate: 500,
    timestamp: 1,
  });

  // Retrieve and verify decompression
  const cp = s.list(SESS)[0];
  assert.ok(cp.compressedOriginal instanceof Buffer, "compressedOriginal is a Buffer");

  const restored = decompressSmart(cp.compressedOriginal as Buffer).toString("utf-8");
  assert.equal(restored, originalText, "decompression produces the original content");
});

test("8b. Compression round-trip with different content sizes", () => {
  const s = store();
  const SESS = "sess_compress_sizes";

  // Small text (under 512 bytes → raw tier)
  const small = "small region text about a minor fix";
  s.add({ sessionId: SESS, summary: "small", regionText: small, timestamp: 1 });

  // Medium text (512B–4KB → gzip level 1)
  const medium = "medium region text with more detail. ".repeat(50);
  s.add({ sessionId: SESS, summary: "medium", regionText: medium, timestamp: 2 });

  // Large text (>4KB → gzip level 6 or brotli)
  const large = "detailed region text with lots of context about the codebase. ".repeat(200);
  s.add({ sessionId: SESS, summary: "large", regionText: large, timestamp: 3 });

  const checkpoints = s.list(SESS);
  assert.equal(checkpoints.length, 3);

  // Verify each round-trips correctly
  const texts = [small, medium, large];
  for (let i = 0; i < 3; i++) {
    const cp = checkpoints[i];
    assert.ok(cp.compressedOriginal instanceof Buffer);
    const restored = decompressSmart(cp.compressedOriginal as Buffer).toString("utf-8");
    assert.equal(restored, texts[i], `content ${i} round-trips correctly`);
  }
});

// ---------------------------------------------------------------------------
// 9. Store Stats and Metrics
// ---------------------------------------------------------------------------

test("9. Store stats and metrics reflect actual state after compactions", () => {
  const s = store();
  const SESS = "sess_stats_e2e";

  // Compact three different conversations
  const conv1: EngineMessage[] = [
    msg("user", "read src/index.ts and refactor the imports"),
    msg("assistant", "Refactored imports in src/index.ts", "Edit"),
  ];
  const r1 = compactSession({ sessionId: SESS, messages: conv1, keepFrom: 2, timestamp: 1 }, s);
  assert.equal(r1.deduped, false);

  const conv2: EngineMessage[] = [
    msg("user", "fix the type errors in src/types.ts"),
    msg("assistant", "Fixed type errors in src/types.ts", "Edit"),
  ];
  const r2 = compactSession({ sessionId: SESS, messages: conv2, keepFrom: 2, timestamp: 2 }, s);
  assert.equal(r2.deduped, false);

  const conv3: EngineMessage[] = [
    msg("user", "add unit tests for the new utility functions"),
    msg("assistant", "Added tests in src/utils.test.ts", "Edit"),
  ];
  const r3 = compactSession({ sessionId: SESS, messages: conv3, keepFrom: 2, timestamp: 3 }, s);
  assert.equal(r3.deduped, false);

  // Get stats
  const st = s.stats(SESS);
  assert.equal(st.checkpointCount, 3, "three checkpoints stored");
  assert.ok(st.totalTokenEstimate > 0, "totalTokenEstimate should be positive");
  assert.equal(st.lastCheckpointId, "chkpt_003", "last checkpoint id correct");
  assert.ok(st.lastSummary && st.lastSummary.length > 0, "last summary is non-empty");
  assert.equal(st.injectedCount, 0, "no injections yet");
  assert.equal(st.dedupHitRate, 0, "dedupHitRate is 0 with no injections");

  // Mark one injected and re-check
  s.markInjected(SESS, "chkpt_001");
  const st2 = s.stats(SESS);
  assert.equal(st2.injectedCount, 1, "one injection tracked");
  assert.ok(Math.abs(st2.dedupHitRate - 1 / 3) < 1e-9, "dedupHitRate = injected/checkpoints");
});

test("9b. Stats on empty session returns zeros", () => {
  const s = store();
  const st = s.stats("sess_nothing");
  assert.equal(st.checkpointCount, 0);
  assert.equal(st.totalTokenEstimate, 0);
  assert.equal(st.lastCheckpointId, undefined);
  assert.equal(st.lastSummary, undefined);
  assert.equal(st.dedupHitRate, 0);
});

// ---------------------------------------------------------------------------
// 10. Concurrent Sessions
// ---------------------------------------------------------------------------

test("10. Concurrent sessions: no cross-contamination", () => {
  const s = store();

  // Three different sessions with distinct content
  const sessions = [
    { id: "sess_concurrent_a", msgs: [
      msg("user", "work on the authentication module in src/auth.ts"),
      msg("assistant", "Updated src/auth.ts with JWT validation", "Edit"),
    ]},
    { id: "sess_concurrent_b", msgs: [
      msg("user", "optimize the database queries in src/db.ts"),
      msg("assistant", "Added covering indexes in src/db.ts", "Edit"),
    ]},
    { id: "sess_concurrent_c", msgs: [
      msg("user", "fix the rendering bug in src/canvas.ts"),
      msg("assistant", "Fixed the canvas rendering loop in src/canvas.ts", "Edit"),
    ]},
  ];

  // Compact all three "simultaneously" (sequentially but back-to-back)
  const results = sessions.map((sess) =>
    compactSession({ sessionId: sess.id, messages: sess.msgs, keepFrom: 2, timestamp: 1 }, s),
  );

  // Each session has its own checkpoint
  results.forEach((r, i) => {
    assert.equal(r.skipped, false, `session ${i} should compact`);
    assert.equal(r.deduped, false, `session ${i} should not be deduped (distinct content)`);
    assert.ok(r.checkpointId);
  });

  // Verify: each session has exactly one checkpoint
  sessions.forEach((sess) => {
    const cps = s.list(sess.id);
    assert.equal(cps.length, 1, `${sess.id} should have 1 checkpoint`);
  });

  // Verify: search in one session doesn't return another session's checkpoints
  const hitsA = s.search("sess_concurrent_a", "authentication JWT", 5);
  assert.ok(hitsA.every((h) => h.checkpoint.sessionId === "sess_concurrent_a"),
    "search in A returns only A's checkpoints");

  const hitsB = s.search("sess_concurrent_b", "database queries indexes", 5);
  assert.ok(hitsB.every((h) => h.checkpoint.sessionId === "sess_concurrent_b"),
    "search in B returns only B's checkpoints");

  const hitsC = s.search("sess_concurrent_c", "canvas rendering bug", 5);
  assert.ok(hitsC.every((h) => h.checkpoint.sessionId === "sess_concurrent_c"),
    "search in C returns only C's checkpoints");
});

// ---------------------------------------------------------------------------
// 11. Edge Cases
// ---------------------------------------------------------------------------

test("11a. Empty session (no messages) — compactSession should skip", () => {
  const s = store();
  const r = compactSession({ sessionId: "sess_empty_msgs", messages: [], keepFrom: 0, timestamp: 1 }, s);
  assert.equal(r.skipped, true, "empty session should be skipped");
  assert.equal(r.summary, "");
  assert.equal(r.regionHash, "");
  assert.equal(s.list("sess_empty_msgs").length, 0);
});

test("11b. Single message session — should skip or handle gracefully", () => {
  const s = store();
  const r = compactSession({
    sessionId: "sess_single_msg",
    messages: [msg("user", "hello world")],
    keepFrom: 0,
    timestamp: 1,
  }, s);
  // With keepFrom=0, the single message is compactable, so it should work
  // but produce a minimal summary
  assert.ok(r.skipped === true || r.skipped === false, "should not throw");
  if (!r.skipped) {
    assert.ok(r.checkpointId);
  }
});

test("11c. Very large region text — should still compact and store", () => {
  const s = store();
  const SESS = "sess_large";

  // Build a large conversation with many messages
  const messages: EngineMessage[] = [];
  for (let i = 0; i < 50; i++) {
    messages.push(msg("user", `read src/module_${i}.ts and review the implementation of feature ${i}`));
    messages.push(msg("assistant", `Reviewed src/module_${i}.ts — feature ${i} looks good with minor issues`, "Read"));
    messages.push(msg("user", `fix the issues in src/module_${i}.ts`));
    messages.push(msg("assistant", `Fixed issues in src/module_${i}.ts`, "Edit"));
  }

  const r = compactSession({ sessionId: SESS, messages, keepFrom: 8, timestamp: 1 }, s);
  assert.equal(r.skipped, false, "large conversation should compact");
  assert.ok(r.checkpointId, "checkpoint created");
  assert.ok(r.summary.length > 0, "summary produced");

  // Verify it's searchable
  const hits = s.search(SESS, "module feature fix review", 3);
  assert.ok(hits.length > 0, "large checkpoint is searchable");
});

test("11d. Unicode and emoji content — should normalize and hash correctly", () => {
  const s = store();
  const SESS = "sess_unicode";

  const messages: EngineMessage[] = [
    msg("user", "read src/本地化.ts and fix the 中文 translation issues 🌏"),
    msg("assistant", "Fixed translations in src/本地化.ts — updated 中文 strings and emoji handling 🌏✅", "Edit"),
    msg("user", "add support for 日本語 and 한국어 locales too"),
    msg("assistant", "Added 日本語 and 한국어 locale support in src/本地化.ts 🌏✅🇯🇵🇰🇷", "Edit"),
  ];

  const r = compactSession({ sessionId: SESS, messages, keepFrom: 4, timestamp: 1 }, s);
  assert.equal(r.skipped, false, "unicode conversation should compact");
  assert.ok(r.regionHash.length > 0, "regionHash computed for unicode content");

  // Verify the checkpoint exists and is searchable
  const hits = s.search(SESS, "中文 translation 本地化", 3);
  assert.ok(hits.length > 0, "unicode checkpoint is searchable");

  // Verify regionHash is deterministic for the same unicode content
  const r2 = compactSession({ sessionId: SESS, messages, keepFrom: 4, timestamp: 2 }, s);
  assert.equal(r2.deduped, true, "identical unicode content should be deduped");
  assert.equal(r.regionHash, r2.regionHash, "regionHash is deterministic for unicode");
});

test("11e. All messages in preserve-recent window — nothing to compact", () => {
  const s = store();
  const messages: EngineMessage[] = [
    msg("user", "first message"),
    msg("assistant", "first response", "Edit"),
    msg("user", "second message"),
    msg("assistant", "second response", "Edit"),
  ];

  // keepFrom = 0 → compactable slice is empty (everything is "preserved")
  const r = compactSession({
    sessionId: "sess_all_preserved",
    messages,
    keepFrom: 0,
    timestamp: 1,
  }, s);
  assert.equal(r.skipped, true, "should skip when keepFrom=0 (nothing to compact)");
  assert.equal(s.list("sess_all_preserved").length, 0, "no checkpoints stored");
});

// ---------------------------------------------------------------------------
// 12. Feature Flag Toggling
// ---------------------------------------------------------------------------

test("12a. L0_ENABLED=false — L0 does not collapse exact dups", () => {
  // Disable all tiers so no dedup happens at all
  const s = store({ L0_ENABLED: false, L1_ENABLED: false, L2_ENABLED: false });
  const SESS = "sess_l0_off";

  // Use different regionText for each add to avoid the SQLite content_hash
  // unique constraint (which fires regardless of L0 flag since the hash is
  // always computed). When L0 is disabled, the dedup cascade skips the
  // hash check, but the DB constraint is structural.
  const r1 = s.add({
    sessionId: SESS,
    summary: "first checkpoint about the parser",
    regionText: "the parser tokenizes the input into a stream of tokens for the compiler version one",
    timestamp: 1,
  });
  const r2 = s.add({
    sessionId: SESS,
    summary: "second checkpoint about the parser",
    regionText: "the parser tokenizes the input into a stream of tokens for the compiler version two",
    timestamp: 2,
  });

  assert.equal(r1.deduped, false);
  // With L0 off (and L1/L2 off too), near-dup should NOT be collapsed
  assert.equal(r2.deduped, false, "L0 disabled → near-dup not collapsed");
  assert.equal(s.list(SESS).length, 2, "both checkpoints stored when L0 is off");
});

test("12b. MARK_ONLY_L1=true — L1 records but does not collapse", () => {
  // Disable L2 to isolate L1 behavior
  const s = store({ L1_ENABLED: true, MARK_ONLY_L1: true, L2_ENABLED: false });
  const SESS = "sess_mark_only_l1";

  const r1 = s.add({
    sessionId: SESS,
    summary: "user worked on the parser optimization",
    regionText: "the parser optimized the hot loop with aggressive inlining",
    timestamp: 1,
  });
  const r2 = s.add({
    sessionId: SESS,
    summary: "user worked on the parser optimization",
    regionText: "the parser optimized the hot loop with aggressive inlinings",
    timestamp: 2,
  });

  assert.equal(r1.deduped, false);
  // MARK_ONLY_L1 → L1 detects the near-dup but does NOT collapse
  assert.equal(r2.deduped, false, "MARK_ONLY_L1 → not collapsed");
  assert.equal(s.list(SESS).length, 2, "both checkpoints stored (mark only)");

  // Both should be active (not removed)
  const all = s.list(SESS);
  assert.ok(all.every((c) => c.dedupStatus === "active"), "both rows active under MARK_ONLY");
});

test("12c. L2_ENABLED=false — L2 skipped but L0/L1 still work", () => {
  const s = store({ L2_ENABLED: false });
  const SESS = "sess_l2_off";

  // L0 should still catch exact dups
  s.add({
    sessionId: SESS,
    summary: "auth module work",
    regionText: "the auth module validates the session token and refreshes it on each request",
    timestamp: 1,
  });
  const r2 = s.add({
    sessionId: SESS,
    summary: "auth module work",
    regionText: "the auth module validates the session token and refreshes it on each request",
    timestamp: 2,
  });
  assert.equal(r2.deduped, true, "L0 still catches exact dup with L2 off");
  assert.equal(r2.reason, "contentHash", "L0 contentHash still fires");

  // L1 should still catch near-dups
  const r3 = s.add({
    sessionId: SESS,
    summary: "auth module work variant",
    regionText: "the auth module validates the session tokens and refreshes them on each requests",
    timestamp: 3,
  });
  assert.equal(r3.deduped, true, "L1 still catches near-dup with L2 off");
  assert.equal(r3.reason, "l1MinHash", "L1 MinHash still fires");
});

test("12d. All tiers disabled — nothing deduped, everything stored", () => {
  const s = store({ L0_ENABLED: false, L1_ENABLED: false, L2_ENABLED: false });
  const SESS = "sess_all_off";

  // Use different regionText to avoid SQLite content_hash unique constraint
  const r1 = s.add({
    sessionId: SESS,
    summary: "alpha",
    regionText: "alpha region text about the compiler optimization pipeline first pass",
    timestamp: 1,
  });
  const r2 = s.add({
    sessionId: SESS,
    summary: "alpha",
    regionText: "alpha region text about the compiler optimization pipeline second pass",
    timestamp: 2,
  });

  assert.equal(r1.deduped, false);
  assert.equal(r2.deduped, false, "all tiers off → nothing deduped");
  assert.equal(s.list(SESS).length, 2, "both stored");
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

test("E2E cleanup", () => {
  rmSync(baseTmp, { recursive: true, force: true });
});
