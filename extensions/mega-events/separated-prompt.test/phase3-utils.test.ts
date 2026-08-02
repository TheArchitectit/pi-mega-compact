/**
 * phase3-utils.test.ts — cosineSimilarity, detectTopicShift, encode/decodeEmbeddingBlob,
 * refreshStripeAssignments (Phase 3 utility tests).
 * Split from separated-prompt.test.ts; test bodies are unchanged.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import {
  cosineSimilarity,
  detectTopicShift,
  decodeEmbeddingBlob,
  encodeEmbeddingBlob,
  refreshStripeAssignments,
} from "../separated-prompt.js";
import { createTestDb } from "./_helpers.js";

describe("cosineSimilarity (Phase 3)", () => {
  it("identical vectors return 1.0", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([1, 0, 0]);
    assert.equal(cosineSimilarity(a, b), 1.0);
  });

  it("orthogonal vectors return 0.0", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    assert.equal(cosineSimilarity(a, b), 0.0);
  });

  it("opposite vectors return -1.0", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    assert.equal(cosineSimilarity(a, b), -1.0);
  });

  it("partial similarity works", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([1, 1]);
    const expected = 1 / Math.sqrt(2);
    assert.ok(Math.abs(cosineSimilarity(a, b) - expected) < 0.0001);
  });

  it("mismatched lengths return 0", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([1, 0, 0]);
    assert.equal(cosineSimilarity(a, b), 0);
  });

  it("zero vectors return 0", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 0, 0]);
    assert.equal(cosineSimilarity(a, b), 0);
  });

  it("both zero vectors return 0", () => {
    const a = new Float32Array([0, 0]);
    const b = new Float32Array([0, 0]);
    assert.equal(cosineSimilarity(a, b), 0);
  });

  it("empty arrays return 0", () => {
    const a = new Float32Array([]);
    const b = new Float32Array([]);
    assert.equal(cosineSimilarity(a, b), 0);
  });
});

describe("detectTopicShift (Phase 3)", () => {
  it("returns true when similarity < 0.7", () => {
    const current = new Float32Array([1, 0, 0]);
    const previous = new Float32Array([0, 1, 0]);
    assert.equal(detectTopicShift(current, previous), true);
  });

  it("returns false when similarity >= 0.7", () => {
    const current = new Float32Array([1, 0]);
    const previous = new Float32Array([1, 0.5]);
    assert.equal(detectTopicShift(current, previous), false);
  });

  it("returns false when current is null", () => {
    assert.equal(detectTopicShift(null, new Float32Array([1, 0, 0])), false);
  });

  it("returns false when previous is null", () => {
    assert.equal(detectTopicShift(new Float32Array([1, 0, 0]), null), false);
  });

  it("returns false when both are null", () => {
    assert.equal(detectTopicShift(null, null), false);
  });

  it("returns false when current is undefined", () => {
    assert.equal(detectTopicShift(undefined, new Float32Array([1, 0, 0])), false);
  });

  it("just below 0.7 returns true", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0.699, Math.sqrt(1 - 0.699 * 0.699)]);
    assert.equal(detectTopicShift(a, b), true);
  });
});

describe("decodeEmbeddingBlob / encodeEmbeddingBlob (Phase 3)", () => {
  it("round-trips Float32Array through Buffer", () => {
    const original = new Float32Array([1.5, -2.5, 3.0, -0.0, 1e-10]);
    const blob = encodeEmbeddingBlob(original);
    const decoded = decodeEmbeddingBlob(blob);
    assert.notEqual(decoded, null);
    assert.equal(decoded!.length, original.length);
    for (let i = 0; i < original.length; i++) {
      assert.equal(decoded![i], original[i]);
    }
  });

  it("decodeEmbeddingBlob null/undefined returns null", () => {
    assert.equal(decodeEmbeddingBlob(null), null);
    assert.equal(decodeEmbeddingBlob(undefined), null);
    assert.equal(decodeEmbeddingBlob(Buffer.alloc(0)), null);
  });
});

describe("refreshStripeAssignments (Phase 3)", () => {
  it("returns empty array when no stripes exist", () => {
    const { db, dir } = createTestDb();
    db.close();

    const rows = refreshStripeAssignments(dir, "nonexistent-epoch");
    assert.deepEqual(rows, []);
    rmSync(dir, { recursive: true });
  });

  it("returns stripes ordered by stability DESC", () => {
    const { db, dir } = createTestDb();
    const now = Date.now();

    db.prepare(
      `INSERT INTO cache_stripes (chunk_id, stripe, stability, assigned_at, epoch_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("chunk-a", 2, 0.9, now, "epoch-1");
    db.prepare(
      `INSERT INTO cache_stripes (chunk_id, stripe, stability, assigned_at, epoch_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("chunk-b", 2, 0.5, now, "epoch-1");
    db.prepare(
      `INSERT INTO cache_stripes (chunk_id, stripe, stability, assigned_at, epoch_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("chunk-c", 2, 0.7, now, "epoch-1");
    db.close();

    const rows = refreshStripeAssignments(dir, "epoch-1");
    assert.equal(rows.length, 3);
    assert.equal(rows[0].chunk_id, "chunk-a");
    assert.equal(rows[1].chunk_id, "chunk-c");
    assert.equal(rows[2].chunk_id, "chunk-b");
    rmSync(dir, { recursive: true });
  });

  it("respects limit parameter", () => {
    const { db, dir } = createTestDb();
    const now = Date.now();

    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT INTO cache_stripes (chunk_id, stripe, stability, assigned_at, epoch_id)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(`chunk-${i}`, 2, 1.0 - i * 0.1, now, "epoch-2");
    }
    db.close();

    const rows = refreshStripeAssignments(dir, "epoch-2", 2);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].chunk_id, "chunk-0");
    assert.equal(rows[1].chunk_id, "chunk-1");
    rmSync(dir, { recursive: true });
  });
});
