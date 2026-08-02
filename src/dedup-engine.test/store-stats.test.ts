/**
 * store-stats.test.ts — checkpoints, token estimate, injection and dedup hit rate.
 * Split out of dedup-engine.test.ts; describe bodies are unchanged.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { vectorStats, vectorSearch, vectorMarkInjected } from "../vectorStore.js";
import { makeStore, makeMsg, compactFull } from "./_helpers.js";
describe("Compression / Store Stats", () => {
  const SESS = "sess_stats";

  it("stats reflect checkpoints, tokens, injection and dedup hit rate", () => {
    const s = makeStore();

    // Mixed duplicate and unique stores.
    const unique = "unique topic about payment gateway integration";
    compactFull(s, SESS, [makeMsg("user", unique)], 1);

    const dup = "duplicate topic about payment gateway integration";
    compactFull(s, SESS, [makeMsg("user", dup)], 1);

    const statsBefore = vectorStats(s,SESS);
    assert.ok(statsBefore.checkpointCount >= 1, "checkpointCount should be positive");
    assert.ok(statsBefore.totalTokenEstimate >= 0, "totalTokenEstimate should be non-negative");
    assert.equal(statsBefore.dedupHitRate, 0, "no injections yet => dedupHitRate 0");
    assert.equal(statsBefore.injectedCount, 0, "no injections yet => injectedCount 0");

    const hits = vectorSearch(s, SESS, "payment gateway", 5);
    assert.ok(hits.length > 0, "should find the stored checkpoint");
    const cpId = hits[0].checkpoint.checkpointId;

    vectorMarkInjected(s,SESS, cpId);
    const statsAfter = vectorStats(s,SESS);
    assert.equal(statsAfter.injectedCount, 1, "injectedCount tracks markInjected");
    if (statsAfter.checkpointCount > 0) {
      assert.ok(
        Math.abs(statsAfter.dedupHitRate - 1 / statsAfter.checkpointCount) < 0.001,
        "dedupHitRate = injected / checkpoints",
      );
    }
    assert.ok(statsAfter.totalTokenEstimate > 0, "totalTokenEstimate positive after inserts");
  });

  it("dedupHitRate increases with duplicate content", () => {
    const s = makeStore();
    const base = "repeated region for hit-rate measurement";

    // Insert several duplicates; only first survives.
    for (let i = 0; i < 5; i++) {
      compactFull(s, SESS, [makeMsg("user", base)], 1);
    }
    compactFull(s, SESS, [makeMsg("user", "unique region for hit-rate measurement variant")], 1);

    // Mark the first as injected.
    const first = vectorSearch(s, SESS, base, 1)[0]?.checkpoint.checkpointId;
    if (first) vectorMarkInjected(s,SESS, first);

    const stats = vectorStats(s,SESS);
    assert.ok(stats.checkpointCount >= 1);
    assert.ok(
      stats.dedupHitRate > 0 || stats.checkpointCount === 1,
      "hit rate should be positive when there are multiple checkpoint",
    );
  });
});
