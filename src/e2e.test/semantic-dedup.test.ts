/**
 * semantic-dedup.test.ts — L2 cosine dedup, MMR diversification, SemDeDup cleanup.
 * Split from e2e.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { VectorStore, vectorList, vectorSearch, vectorSemDedup } from "../vectorStore.js";
import { loadDedupConfig } from "../config/dedup.js";
import { closeStore } from "../store/sqlite.js";
import { store, storeDir, seedDirect } from "./_helpers.js";

test("4. Semantic dedup: L2 cosine catches highly similar content that L0/L1 miss", () => {
  const s = store();
  const SESS = "sess_l2_e2e";

  const r1 = s.add({
    sessionId: SESS,
    summary: "user authentication and session token management",
    regionText: "user authentication and session token management login validation session expiry handling secure cookie management",
    timestamp: 1,
  });
  assert.equal(r1.deduped, false);

  const r2 = s.add({
    sessionId: SESS,
    summary: "user authentication and session token management login validation",
    regionText: "user authentication and session token management login validation session expiry handling secure cookie configuration",
    timestamp: 2,
  });

  assert.equal(r2.deduped, true, "L2 should catch the high-similarity paraphrase");
  assert.ok(r2.reason === "contentSimilarity" || r2.reason === "l1MinHash",
    `dedup reason should be L2 contentSimilarity or L1 l1MinHash, got ${r2.reason}`);
  assert.equal(vectorList(s, SESS).length, 1, "only one checkpoint after semantic dedup");
});

test("4b. MMR diversifies search results", () => {
  const s = store();
  const SESS = "sess_mmr_e2e";

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

  const hits = vectorSearch(s, SESS, "parser tokenization source code files", 4);
  assert.ok(hits.length >= 1, "should return at least one result");
  assert.ok(hits[0].checkpoint.summary.includes("topic_0"), "top hit is the parser topic");

  const summaries = hits.map((h) => h.checkpoint.summary);
  const uniqueSummaries = new Set(summaries);
  assert.ok(uniqueSummaries.size >= 2, "MMR provides diverse results");
});

test("5. SemDeDup offline cleanup: redundant rows marked removed, not deleted", () => {
  const dir = storeDir();
  const s = new VectorStore({ stateDir: dir, config: { ...loadDedupConfig() } });
  const SESS = "sess_semdedup";

  seedDirect(dir, SESS, [
    { id: "chkpt_001", text: "the cache stores parsed ast nodes for fast lookup and retrieval", tok: 100, ts: 1 },
    { id: "chkpt_002", text: "the cache stores parsed ast nodes for fast lookup and retrieval and reuse", tok: 900, ts: 2 },
    { id: "chkpt_003", text: "the frontend uses a virtualized list for rendering large datasets efficiently", tok: 500, ts: 3 },
  ]);

  const removed = vectorSemDedup(s, SESS, 0.85);
  assert.equal(removed, 1, "one redundant row should be marked removed");

  const all = vectorList(s, SESS);
  const dropped = all.find((c) => c.dedupStatus === "removed");
  assert.ok(dropped, "a row should have dedup_status='removed'");
  assert.equal(dropped!.checkpointId, "chkpt_001", "lower tokenEstimate row removed");
  assert.equal(dropped!.dedupStatus, "removed");

  const hits = vectorSearch(s, SESS, "cache parsed ast nodes frontend virtualized list", 10);
  assert.equal(hits.length, 2, "search excludes the removed row, returns 2 active");
  assert.ok(hits.every((h) => h.checkpoint.dedupStatus !== "removed"), "no removed rows in search");

  const secondRun = vectorSemDedup(s, SESS, 0.85);
  assert.equal(secondRun, 0, "idempotent re-run removes nothing new");

  closeStore(dir);
});
