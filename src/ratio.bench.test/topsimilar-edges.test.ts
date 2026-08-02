/**
 * topsimilar-edges.test.ts — topSimilar edge cases & coverage benchmarks.
 * Split from ratio.bench.test.ts; test bodies are unchanged.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { VectorStore, vectorTopSimilar } from "../vectorStore.js";
import { estimateBlockTokens } from "../tokens.js";
import { makeDir } from "./_helpers.js";

describe("topSimilar Edge Cases & Coverage", () => {
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

  it("topSimilar respects n limit", () => {
    const sid = "sess_limit_all";
    for (let i = 0; i < 10; i++) {
      const content = `Checkpoint ${i} about topic ${i}.`;
      store.add({
        sessionId: sid,
        summary: content,
        regionText: content,
        keyDecisions: [],
        nextSteps: [],
        filesModified: [],
        tokenEstimate: estimateBlockTokens(content),
        timestamp: Date.now() + i,
      });
    }

    for (const n of [1, 3, 5, 10]) {
      const results = vectorTopSimilar(store, sid, n);
      assert.ok(
        results.length <= n,
        `topSimilar(${n}) returned ${results.length} results (should be <= ${n})`,
      );
      console.log(`    n=${n}: ${results.length} results`);
    }
  });

  it("topSimilar returns empty for empty session", () => {
    const results = vectorTopSimilar(store, "sess_unknown_empty", 5);
    assert.equal(results.length, 0, "Empty session should return no results");
  });
});
