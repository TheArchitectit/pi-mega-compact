/**
 * store-stats.test.ts — Store stats & dedup metrics benchmarks.
 * Split from ratio.bench.test.ts; test bodies are unchanged.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { VectorStore, vectorStats, vectorWasInjected, vectorMarkInjected } from "../vectorStore.js";
import type { SearchHit } from "../vectorStore.js";
import { recall } from "../engine.js";
import { estimateBlockTokens } from "../tokens.js";
import { makeDir } from "./_helpers.js";

describe("Store Stats & Dedup Metrics", () => {
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

  it("stats track checkpoint count and dedup hit rate accurately", () => {
    const content = "Reusable checkpoint content for stats testing.";
    const session = "sess_stats";

    for (let i = 0; i < 3; i++) {
      store.add({
        sessionId: session,
        summary: content,
        regionText: content,
        keyDecisions: [],
        nextSteps: [],
        filesModified: [],
        tokenEstimate: estimateBlockTokens(content),
        timestamp: Date.now() + i,
      });
    }

    for (let i = 0; i < 2; i++) {
      const uniqueContent = `Unique checkpoint ${i} about different topics.`;
      store.add({
        sessionId: session,
        summary: uniqueContent,
        regionText: uniqueContent,
        keyDecisions: [],
        nextSteps: [],
        filesModified: [],
        tokenEstimate: estimateBlockTokens(uniqueContent),
        timestamp: Date.now() + 100 + i,
      });
    }

    const stats = vectorStats(store, session);

    console.log(`    Total added: 5`);
    console.log(`    Checkpoints stored: ${stats.checkpointCount}`);
    console.log(
      `    Dedup hit rate: ${(stats.dedupHitRate * 100).toFixed(0)}%`,
    );
    console.log(`    Injected count: ${stats.injectedCount}`);
    console.log(`    Total token estimate: ${stats.totalTokenEstimate}`);

    assert.ok(
      stats.checkpointCount <= 5,
      "Should not store more than added",
    );
    assert.ok(stats.checkpointCount >= 2, "Should store at least the unique ones");
  });

  it("injection tracking via store.markInjected/wasInjected", () => {
    const id1 = "chkpt_inject_a";
    const id2 = "chkpt_inject_b";
    const sid = "sess_inject";

    assert.equal(
      vectorWasInjected(store, sid, id1),
      false,
      "Should not be injected initially",
    );

    vectorMarkInjected(store, sid, id1);
    assert.equal(
      vectorWasInjected(store, sid, id1),
      true,
      "Should be injected after mark",
    );
    assert.equal(
      vectorWasInjected(store, sid, id2),
      false,
      "Different ID should not be affected",
    );

    vectorMarkInjected(store, sid, id2);
    assert.equal(
      vectorWasInjected(store, sid, id2),
      true,
      "Second ID should also be injected",
    );

    vectorMarkInjected(store, sid, id1);
    assert.equal(
      vectorWasInjected(store, sid, id1),
      true,
      "Re-mark should be idempotent",
    );
  });

  it("recall skips already-injected checkpoints", () => {
    const content = "Checkpoint for recall dedup sentinel test.";
    const sid = "sess_recall_dedup";

    store.add({
      sessionId: sid,
      summary: content,
      regionText: content,
      keyDecisions: ["Decision A"],
      nextSteps: [],
      filesModified: [],
      tokenEstimate: estimateBlockTokens(content),
      timestamp: Date.now(),
    });

    const results1 = recall(
      {
        sessionId: sid,
        query: "What was the checkpoint about?",
        limit: 3,
      },
      store,
    );

    assert.ok(
      results1.hits.length >= 1,
      "First recall should return checkpoint",
    );

    vectorMarkInjected(
      store,
      sid,
      results1.hits[0].checkpoint.checkpointId,
    );

    const results2 = recall(
      {
        sessionId: sid,
        query: "What was the checkpoint about?",
        limit: 3,
      },
      store,
    );

    const ids2 = results2.hits.map(
      (hit: SearchHit) => hit.checkpoint.checkpointId,
    );
    const injectedStillPresent = ids2.includes(results1.hits[0].checkpoint.checkpointId);

    console.log(
      `    First recall: ${results1.hits.length} hits, ${results1.newHits.length} new`,
    );
    console.log(
      `    After injection: ${results2.hits.length} hits, injected still present: ${injectedStillPresent}`,
    );
    const newIds = results2.newHits.map(
      (hit: SearchHit) => hit.checkpoint.checkpointId,
    );
    assert.ok(
      !newIds.includes(results1.hits[0].checkpoint.checkpointId),
      "newHits should exclude injected checkpoint",
    );
  });
});
