/**
 * tier-thresholds.test.ts — named compaction tiers + explicit threshold override.
 * Split from mega-compact.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./_helpers.js";

const TIER_CASES: Array<[string, number]> = [
	["low", 1_000_000], // 0.50 × 2_000_000
	["medium", 1_200_000], // 0.60 × 2_000_000
	["high", 1_400_000], // 0.70 × 2_000_000
	["ultra", 1_400_000], // 0.70 × 2_000_000
	["mega", 1_500_000], // 0.75 × 2_000_000
];
for (const [tier, threshold] of TIER_CASES) {
	test(`tier "${tier}" resolves to a ${threshold.toLocaleString()}-token threshold (tierPct × 2M window; live band shown separately)`, async () => {
		// Keep tier + keep threshold UNSET so the tier (not an explicit number)
		// drives the threshold. harness() would otherwise reset the threshold.
		delete process.env.MEGACOMPACT_THRESHOLD_TOKENS;
		process.env.MEGACOMPACT_TIER = tier;
		const h = harness({ keepTier: true, keepThreshold: true });
		// tokens=1 against a 2M window → near-zero pressure → live band "low".
		const ctx = h.ctx({
			getContextUsage: () => ({
				tokens: 1,
				contextWindow: 2_000_000,
				percent: 0.01,
			}),
		});
		await h.commands["mega-status"].handler("", ctx);
		delete process.env.MEGACOMPACT_TIER;
		// /mega-status renders threshold with toLocaleString() (thousands commas).
		assert.ok(
			h.notifies.some(
				(n) =>
					n.includes(`preset=${tier}`) &&
					n.includes(`threshold=${threshold.toLocaleString()}`),
			),
			`status should report preset=${tier} threshold=${threshold.toLocaleString()} (tierPct × 2M window)`,
		);
		// S24: the headline tier is the LIVE pressure band, shown as "tier=low (live)".
		assert.ok(
			h.notifies.some((n) => n.includes("tier=low (live)")),
			"live band reported (low at near-zero pressure)",
		);
	});
}

for (const [tier, threshold] of TIER_CASES) {
	test(`tier "${tier}" resolves to a ${threshold.toLocaleString()}-token threshold (tierPct × 2M window; live band shown separately)`, async () => {
		// Keep tier + keep threshold UNSET so the tier (not an explicit number)
		// drives the threshold. harness() would otherwise reset the threshold.
		delete process.env.MEGACOMPACT_THRESHOLD_TOKENS;
		process.env.MEGACOMPACT_TIER = tier;
		const h = harness({ keepTier: true, keepThreshold: true });
		// tokens=1 against a 2M window → near-zero pressure → live band "low".
		const ctx = h.ctx({
			getContextUsage: () => ({
				tokens: 1,
				contextWindow: 2_000_000,
				percent: 0.01,
			}),
		});
		await h.commands["mega-status"].handler("", ctx);
		delete process.env.MEGACOMPACT_TIER;
		// /mega-status renders threshold with toLocaleString() (thousands commas).
		assert.ok(
			h.notifies.some(
				(n) =>
					n.includes(`preset=${tier}`) &&
					n.includes(`threshold=${threshold.toLocaleString()}`),
			),
			`status should report preset=${tier} threshold=${threshold.toLocaleString()} (tierPct × 2M window)`,
		);
		// S24: the headline tier is the LIVE pressure band, shown as "tier=low (live)".
		assert.ok(
			h.notifies.some((n) => n.includes("tier=low (live)")),
			"live band reported (low at near-zero pressure)",
		);
	});
}

test("explicit MEGACOMPACT_THRESHOLD_TOKENS overrides the tier", async () => {
	process.env.MEGACOMPACT_TIER = "mega";
	process.env.MEGACOMPACT_THRESHOLD_TOKENS = "777";
	const h = harness({ keepTier: true, keepThreshold: true });
	const ctx = h.ctx({
		getContextUsage: () => ({
			tokens: 1,
			contextWindow: 2_000_000,
			percent: 0.01,
		}),
	});
	await h.commands["mega-status"].handler("", ctx);
	delete process.env.MEGACOMPACT_TIER;
	assert.ok(
		h.notifies.some(
			(n) => n.includes("preset=custom") && n.includes("threshold=777"),
		),
		"explicit threshold wins over tier (preset=custom)",
	);
});

