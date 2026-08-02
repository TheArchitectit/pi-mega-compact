/**
 * token-estimation.test.ts — Token estimation accuracy benchmarks.
 * Split from ratio.bench.test.ts; test bodies are unchanged.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { estimateBlockTokens, estimateMessageTokens, estimateSessionTokens } from "../tokens.js";
import type { EngineMessage } from "../types.js";
import { generateMessages } from "./_helpers.js";

describe("Token Estimation Accuracy", () => {
  it("char/4 heuristic produces reasonable estimates", () => {
    const samples = [
      { text: "hello world", expectedApprox: 3 },
      { text: "x".repeat(100), expectedApprox: 25 },
      { text: "x".repeat(1000), expectedApprox: 250 },
      { text: "x".repeat(10000), expectedApprox: 2500 },
    ];

    for (const { text, expectedApprox } of samples) {
      const estimate = estimateBlockTokens(text);
      const ratio = estimate / expectedApprox;

      console.log(
        `    ${text.length} chars -> ${estimate} tokens (expected ~${expectedApprox}, ratio ${ratio.toFixed(2)})`,
      );

      assert.ok(
        ratio > 0.5 && ratio < 2.0,
        `Estimate ${estimate} should be within 2x of ${expectedApprox}`,
      );
    }
  });

  it("token estimation scales linearly with content length", () => {
    const lengths = [100, 500, 1000, 5000, 10000];
    const estimates: number[] = [];

    for (const len of lengths) {
      const text = "a".repeat(len);
      estimates.push(estimateBlockTokens(text));
    }

    const ratios = lengths.map(
      (len: number, i: number) => estimates[i] / len,
    );
    const avgRatio =
      ratios.reduce((a: number, b: number) => a + b, 0) / ratios.length;

    console.log(`    Length -> Tokens | Ratio`);
    console.log(`    ------   ------ | -----`);
    for (let i = 0; i < lengths.length; i++) {
      console.log(
        `    ${String(lengths[i]).padStart(6)} -> ${String(estimates[i]).padStart(6)} | ${ratios[i].toFixed(4)}`,
      );
    }
    console.log(
      `    Average ratio: ${avgRatio.toFixed(4)} (expected ~0.25)`,
    );

    for (const r of ratios) {
      assert.ok(
        r > 0.2 && r < 0.35,
        `Ratio ${r.toFixed(4)} should be near 0.25`,
      );
    }
  });

  it("message token estimation accounts for all fields", () => {
    const textOnly: EngineMessage = {
      role: "user",
      text: "hello world this is a test message",
    };
    const withTool: EngineMessage = {
      role: "tool",
      text: "running tool",
      toolName: "search",
      input: "query: compression ratios",
      output: "Found 5 results matching 'compression ratios'",
    };
    const withOutput: EngineMessage = {
      role: "assistant",
      text: "analysis complete",
      output: "x".repeat(2000),
    };

    const tokensText = estimateMessageTokens(textOnly);
    const tokensTool = estimateMessageTokens(withTool);
    const tokensOutput = estimateMessageTokens(withOutput);

    console.log(`    Text only: ${tokensText} tokens`);
    console.log(`    With tool fields: ${tokensTool} tokens`);
    console.log(`    With large output: ${tokensOutput} tokens`);

    assert.ok(tokensTool > tokensText, "Tool fields should add tokens");
    assert.ok(tokensOutput > tokensText, "Output field should add tokens");
  });

  it("session token estimation sums correctly", () => {
    const messages = generateMessages(50, { pattern: "mixed" });
    const sessionTokens = estimateSessionTokens(messages);

    let manualSum = 0;
    for (const msg of messages) {
      manualSum += estimateMessageTokens(msg);
    }

    assert.equal(
      sessionTokens,
      manualSum,
      "Session tokens should equal sum of message tokens",
    );
    console.log(
      `    50 messages: ${sessionTokens} tokens (manual sum: ${manualSum})`,
    );
    console.log(
      `    Average per message: ${(sessionTokens / messages.length).toFixed(0)} tokens`,
    );
  });
});
