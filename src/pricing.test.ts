/**
 * pricing.test.ts — computeCacheSavings + lookupModelInputRate unit tests.
 *
 * TDD (E.4): verifies fixture arithmetic, round4 behavior, and prefix/unknown lookups.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	computeCacheSavings,
	lookupModelInputRate,
	CACHE_READ_MULTIPLIER,
	CACHE_WRITE_MULTIPLIER,
} from "./pricing.js";

describe("pricing.ts", () => {
	describe("CACHE_READ_MULTIPLIER", () => {
		it("is 0.9 (90% discount on cache-read tokens)", () => {
			assert.equal(CACHE_READ_MULTIPLIER, 0.9);
		});
	});

	describe("CACHE_WRITE_MULTIPLIER", () => {
		it("is 0.25 (25% premium on cache-write tokens)", () => {
			assert.equal(CACHE_WRITE_MULTIPLIER, 0.25);
		});
	});

	describe("computeCacheSavings", () => {
		it("1,000,000 read tokens, 0 write at $3/1M → cacheReadSaved 2.7, netSaved 2.7", () => {
			const r = computeCacheSavings(1_000_000, 0, 3 / 1_000_000);
			assert.equal(r.cacheReadSaved, 2.7);
			assert.equal(r.cacheWriteCost, 0);
			assert.equal(r.netSaved, 2.7);
		});

		it("1,000,000 write tokens, 0 read at $3/1M → cacheWriteCost 0.75, netSaved -0.75", () => {
			const r = computeCacheSavings(0, 1_000_000, 3 / 1_000_000);
			assert.equal(r.cacheReadSaved, 0);
			assert.equal(r.cacheWriteCost, 0.75);
			assert.equal(r.netSaved, -0.75);
		});

		it("small token counts produce proportionally small values (no premature rounding)", () => {
			// 1 token at $1/1M = $0.000001 * 0.9 = 9e-7
			const r = computeCacheSavings(1, 0, 1 / 1_000_000);
			assert.ok(Math.abs(r.cacheReadSaved - 9e-7) < 1e-15);
		});

		it("10K read tokens at $3/1M → ~$0.027", () => {
			// 10,000 read tokens at $3/1M → $0.03 * 0.9 = $0.027
			const r = computeCacheSavings(10_000, 0, 3 / 1_000_000);
			assert.ok(Math.abs(r.cacheReadSaved - 0.027) < 1e-15);
		});

		it("both read and write: netSaved = readSaved - writeCost", () => {
			// 500K read, 200K write at $3/1M
			// readSaved = 500K * 3e-6 * 0.9 = 1.35
			// writeCost = 200K * 3e-6 * 0.25 = 0.15
			// net = 1.35 - 0.15 = 1.20
			const r = computeCacheSavings(500_000, 200_000, 3 / 1_000_000);
			assert.ok(Math.abs(r.cacheReadSaved - 1.35) < 1e-10);
			assert.ok(Math.abs(r.cacheWriteCost - 0.15) < 1e-10);
			assert.ok(Math.abs(r.netSaved - 1.2) < 1e-10);
		});

		it("zero inputRate → all zeros", () => {
			const r = computeCacheSavings(1_000_000, 1_000_000, 0);
			assert.equal(r.cacheReadSaved, 0);
			assert.equal(r.cacheWriteCost, 0);
			assert.equal(r.netSaved, 0);
		});
	});

	describe("lookupModelInputRate", () => {
		it("exact match returns the rate", () => {
			const rate = lookupModelInputRate("claude-sonnet-4-20250514");
			assert.ok(rate !== undefined, "expected a rate for claude-sonnet-4-20250514");
			assert.equal(rate, 3 / 1_000_000);
		});

		it("prefix match returns the rate (e.g. gpt-4o-mini prefix)", () => {
			const rate = lookupModelInputRate("gpt-4o-mini-2024-07-18");
			assert.ok(rate !== undefined, "expected a rate for gpt-4o-mini-2024-07-18");
		});

		it("unknown model returns undefined", () => {
			const rate = lookupModelInputRate("unknown-model-xyz-9999");
			assert.equal(rate, undefined);
		});
	});
});
