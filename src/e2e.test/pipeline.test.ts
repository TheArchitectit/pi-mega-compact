/**
 * pipeline.test.ts — Full compaction + multi-session dedup + L1 near-duplicate tests.
 * Split from e2e.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compactSession, supersededCount } from "../engine.js";
import { vectorList, vectorSearch } from "../vectorStore.js";
import type { EngineMessage } from "../types.js";
import { store, msg } from "./_helpers.js";

test("1. Full compaction pipeline: SUPERSEDE → COLLAPSE → CLUSTER", () => {
  const s = store();
  const SESS = "sess_full_pipeline";

  const messages: EngineMessage[] = [
    msg("user", "read src/server.ts to understand the current setup"),
    msg("assistant", "Reading src/server.ts", "Read", "src/server.ts", "const server = createServer(...)"), // guardrails-allow PREVENT-PI-004: test fixture string containing example code in quotes (not real net call)
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

  const r = compactSession({ sessionId: SESS, messages, keepFrom: 18, timestamp: 100 }, s);

  assert.equal(r.skipped, false, "compaction should not be skipped");
  assert.ok(r.summary.length > 0, "summary should be produced by COLLAPSE");
  assert.ok(r.regionHash.length > 0, "regionHash should be computed");
  assert.match(r.regionHash, /^[0-9a-f]{16}$/, "regionHash is 16-hex SHA-256 prefix");

  const compactable = messages.slice(0, 18);
  const superseded = supersededCount(compactable);
  assert.ok(superseded >= 1, `at least 1 superseded file read, got ${superseded}`);

  assert.ok(r.checkpointId, "checkpointId should be set");
  assert.match(r.checkpointId!, /^chkpt_001$/);

  const hits = vectorSearch(s, SESS, "server.ts memory leak JWT auth", 5);
  assert.ok(hits.length > 0, "checkpoint should be searchable");
  assert.equal(hits[0].checkpoint.checkpointId, r.checkpointId);
});

test("2. Multi-session dedup: identical content in same session detected by L0", () => {
  const s = store();

  const messagesA: EngineMessage[] = [
    msg("user", "read src/database.ts and fix the connection pooling"),
    msg("assistant", "Fixed connection pool in src/database.ts", "Edit"),
    msg("user", "add a retry mechanism for failed queries"),
    msg("assistant", "Added retry logic in src/database.ts:85", "Edit"),
  ];

  const rA = compactSession({ sessionId: "sess_multi_a", messages: messagesA, keepFrom: 4, timestamp: 1 }, s);
  assert.equal(rA.deduped, false, "first compaction should not be deduped");
  assert.ok(rA.checkpointId);

  const messagesB: EngineMessage[] = [
    msg("user", "read src/database.ts and fix the connection pooling"),
    msg("assistant", "Fixed connection pool in src/database.ts", "Edit"),
    msg("user", "add a retry mechanism for failed queries"),
    msg("assistant", "Added retry logic in src/database.ts:85", "Edit"),
  ];

  const rB = compactSession({ sessionId: "sess_multi_a", messages: messagesB, keepFrom: 4, timestamp: 2 }, s);

  assert.equal(rB.deduped, true, "second identical compaction should be deduped by L0");
  assert.ok(rB.dedupReason === "regionHash" || rB.dedupReason === "contentHash",
    `dedup reason should be L0 (regionHash or contentHash), got ${rB.dedupReason}`);

  const hits = vectorSearch(s, "sess_multi_a", "database connection pooling", 5);
  assert.ok(hits.length > 0, "search returns the deduped result");
  assert.equal(hits[0].checkpoint.checkpointId, rA.checkpointId);
});

test("3. Near-duplicate detection: L1 MinHash/LSH catches one-word edits that L0 misses", () => {
  const s = store({ L2_ENABLED: false });
  const SESS = "sess_l1_e2e";

  const r1 = s.add({
    sessionId: SESS,
    summary: "user reviewed the authentication module and merged the pull request",
    regionText: "user reviewed the authentication module and merged the pull request on github after ci passed",
    timestamp: 1,
  });
  assert.equal(r1.deduped, false);

  const r2 = s.add({
    sessionId: SESS,
    summary: "user reviewed the authentication module and merged the pull request",
    regionText: "user reviewed the authentication module and merged the pull requests on github after ci passed",
    timestamp: 2,
  });

  assert.equal(r2.deduped, true, "L1 should catch the near-duplicate");
  assert.equal(r2.reason, "l1MinHash", "dedup reason should be l1MinHash");
  assert.equal(vectorList(s, SESS).length, 1, "only one checkpoint stored");
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
  assert.equal(vectorList(s, SESS).length, 2, "both checkpoints stored");
});
