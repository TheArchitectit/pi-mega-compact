/**
 * collapsible-detection.test.ts — Collapsible message detection rate benchmarks.
 * Split from ratio.bench.test.ts; test bodies are unchanged.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findSuperseded } from "../supersede.js";
import { autoCompactCheck, isChatty } from "../compact.js";
import { makeMsg } from "./_helpers.js";

describe("Collapsible Message Detection Rates", () => {
  it("isChatty correctly identifies short/filler messages", () => {
    const chatty = [
      "hello",
      "thanks",
      "great",
      "ok",
      "got it",
      "sure",
      "yes",
      "no",
      "understood",
      "sounds good",
    ];
    const substantial = [
      "I found a bug in the compression module. The gzip fallback doesn't trigger for payloads between 512 and 4096 bytes.",
      "Here's the implementation:\n```typescript\nfunction compress(data: Buffer): Buffer {\n  if (data.length < 512) return data;\n  return gzipSync(data, { level: 6 });\n}\n```",
      "The test suite covers 12 scenarios including edge cases for empty input, unicode content, and concurrent access patterns.",
    ];

    let chattCorrect = 0;
    let subCorrect = 0;

    for (const text of chatty) {
      if (isChatty(text)) chattCorrect++;
      else console.log(`    MISSED chatty: "${text}"`);
    }
    for (const text of substantial) {
      if (!isChatty(text)) subCorrect++;
      else console.log(`    FALSE POSITIVE: "${text.slice(0, 60)}..."`);
    }

    const chattRate = chattCorrect / chatty.length;
    const subRate = subCorrect / substantial.length;

    console.log(
      `    Chatty detection: ${(chattRate * 100).toFixed(0)}% (${chattCorrect}/${chatty.length})`,
    );
    console.log(
      `    Substantial detection: ${(subRate * 100).toFixed(0)}% (${subCorrect}/${substantial.length})`,
    );

    assert.ok(chattRate >= 0.7, "Should detect at least 70% of chatty messages");
    assert.ok(
      subRate >= 0.9,
      "Should preserve at least 90% of substantial messages",
    );
  });

  it("supersede detects file read obsolescence", () => {
    const messages = [
      makeMsg("user", "Show me the engine.ts file"),
      makeMsg("tool", "File content of src/engine.ts:\n" + "x".repeat(2000)),
      makeMsg("assistant", "Here's the engine.ts analysis..."),
      makeMsg("user", "Now fix the bug in it"),
      makeMsg("assistant", "I'll fix the bug in engine.ts"),
      makeMsg("user", "Show me the engine.ts file again"),
      makeMsg("tool", "File content of src/engine.ts:\n" + "y".repeat(2000)),
      makeMsg("assistant", "Here's the updated engine.ts..."),
    ];

    const superseded = findSuperseded(messages);

    assert.ok(
      superseded.length >= 1,
      `Should find at least 1 superseded read, found ${superseded.length}`,
    );

    assert.ok(superseded.includes(1), "First file read (index 1) should be superseded");
    assert.ok(!superseded.includes(6), "Second file read (index 6) should NOT be superseded");

    const collapseRate = superseded.length / 2;
    console.log(
      `    File reads: 2, Superseded: ${superseded.length}, Collapse rate: ${(collapseRate * 100).toFixed(0)}%`,
    );
  });

  it("compactCheck accurately reports token utilization", () => {
    const scenarios = [
      { tokens: 10000, threshold: 50000, expectedCompact: false },
      { tokens: 45000, threshold: 50000, expectedCompact: false },
      { tokens: 50000, threshold: 50000, expectedCompact: true },
      { tokens: 75000, threshold: 50000, expectedCompact: true },
      { tokens: 100000, threshold: 50000, expectedCompact: true },
    ];

    for (const { tokens, threshold, expectedCompact } of scenarios) {
      const result = autoCompactCheck(tokens, threshold);
      const expectedPct = Math.round((tokens / threshold) * 1000) / 10;

      assert.equal(
        result.shouldCompact,
        expectedCompact,
        `${tokens} tokens vs ${threshold} threshold`,
      );
      assert.equal(result.currentTokens, tokens);
      assert.equal(result.threshold, threshold);
      assert.equal(result.utilizationPct, expectedPct);

      console.log(
        `    ${tokens.toLocaleString()} / ${threshold.toLocaleString()} = ${result.utilizationPct}% -> compact: ${result.shouldCompact}`,
      );
    }
  });
});
