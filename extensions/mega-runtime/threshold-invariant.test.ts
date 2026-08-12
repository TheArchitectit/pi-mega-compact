/**
 * threshold-invariant.test.ts — 3WF-2 threshold invariant.
 *
 * Fire point = configuredPct × ACTUAL lastCtxWindow (the provider-reported
 * window). No hardcoded window value anywhere in the firing path. When the
 * window is unknown (lastCtxWindow <= 0) with a tiered config, auto-compaction
 * DEFERS (never substitutes a guessed window). custom tier (tierPct null) is an
 * explicit absolute. Token path (token gate) honors the per-model Dashboard
 * Model Thresholds override exactly like the percent path.
 *
 * Uses real node:sqlite stores (mkdtemp) end-to-end for the per-model override
 * path (no mocks). Pure functions exercised directly otherwise.
 *
 * Umbrella flag MEGACOMPACT_THREE_WAY_FAILBACK OFF must be byte-identical to
 * v0.20.83 (default tier=low 0.5, 200k boot fallback, no defer, no token-path
 * override).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	effectiveThresholdImpl,
	type PressureContext,
} from "./pressure-getters.js";
import { evaluateGate } from "../mega-events/context-handler/gateCheck.js";
import type { MegaConfig } from "../mega-config.js";
import {
	putModelThreshold,
	resolveModelThreshold,
} from "../../src/store/sqlite/model-thresholds.js";
import { SETTING_BY_KEY, EXCLUDED_SETTINGS } from "../dashboard-server/routes-rag-settings-helpers.js";

// --- helpers ----------------------------------------------------------------

function mkdir(): string {
	return mkdtempSync(join(tmpdir(), "mc-thresh-"));
}

/** A PressureContext-shaped object (effectiveThresholdImpl reads config +
 *  lastCtxWindow only). */
function pc(over: Partial<PressureContext>): PressureContext {
	return {
		config: over.config as MegaConfig,
		lastCtxTokens: over.lastCtxTokens ?? null,
		lastCtxPercent: over.lastCtxPercent ?? null,
		lastCtxWindow: over.lastCtxWindow ?? 0,
	};
}

/** Minimal config for a tiered (pct set) umbrella-ON config. */
function tieredConfig(
	tierPct: number,
	threeWayFailback = true,
): MegaConfig {
	return {
		tier: "low",
		tierPct,
		thresholdTokens: Math.round(tierPct * 200_000),
		threeWayFailback,
	} as MegaConfig;
}

// --- Tests 1-3, 5, 6: effectiveThresholdImpl -------------------------------

test("invariant 1: tiered + window unknown → DEFER (non-finite threshold)", () => {
	const self = pc({ config: tieredConfig(0.8), lastCtxWindow: 0 });
	const t = effectiveThresholdImpl(self);
	assert.equal(Number.isFinite(t), false, "threshold must be non-finite (defer)");
	assert.equal(t, Number.POSITIVE_INFINITY);
});

test("invariant 2: window known 1M, default 0.80 → fires at 800k (not 100k)", () => {
	const self = pc({ config: tieredConfig(0.8), lastCtxWindow: 1_000_000 });
	const t = effectiveThresholdImpl(self);
	assert.equal(t, 800_000, "must be 0.80 × 1M, NOT tierPct×200k");
});

test("invariant 3: window known 2M (>1M) → fires at 1.6M (no 1M clamp)", () => {
	const self = pc({ config: tieredConfig(0.8), lastCtxWindow: 2_000_000 });
	const t = effectiveThresholdImpl(self);
	assert.equal(t, 1_600_000, "must be 0.80 × 2M, no upper clamp");
});

test("invariant 5: custom tier + window unknown → still fires (explicit absolute)", () => {
	const cfg = {
		tier: "custom",
		tierPct: null,
		thresholdTokens: 123_456,
		threeWayFailback: true,
	} as MegaConfig;
	const self = pc({ config: cfg, lastCtxWindow: 0 });
	const t = effectiveThresholdImpl(self);
	assert.equal(t, 123_456, "custom absolute fires regardless of window");
});

test("invariant 6: umbrella OFF → legacy 100k fallback fires (byte-identical)", () => {
	// umbrella OFF + no tier → config resolves to tier=low 0.5, threshold 100k.
	const cfg = {
		tier: "low",
		tierPct: 0.5,
		thresholdTokens: 100_000,
		threeWayFailback: false,
	} as MegaConfig;
	const self = pc({ config: cfg, lastCtxWindow: 0 });
	const t = effectiveThresholdImpl(self);
	assert.equal(t, 100_000, "umbrella OFF → legacy 200k boot fallback (0.5×200k)");
});

// --- Test 4: token path honors per-model override --------------------------

test("invariant 4: token path (pct null) honors model_thresholds override (firePointPct 40)", () => {
	const stateDir = mkdir();
	// Write a real per-model override row through the production upsert path.
	putModelThreshold("test-model-x", 5, 40, stateDir);

	// Resolve the override exactly as gateCheck does (sanity + fixtures).
	const mt = resolveModelThreshold("test-model-x", {
		safetyMarginFallback: 5,
		firePointFallback: 80,
		stateDir,
	});
	assert.equal(mt.firePointPct, 40);

	// Build a runtime-like object the gate reads. Window known 1M. Token path:
	// pct == null. The override → gate = 0.40 × 1M = 400k. At 0.80 tier the bare
	// window gate would be 800k, so a 500k token count would NOT fire there — but
	// it MUST fire at the override's 400k.
	const cfg = tieredConfig(0.8, true);
	const runtime = {
		config: cfg,
		currentModel: { modelId: "test-model-x" },
		currentStateDir: stateDir,
		lastCtxWindow: 1_000_000,
		effectiveThreshold: effectiveThresholdImpl(pc({ config: cfg, lastCtxWindow: 1_000_000 })),
		diagCtxFastGate: 0,
		diagCtxNoCompact: 0,
	} as any;

	const tailResult = () => undefined;
	// 500_000 tokens ≥ 400_000 override gate → gate passes (proceed).
	const pass = evaluateGate(runtime, cfg, {
		pct: null,
		currentTokens: 500_000,
		tailResult,
	});
	assert.equal(pass.kind, "proceed", "500k must fire at the 400k override gate");

	// 300_000 tokens < 400_000 override gate → gate does NOT pass (return).
	const noPass = evaluateGate(runtime, cfg, {
		pct: null,
		currentTokens: 300_000,
		tailResult,
	});
	assert.equal(noPass.kind, "return", "300k must NOT fire below the 400k override gate");
});

// --- Test 7: Settings surface ---------------------------------------------

test("invariant 7: MEGACOMPACT_THRESHOLD_PCT present in SETTINGS, absent from EXCLUDED_SETTINGS", () => {
	assert.ok(
		SETTING_BY_KEY.has("MEGACOMPACT_THRESHOLD_PCT"),
		"MEGACOMPACT_THRESHOLD_PCT must be in SETTINGS",
	);
	const spec = SETTING_BY_KEY.get("MEGACOMPACT_THRESHOLD_PCT")!;
	assert.equal(spec.type, "number");
	assert.equal(spec.default, 0.8);
	assert.equal(spec.min, 0.1);
	assert.equal(spec.max, 0.95);
	assert.equal(
		EXCLUDED_SETTINGS.includes("MEGACOMPACT_THRESHOLD_PCT"),
		false,
		"MEGACOMPACT_THRESHOLD_PCT must NOT be in EXCLUDED_SETTINGS",
	);
});
