/**
 * headroom.test.ts — v0.21.9 output-headroom gate + tail-cap tests.
 *
 * Regression suite for the 2026-08-19 32k truncation loop (attempt #6): the
 * gate judged only INPUT utilization (80% fire point = 25600 on a 32k window)
 * while the provider's request budget is input + maxTokens output reserve +
 * margin — for the user's GLM-4.7 (32000 window / 20000 maxTokens) the
 * request overflows at ~37% INPUT, so the gate never fired ("compact never")
 * and the session 400-looped. The fix: an output-headroom pre-fire check
 * (percent-based — identical math at every window size) + a shared reserve
 * source + pair-safe tail cap + thrash-guard exemption for headroom fires.
 *
 * This file covers the PURE functions (resolveOutputReserve / applyTailCap /
 * recapReplayedTail). The handler-level gate tests (evaluateGate headroom
 * trip, flag-OFF, scale invariance, ThrashGuard exemption) are split into
 * headroom-gate.test.ts per the extensions/ 400-line soft limit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	resolveOutputReserve,
	applyTailCap,
	recapReplayedTail,
	MAX_OUTPUT_PLAUSIBLE_FRACTION,
} from "./headroom.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

// ─────────────────────────────────────────────────────────────────────────────
// resolveOutputReserve — the shared reserve source
// ─────────────────────────────────────────────────────────────────────────────

test("resolveOutputReserve: plausible declared maxTokens wins (the user's 32k/20k GLM-4.7)", () => {
	// 20000/32000 = 62.5% of the window — a REAL config (vLLM reserves the
	// FULL maxTokens). Pre-v0.21.9 attempt-#6 code treated >60% as implausible
	// and fell back to 30% (9600) while the backend reserved 20000 — the gate
	// kept firing late. maxTokens must win here.
	const r = resolveOutputReserve(32000, 20000, 0.3);
	assert.equal(r.reserveTokens, 20000, "declared maxTokens is the reserve");
	assert.equal(r.fallbackUsed, false, "no fallback for a plausible maxTokens");
});

test("resolveOutputReserve: window <= 0 / non-finite defers (never guesses)", () => {
	assert.deepEqual(resolveOutputReserve(0, 20000, 0.3), {
		reserveTokens: 0,
		fallbackUsed: false,
	});
	assert.deepEqual(resolveOutputReserve(-5, 20000, 0.3), {
		reserveTokens: 0,
		fallbackUsed: false,
	});
	assert.deepEqual(resolveOutputReserve(Number.NaN, 20000, 0.3), {
		reserveTokens: 0,
		fallbackUsed: false,
	});
});

test("resolveOutputReserve: sentinel maxTokens (1e9 / 1e38 / 0 / NaN) falls back to the clamped fraction", () => {
	// Kimi-K2.5 ships maxTokens 1e9; pi's "auto" ships 1e38. Both are junk —
	// 1e9 > 0.95 × any real window. The fallback keeps the cap alive instead
	// of computing a negative budget (the pre-v0.21.9 silent-disable bug).
	const k25 = resolveOutputReserve(200000, 1e9, 0.3);
	assert.equal(k25.reserveTokens, 60000, "30% of the 200k window");
	assert.equal(k25.fallbackUsed, true);

	const auto = resolveOutputReserve(200000, 1e38, 0.3);
	assert.equal(auto.fallbackUsed, true);
	assert.equal(auto.reserveTokens, 60000);

	const zero = resolveOutputReserve(200000, 0, 0.3);
	assert.equal(zero.fallbackUsed, true);
	assert.equal(zero.reserveTokens, 60000);

	const nan = resolveOutputReserve(200000, Number.NaN, 0.3);
	assert.equal(nan.fallbackUsed, true);
});

test("resolveOutputReserve: the plausibility bound sits at 95% of the window", () => {
	// Just under the bound → declared wins; at the bound it is still plausible
	// (inclusive <=); above it (or >= the window) → fallback. Percent-based:
	// the bound scales with the window.
	assert.equal(MAX_OUTPUT_PLAUSIBLE_FRACTION, 0.95);
	const under = resolveOutputReserve(100000, 94000, 0.3);
	assert.equal(under.fallbackUsed, false);
	assert.equal(under.reserveTokens, 94000);
	const at = resolveOutputReserve(100000, 95000, 0.3);
	assert.equal(at.fallbackUsed, false, "exactly at the bound is still plausible");
	assert.equal(at.reserveTokens, 95000);
	const over = resolveOutputReserve(100000, 95001, 0.3);
	assert.equal(over.fallbackUsed, true, "above the bound is junk");
	const pastWindow = resolveOutputReserve(100000, 150000, 0.3);
	assert.equal(pastWindow.fallbackUsed, true, "a maxTokens > window is junk");
});

test("resolveOutputReserve: the fallback fraction is clamped [0.1, 0.95] and defaults to 0.3 on junk input", () => {
	assert.equal(resolveOutputReserve(100000, 0, 0.01).reserveTokens, 10000, "clamped up to 10%");
	assert.equal(resolveOutputReserve(100000, 0, 5).reserveTokens, 95000, "clamped down to 95%");
	assert.equal(resolveOutputReserve(100000, 0, Number.NaN).reserveTokens, 30000, "NaN → 30% default");
});

test("resolveOutputReserve is percent-based: identical math at 64k / 1M / 5M windows", () => {
	// A model whose maxTokens is 25% of its window reserves exactly that
	// fraction at ANY size — no hardcoded token constants anywhere.
	for (const window of [64000, 128000, 256000, 512000, 200000, 1000000, 5000000]) {
		const r = resolveOutputReserve(window, Math.round(window * 0.25), 0.3);
		assert.equal(r.reserveTokens, Math.round(window * 0.25), `window=${window}`);
		assert.equal(r.fallbackUsed, false, `window=${window}`);
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// applyTailCap — the pair-safe live-trim tail cap
// ─────────────────────────────────────────────────────────────────────────────

function am(role: "user" | "assistant" | "toolResult", text: string): AgentMessage {
	if (role === "toolResult") {
		return {
			role,
			toolCallId: "c1",
			toolName: "Bash",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: 0,
		} as unknown as AgentMessage;
	}
	return { role, content: text, timestamp: 0 } as unknown as AgentMessage;
}

test("applyTailCap: front-drops oldest until the tail fits window − reserve − margin − summary", () => {
	// window 32000, maxTokens 20000 (plausible → reserve 20000), margin 5%
	// (1600), summary 100 → budget = 32000 − 20000 − 1600 − 100 = 10300.
	// 3 messages × 12000 chars (~3000 tokens each): all 3 = 9000 <= 10300 →
	// none dropped. Shrink the window to force drops.
	const msgs = [am("user", "A".repeat(12000)), am("assistant", "B".repeat(12000)), am("user", "C".repeat(12000))];
	const noDrop = applyTailCap({
		recentRaw: msgs,
		summaryTokens: 100,
		ctxWindow: 32000,
		maxOutputTokens: 20000,
		outputReservePct: 0.3,
		safetyMarginPct: 5,
	});
	assert.equal(noDrop.dropped, 0, "everything fits the 10300-token budget");

	// Smaller window: 32000 → reserve still 20000, budget = 8300... use a
	// window where the budget shrinks below the 9000-token tail: window 30000
	// → budget = 30000 − 20000 (declared) − 1500 (5%) − 100 = 8400 < 9000 →
	// the oldest is dropped.
	const drop = applyTailCap({
		recentRaw: msgs,
		summaryTokens: 100,
		ctxWindow: 30000,
		maxOutputTokens: 20000,
		outputReservePct: 0.3,
		safetyMarginPct: 5,
	});
	assert.ok(drop.dropped >= 1, "the oldest message is front-dropped");
	assert.ok(drop.recent.length + drop.dropped === msgs.length);
	assert.equal(
		(drop.recent[drop.recent.length - 1] as { content: string }).content[0],
		"C",
		"the FINAL message always survives",
	);
});

test("applyTailCap: budget floor keeps the cap active for a sentinel maxTokens (1e9)", () => {
	// Pre-v0.21.9 the reserve was the raw maxTokens → budget went negative →
	// the cap silently disabled itself and the oversized tail sailed past the
	// window. Now the reserve falls back to the clamped fraction (≤95%) and
	// the budget floor max(1, …) keeps the cap alive even on the worst case.
	const big = [am("user", "X".repeat(40000)), am("assistant", "Y".repeat(40000)), am("user", "Z".repeat(40000))];
	const r = applyTailCap({
		recentRaw: big,
		summaryTokens: 0,
		ctxWindow: 32000,
		maxOutputTokens: 1e9, // Kimi sentinel junk
		outputReservePct: 0.3,
		safetyMarginPct: 5,
	});
	// budget = max(1, 32000 − 9600 − 1600 − 0) = 20800 → each 10000-token
	// message: tail of 2 = 20000 fits, tail of 3 = 30000 > 20800 → drop 1.
	assert.ok(r.dropped >= 1, "the cap is ACTIVE (not silently disabled)");
	assert.ok(r.recent.length >= 1, "the final message survives");
});

test("applyTailCap: never returns an empty tail — the final message is always kept", () => {
	const one = am("user", "X".repeat(400000)); // ~100k tokens, way over any budget
	const r = applyTailCap({
		recentRaw: [one],
		summaryTokens: 0,
		ctxWindow: 32000,
		maxOutputTokens: 20000,
		outputReservePct: 0.3,
		safetyMarginPct: 5,
	});
	assert.equal(r.recent.length, 1, "a single oversized message is kept (agent must respond)");
	assert.equal(r.dropped, 0);
});

test("applyTailCap (PREVENT-PI-002): the preserved tail never starts on an orphaned toolResult", () => {
	// Construct a tail whose front-drop lands BETWEEN a toolCall and its
	// toolResult: [user, assistant(toolCall), toolResult(big), user]. The
	// budget admits only the last ~1 message, so the naive cut would start on
	// the toolResult — the cap must advance past it (the pair drops whole).
	const pairCall = {
		role: "assistant",
		content: [{ type: "toolCall", name: "Bash", id: "c1", arguments: {} }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "m",
		usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
		stopReason: "tool_use",
		timestamp: 0,
	} as unknown as AgentMessage;
	const msgs = [
		am("user", "first user message with some padding text"),
		pairCall,
		am("toolResult", "R".repeat(40000)), // ~10000 tokens — forces the drop
		am("user", "final user message"),
	];
	const r = applyTailCap({
		recentRaw: msgs,
		summaryTokens: 0,
		ctxWindow: 32000,
		maxOutputTokens: 20000, // reserve 20000; budget = 32000−20000−1600 = 10400
		outputReservePct: 0.3,
		safetyMarginPct: 5,
	});
	const first = r.recent[0] as { role: string };
	assert.notEqual(first.role, "toolResult", "tail must not begin on an orphaned toolResult");
	// If the toolCall survived, its result must too (pair intact); the usual
	// outcome here is that BOTH dropped whole.
	if (r.recent.some((m) => (m as { role: string }).role === "assistant")) {
		assert.ok(
			r.recent.some((m) => (m as { role: string }).role === "toolResult"),
			"a kept toolCall keeps its toolResult",
		);
	}
});

test("applyTailCap: window <= 0 or a single message is a no-op", () => {
	const msgs = [am("user", "a"), am("user", "b")];
	assert.equal(applyTailCap({ recentRaw: msgs, summaryTokens: 0, ctxWindow: 0, maxOutputTokens: 20000, outputReservePct: 0.3, safetyMarginPct: 5 }).dropped, 0);
	const single = [am("user", "a")];
	assert.equal(applyTailCap({ recentRaw: single, summaryTokens: 0, ctxWindow: 32000, maxOutputTokens: 20000, outputReservePct: 0.3, safetyMarginPct: 5 }).dropped, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-08-20 incident: toolCall-argument undercount (the truncate-loop root cause)
// The estimator counted only content[].text — a GLM-4.7 assistant message whose
// 11.6k bytes live in toolCall `arguments` registered as ~77 tokens. A 30k tail
// passed the 11.9k budget; the model overflowed immediately; pi's one-shot
// compact-and-retry failed → "Context overflow recovery failed". What convertToLlm
// ships verbatim must be counted verbatim: toolCall arguments, thinking blocks,
// and every non-text field in the message.
// ─────────────────────────────────────────────────────────────────────────────

/** Anthropic-style assistant message carrying a fat toolCall (GLM-4.7 shape). */
function toolCallAssist(jsonArgChars: number): AgentMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "reasoning padding".repeat(20) },
			{
				type: "toolCall",
				name: "Edit",
				id: "c1",
				arguments: { filePath: "engine/mesh.go", oldString: "x".repeat(jsonArgChars) },
			},
		],
		api: "anthropic-messages",
		provider: "plexus",
		model: "hf:zai-org/GLM-4.7",
		usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
		stopReason: "toolUse",
		timestamp: 0,
	} as unknown as AgentMessage;
}

test("applyTailCap: toolCall arguments + thinking blocks count toward the budget (undercount regression)", () => {
	// Budget on a 32k/20k GLM-4.7 with 5% margin and a 100-token summary:
	//   32000 − 20000 − 1600 − 100 = 10300 tokens.
	// Three toolCall assistant messages each carrying ~44000 bytes ≈ 11000
	// tokens of arguments + thinking. A text-only estimator sees ~90 tokens
	// each (270 total) and passes all three (33000 tokens on the wire) through
	// the 10300 budget — the model overflows on the very next turn.
	const big = [toolCallAssist(40000), toolCallAssist(40000), am("user", "fix engine/mesh.go now")];
	const r = applyTailCap({
		recentRaw: big,
		summaryTokens: 100,
		ctxWindow: 32000,
		maxOutputTokens: 20000,
		outputReservePct: 0.3,
		safetyMarginPct: 5,
	});
	assert.ok(
		r.dropped >= 1,
		`expected the oversized toolCall tail to be front-dropped (dropped=${r.dropped});` +
			" text-only estimation passes ~33k tokens through a 10.3k budget",
	);
	assert.equal(
		(r.recent[r.recent.length - 1] as { role: string }).role,
		"user",
		"the final user turn always survives",
	);
});

test("recapReplayedTail: replay path shares the full-budget accounting", () => {
	const summary = am("user", "S".repeat(400));
	const tail = [toolCallAssist(40000), toolCallAssist(40000), am("user", "resume")];
	const r = recapReplayedTail({
		recentRaw: tail,
		summaryAgentMsg: summary,
		ctxWindow: 32000,
		maxOutputTokens: 20000,
		outputReservePct: 0.3,
		safetyMarginPct: 5,
	});
	assert.ok(r.dropped >= 1, "the replayed tail must apply the same full-message accounting");
});


test("recapReplayedTail: re-caps a replayed tail against a SHRUNKEN window", () => {
	// A view built for a 200k window replayed after a model switch to 32k.
	const summary = am("user", "S".repeat(400)); // ~100-token summary
	const tail = [am("user", "A".repeat(40000)), am("assistant", "B".repeat(40000)), am("user", "C".repeat(4000))];
	const r = recapReplayedTail({
		recentRaw: tail,
		summaryAgentMsg: summary,
		ctxWindow: 32000,
		maxOutputTokens: 20000,
		outputReservePct: 0.3,
		safetyMarginPct: 5,
	});
	// budget = 32000 − 20000 − 1600 − ~101 ≈ 10299 → the two 10000-token
	// messages cannot both survive.
	assert.ok(r.dropped >= 1, "the replayed tail is re-capped for the smaller window");
});

test("recapReplayedTail: no-op when the tail already fits the current window", () => {
	const summary = am("user", "summary");
	const tail = [am("user", "small"), am("user", "tail")];
	const r = recapReplayedTail({
		recentRaw: tail,
		summaryAgentMsg: summary,
		ctxWindow: 200000,
		maxOutputTokens: 20000,
		outputReservePct: 0.3,
		safetyMarginPct: 5,
	});
	assert.equal(r.dropped, 0);
	assert.equal(r.recent.length, tail.length);
});
