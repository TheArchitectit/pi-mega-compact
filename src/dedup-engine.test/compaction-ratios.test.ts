/**
 * compaction-ratios.test.ts — extractive summary size vs input across message counts.
 * Split out of dedup-engine.test.ts; describe bodies are unchanged.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compactSession } from "../engine.js";
import { extractiveSummarize } from "../extractive.js";
import { estimateSessionTokens } from "../tokens.js";
import { makeStore, buildConversation } from "./_helpers.js";
describe("Compaction Ratios", () => {
  const SESS = "sess_ratios";

  for (const n of [10, 50, 100, 200, 400]) {
    it(`${n} messages: extractive summary is smaller than input; strictly smaller when > 50`, () => {
      const s = makeStore();
      const messages = buildConversation(n, `feature work item ${n}`);
      const inputTokens = estimateSessionTokens(messages);

      const ext = extractiveSummarize(messages);
      const outputTokens = ext.tokenEstimate;

      console.log(
        `[ratio] ${n} messages: input=${inputTokens} output=${outputTokens} ratio=${
          inputTokens ? (outputTokens / inputTokens).toFixed(3) : "n/a"
        }`,
      );

      assert.ok(
        outputTokens <= inputTokens || inputTokens === 0,
        "output should not exceed input",
      );
      if (n > 50) {
        assert.ok(
          outputTokens < inputTokens,
          `expected output smaller than input for ${n} messages`,
        );
      }

      // Also run through compactSession and verify a checkpoint exists.
      const r = compactSession(
        { sessionId: SESS, messages, keepFrom: messages.length, useExtractiveSummary: true },
        s,
      );
      assert.equal(r.skipped, false);
      assert.ok(r.checkpointId);
      assert.ok(r.tokenEstimate <= inputTokens);
    });
  }
});
