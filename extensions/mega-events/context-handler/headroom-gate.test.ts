/**
 * headroom-gate.test.ts — v0.21.9 output-headroom GATE tests (handler-level).
 *
 * Sibling of headroom.test.ts (the pure-function half), split per the
 * extensions/ 400-line soft limit. These tests exercise the real harness:
 * the headroom trip inside evaluateGate, its flag-OFF behavior, its
 * percent-based scale invariance, and the ThrashGuard exemption for
 * headroom-triggered fires. Env isolation: loadConfig reads env at
 * harness()/register time, so each test sets its own env.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateGate, thrashGuardBlocks } from "./gateCheck.js";
import { armThrashGuard } from "./thrashGuard.js";
import { harness } from "../../mega-compact.test/_helpers.js";
import type { MegaConfig } from "../../mega-config.js";
import { loadConfig } from "../../mega-config.js";

/** Minimal config for evaluateGate from loadConfig with per-test env. */
function configWith(env: Record<string, string | undefined>): MegaConfig {
	const saved: [string, string | undefined][] = [];
	for (const [k, v] of Object.entries(env)) {
		saved.push([k, process.env[k]]);
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	const cfg = loadConfig();
	for (const [k, v] of saved) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	return cfg;
}

const tailNone = () => undefined;

test("evaluateGate: headroom trips on the user's real 32k/20k model at 21.4k tokens (37% input)", async () => {
	const reg = await import("../register.js");
	const h = harness();
	await h.fire(
		"model_select",
		{ type: "model_select", model: "hf:zai-org/GLM-4.7" },
		h.ctx({
			model: {
				id: "hf:zai-org/GLM-4.7",
				provider: "plexus",
				contextWindow: 32000,
				maxTokens: 20000,
				reasoning: true,
			},
		}),
	);
	const runtime = reg.lastRuntime;
	assert.ok(runtime, "runtime registered");
	runtime.lastCtxWindow = 32000;
	const cfg = configWith({});
	assert.equal(cfg.overflowHeadroom, true, "headroom gate defaults ON");

	// The exact incident numbers: 21433 input tokens (67% of the window —
	// BELOW the 80% fire point), 20000 declared maxTokens, 5% margin:
	// 21433 + 20000 + 1600 = 43033 >= 32000 → TRIP. Pre-v0.21.9 this returned
	// "return" (fast-gate) → "compact never" → the 400 loop.
	const out = evaluateGate(runtime, cfg, {
		pct: 67,
		currentTokens: 21433,
		tailResult: tailNone,
	});
	assert.equal(out.kind, "proceed", "headroom forces compaction before the overflow");
	if (out.kind === "proceed") {
		assert.equal(out.headroomExceeded, true, "the proceed is tagged headroomExceeded");
	}
	assert.ok(runtime.diagCtxHeadroomTrip >= 1, "the headroom trip counter increments");
});

test("evaluateGate: headroom stays quiet at 10k tokens on the 32k/20k model (no early thrash)", async () => {
	const reg = await import("../register.js");
	// keepThreshold + clear the custom token gate leaked by an earlier plain
	// harness() in this process: the below-line case must fall to the PERCENT
	// branch (31% < 80% → return), not the token gate.
	const h = harness({ keepThreshold: true });
	delete process.env.MEGACOMPACT_THRESHOLD_TOKENS;
	process.env.MEGACOMPACT_TIER = "high";
	process.env.MEGACOMPACT_THRESHOLD_PCT = "0.8";
	await h.fire(
		"model_select",
		{ type: "model_select", model: "hf:zai-org/GLM-4.7" },
		h.ctx({
			model: {
				id: "hf:zai-org/GLM-4.7",
				provider: "plexus",
				contextWindow: 32000,
				maxTokens: 20000,
				reasoning: true,
			},
		}),
	);
	const runtime = reg.lastRuntime;
	assert.ok(runtime);
	runtime.lastCtxWindow = 32000;
	const cfg = configWith({});
	const before = runtime.diagCtxHeadroomTrip;
	// 10000 + 20000 + 1600 = 31600 < 32000 → below the trip line. Falls to the
	// percent gate: 31% < 80% → "return" (fast-gate). The headroom gate must
	// NOT fire early and thrash a healthy session.
	const out = evaluateGate(runtime, cfg, {
		pct: 31,
		currentTokens: 10000,
		tailResult: tailNone,
	});
	assert.equal(out.kind, "return");
	assert.equal(runtime.diagCtxHeadroomTrip, before, "no headroom trip below the line");
});

test("evaluateGate: MEGACOMPACT_OVERFLOW_HEADROOM=0 disables the pre-fire gate check", async () => {
	const reg = await import("../register.js");
	// keepThreshold + named tier → percent gate (67% < 80% must return when
	// the headroom gate is disabled). Clear the custom token gate leaked by
	// an earlier plain harness() in this process.
	const h = harness({ keepThreshold: true });
	delete process.env.MEGACOMPACT_THRESHOLD_TOKENS;
	process.env.MEGACOMPACT_TIER = "high";
	process.env.MEGACOMPACT_THRESHOLD_PCT = "0.8";
	await h.fire(
		"model_select",
		{ type: "model_select", model: "hf:zai-org/GLM-4.7" },
		h.ctx({
			model: {
				id: "hf:zai-org/GLM-4.7",
				provider: "plexus",
				contextWindow: 32000,
				maxTokens: 20000,
				reasoning: true,
			},
		}),
	);
	const runtime = reg.lastRuntime;
	assert.ok(runtime);
	runtime.lastCtxWindow = 32000;
	const cfg = configWith({ MEGACOMPACT_OVERFLOW_HEADROOM: "0" });
	assert.equal(cfg.overflowHeadroom, false);
	// Same numbers that TRIP when the flag is ON — with the flag OFF the gate
	// must behave as pre-v0.21.9: 67% < 80% fire point → "return". (Scope: the
	// flag disables the GATE check only; the pair-safe tail-cap hardenings are
	// unconditional guardrail fixes — see mega-config-types.ts.)
	const out = evaluateGate(runtime, cfg, {
		pct: 67,
		currentTokens: 21433,
		tailResult: tailNone,
	});
	assert.equal(out.kind, "return", "flag OFF restores the input-only gate");
	assert.equal(runtime.diagCtxHeadroomTrip, 0, "no trip is counted when the flag is OFF");
});

test("evaluateGate: headroom is percent-based — the same FRACTION trips at 200k and 1M", async () => {
	// With no declared maxTokens the fallback reserve is 30% of the window and
	// the margin is 5%: the trip line is 65% of the window at ANY size. Prove
	// the gate trips just above and stays quiet just below, at two window
	// sizes, using only fractions (no hardcoded token constants).
	for (const window of [200000, 1000000]) {
		const reg = await import("../register.js");
		harness({ keepThreshold: true }); // fresh runtime per window size
		delete process.env.MEGACOMPACT_THRESHOLD_TOKENS; // percent gate, not custom
		process.env.MEGACOMPACT_TIER = "high";
		process.env.MEGACOMPACT_THRESHOLD_PCT = "0.8";
		const runtime = reg.lastRuntime;
		assert.ok(runtime);
		runtime.lastCtxWindow = window;
		runtime.currentModel = undefined; // no declared maxTokens → fallback
		const cfg = configWith({});
		const tripAt = Math.ceil(window * 0.66); // 66% > the 65% trip line
		const quietAt = Math.floor(window * 0.64); // 64% < the 65% trip line
		const tripped = evaluateGate(runtime, cfg, { pct: 66, currentTokens: tripAt, tailResult: tailNone });
		assert.equal(tripped.kind, "proceed", `window=${window}: trips at 66%`);
		const quiet = evaluateGate(runtime, cfg, { pct: 64, currentTokens: quietAt, tailResult: tailNone });
		assert.equal(quiet.kind, "return", `window=${window}: quiet at 64%`);
	}
});

test("evaluateGate: unknown window (0) defers the headroom check entirely", async () => {
	const reg = await import("../register.js");
	harness();
	const runtime = reg.lastRuntime;
	assert.ok(runtime);
	runtime.lastCtxWindow = 0; // no reported window, no captured model
	const cfg = configWith({});
	// Huge token count but NO window → the headroom gate must defer (never
	// guess a window), matching the effectiveThresholdImpl Phase-C invariant.
	const out = evaluateGate(runtime, cfg, {
		pct: null,
		currentTokens: 999999,
		tailResult: tailNone,
	});
	// Falls through to the token gate: the harness sets THRESHOLD_TOKENS=50,
	// so 999999 > 50 → proceed via the TOKEN branch (not headroom).
	assert.equal(out.kind, "proceed");
	if (out.kind === "proceed") {
		assert.notEqual(out.headroomExceeded, true, "the proceed is NOT a headroom trip");
	}
});

test("thrashGuardBlocks: an armed guard blocks a normal fire but EXEMPTS a headroom fire", async () => {
	const reg = await import("../register.js");
	harness();
	const runtime = reg.lastRuntime;
	assert.ok(runtime);
	const cfg = configWith({});
	assert.equal(cfg.threeWayFailback, true, "umbrella ON by default");

	// Arm the guard: refuse re-fires below 30000 tokens.
	armThrashGuard(25000, 0.1, 25600, runtime.currentStateDir);

	// Normal fire at 21433 (< 30000): BLOCKED.
	assert.equal(
		thrashGuardBlocks(runtime, cfg, 21433),
		true,
		"the armed guard refuses an ordinary re-fire",
	);
	// Headroom fire at the SAME token count: EXEMPT — an overflow-bound fire
	// is never refused (an overflowed session is unrecoverable).
	assert.equal(
		thrashGuardBlocks(runtime, cfg, 21433, true),
		false,
		"a headroomExceeded fire bypasses the thrash guard",
	);
	// Umbrella OFF: never blocks regardless.
	const cfgOff = configWith({ MEGACOMPACT_THREE_WAY_FAILBACK: "0" });
	assert.equal(thrashGuardBlocks(runtime, cfgOff, 21433), false);
});
