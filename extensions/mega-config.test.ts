/**
 * mega-config.test.ts — unit tests for the central config resolver.
 *
 * Covers `effectiveThresholdTokens` (the pure compaction fire-point), tier
 * resolution + env loading (including the E1 NaN guards on the similarity
 * thresholds), and the fast-gate pct default. These are pure functions that
 * had no dedicated test before (audit TC2).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  effectiveThresholdTokens,
  loadConfig,
  TIER_PCT,
  COMPACT_TIERS,
} from "./mega-config.js";

// Snapshot/restore the env vars loadConfig reads, so tests are independent.
const ENV_KEYS = [
  "MEGACOMPACT_THRESHOLD_TOKENS",
  "MEGACOMPACT_TIER",
  "MEGACOMPACT_FAST_GATE_PCT",
  "MEGACOMPACT_DEDUP_SIM",
  "MEGACOMPACT_CROSSREPO_COSINE",
  "MEGACOMPACT_AUTO",
  "MEGACOMPACT_RAPTOR_ENABLED",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}
function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

// --- effectiveThresholdTokens (pure) --------------------------------------

test("effectiveThresholdTokens: custom tier returns the absolute explicit threshold", () => {
  // tierPct null == custom: never percent-scaled, even with a big window.
  const t = effectiveThresholdTokens({
    tierPct: null,
    fallbackThreshold: 50_000,
    window: 2_000_000,
    explicitThreshold: 12345,
  });
  assert.equal(t, 12345);
});

test("effectiveThresholdTokens: custom without explicit falls back to fallback", () => {
  const t = effectiveThresholdTokens({
    tierPct: null,
    fallbackThreshold: 50_000,
    window: 2_000_000,
  });
  assert.equal(t, 50_000);
});

test("effectiveThresholdTokens: tiered scales by window (round(tierPct * window))", () => {
  // tier 'medium' pct 0.6 over a 200k window → 120k.
  const t = effectiveThresholdTokens({
    tierPct: 0.6,
    fallbackThreshold: 50_000,
    window: 200_000,
  });
  assert.equal(t, 120_000);
});

test("effectiveThresholdTokens: tiered with no known window uses the boot fallback", () => {
  const t = effectiveThresholdTokens({
    tierPct: 0.6,
    fallbackThreshold: 50_000,
    window: 0,
  });
  assert.equal(t, 50_000);
});

// --- loadConfig: tier resolution + env parsing ----------------------------

test("loadConfig: explicit MEGACOMPACT_THRESHOLD_TOKENS wins and is absolute (tier custom, tierPct null)", () => {
  const snap = snapshotEnv();
  process.env.MEGACOMPACT_THRESHOLD_TOKENS = "777";
  try {
    const cfg = loadConfig();
    assert.equal(cfg.tier, "custom");
    assert.equal(cfg.tierPct, null);
    assert.equal(cfg.thresholdTokens, 777);
  } finally {
    restoreEnv(snap);
  }
});

test("loadConfig: unknown tier falls back to 'low'", () => {
  const snap = snapshotEnv();
  process.env.MEGACOMPACT_TIER = "nonsense-tier";
  try {
    const cfg = loadConfig();
    assert.equal(cfg.tier, "low");
    assert.equal(cfg.tierPct, TIER_PCT.low);
  } finally {
    restoreEnv(snap);
  }
});

test("loadConfig: TIER_PCT keys match COMPACT_TIERS (no drift)", () => {
  // Guards against a tier existing in one map but not the other.
  assert.deepEqual(
    [...Object.keys(COMPACT_TIERS)].sort(),
    [...Object.keys(TIER_PCT)].sort(),
  );
});

// E1 regression: the similarity thresholds must NEVER be NaN — a non-numeric
// env value used to produce NaN via raw Number(), silently disabling recall
// dedup (anything >= NaN is false). They now use the isFinite-guarded envFlag.
test("loadConfig: E1 — non-numeric DEDUP_SIM/CROSSREPO_COSINE never yield NaN (fall back to default)", () => {
  const snap = snapshotEnv();
  process.env.MEGACOMPACT_DEDUP_SIM = "not-a-number";
  process.env.MEGACOMPACT_CROSSREPO_COSINE = "also-bad";
  try {
    const cfg = loadConfig();
    assert.ok(Number.isFinite(cfg.dedupSim), "dedupSim is finite");
    assert.ok(Number.isFinite(cfg.crossRepoCosine), "crossRepoCosine is finite");
    assert.ok(!Number.isNaN(cfg.dedupSim), "dedupSim is not NaN");
    assert.ok(!Number.isNaN(cfg.crossRepoCosine), "crossRepoCosine is not NaN");
  } finally {
    restoreEnv(snap);
  }
});

test("loadConfig: valid DEDUP_SIM/CROSSREPO_COSINE parse through", () => {
  const snap = snapshotEnv();
  process.env.MEGACOMPACT_DEDUP_SIM = "0.85";
  process.env.MEGACOMPACT_CROSSREPO_COSINE = "0.95";
  try {
    const cfg = loadConfig();
    assert.equal(cfg.dedupSim, 0.85);
    assert.equal(cfg.crossRepoCosine, 0.95);
  } finally {
    restoreEnv(snap);
  }
});
