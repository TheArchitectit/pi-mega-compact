/**
 * recall-inline.test.ts — Recall + inline dedup sentinel + topSimilar tests.
 * Split from e2e.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compactSession, recall } from "../engine.js";
import { vectorList, vectorMarkInjected, vectorTopSimilar, vectorWasInjected } from "../vectorStore.js";
import type { EngineMessage } from "../types.js";
import { store, msg } from "./_helpers.js";

test("6. Recall + inline with dedup sentinel: injected checkpoints are skipped", () => {
  const s = store();
  const SESS = "sess_recall";

  const messages: EngineMessage[] = [
    msg("user", "investigated src/vectorStore.ts to understand the dedup cascade"),
    msg("assistant", "Found the L0, L1, L2 tiers in src/vectorStore.ts", "Read"),
    msg("user", "now document the dedup pipeline in README.md"),
    msg("assistant", "Updated README.md with full dedup documentation", "Edit"),
  ];

  const r = compactSession({ sessionId: SESS, messages, keepFrom: 4, timestamp: 1 }, s);
  assert.ok(r.checkpointId);

  const first = recall({ sessionId: SESS, query: "vectorStore dedup cascade", limit: 5, skipInjected: true }, s);
  assert.equal(first.newHits.length, 1, "first recall should find the checkpoint");
  assert.equal(first.hits.length, 1);

  const cpId = first.hits[0].checkpoint.checkpointId;
  vectorMarkInjected(s, SESS, cpId);

  const second = recall({ sessionId: SESS, query: "vectorStore dedup cascade", limit: 5, skipInjected: true }, s);
  assert.equal(second.newHits.length, 0, "injected checkpoint should be skipped (dedup sentinel)");
  assert.equal(second.hits.length, 1, "hits still surface without skipInjected");

  assert.equal(vectorWasInjected(s, SESS, cpId), true, "wasInjected returns true for injected checkpoint");
  assert.equal(vectorWasInjected(s, SESS, "chkpt_999"), false, "wasInjected returns false for non-injected");
});

test("7. topSimilar: returns n most cosine-similar checkpoints", () => {
  const s = store();
  const SESS = "sess_topsim";

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

  const hits = vectorTopSimilar(s, SESS, 3);
  assert.ok(hits.length <= 3, "should respect n limit");
  assert.ok(hits.length > 0, "should return results");

  const all = vectorList(s, SESS);
  const ordered = [...all].sort((a, b) => a.checkpointId.localeCompare(b.checkpointId));
  const current = ordered[ordered.length - 1];
  assert.ok(!hits.some((h) => h.checkpoint.checkpointId === current.checkpointId), "current checkpoint excluded");

  for (let i = 1; i < hits.length; i++) {
    assert.ok(hits[i - 1].score >= hits[i].score, "scores should be descending");
  }
});

test("7b. topSimilar respects n limit strictly", () => {
  const s = store();
  const SESS = "sess_topsim_limit";

  const regions = [
    "the compiler optimizer unrolls loops and inlines function calls for speed",
    "the database engine uses a covering b-tree index to accelerate lookups",
    "the frontend framework virtualizes large list with lazy rendering and recycling",
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

  const hits = vectorTopSimilar(s, SESS, 2);
  assert.equal(hits.length, 2, "n limit respected");
});

test("7c. topSimilar returns empty for sessions with 0 or 1 checkpoints", () => {
  const s = store();
  assert.deepEqual(vectorTopSimilar(s, "sess_empty", 5), []);
  s.add({ sessionId: "sess_one", summary: "solo", regionText: "only checkpoint here", timestamp: 1 });
  assert.deepEqual(vectorTopSimilar(s, "sess_one", 5), []);
});
