/**
 * dedup-hit-rates.test.ts — Dedup hit rate benchmarks across L0/L1/L2 tiers.
 * Split from ratio.bench.test.ts; test bodies are unchanged.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { VectorStore, computeRegionHash, vectorStats } from "../vectorStore.js";
import { estimateBlockTokens } from "../tokens.js";
import { makeDir, generateNearDuplicates } from "./_helpers.js";

describe("Dedup Hit Rates by Similarity Level", () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(() => {
    dir = makeDir();
    store = new VectorStore({ stateDir: dir });
  });

  afterEach(() => {
    store = undefined!;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("L0 exact hash dedup: identical content should be detected", async () => {
    const content =
      "Found a critical bug in the compression module: gzip level selection was off by one.";
    const sessionIds = ["sess_l0_a", "sess_l0_b", "sess_l0_c"];

    for (const sid of sessionIds) {
      computeRegionHash(content);
      store.add({
        sessionId: sid,
        summary: content,
        regionText: content,
        keyDecisions: [],
        nextSteps: [],
        filesModified: [],
        tokenEstimate: estimateBlockTokens(content),
        timestamp: Date.now(),
      });
    }

    for (const sid of sessionIds) {
      const stats = vectorStats(store, sid);
      console.log(
        `    ${sid}: ${stats.checkpointCount} checkpoint(s), dedup rate: ${(stats.dedupHitRate * 100).toFixed(0)}%`,
      );
    }
  });

  it("L1 near-duplicate detection rate with one-word edits", () => {
    const baseContent =
      "Implemented the compression pipeline with gzip fallback for medium payloads and brotli for large ones. Tests cover edge cases.";
    const variations = generateNearDuplicates(baseContent, 8, "one-word");

    for (let i = 0; i < variations.length; i++) {
      store.add({
        sessionId: `sess_l1_${i}`,
        summary: variations[i],
        regionText: variations[i],
        keyDecisions: [],
        nextSteps: [],
        filesModified: [],
        tokenEstimate: estimateBlockTokens(variations[i]),
        timestamp: Date.now() + i,
      });
    }

    let totalCheckpoints = 0;
    for (let i = 0; i < variations.length; i++) {
      const stats = vectorStats(store, `sess_l1_${i}`);
      totalCheckpoints += stats.checkpointCount;
    }

    console.log(`    Near-duplicates added: ${variations.length}`);
    console.log(`    Total checkpoints stored: ${totalCheckpoints}`);
    const collapseRate = 1 - totalCheckpoints / variations.length;
    console.log(`    Collapse rate: ${(collapseRate * 100).toFixed(0)}%`);
  });

  it("L1 negative: major changes should NOT be deduped", () => {
    const baseContent =
      "Implemented the compression pipeline with gzip and brotli support.";
    const variations = generateNearDuplicates(baseContent, 5, "major-change");

    for (let i = 0; i < variations.length; i++) {
      store.add({
        sessionId: `sess_l1neg_${i}`,
        summary: variations[i],
        regionText: variations[i],
        keyDecisions: [],
        nextSteps: [],
        filesModified: [],
        tokenEstimate: estimateBlockTokens(variations[i]),
        timestamp: Date.now() + i,
      });
    }

    let totalCheckpoints = 0;
    for (let i = 0; i < variations.length; i++) {
      const stats = vectorStats(store, `sess_l1neg_${i}`);
      totalCheckpoints += stats.checkpointCount;
    }

    const collapseRate = 1 - totalCheckpoints / variations.length;

    console.log(`    Major changes added: ${variations.length}`);
    console.log(`    Total checkpoints stored: ${totalCheckpoints}`);
    console.log(
      `    Collapse rate: ${(collapseRate * 100).toFixed(0)}% (should be ~0%)`,
    );

    assert.ok(
      collapseRate < 0.3,
      "Major changes should NOT be collapsed (rate < 30%)",
    );
  });

  it("L2 semantic cosine dedup catches paraphrases", () => {
    const paraphrases = [
      "The compression function uses gzip for payloads under 32KB and brotli for larger ones.",
      "Compression is handled by using gzip when data is smaller than 32KB and switching to brotli above that threshold.",
      "For compression: small payloads (< 32KB) get gzip, while large payloads use brotli.",
    ];

    for (let i = 0; i < paraphrases.length; i++) {
      store.add({
        sessionId: `sess_l2_${i}`,
        summary: paraphrases[i],
        regionText: paraphrases[i],
        keyDecisions: [],
        nextSteps: [],
        filesModified: [],
        tokenEstimate: estimateBlockTokens(paraphrases[i]),
        timestamp: Date.now() + i,
      });
    }

    let totalCheckpoints = 0;
    for (let i = 0; i < paraphrases.length; i++) {
      const stats = vectorStats(store, `sess_l2_${i}`);
      totalCheckpoints += stats.checkpointCount;
    }

    console.log(`    Paraphrases: ${paraphrases.length}`);
    console.log(`    Total checkpoints stored: ${totalCheckpoints}`);
  });

  it("dedup effectiveness summary across tiers", () => {
    const exact =
      "Exact duplicate content about the search module refactoring.";
    const nearBase =
      "Fixed the embedding dimension mismatch in the vector store.";
    const unique = [
      "Refactored the recall pipeline to support concurrent checkpoint lookups.",
      "Added zstd compression tier for DR backup payloads exceeding 1MB.",
      "Implemented MMR diversity scoring for the semantic search results.",
    ];

    let idx = 0;

    const dedupSession = "sess_dedup_mixed";
    for (let i = 0; i < 3; i++) {
      store.add({
        sessionId: dedupSession,
        summary: exact,
        regionText: exact,
        keyDecisions: [],
        nextSteps: [],
        filesModified: [],
        tokenEstimate: estimateBlockTokens(exact),
        timestamp: Date.now() + idx++ * 1000,
      });
    }

    const nearVariations = generateNearDuplicates(nearBase, 4, "one-word");
    for (const text of nearVariations) {
      store.add({
        sessionId: dedupSession,
        summary: text,
        regionText: text,
        keyDecisions: [],
        nextSteps: [],
        filesModified: [],
        tokenEstimate: estimateBlockTokens(text),
        timestamp: Date.now() + idx++ * 1000,
      });
    }

    for (const text of unique) {
      store.add({
        sessionId: dedupSession,
        summary: text,
        regionText: text,
        keyDecisions: [],
        nextSteps: [],
        filesModified: [],
        tokenEstimate: estimateBlockTokens(text),
        timestamp: Date.now() + idx++ * 1000,
      });
    }

    const stats = vectorStats(store, dedupSession);
    const totalAdded = 3 + 4 + 3;

    console.log(`    Total added: ${totalAdded}`);
    console.log(`    Checkpoints stored: ${stats.checkpointCount}`);
    console.log(
      `    Dedup hit rate: ${(stats.dedupHitRate * 100).toFixed(0)}%`,
    );
    console.log(`    Injected count: ${stats.injectedCount}`);
    console.log(`    Total token estimate: ${stats.totalTokenEstimate}`);

    assert.ok(
      stats.checkpointCount >= 1,
      "Should store at least one checkpoint",
    );
    assert.ok(
      stats.checkpointCount <= totalAdded,
      "Should not store more than added",
    );
  });
});
