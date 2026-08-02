/**
 * s29-percent.test.ts — S29 percent-based auto-compact trigger.
 * Split from mega-compact.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./_helpers.js";

function s29TieredCtx(
	h: ReturnType<typeof harness>,
	usage: { tokens: number; contextWindow: number; percent: number | null },
) {
	delete process.env.MEGACOMPACT_LEGACY_DURABLE_TRIM;
	delete process.env.MEGACOMPACT_DURABLE_TRIM_FLOOR;
	process.env.MEGACOMPACT_ANCHOR_USER_MESSAGES = "1";
	return h.ctx({
		isIdle: () => true,
		hasPendingMessages: () => false,
		getContextUsage: () => usage as any,
	});
}

test("S29: percent gate fires when tokens under-report (tiered low, percent 55, tokens 10)", async () => {
	process.env.MEGACOMPACT_TIER = "low";
	delete process.env.MEGACOMPACT_THRESHOLD_TOKENS;
	delete process.env.MEGACOMPACT_AUTO_PCT_TRIGGER;
	try {
		const h = harness({ keepTier: true, keepThreshold: true });
		// tokens=10 (under the 0.5×10000=5000 token gate), percent=55 (>= 0.5).
		// The OLD token-only gate would return (10 < 5000) → no trim. The S29
		// percent gate (0.55 >= 0.5) fires → live trim returns a trimmed view.
		const ctx = s29TieredCtx(h, {
			tokens: 10,
			contextWindow: 10000,
			percent: 55,
		});
		const res = await h.fire(
			"context",
			{ type: "context", messages: h.session },
			ctx,
		);
		assert.ok(
			res && typeof res === "object",
			"percent gate: live trim returned a result object",
		);
		assert.ok(
			Array.isArray((res as any).messages),
			"percent gate: result has a trimmed messages array",
		);
		assert.ok(
			(res as any).messages.length < h.session.length,
			"percent gate: trimmed view is shorter than the full session",
		);
		assert.equal(
			h.compactCalls.length,
			0,
			"percent gate: live trim, no ctx.compact()",
		);

		// Control: percent 40 (< 0.5) → no trim, even with the same under-reported tokens.
		const h2 = harness({ keepTier: true, keepThreshold: true });
		const ctx2 = s29TieredCtx(h2, {
			tokens: 10,
			contextWindow: 10000,
			percent: 40,
		});
		const res2 = await h2.fire(
			"context",
			{ type: "context", messages: h2.session },
			ctx2,
		);
		assert.ok(
			!(
				res2 &&
				typeof res2 === "object" &&
				Array.isArray((res2 as any).messages)
			),
			"percent below fire point: no trim (token count 10 is also below the token gate)",
		);
	} finally {
		delete process.env.MEGACOMPACT_TIER;
		delete process.env.MEGACOMPACT_ANCHOR_USER_MESSAGES;
	}
});

test("S29: MEGACOMPACT_AUTO_PCT_TRIGGER overrides the tier fire point (0.85)", async () => {
	process.env.MEGACOMPACT_TIER = "low"; // tierPct 0.5
	process.env.MEGACOMPACT_AUTO_PCT_TRIGGER = "0.85";
	delete process.env.MEGACOMPACT_THRESHOLD_TOKENS;
	try {
		// percent 80 < 0.85 → no trim.
		const h = harness({ keepTier: true, keepThreshold: true });
		const ctx80 = s29TieredCtx(h, {
			tokens: 10,
			contextWindow: 10000,
			percent: 80,
		});
		const res80 = await h.fire(
			"context",
			{ type: "context", messages: h.session },
			ctx80,
		);
		assert.ok(
			!(
				res80 &&
				typeof res80 === "object" &&
				Array.isArray((res80 as any).messages)
			),
			"override 0.85: percent 80 does NOT trim (below the override fire point)",
		);

		// percent 90 >= 0.85 → trim fires (despite the tier's own 0.5 fire point).
		const h2 = harness({ keepTier: true, keepThreshold: true });
		const ctx90 = s29TieredCtx(h2, {
			tokens: 10,
			contextWindow: 10000,
			percent: 90,
		});
		const res90 = await h2.fire(
			"context",
			{ type: "context", messages: h2.session },
			ctx90,
		);
		assert.ok(
			res90 &&
				Array.isArray((res90 as any).messages) &&
				(res90 as any).messages.length < h2.session.length,
			"override 0.85: percent 90 DOES trim (above the override fire point)",
		);
	} finally {
		delete process.env.MEGACOMPACT_TIER;
		delete process.env.MEGACOMPACT_AUTO_PCT_TRIGGER;
		delete process.env.MEGACOMPACT_ANCHOR_USER_MESSAGES;
	}
});

test("S29: custom tier keeps the absolute token gate (percent 40 but tokens 100 >= 50)", async () => {
	// MEGACOMPACT_THRESHOLD_TOKENS → custom (tierPct null) → token gate, percent ignored.
	process.env.MEGACOMPACT_THRESHOLD_TOKENS = "50";
	delete process.env.MEGACOMPACT_TIER;
	delete process.env.MEGACOMPACT_AUTO_PCT_TRIGGER;
	try {
		const h = harness({ keepTier: true, keepThreshold: true });
		// percent 40 (low) BUT tokens 100 >= 50 threshold → custom token gate fires.
		const ctx = s29TieredCtx(h, {
			tokens: 100,
			contextWindow: 10000,
			percent: 40,
		});
		const res = await h.fire(
			"context",
			{ type: "context", messages: h.session },
			ctx,
		);
		assert.ok(
			res &&
				Array.isArray((res as any).messages) &&
				(res as any).messages.length < h.session.length,
			"custom tier: token gate fires (tokens 100 >= 50) despite low percent 40",
		);
	} finally {
		delete process.env.MEGACOMPACT_THRESHOLD_TOKENS;
		delete process.env.MEGACOMPACT_ANCHOR_USER_MESSAGES;
	}
});

test("S29: tiered config with pct==null falls back to the token gate (not skipped)", async () => {
	// The regression guard for the audit finding: a percent-ONLY gate would skip
	// compaction when percent is unreported. S29 falls back to the token gate
	// (S27 boot-fallback guarantee). tiered low: effectiveThreshold = 0.5×10000 = 5000;
	// tokens 6000 >= 5000 → token fallback fires.
	process.env.MEGACOMPACT_TIER = "low";
	delete process.env.MEGACOMPACT_THRESHOLD_TOKENS;
	delete process.env.MEGACOMPACT_AUTO_PCT_TRIGGER;
	try {
		const h = harness({ keepTier: true, keepThreshold: true });
		const ctx = s29TieredCtx(h, {
			tokens: 6000,
			contextWindow: 10000,
			percent: null,
		});
		const res = await h.fire(
			"context",
			{ type: "context", messages: h.session },
			ctx,
		);
		assert.ok(
			res &&
				Array.isArray((res as any).messages) &&
				(res as any).messages.length < h.session.length,
			"pct==null on tiered: token fallback fires (NOT skipped) — S27 boot-fallback preserved",
		);
	} finally {
		delete process.env.MEGACOMPACT_TIER;
		delete process.env.MEGACOMPACT_ANCHOR_USER_MESSAGES;
	}
});

