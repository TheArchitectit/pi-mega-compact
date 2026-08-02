/**
 * tier-switching.test.ts — percentage-based tier thresholds + effectiveThresholdTokens.
 * Split out of dedup-engine.test.ts; describe bodies are unchanged.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TIER_PCT, effectiveThresholdTokens, loadConfig } from "../../extensions/mega-config.js";describe("Tier Switching — percentage-based thresholds", () => {
  // Documented tierPct fractions (single source of truth in mega-config.ts).
  it("each named tier carries the documented tierPct fraction", () => {
    assert.equal(TIER_PCT.low, 0.5);
    assert.equal(TIER_PCT.medium, 0.6);
    assert.equal(TIER_PCT.high, 0.7);
    assert.equal(TIER_PCT.ultra, 0.7);
    assert.equal(TIER_PCT.mega, 0.75);
  });

  // Boot fallback threshold (sane gate before the first context event supplies a
  // window): round(tierPct × 200_000). Resolved through the REAL loadConfig().
  it("MEGACOMPACT_TIER env resolves to the boot fallback threshold via real config", () => {
    const tiers: Array<[keyof typeof TIER_PCT, number]> = [
      ["low", 100_000], // 0.50 × 200_000
      ["medium", 120_000], // 0.60 × 200_000
      ["high", 140_000], // 0.70 × 200_000
      ["ultra", 140_000], // 0.70 × 200_000
      ["mega", 150_000], // 0.75 × 200_000
    ];
    for (const [tier, expectedBoot] of tiers) {
      const original = process.env.MEGACOMPACT_TIER;
      delete process.env.MEGACOMPACT_THRESHOLD_TOKENS;
      process.env.MEGACOMPACT_TIER = tier;
      try {
        const cfg = loadConfig();
        assert.equal(cfg.tier, tier, `tier ${tier} should resolve`);
        assert.equal(cfg.tierPct, TIER_PCT[tier], `tier ${tier} tierPct`);
        assert.equal(
          cfg.thresholdTokens,
          expectedBoot,
          `tier ${tier} boot fallback threshold should be ${expectedBoot}`,
        );
      } finally {
        if (original === undefined) delete process.env.MEGACOMPACT_TIER;
        else process.env.MEGACOMPACT_TIER = original;
      }
    }
  });

  it("explicit MEGACOMPACT_THRESHOLD_TOKENS overrides tier (custom stays absolute)", () => {
    const originalTier = process.env.MEGACOMPACT_TIER;
    const originalThreshold = process.env.MEGACOMPACT_THRESHOLD_TOKENS;
    delete process.env.MEGACOMPACT_TIER;
    process.env.MEGACOMPACT_THRESHOLD_TOKENS = "123456";
    try {
      const cfg = loadConfig();
      assert.equal(cfg.tier, "custom", "explicit token threshold → custom tier");
      assert.equal(cfg.tierPct, null, "custom tier has no tierPct (stays absolute)");
      assert.equal(cfg.thresholdTokens, 123_456, "explicit token threshold should win");
    } finally {
      if (originalTier === undefined) delete process.env.MEGACOMPACT_TIER;
      else process.env.MEGACOMPACT_TIER = originalTier;
      if (originalThreshold === undefined) delete process.env.MEGACOMPACT_THRESHOLD_TOKENS;
      else process.env.MEGACOMPACT_THRESHOLD_TOKENS = originalThreshold;
    }
  });
});

describe("effectiveThresholdTokens — tierPct × model window", () => {
  // The real compaction fire point. Tiered → scales with the window so it always
  // fires BELOW pi's native ~80% auto-compact for any model size. Custom (null
  // tierPct) → absolute explicitThreshold, never percent-scaled.

  it("scales tierPct × window for a 200k model", () => {
    assert.equal(
      effectiveThresholdTokens({ tierPct: TIER_PCT.low, fallbackThreshold: 100_000, window: 200_000 }),
      100_000,
    );
    assert.equal(
      effectiveThresholdTokens({ tierPct: TIER_PCT.mega, fallbackThreshold: 150_000, window: 200_000 }),
      150_000,
    );
  });

  it("scales tierPct × window for a 1M model", () => {
    assert.equal(
      effectiveThresholdTokens({ tierPct: TIER_PCT.low, fallbackThreshold: 500_000, window: 1_000_000 }),
      500_000,
    );
    assert.equal(
      effectiveThresholdTokens({ tierPct: TIER_PCT.mega, fallbackThreshold: 750_000, window: 1_000_000 }),
      750_000,
    );
  });

  it("falls back to the boot threshold when the window is 0/unknown", () => {
    assert.equal(
      effectiveThresholdTokens({ tierPct: TIER_PCT.mega, fallbackThreshold: 150_000, window: 0 }),
      150_000,
    );
    assert.equal(
      effectiveThresholdTokens({ tierPct: TIER_PCT.low, fallbackThreshold: 100_000, window: -5 }),
      100_000,
    );
  });

  it("custom (tierPct null) stays an absolute threshold regardless of window", () => {
    assert.equal(
      effectiveThresholdTokens({ tierPct: null, fallbackThreshold: 100_000, window: 200_000, explicitThreshold: 123456 }),
      123456,
      "explicit absolute wins (200k window)",
    );
    assert.equal(
      effectiveThresholdTokens({ tierPct: null, fallbackThreshold: 100_000, window: 1_000_000, explicitThreshold: 123456 }),
      123456,
      "explicit absolute wins (1M window)",
    );
    assert.equal(
      effectiveThresholdTokens({ tierPct: null, fallbackThreshold: 100_000, window: 200_000 }),
      100_000,
      "no explicit → boot fallback",
    );
  });
});
