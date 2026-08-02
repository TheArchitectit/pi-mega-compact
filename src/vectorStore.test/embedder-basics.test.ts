/**
 * embedder-basics.test.ts — embedder determinism, cosine similarity, normalizeSessionId,
 * computeRegionHash.
 * Split from src/vectorStore.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { TrigramEmbedder, cosineSimilarity, l2Normalize, defaultEmbedder } from "../embedder.js";
import { normalizeSessionId } from "../store.js";
import { computeRegionHash } from "../vectorStore.js";
import { baseTmp } from "./_helpers.js";

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

test("normalizeSessionId handles null, prefixed, and uuid forms", () => {
  assert.match(normalizeSessionId("sess_abc"), /^sess_/);
  assert.equal(normalizeSessionId("sess_abc"), "sess_abc");
  assert.match(
    normalizeSessionId("550e8400-e29b-41d4-a716-446655440000"),
    /^sess_[0-9a-f]{16}$/,
  );
  assert.match(normalizeSessionId(undefined), /^sess_[0-9a-f]{16}$/);
});

test("computeRegionHash normalizes whitespace before hashing", () => {
  const h1 = computeRegionHash("foo  bar");
  const h2 = computeRegionHash("foo bar");
  const h3 = computeRegionHash("  foo   bar  ");
  assert.equal(h1, h2, "double space and single space should hash the same");
  assert.equal(h2, h3, "leading/trailing spaces should hash the same");
  assert.notEqual(h1, computeRegionHash("foo baz"));
});
