/**
 * stats-concurrent.test.ts — Store stats/metrics + concurrent session isolation tests.
 * Split from e2e.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compactSession } from "../engine.js";
import { vectorList, vectorMarkInjected, vectorSearch, vectorStats } from "../vectorStore.js";
import type { EngineMessage } from "../types.js";
import { store, msg } from "./_helpers.js";

test("9. Store stats and metrics reflect actual state after compactions", () => {
  const s = store();
  const SESS = "sess_stats_e2e";

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

  const st = vectorStats(s, SESS);
  assert.equal(st.checkpointCount, 3, "three checkpoints stored");
  assert.ok(st.totalTokenEstimate > 0, "totalTokenEstimate should be positive");
  assert.equal(st.lastCheckpointId, "chkpt_003", "last checkpoint id correct");
  assert.ok(st.lastSummary && st.lastSummary.length > 0, "last summary is non-empty");
  assert.equal(st.injectedCount, 0, "no injections yet");
  assert.equal(st.dedupHitRate, 0, "dedupHitRate is 0 with no injections");

  vectorMarkInjected(s, SESS, "chkpt_001");
  const st2 = vectorStats(s, SESS);
  assert.equal(st2.injectedCount, 1, "one injection tracked");
  assert.ok(Math.abs(st2.dedupHitRate - 1 / 3) < 1e-9, "dedupHitRate = injected/checkpoints");
});

test("9b. Stats on empty session returns zeros", () => {
  const s = store();
  const st = vectorStats(s, "sess_nothing");
  assert.equal(st.checkpointCount, 0);
  assert.equal(st.totalTokenEstimate, 0);
  assert.equal(st.lastCheckpointId, undefined);
  assert.equal(st.lastSummary, undefined);
  assert.equal(st.dedupHitRate, 0);
});

test("10. Concurrent sessions: no cross-contamination", () => {
  const s = store();

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

  const results = sessions.map((sess) =>
    compactSession({ sessionId: sess.id, messages: sess.msgs, keepFrom: 2, timestamp: 1 }, s),
  );

  results.forEach((r, i) => {
    assert.equal(r.skipped, false, `session ${i} should compact`);
    assert.equal(r.deduped, false, `session ${i} should not be deduped (distinct content)`);
    assert.ok(r.checkpointId);
  });

  sessions.forEach((sess) => {
    const cps = vectorList(s, sess.id);
    assert.equal(cps.length, 1, `${sess.id} should have 1 checkpoint`);
  });

  const hitsA = vectorSearch(s, "sess_concurrent_a", "authentication JWT", 5);
  assert.ok(hitsA.every((h) => h.checkpoint.sessionId === "sess_concurrent_a"),
    "search in A returns only A's checkpoints");

  const hitsB = vectorSearch(s, "sess_concurrent_b", "database queries indexes", 5);
  assert.ok(hitsB.every((h) => h.checkpoint.sessionId === "sess_concurrent_b"),
    "search in B returns only B's checkpoints");

  const hitsC = vectorSearch(s, "sess_concurrent_c", "canvas rendering bug", 5);
  assert.ok(hitsC.every((h) => h.checkpoint.sessionId === "sess_concurrent_c"),
    "search in C returns only C's checkpoints");
});
