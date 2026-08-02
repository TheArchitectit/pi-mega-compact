/**
 * compression-roundtrip.test.ts — Compression round-trip verification tests.
 * Split from e2e.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { vectorList } from "../vectorStore.js";
import { decompressSmart } from "../store.js";
import { store } from "./_helpers.js";

test("8. Compression round-trip: decompression produces original content", () => {
  const s = store();
  const SESS = "sess_compress";

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

  const cp = vectorList(s, SESS)[0];
  assert.ok(cp.compressedOriginal instanceof Buffer, "compressedOriginal is a Buffer");

  const restored = decompressSmart(cp.compressedOriginal as Buffer).toString("utf-8");
  assert.equal(restored, originalText, "decompression produces the original content");
});

test("8b. Compression round-trip with different content sizes", () => {
  const s = store();
  const SESS = "sess_compress_sizes";

  const small = "small region text about a minor fix";
  s.add({ sessionId: SESS, summary: "small", regionText: small, timestamp: 1 });

  const medium = "medium region text with more detail. ".repeat(50);
  s.add({ sessionId: SESS, summary: "medium", regionText: medium, timestamp: 2 });

  const large = "detailed region text with lots of context about the codebase. ".repeat(200);
  s.add({ sessionId: SESS, summary: "large", regionText: large, timestamp: 3 });

  const checkpoints = vectorList(s, SESS);
  assert.equal(checkpoints.length, 3);

  const texts = [small, medium, large];
  for (let i = 0; i < 3; i++) {
    const cp = checkpoints[i];
    assert.ok(cp.compressedOriginal instanceof Buffer);
    const restored = decompressSmart(cp.compressedOriginal as Buffer).toString("utf-8");
    assert.equal(restored, texts[i], `content ${i} round-trips correctly`);
  }
});
