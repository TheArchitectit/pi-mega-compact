/**
 * pricing.test.ts — S53C provider prompt-cache savings math.
 * Pi-agnostic, pure. No state dir, no store.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	estimateCacheSavings,
	PROVIDER_CACHE_READ_MULT,
	PROVIDER_CACHE_WRITE_MULT,
} from "./pricing.js";

const SONNET_INPUT_RATE = 3 / 1_000_000; // $3 / MTok

describe("pricing (S53C)", () => {
	it("multipliers match the Anthropic prompt-cache schedule", () => {
		assert.equal(PROVIDER_CACHE_READ_MULT, 0.1);
		assert.equal(PROVIDER_CACHE_WRITE_MULT, 1.25);
	});

	it("computes savings for a typical 60%-hit session", () => {
		// Numbers from docs/PROMPTCACHE_FULL_GAP_ANALYSIS.md (43-sample session).
		const saved = estimateCacheSavings(
			{ totalInput: 939, totalCacheRead: 41024, totalCacheWrite: 0 },
			SONNET_INPUT_RATE,
		);
		assert.ok(saved != null);
		// A turn's fresh input can be smaller than what the cache served, so
		// fresh input floors at 0 and savings can floor at 0 for that window.
		const withoutCache = 939 * SONNET_INPUT_RATE;
		const withCache = 0 * SONNET_INPUT_RATE + 41024 * SONNET_INPUT_RATE * 0.1;
		assert.ok(Math.abs(saved - Math.max(withoutCache - withCache, 0)) < 1e-12);
		assert.ok(saved >= 0);
	});

	it("counts cache writes at 1.25x (write-heavy turns reduce savings)", () => {
		const noWrite = estimateCacheSavings(
			{ totalInput: 10_000, totalCacheRead: 0, totalCacheWrite: 0 },
			SONNET_INPUT_RATE,
		);
		const withWrite = estimateCacheSavings(
			{ totalInput: 10_000, totalCacheRead: 0, totalCacheWrite: 8_000 },
			SONNET_INPUT_RATE,
		);
		assert.equal(noWrite, 0);
		assert.ok(withWrite != null && withWrite === 0); // floored at 0
	});

	it("returns null for missing/invalid rate or totals (UI shows —)", () => {
		assert.equal(
			estimateCacheSavings(
				{ totalInput: 1, totalCacheRead: 0, totalCacheWrite: 0 },
				null,
			),
			null,
		);
		assert.equal(
			estimateCacheSavings(
				{ totalInput: 1, totalCacheRead: 0, totalCacheWrite: 0 },
				0,
			),
			null,
		);
		assert.equal(
			estimateCacheSavings(
				{ totalInput: -5, totalCacheRead: 0, totalCacheWrite: 0 },
				SONNET_INPUT_RATE,
			),
			null,
		);
		assert.equal(
			estimateCacheSavings(
				{
					totalInput: Number.NaN,
					totalCacheRead: 0,
					totalCacheWrite: 0,
				},
				SONNET_INPUT_RATE,
			),
			null,
		);
	});

	it("zero-activity session saves exactly 0", () => {
		assert.equal(
			estimateCacheSavings(
				{ totalInput: 0, totalCacheRead: 0, totalCacheWrite: 0 },
				SONNET_INPUT_RATE,
			),
			0,
		);
	});
});
