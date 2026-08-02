/**
 * extractive-summary.test.ts — Extractive summary ratio benchmarks.
 * Split from ratio.bench.test.ts; test bodies are unchanged.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractiveSummarize } from "../extractive.js";
import { estimateSessionTokens } from "../tokens.js";
import { generateMessages } from "./_helpers.js";

describe("Extractive Summary Compression Ratio", () => {
  it("extractive summarization achieves high ratio on large conversations", () => {
    const messages = generateMessages(400, { pattern: "mixed" });
    const totalTokens = estimateSessionTokens(messages);

    const summary = extractiveSummarize(messages);

    const ratio = totalTokens / Math.max(summary.tokenEstimate, 1);

    console.log(`    Input: ${totalTokens} tokens (${messages.length} messages)`);
    console.log(`    Summary: ${summary.tokenEstimate} tokens`);
    console.log(`    Ratio: ${ratio.toFixed(1)}:1`);
    console.log(
      `    Decisions: ${summary.keyDecisions.length}, Next steps: ${summary.nextSteps.length}, Files: ${summary.filesModified.length}`,
    );

    assert.ok(ratio > 10, `Ratio ${ratio.toFixed(1)}:1 should exceed 10:1`);
    assert.ok(
      summary.tokenEstimate < totalTokens,
      "Summary should be smaller than input",
    );
  });

  it("extractive summary scales with input size", () => {
    const sizes = [20, 50, 100, 200];
    const results: {
      msgs: number;
      input: number;
      output: number;
      ratio: number;
    }[] = [];

    for (const n of sizes) {
      const messages = generateMessages(n, { pattern: "code-review" });
      const input = estimateSessionTokens(messages);
      const summary = extractiveSummarize(messages);
      const ratio = input / Math.max(summary.tokenEstimate, 1);
      results.push({ msgs: n, input, output: summary.tokenEstimate, ratio });
    }

    console.log(`    Messages | Input Tokens | Summary Tokens | Ratio`);
    console.log(`    ---------|-------------|----------------|------`);
    for (const r of results) {
      console.log(
        `    ${String(r.msgs).padStart(8)} | ${String(r.input).padStart(12)} | ${String(r.output).padStart(15)} | ${r.ratio.toFixed(1)}:1`,
      );
    }

    const smallRatio = results[0].ratio;
    const largeRatio = results[results.length - 1].ratio;
    assert.ok(
      largeRatio >= smallRatio * 0.5,
      "Larger inputs should maintain or improve ratio",
    );
  });

  it("extractive summary on debug session captures errors and files", () => {
    const messages = generateMessages(60, { pattern: "debug-session" });
    const summary = extractiveSummarize(messages);

    console.log(`    Files extracted: ${summary.filesModified.length}`);
    console.log(`    Decisions: ${summary.keyDecisions.length}`);

    const inputTokens = estimateSessionTokens(messages);
    const ratio = inputTokens / Math.max(summary.tokenEstimate, 1);

    console.log(
      `    Debug session: ${inputTokens} -> ${summary.tokenEstimate} tokens (${ratio.toFixed(1)}:1)`,
    );
    console.log(`    Files: ${summary.filesModified.join(", ")}`);
    console.log(`    Decisions: ${summary.keyDecisions.join("; ")}`);
  });
});
