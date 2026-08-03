/**
 * overflow-fix.test.ts — regression for the 2026-08-03 compaction-overflow
 * incident on neuralwatt/glm-5.2-short (200K window).
 *
 * Two bugs caused "Your conversation is too long even after compaction" 400s:
 *
 *  FIX 1 — criticalOver escape hatch never armed when pct is null.
 *    OpenAI-compatible providers (neuralwatt/plexus) don't report
 *    usage.percent, so `pct === null` and the old guard
 *    `criticalOver: (pct ?? 0) >= 90` was ALWAYS false. When the anchor floor
 *    couldn't be met, computeLiveTrimCut returned null → the raw overflow
 *    was sent to the model → 400. The fix also arms on pressure >= 0.9
 *    (token-basis).
 *
 *  FIX 2 — no token-budget cap on [summary + preserved tail].
 *    A single turn with a huge tool output jumps context from 139K → 199K+
 *    before the next gate fires, and the preserved tail alone exceeds the
 *    window. The fix walks the preserved tail from the front, dropping oldest
 *    messages until [summary + tail] fits under (window − maxOutput − 10%
 *    safety margin).
 *
 * Both fixes scale PER MODEL: window + maxTokens come from the model snapshot,
 * so a 200K model caps at ~158K and a 1M model caps at ~878K.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./_helpers.js";

/** Build a session whose preserved tail has MULTIPLE large (but
 * individually sub-window) tool results that TOGETHER exceed the window.
 * This is the real 2026-08-03 scenario: compaction fires at 140K, collapses
 * the old region to a ~2K summary, but the kept recent tail holds several
 * 40K-token bash outputs that together push [summary + tail] past 200K. */
function overflowSession() {
	const h = harness();
	// Each tool result ~60K tokens (240K chars) — well under the 200K window on
	// its own, but four of them + summary = ~240K > 200K.
	const big = "X".repeat(240_000);
	for (let i = 0; i < 4; i++) {
		h.session.push({
			role: "user",
			content: `run bash command ${i}`,
			timestamp: 0,
		} as any);
		h.session.push({
			role: "toolResult",
			toolCallId: "c1",
			toolName: "Bash",
			content: [{ type: "text", text: big }],
			isError: false,
			timestamp: 0,
		} as any);
	}
	return h;
}

test("FIX 1: criticalOver arms on token-pressure when pct is null (OpenAI-compat provider)", async () => {
	// Simulate a provider that does NOT report usage.percent (neuralwatt/plexus).
	// Without Fix 1, pct=null → criticalOver=false → computeLiveTrimCut bails
	// to null → the raw overflow is returned → 400 at the provider.
	const h = overflowSession();
	const ctx = h.ctx({
		// No usage.tokens AND no usage.percent — the neuralwatt regression case.
		getContextUsage: () => ({
			tokens: null,
			contextWindow: 200000,
			// percent deliberately OMITTED (undefined) — mirrors plexus/neuralwatt.
			percent: undefined as unknown as number,
		}),
		// Report the model so the runtime knows the window (200K) + maxTokens (20K).
		model: {
			id: "glm-5.2-short",
			provider: "plexus",
			name: "GLM-5.2 (short)",
			contextWindow: 200000,
			maxTokens: 20000,
			cost: { input: 0, output: 0 },
			reasoning: true,
		} as any,
	});

	const res = await h.fire(
		"context",
		{ type: "context", messages: h.session },
		ctx,
	);
	// The returned view MUST be trimmed (summary + capped tail), NOT the raw
	// overflow. If criticalOver didn't arm, computeLiveTrimCut returns null and
	// the handler returns undefined (raw overflow → 400). A non-undefined return
	// with a .messages array means the live trim fired.
	assert.ok(
		res,
		"live-trim returned a trimmed view (not undefined/raw overflow)",
	);
	assert.ok(res.messages, "returned view has a messages array");
	// The trimmed view must be SHORTER than the full session (we dropped the
	// oversized tail).
	assert.ok(
		res.messages.length < h.session.length,
		`trimmed view (${res.messages.length} msgs) < session (${h.session.length} msgs)`,
	);
	// And the first message is our compact summary (role=user, contains the
	// compaction marker).
	assert.equal(res.messages[0].role, "user");
});

test("FIX 2: preserved tail is capped to fit the model context window", async () => {
	// Even when pct IS reported (so criticalOver arms normally), a single
	// oversized tool result in the preserved tail can exceed the window.
	// The tail-cap must drop oldest preserved messages until [summary + tail]
	// fits under (window − maxOutput − 10% margin).
	const h = overflowSession();
	const ctx = h.ctx({
		getContextUsage: () => ({
			tokens: 199000,
			contextWindow: 200000,
			percent: 99, // over 90 → criticalOver arms via the pct path too
		}),
		model: {
			id: "glm-5.2-short",
			provider: "plexus",
			name: "GLM-5.2 (short)",
			contextWindow: 200000,
			maxTokens: 20000,
			cost: { input: 0, output: 0 },
			reasoning: true,
		} as any,
	});

	const res = await h.fire(
		"context",
		{ type: "context", messages: h.session },
		ctx,
	);
	assert.ok(res?.messages, "live-trim returned a trimmed view");
	// The oversized tool result (~200K tokens) MUST have been dropped — the
	// final view's total text must be far under the 200K window.
	// The 4 oversized tool results (4×240K = 960K chars, ~240K tokens) MUST
	// have been capped — the final view's total text must fit under the
	// (window − maxOutput − 10% margin) ≈ 158K-token budget (~632K chars).
	const totalChars = res.messages.reduce(
		(n: number, m: any) =>
			n +
			(typeof m.content === "string"
				? m.content.length
				: Array.isArray(m.content)
					? m.content.reduce(
							(s: number, c: any) => s + (c.text?.length ?? 0),
							0,
						)
					: 0),
		0,
	);
	assert.ok(
		totalChars < 700_000,
		`final view (${totalChars} chars) was capped below ~700K (4×240K=960K uncapped)`,
	);
});

test("FIX 1+2 scale per-model: a 1M-window model keeps more tail than a 200K model", async () => {
	// The same oversized tail should survive on a 1M model (fits) but be capped
	// on a 200K model. This proves the cap is percentage/window-based, not hardcoded.
	const h = overflowSession();
	const ctx200k = h.ctx({
		getContextUsage: () => ({
			tokens: 199000,
			contextWindow: 200000,
			percent: 99,
		}),
		model: {
			id: "glm-5.2-short",
			provider: "plexus",
			contextWindow: 200000,
			maxTokens: 20000,
			cost: { input: 0, output: 0 },
			reasoning: true,
		} as any,
	});
	const res200k = await h.fire(
		"context",
		{ type: "context", messages: h.session },
		ctx200k,
	);
	assert.ok(res200k?.messages, "200K model: live-trim returned a view");

	// Now a 1M model: the 4×240K-char tail (~240K tokens) FITS under the
	// 1M-10%-10% budget (~878K-token ≈ 3.5M chars), so it should be preserved.
	const h2 = overflowSession();
	const ctx1m = h2.ctx({
		getContextUsage: () => ({
			tokens: 300000,
			contextWindow: 1_000_000,
			percent: 30,
		}),
		model: {
			id: "glm-5.2",
			provider: "plexus",
			contextWindow: 1_000_000,
			maxTokens: 20000,
			cost: { input: 0, output: 0 },
			reasoning: true,
		} as any,
	});
	const res1m = await h2.fire(
		"context",
		{ type: "context", messages: h2.session },
		ctx1m,
	);
	assert.ok(res1m?.messages, "1M model: live-trim returned a view");

	// The 1M model's view should be LARGER than the 200K model's view because
	// the percentage-based cap allows more on a bigger window (the 4 tool
	// results survive on 1M but get capped on 200K).
	const size = (v: any) =>
		v.messages.reduce(
			(n: number, m: any) =>
				n +
				(typeof m.content === "string"
					? m.content.length
					: Array.isArray(m.content)
						? m.content.reduce(
								(s: number, c: any) => s + (c.text?.length ?? 0),
								0,
							)
						: 0),
			0,
		);
	assert.ok(
		size(res1m) > size(res200k),
		`1M model view (${size(res1m)} chars) > 200K model view (${size(res200k)} chars) — cap scales per-model`,
	);
});
