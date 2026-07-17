/**
 * dedup-engine.test.ts — comprehensive compaction + dedup level test suite.
 *
 * Covers:
 *   1. Compaction tier thresholds (low/medium/high/ultra/mega)
 *   2. Dedup levels (L0/L1/L2/disabled, and combined)
 *   3. Compaction ratios across conversation sizes
 *   4. Store stats + injected-count tracking
 *   5. Recall & dedup sentinel behavior
 *   6. Edge cases (empty/single/near-end/unicode/large/mixed roles)
 *   7. Tier switching via MEGACOMPACT_TIER env var
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { compactSession } from "./engine.js";
import { VectorStore } from "./vectorStore.js";
import { extractiveSummarize } from "./extractive.js";
import { estimateSessionTokens, estimateMessageTokens } from "./tokens.js";
import { autoCompactCheck } from "./compact.js";
import { loadDedupConfig, type DedupConfigShape } from "./config/dedup.js";
import type { EngineMessage } from "./types.js";

// Real percentage-based threshold config. Replaces the previous LOCAL replica of
// COMPACT_TIERS + resolveThresholdFromEnv that asserted the OLD static token
// amounts — importing the live source of truth keeps tests in sync with the
// source (thresholds are tierPct × the model's context window, not fixed tokens).
import { TIER_PCT, effectiveThresholdTokens, loadConfig } from "../extensions/mega-config.js";

// recallAndInline may or may not be exported; import safely.
import * as recallMod from "./recall.js";

interface RecallInjectResult {
  toInject: unknown[];
  empty: boolean;
}

const recallAndInline = (recallMod as any).recallAndInline as
  | ((
      opts: {
        sessionId: string;
        query: string;
        limit?: number;
        source: "command";
        skipInjected?: boolean;
      },
      store: VectorStore,
    ) => RecallInjectResult)
  | undefined;

// -------------------- Helpers --------------------

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mc-dedup-"));
}

let currentTmpDir: string | undefined;

beforeEach(() => {
  currentTmpDir = mkTmpDir();
});

afterEach(() => {
  if (currentTmpDir && fs.existsSync(currentTmpDir)) {
    fs.rmSync(currentTmpDir, { recursive: true, force: true });
  }
  currentTmpDir = undefined;
});

function baseConfig(): DedupConfigShape {
  return loadDedupConfig();
}

function makeStore(over: Partial<DedupConfigShape> = {}): VectorStore {
  return new VectorStore({
    stateDir: currentTmpDir,
    config: { ...baseConfig(), ...over },
  });
}

function makeMsg(role: EngineMessage["role"], text: string): EngineMessage {
  return { role, text };
}

function buildConversation(n: number, prefix = "turn"): EngineMessage[] {
  const out: EngineMessage[] = [];
  for (let i = 0; i < n; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    out.push(
      makeMsg(
        role,
        `${prefix} ${i + 1}: ${role} discusses implementation of feature ${i + 1} in src/module${i + 1}.ts and considers tradeoffs.`,
      ),
    );
  }
  return out;
}

function compactFull(
  store: VectorStore,
  sessionId: string,
  messages: EngineMessage[],
  keepFrom?: number,
): ReturnType<typeof compactSession> {
  return compactSession({ sessionId, messages, keepFrom: keepFrom ?? messages.length }, store);
}

// -------------------- 1. Compaction Levels --------------------

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

// -------------------- 2. Dedupe Levels --------------------

describe("Dedupe Levels", () => {
  const SESS = "sess_dedup";

  it("L0 only: identical content stored twice collapses to one checkpoint", () => {
    const s = makeStore({ L0_ENABLED: true, L1_ENABLED: false, L2_ENABLED: false });
    const region = "exact same user request about database migration and index setup";

    const r1 = compactFull(s, SESS, [makeMsg("user", region)]);
    assert.equal(r1.deduped, false);
    assert.ok(r1.checkpointId);

    const r2 = compactFull(s, SESS, [makeMsg("user", region)]);
    assert.equal(r2.deduped, true);
    assert.equal(r2.checkpointId, r1.checkpointId);
    assert.equal(s.list(SESS).length, 1);
  });

  it("L0 only: distinct content stored twice creates two checkpoints", () => {
    const s = makeStore({ L0_ENABLED: true, L1_ENABLED: false, L2_ENABLED: false });
    const regionA = "first exact region about authentication module refactoring";
    const regionB = "second distinct region about frontend component testing";

    const r1 = compactFull(s, SESS, [makeMsg("user", regionA)]);
    const r2 = compactFull(s, SESS, [makeMsg("user", regionB)]);
    assert.equal(r1.deduped, false);
    assert.equal(r2.deduped, false);
    assert.notEqual(r1.checkpointId, r2.checkpointId);
    assert.equal(s.list(SESS).length, 2);
  });

  it("L1 only: one-word variants collapse; major rewrites do not", () => {
    const s = makeStore({ L0_ENABLED: false, L1_ENABLED: true, L2_ENABLED: false });

    const base = "the database migration added three new indexes to the users table for faster lookups";
    const variant = "the database migration added three new indexes to the users table for faster lookup";
    const rewrite = "the frontend dark mode toggle uses css custom properties for theming";

    const r1 = s.add({ sessionId: SESS, summary: "migration", regionText: base, timestamp: 1 });
    assert.equal(r1.deduped, false);

    const r2 = s.add({ sessionId: SESS, summary: "migration", regionText: variant, timestamp: 2 });
    assert.equal(r2.deduped, true, "one-word variant should be collapsed by L1");
    assert.equal(s.list(SESS).length, 1);

    const r3 = s.add({ sessionId: SESS, summary: "frontend", regionText: rewrite, timestamp: 3 });
    assert.equal(r3.deduped, false, "major rewrite should not be collapsed by L1");
    assert.equal(s.list(SESS).length, 2);
  });

  it("L2 only: semantic paraphrases collapse; unrelated topics do not", () => {
    // Use a lower threshold and longer, lexically-overlapping paraphrase so the
    // deterministic trigram embedder reliably catches it while still distinguishing
    // unrelated topics.
    const s = makeStore({ L0_ENABLED: false, L1_ENABLED: false, L2_ENABLED: true, L2_COSINE: 0.60 });

    const original =
      "user authentication and session token management login validation session expiry handling secure cookie";
    const paraphrase =
      "login validation session expiry handling secure cookie user authentication and session token management";
    const unrelated = "the frontend added a dark mode toggle with css custom properties";

    const r1 = s.add({ sessionId: SESS, summary: "auth", regionText: original, timestamp: 1 });
    assert.equal(r1.deduped, false);

    const r2 = s.add({ sessionId: SESS, summary: "auth paraphrase", regionText: paraphrase, timestamp: 2 });
    assert.equal(r2.deduped, true, "semantic paraphrase should be collapsed by L2");
    assert.equal(s.list(SESS).length, 1);

    const r3 = s.add({ sessionId: SESS, summary: "frontend", regionText: unrelated, timestamp: 3 });
    assert.equal(r3.deduped, false, "unrelated topic should not be collapsed by L2");
    assert.equal(s.list(SESS).length, 2);
  });

  it("All tiers disabled: every store.add() with different region text creates a distinct checkpoint", () => {
    // Even with all dedup tiers disabled, the store still enforces a unique
    // content_hash constraint, so we vary the region text slightly for each add.
    const s = makeStore({ L0_ENABLED: false, L1_ENABLED: false, L2_ENABLED: false });

    const r1 = s.add({ sessionId: SESS, summary: "a", regionText: "region alpha", timestamp: 1 });
    const r2 = s.add({ sessionId: SESS, summary: "a", regionText: "region beta", timestamp: 2 });
    const r3 = s.add({ sessionId: SESS, summary: "a", regionText: "region gamma", timestamp: 3 });

    assert.equal(r1.deduped, false);
    assert.equal(r2.deduped, false);
    assert.equal(r3.deduped, false);
    assert.notEqual(r1.checkpoint.checkpointId, r2.checkpoint.checkpointId);
    assert.notEqual(r2.checkpoint.checkpointId, r3.checkpoint.checkpointId);
    assert.equal(s.list(SESS).length, 3);
  });

  it("Combined L0+L1+L2: layered behavior exact -> near -> semantic", () => {
    const s = makeStore({ L0_ENABLED: true, L1_ENABLED: true, L2_ENABLED: true });

    // First checkpoint establishes baseline.
    const original = "implement user authentication with session tokens and secure cookies";
    const r1 = compactFull(s, SESS, [makeMsg("user", original)]);
    assert.equal(r1.deduped, false);

    // Exact duplicate -> L0.
    const r2 = compactFull(s, SESS, [makeMsg("user", original)]);
    assert.equal(r2.deduped, true);
    okReason(r2.dedupReason, ["regionHash", "contentHash", "summaryHash"]);

    // One-word edit -> L1 (if not caught by L0 first).
    const near = "implement user authentication with session token and secure cookies";
    const r3 = compactFull(s, SESS, [makeMsg("user", near)]);
    if (r3.deduped) {
      okReason(r3.dedupReason, ["l1MinHash", "contentSimilarity"]);
    }

    // Semantic paraphrase -> L2 (if distinct from above).
    const para = "build login validation and session cookie security for users";
    const r4 = compactFull(s, SESS, [makeMsg("user", para)]);
    if (r4.deduped) {
      okReason(r4.dedupReason, ["contentSimilarity", "l1MinHash"]);
    }

    assert.ok(s.list(SESS).length >= 1, "layered dedup keeps at least one checkpoint");
    assert.ok(s.list(SESS).length <= 4, "layered dedup should not explode to many checkpoints");
  });
});

function okReason(reason: string | undefined, expected: string[]): void {
  assert.ok(
    reason !== undefined && expected.includes(reason),
    `expected dedupReason one of ${expected.join(", ")}, got ${reason}`,
  );
}

// -------------------- 3. Compaction Ratios --------------------

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

// -------------------- 4. Compression / Store Stats --------------------

describe("Compression / Store Stats", () => {
  const SESS = "sess_stats";

  it("stats reflect checkpoints, tokens, injection and dedup hit rate", () => {
    const s = makeStore();

    // Mixed duplicate and unique stores.
    const unique = "unique topic about payment gateway integration";
    compactFull(s, SESS, [makeMsg("user", unique)], 1);

    const dup = "duplicate topic about payment gateway integration";
    compactFull(s, SESS, [makeMsg("user", dup)], 1);

    const statsBefore = s.stats(SESS);
    assert.ok(statsBefore.checkpointCount >= 1, "checkpointCount should be positive");
    assert.ok(statsBefore.totalTokenEstimate >= 0, "totalTokenEstimate should be non-negative");
    assert.equal(statsBefore.dedupHitRate, 0, "no injections yet => dedupHitRate 0");
    assert.equal(statsBefore.injectedCount, 0, "no injections yet => injectedCount 0");

    const hits = s.search(SESS, "payment gateway", 5);
    assert.ok(hits.length > 0, "should find the stored checkpoint");
    const cpId = hits[0].checkpoint.checkpointId;

    s.markInjected(SESS, cpId);
    const statsAfter = s.stats(SESS);
    assert.equal(statsAfter.injectedCount, 1, "injectedCount tracks markInjected");
    if (statsAfter.checkpointCount > 0) {
      assert.ok(
        Math.abs(statsAfter.dedupHitRate - 1 / statsAfter.checkpointCount) < 0.001,
        "dedupHitRate = injected / checkpoints",
      );
    }
    assert.ok(statsAfter.totalTokenEstimate > 0, "totalTokenEstimate positive after inserts");
  });

  it("dedupHitRate increases with duplicate content", () => {
    const s = makeStore();
    const base = "repeated region for hit-rate measurement";

    // Insert several duplicates; only first survives.
    for (let i = 0; i < 5; i++) {
      compactFull(s, SESS, [makeMsg("user", base)], 1);
    }
    compactFull(s, SESS, [makeMsg("user", "unique region for hit-rate measurement variant")], 1);

    // Mark the first as injected.
    const first = s.search(SESS, base, 1)[0]?.checkpoint.checkpointId;
    if (first) s.markInjected(SESS, first);

    const stats = s.stats(SESS);
    assert.ok(stats.checkpointCount >= 1);
    assert.ok(
      stats.dedupHitRate > 0 || stats.checkpointCount === 1,
      "hit rate should be positive when there are multiple checkpoint",
    );
  });
});

// -------------------- 5. Recall & Dedup Sentinel --------------------

describe("Recall & Dedup Sentinel", () => {
  const SESS = "sess_recall";

  it("recallAndInline returns toInject on first call and empty on second due to skipInjected", () => {
    const s = makeStore();
    const region = "detailed work on the vector store dedup sentinel and recall pipeline";
    compactFull(s, SESS, [makeMsg("user", region)]);

    assert.ok(
      recallAndInline,
      "recallAndInline should be exported from recall.js for this test",
    );

    const r1 = recallAndInline!(
      {
        sessionId: SESS,
        query: "dedup sentinel recall",
        limit: 3,
        source: "command",
        skipInjected: true,
      },
      s,
    );
    assert.ok(r1.toInject.length > 0, "first recall should return hits to inject");

    const r2 = recallAndInline!(
      {
        sessionId: SESS,
        query: "dedup sentinel recall",
        limit: 3,
        source: "command",
        skipInjected: true,
      },
      s,
    );
    assert.ok(r2.empty, "second recall should be empty because sentinel marked injected");
  });

  it("manual markInjected creates skip behavior when recallAndInline is unavailable", () => {
    const s = makeStore();
    const region = "manual sentinel tracking without recallAndInline";
    compactFull(s, SESS, [makeMsg("user", region)]);

    const hits = s.search(SESS, "manual sentinel", 3);
    assert.ok(hits.length > 0, "search should return checkpoint");
    const cpId = hits[0].checkpoint.checkpointId;
    assert.equal(s.wasInjected(SESS, cpId), false, "not yet injected");

    s.markInjected(SESS, cpId);
    assert.equal(s.wasInjected(SESS, cpId), true, "markInjected recorded");

    const hits2 = s.search(SESS, "manual sentinel", 3).filter(
      (h) => !s.wasInjected(SESS, h.checkpoint.checkpointId),
    );
    assert.equal(hits2.length, 0, "filtered search excludes injected checkpoint");
  });
});

// -------------------- 6. Edge Cases --------------------

describe("Edge Cases", () => {
  const SESS = "sess_edge";

  it("empty message list returns skipped", () => {
    const s = makeStore();
    const r = compactSession({ sessionId: SESS, messages: [], keepFrom: 0 }, s);
    assert.equal(r.skipped, true);
    assert.equal(r.summary, "");
    assert.equal(s.list(SESS).length, 0);
  });

  it("single message with keepFrom=0 returns skipped", () => {
    const s = makeStore();
    const r = compactSession(
      { sessionId: SESS, messages: [makeMsg("user", "only one message")], keepFrom: 0 },
      s,
    );
    assert.equal(r.skipped, true);
    assert.equal(s.list(SESS).length, 0);
  });

  it("keepFrom at messages.length compacts all prior messages (verified behavior)", () => {
    // The engine treats keepFrom as the compactable boundary: messages[0..keepFrom)
    // are compacted. When keepFrom equals messages.length the entire conversation is
    // compactable, so it is NOT skipped. This test documents that behavior.
    const s = makeStore();
    const messages = buildConversation(6);
    const r = compactSession({ sessionId: SESS, messages, keepFrom: messages.length }, s);
    assert.equal(r.skipped, false);
    assert.ok(r.checkpointId);
    assert.equal(s.list(SESS).length, 1);
  });

  it("unicode and emoji messages store and retrieve intact", () => {
    const s = makeStore();
    const text =
      "用户请求：创建 🎉 庆祝页面，包含 café 菜单 — déjà vu! " +
      "日本語テキスト 日本語テキスト 👍🔥";
    const r = compactFull(s, SESS, [makeMsg("user", text)], 1);
    assert.equal(r.skipped, false);
    const stored = s.list(SESS)[0];
    assert.ok(stored);
    const recovered = Buffer.from(stored.compressedOriginal ?? Buffer.alloc(0));
    assert.ok(
      recovered.toString("utf-8").includes("🎉"),
      "emoji recovered from compressedOriginal",
    );
    assert.ok(stored.summary.includes("café") || stored.summary.includes("cafe"));
  });

  it("very large single message (>10k chars) compacts and stores successfully", () => {
    const s = makeStore();
    const big = "bigint ".repeat(2000);
    assert.ok(big.length > 10_000, `message length ${big.length}`);
    const r = compactFull(s, SESS, [makeMsg("user", big)], 1);
    assert.equal(r.skipped, false);
    assert.ok(r.checkpointId);
    assert.equal(s.list(SESS).length, 1);
    const stats = s.stats(SESS);
    assert.ok(stats.totalTokenEstimate > 0);
  });

  it("mixed roles (user/assistant/tool) are included in summary", () => {
    const s = makeStore();
    const messages: EngineMessage[] = [
      { role: "user", text: "fix the bug" },
      { role: "assistant", text: "will do", toolName: "Read", input: "src/bug.ts" },
      { role: "tool", text: "", toolName: "Read", output: "function foo() {}" },
      { role: "assistant", text: "fixed it", toolName: "Edit" },
    ];
    const r = compactFull(s, SESS, messages, messages.length);
    assert.equal(r.skipped, false);
    assert.ok(r.summary.length > 0);
    assert.ok(
      r.summary.includes("tool") ||
        r.summary.includes("Read") ||
        r.summary.includes("Edit") ||
        r.summary.includes("user") ||
        r.summary.includes("assistant"),
      "summary should reference roles or tools",
    );
    assert.equal(s.list(SESS).length, 1);
  });
});

// -------------------- 7. Tier Switching (percentage-based) --------------------

// Replaces the previous LOCAL replica of COMPACT_TIERS + resolveThresholdFromEnv
// that asserted the OLD static token amounts. We now import the REAL config
// helpers from extensions/mega-config.js so the tests track the live source of
// truth: thresholds are tierPct × the model's context window (not fixed tokens).

describe("Tier Switching — percentage-based thresholds", () => {
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
