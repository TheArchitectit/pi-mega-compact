/**
 * wireTruth.test.ts — v0.21.12 invisible-overhead calibration + wire-truth parse.
 *
 * Pure-function + meta-round-trip tests for parseWireTruth / readWireOverhead /
 * sampleWireOverhead. No mocks; a real SQLite meta store via a temp stateDir
 * (mirrors thrashGuard.test.ts, which uses the same getMetaNumber/setMetaNumber
 * path). Runs via `npm test` (collectTestFiles globs dist/extensions/**).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeIndexStore } from "../../../src/store/sqlite.js";
import {
	parseWireTruth,
	readWireOverhead,
	sampleWireOverhead,
	OVERHEAD_CLAMP_FRACTION,
} from "./wireTruth.js";

const noopLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as import("../../mega-runtime.js").MegaRuntime["logger"];

let tmp: string | undefined;
function tmpStateDir(): string {
	if (tmp == null) tmp = mkdtempSync(join(tmpdir(), "mc-wire-"));
	return tmp;
}
test("teardown: close meta store", () => {
	if (tmp != null) {
		try {
			closeIndexStore();
		} catch {
			/* non-fatal */
		}
		rmSync(tmp, { recursive: true, force: true });
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// parseWireTruth — pure regex on the provider's 400 text
// ─────────────────────────────────────────────────────────────────────────────

test("parseWireTruth: the exact 2026-08-19 incident string", () => {
	const r = parseWireTruth(
		"request (39048 tokens) exceeds the available context size (32768 tokens)",
	);
	assert.deepEqual(r, { requestTokens: 39048, availableTokens: 32768 });
});

test("parseWireTruth: comma-grouped numbers", () => {
	const r = parseWireTruth(
		"request (39,048 tokens) exceeds the available context size (32,768 tokens)",
	);
	assert.deepEqual(r, { requestTokens: 39048, availableTokens: 32768 });
});

test("parseWireTruth: returns null on unrelated text / no match", () => {
	assert.equal(parseWireTruth(""), null);
	assert.equal(parseWireTruth("Context overflow recovery failed after one attempt"), null);
	assert.equal(parseWireTruth("request (abc tokens) exceeds the available context size (32768 tokens)"), null);
	assert.equal(parseWireTruth("the model ran out of context"), null);
});

test("parseWireTruth: rejects zero / negative parsed values", () => {
	assert.equal(parseWireTruth("request (0 tokens) exceeds the available context size (32768 tokens)"), null);
	assert.equal(parseWireTruth("request (100 tokens) exceeds the available context size (0 tokens)"), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// EMA calibration — meta round-trip with a real temp stateDir
// ─────────────────────────────────────────────────────────────────────────────

test("sampleWireOverhead: first sample initializes the EMA", () => {
	const dir = tmpStateDir();
	const modelId = "qwen3.8-27b";
	const out = sampleWireOverhead(modelId, dir, 5000, 32768);
	assert.ok(out > 0, "EMA returns the sample in token space");
	// Stored as fraction ×100 (rounded). 5000/32768 ≈ 0.1526 → 15.
	const stored = readWireOverhead(modelId, dir, 32768);
	assert.ok(Math.abs(stored - 5000) < 400, `stored token EMA ~= sample (got ${stored})`);
});

test("sampleWireOverhead: second sample moves the EMA toward it", () => {
	const dir = tmpStateDir();
	const modelId = "glm4.7";
	sampleWireOverhead(modelId, dir, 4000, 32768); // init
	const out = sampleWireOverhead(modelId, dir, 8000, 32768); // alpha 0.4 → 0.4*8000 + 0.6*4000 = 5600
	assert.ok(Math.abs(out - 5600) < 400, `EMA blends (got ${out})`);
});

test("sampleWireOverhead: clamps to 0.85 × window", () => {
	const dir = tmpStateDir();
	const modelId = "huge";
	const out = sampleWireOverhead(modelId, dir, 999999, 32768); // absurd sample
	assert.ok(out <= 32768 * OVERHEAD_CLAMP_FRACTION + 1, `clamped to ${OVERHEAD_CLAMP_FRACTION} × window`);
});

test("readWireOverhead: 0 when absent / unknown model", () => {
	const dir = tmpStateDir();
	assert.equal(readWireOverhead("never-seen", dir, 32768), 0);
	assert.equal(readWireOverhead("", dir, 32768), 0);
});

test("readWireOverhead: non-fatal on a bogus stateDir", () => {
	// A directory with no sqlite store: the meta read throws internally and we
	// return 0 rather than propagating. (closeIndexStore guards test teardown.)
	assert.equal(readWireOverhead("m", "/nonexistent/path/xyz", 32768), 0);
});

test("flag-off semantics: H=0 path is the caller's responsibility (read returns 0 with no sample)", () => {
	const dir = tmpStateDir();
	// When the flag is OFF the handler never samples and passes H=0; readWireOverhead
	// with no sample also yields 0, so the byte-identical v0.21.11 path holds.
	assert.equal(readWireOverhead("unused", dir, 32768), 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Wire-truth gate — the 400-loop breaker
// ─────────────────────────────────────────────────────────────────────────────

// Replicates the handler's wire-truth correction (context-handler.ts) using the
// REAL parseWireTruth + evaluateGate, so the gate math is exercised end-to-end
// without the full pipeline. The harness import would pull in the parent
// extension lifecycle; this isolates the mechanism (per CLAUDE.md "use maps +
// targeted context").
import { evaluateGate } from "./gateCheck.js";
import type { MegaConfig } from "../../mega-config.js";
import { loadConfig } from "../../mega-config.js";

function cfgWith(env: Record<string, string | undefined>): MegaConfig {
	const saved: [string, string | undefined][] = [];
	for (const [k, v] of Object.entries(env)) {
		saved.push([k, process.env[k]]);
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	const c = loadConfig();
	for (const [k, v] of saved) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	return c;
}

test("wire-truth gate: trailing 400 text trips the gate even when the bare estimate is below all thresholds", () => {
	const dir = tmpStateDir();
	const modelId = "qwen3.8-27b";
	// Calibrate an EMA so readWireOverhead returns a real H.
	sampleWireOverhead(modelId, dir, 13000, 32768);

	// The handler computes the message-list estimate (usage absent → estimate
	// path). Simulate a transcript whose estimate reads ~10000 tokens — BELOW the
	// 80% fire point (26214) AND below the headroom trip (10000 + 20000 + 1638 =
	// 31638 < 32768). The REAL wire prompt is 39048 (the invisible overhead H is
	// uncounted), so the bare estimate is the v0.21.11 blind spot.
	const estimateTokens = 10000;
	const cfg = cfgWith({ MEGACOMPACT_WIRE_OVERHEAD: "true", MEGACOMPACT_OVERFLOW_HEADROOM: "true" });
	assert.equal(cfg.wireOverhead, true);

	// Bare estimate → does NOT trip (pre-v0.21.12 blind spot).
	const bare = evaluateGate(
		{ lastCtxWindow: 32768, currentModel: { modelId, contextWindow: 32768, maxTokens: 20000 }, rt: { sessionId: "s" }, logger: noopLogger } as unknown as import("../../mega-runtime.js").MegaRuntime,
		cfg,
		{ pct: 55, currentTokens: estimateTokens, tailResult: () => undefined },
	);
	assert.equal(bare.kind, "return", "bare estimate (55% input) does NOT trip the gate");

	// Now apply the wire-truth override: the trailing assistant error message
	// carries the provider's overflow text. Parse it → ground-truth tokens, which
	// exceed the window. This is what forces the gate to proceed.
	const parsed = parseWireTruth(
		"request (39048 tokens) exceeds the available context size (32768 tokens)",
	);
	assert.ok(parsed, "the 400 text parses");
	const wireTokens = parsed!.requestTokens; // 39048 > 32768 → unambiguous overflow
	const out = evaluateGate(
		{ lastCtxWindow: 32768, currentModel: { modelId, contextWindow: 32768, maxTokens: 20000 }, rt: { sessionId: "s" }, logger: noopLogger } as unknown as import("../../mega-runtime.js").MegaRuntime,
		cfg,
		{ pct: 55, currentTokens: wireTokens, tailResult: () => undefined },
	);
	assert.equal(out.kind, "proceed", "wire-truth tokens force the gate to proceed");
	if (out.kind === "proceed") {
		assert.equal(out.headroomExceeded, true, "tagged headroomExceeded");
	}
});
