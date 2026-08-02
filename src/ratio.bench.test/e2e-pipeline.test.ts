/**
 * e2e-pipeline.test.ts — End-to-end pipeline compression ratio benchmarks.
 * Split from ratio.bench.test.ts; test bodies are unchanged.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { VectorStore } from "../vectorStore.js";
import { compactSession } from "../engine.js";
import { extractiveSummarize } from "../extractive.js";
import { estimateSessionTokens } from "../tokens.js";
import { makeDir, generateRealisticConversation, generateMessages } from "./_helpers.js";

describe("End-to-End Pipeline Compression", () => {
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

  it("realistic conversation: 50 turns -> checkpoint with measurable compression", () => {
    const messages = generateRealisticConversation(50);
    const inputTokens = estimateSessionTokens(messages);

    const result = compactSession(
      {
        sessionId: "sess_ratio_50",
        messages,
      },
      store,
    );

    const ratio = inputTokens / Math.max(result.tokenEstimate, 1);

    console.log(`    Input: ${inputTokens} tokens (${messages.length} messages)`);
    console.log(
      `    Checkpoint ID: ${result.checkpointId ?? "none (skipped)"}`,
    );
    console.log(`    Deduped: ${result.deduped}, Skipped: ${result.skipped}`);
    console.log(`    Checkpoint tokens: ${result.tokenEstimate}`);
    console.log(`    Compression ratio: ${ratio.toFixed(1)}:1`);
    console.log(
      `    Summary preview: ${result.summary.slice(0, 200)}...`,
    );
    console.log(`    Compacted from: ${result.compactedFrom} messages`);

    assert.ok(ratio >= 1, "Pipeline should compress (ratio >= 1:1)");
    assert.ok(result.summary.length > 0, "Should produce summary");
  });

  it("realistic conversation: 200 turns -> checkpoint compression", () => {
    const messages = generateRealisticConversation(200);
    const inputTokens = estimateSessionTokens(messages);

    const result = compactSession(
      {
        sessionId: "sess_ratio_200",
        messages,
      },
      store,
    );

    const ratio = inputTokens / Math.max(result.tokenEstimate, 1);

    console.log(`    Input: ${inputTokens} tokens (${messages.length} messages)`);
    console.log(`    Checkpoint tokens: ${result.tokenEstimate}`);
    console.log(`    Compression ratio: ${ratio.toFixed(1)}:1`);
    console.log(`    Deduped: ${result.deduped}, Skipped: ${result.skipped}`);

    assert.ok(ratio >= 1, "Larger conversation should compress");
  });

  it("debug session: stack traces compress well", () => {
    const messages = generateMessages(100, { pattern: "debug-session" });
    const inputTokens = estimateSessionTokens(messages);

    const result = compactSession(
      {
        sessionId: "sess_ratio_debug",
        messages,
      },
      store,
    );

    const ratio = inputTokens / Math.max(result.tokenEstimate, 1);

    console.log(
      `    Debug session: ${inputTokens} -> ${result.tokenEstimate} tokens (${ratio.toFixed(1)}:1)`,
    );
    console.log(`    Compacted from: ${result.compactedFrom} messages`);

    assert.ok(ratio >= 1, "Debug sessions should compress");
  });

  it("code review: code blocks compress well", () => {
    const messages = generateMessages(80, { pattern: "code-review" });
    const inputTokens = estimateSessionTokens(messages);

    const result = compactSession(
      {
        sessionId: "sess_ratio_review",
        messages,
      },
      store,
    );

    const ratio = inputTokens / Math.max(result.tokenEstimate, 1);

    console.log(
      `    Code review: ${inputTokens} -> ${result.tokenEstimate} tokens (${ratio.toFixed(1)}:1)`,
    );
    console.log(`    Deduped: ${result.deduped}`);

    assert.ok(ratio >= 1, "Code reviews should compress");
  });

  it("extractive summary ratio on realistic data", () => {
    const messages = generateRealisticConversation(100);
    const inputTokens = estimateSessionTokens(messages);
    const summary = extractiveSummarize(messages);

    const ratio = inputTokens / Math.max(summary.tokenEstimate, 1);

    console.log(
      `    Extractive: ${inputTokens} -> ${summary.tokenEstimate} tokens (${ratio.toFixed(1)}:1)`,
    );
    console.log(`    Decisions: ${summary.keyDecisions.length}`);
    console.log(`    Files: ${summary.filesModified.length}`);
    console.log(`    Next steps: ${summary.nextSteps.length}`);

    assert.ok(
      ratio > 5,
      "Extractive should achieve at least 5:1 on realistic data",
    );
  });
});
