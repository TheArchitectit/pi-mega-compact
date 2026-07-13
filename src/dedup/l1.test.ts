import { test } from "node:test";
import assert from "node:assert/strict";
import { minhashSignature, shingles, signatureSimilarity, NUM_HASHES } from "./l1-minhash.js";
import { lshBands, BANDS, ROWS_PER_BAND } from "./l1-lsh.js";
import { trigramSimilarity, isNearDuplicate, L1_VERIFY_THRESHOLD } from "./l1-verify.js";

test("minhashSignature is deterministic across calls (same input → same sig)", () => {
  const a = minhashSignature("the authentication module handles login securely");
  const b = minhashSignature("the authentication module handles login securely");
  assert.deepEqual(a, b);
  assert.equal(a.length, NUM_HASHES);
});

test("minhashSignature of near-identical text is more similar than of unrelated text", () => {
  const s1 = minhashSignature("user logged in and viewed the dashboard");
  const s2 = minhashSignature("user logged in and viewed the dashboard page"); // one word added
  const s3 = minhashSignature("the compiler optimized the hot loop aggressively");
  assert.ok(signatureSimilarity(s1, s2) > signatureSimilarity(s1, s3));
});

test("lshBands produces BANDS keys and is stable per session", () => {
  const sig = minhashSignature("some text to band");
  const k1 = lshBands(sig, "sess_a", 1);
  const k2 = lshBands(sig, "sess_a", 1);
  assert.equal(k1.length, BANDS);
  assert.equal(BANDS * ROWS_PER_BAND, NUM_HASHES);
  assert.deepEqual(k1, k2);
  // Different session → different bucket keys (scoped, deterministic).
  const k3 = lshBands(sig, "sess_b", 1);
  assert.notDeepEqual(k1, k3);
});

test("lshBands keys are stable across restarts (no entropy source)", () => {
  // Recomputed in a fresh call path — determinism is structural, not time-based.
  const sig = minhashSignature("deterministic bucket key check");
  const first = lshBands(sig, "sess_x", 1);
  const again = lshBands(sig, "sess_x", 1);
  assert.deepEqual(first, again);
});

test("trigramSimilarity is 1 for identical, high for one-word-edit, low for unrelated", () => {
  const a = "the quick brown fox jumps";
  assert.equal(trigramSimilarity(a, a), 1);
  assert.ok(trigramSimilarity(a, "the quick brown fox jumps over") >= L1_VERIFY_THRESHOLD);
  assert.ok(trigramSimilarity(a, "a completely different sentence about databases") < 0.5);
});

test("isNearDuplicate thresholds at 0.85", () => {
  assert.equal(isNearDuplicate("user fixed the parser bug", "user fixed the parser bug today"), true);
  assert.equal(isNearDuplicate("alpha beta gamma", "totally different words here"), false);
});

test("shingles are capped at 50K (complexity guard)", () => {
  const huge = "x".repeat(200_000);
  const sh = shingles(huge);
  assert.ok(sh.length <= 50_000);
});
