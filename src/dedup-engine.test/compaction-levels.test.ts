/**
 * compaction-levels.test.ts — tier threshold behavior (low/medium/high/ultra/mega).
 * Split out of dedup-engine.test.ts; describe bodies are unchanged.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { autoCompactCheck } from "../compact.js";
import { estimateSessionTokens, estimateMessageTokens } from "../tokens.js";
import { buildConversation } from "./_helpers.js";
describe("Compaction Levels (Tier Behavior)", () => {
  const TIER_CASES: Array<[string, number]> = [
    ["low", 50_000],
    ["medium", 100_000],
    ["high", 200_000],
    ["ultra", 1_000_000],
    ["mega", 10_000_000],
  ];

  for (const [tier, threshold] of TIER_CASES) {
    it(`tier "${tier}" (${threshold.toLocaleString()} threshold) triggers only when tokens exceed threshold`, () => {
      // One token below threshold => should not compact.
      const under = autoCompactCheck(threshold - 1, threshold);
      assert.equal(under.shouldCompact, false, "one token below threshold should not trigger");
      assert.equal(under.threshold, threshold);

      // At threshold => should compact.
      const at = autoCompactCheck(threshold, threshold);
      assert.equal(at.shouldCompact, true, "at threshold should trigger");

      // One token above threshold => should compact.
      const over = autoCompactCheck(threshold + 1, threshold);
      assert.equal(over.shouldCompact, true, "one token above threshold should trigger");

      // Generate deterministic conversation of known token size.
      const tokensPerMsg = estimateMessageTokens({
        text: "deterministic sample message of moderate length for threshold testing.",
      });
      assert.ok(tokensPerMsg > 0);
      const needed = Math.ceil((threshold + tokensPerMsg) / tokensPerMsg);
      const messages = buildConversation(needed);
      const estimate = estimateSessionTokens(messages);
      assert.ok(
        estimate >= threshold,
        `expected estimate ${estimate} >= threshold ${threshold}`,
      );
      const longCheck = autoCompactCheck(estimate, threshold);
      assert.equal(longCheck.shouldCompact, true);

      // Smaller conversation should not trigger. Derive the average per-message
      // cost from the large conversation we already tokenized, then leave margin below threshold.
      const avgTokensPerMsg = estimate / messages.length;
      const smallCount = Math.max(1, Math.floor((threshold * 0.95) / avgTokensPerMsg) - 5);
      const smallMessages = buildConversation(smallCount);
      const smallEstimate = estimateSessionTokens(smallMessages);
      assert.ok(
        smallEstimate < threshold,
        `expected small estimate ${smallEstimate} < threshold ${threshold}`,
      );
      const smallCheck = autoCompactCheck(smallEstimate, threshold);
      assert.equal(smallCheck.shouldCompact, false, "small conversation should not trigger tier");
    });
  }
});
