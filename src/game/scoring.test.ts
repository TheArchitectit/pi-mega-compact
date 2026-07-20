/**
 * scoring.test.ts — S33 pure scoring helpers. Pi-agnostic, no I/O.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { turnLevel, isMegaCache, cacheScore } from "./scoring.js";

describe("scoring (S33)", () => {
	it("turnLevel: floor(log2(n+1))+1 sequence", () => {
		assert.equal(turnLevel(0), 1);
		assert.equal(turnLevel(1), 2);
		assert.equal(turnLevel(2), 2);
		assert.equal(turnLevel(3), 3);
		assert.equal(turnLevel(4), 3);
		assert.equal(turnLevel(7), 4);
		assert.equal(turnLevel(15), 5);
		// defensive: non-finite / negative inputs collapse to level 1
		assert.equal(turnLevel(-1), 1);
		assert.equal(turnLevel(NaN), 1);
	});

	it("isMegaCache: 100% is the boundary", () => {
		assert.equal(isMegaCache(99.9), false);
		assert.equal(isMegaCache(100), true);
		assert.equal(isMegaCache(150), true);
		assert.equal(isMegaCache(0), false);
		assert.equal(isMegaCache(NaN), false);
	});

	it("cacheScore: 0 lookups -> 0 (not NaN), else hits/lookups*100", () => {
		assert.equal(cacheScore(0, 0), 0);
		assert.equal(cacheScore(7, 10), 70);
		assert.equal(cacheScore(0, 5), 0);
		assert.equal(cacheScore(10, 10), 100);
		// non-finite inputs are guarded (no NaN leaks)
		assert.equal(cacheScore(1, NaN), 0);
		assert.equal(cacheScore(NaN, 5), 0);
	});
});
