// contextHealth.test.ts — Sprint H (B2): the 6th health axis `storeErrorRate`.
// Verifies computeHealthScore's rebalanced weights (0.09/0.09 split) + axis
// independence (a store-error storm dents the composite exactly as much as an
// API-error storm). Pure-function tests; no I/O.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeHealthScore, type ContextHealthSubScores } from "./contextHealth.js";

const allHealthy: ContextHealthSubScores = {
	drift: 1,
	outputQuality: 1,
	errorRate: 1,
	cacheHealth: 1,
	cachePoison: 1,
	storeErrorRate: 1,
};

test("computeHealthScore: all-healthy → 1.0", () => {
	assert.equal(computeHealthScore(allHealthy), 1.0);
});

test("computeHealthScore: weights sum to 1.0 (6 axes)", () => {
	// Each axis alone at 0 (others 1.0) drops the composite by its weight.
	// 0.22 + 0.22 + 0.20 + 0.18 + 0.09 + 0.09 = 1.00
	const cases: Array<[keyof ContextHealthSubScores, number]> = [
		["drift", 0.22],
		["outputQuality", 0.22],
		["cachePoison", 0.20],
		["cacheHealth", 0.18],
		["errorRate", 0.09],
		["storeErrorRate", 0.09],
	];
	let sum = 0;
	for (const [axis, weight] of cases) {
		const sub = { ...allHealthy, [axis]: 0 };
		const drop = 1.0 - computeHealthScore(sub);
		sum += weight;
		assert.equal(
			Math.abs(drop - weight) < 1e-9,
			true,
			`axis ${axis}: drop ${drop} ≠ weight ${weight}`,
		);
	}
	assert.equal(Math.abs(sum - 1.0) < 1e-9, true, `weights sum ${sum} ≠ 1.0`);
});

test("storeErrorRate is a SEPARATE axis from errorRate (equal weight 0.09)", () => {
	// A store-error storm (storeErrorRate=0, errorRate=1) drops the composite
	// by exactly 0.09 — NOT 0.18 (would mean folded) and NOT 0 (would mean
	// invisible, the Finding-3 bug).
	const storeOnly = { ...allHealthy, storeErrorRate: 0 };
	assert.ok(Math.abs(computeHealthScore(storeOnly) - 0.91) < 1e-9);

	// An API-error storm (errorRate=0, storeErrorRate=1) drops by the same 0.09.
	const apiOnly = { ...allHealthy, errorRate: 0 };
	assert.ok(Math.abs(computeHealthScore(apiOnly) - 0.91) < 1e-9);

	// Both failing drops by 0.18 (the two axes are additive, not folded).
	const both = { ...allHealthy, errorRate: 0, storeErrorRate: 0 };
	assert.ok(Math.abs(computeHealthScore(both) - 0.82) < 1e-9);
});

test("storeErrorRate is independent: changing it does not affect the errorRate input", () => {
	// The whole point of B2 — a store failure must show up without being
	// masked by a healthy API error rate (Finding 3: errorRate was 1.0 while
	// 557 store errors accumulated). With errorRate=1 (healthy API) and
	// storeErrorRate=0 (store failing), the composite is 0.91, NOT 1.0.
	const healthyApiFailingStore = { ...allHealthy, errorRate: 1, storeErrorRate: 0 };
	assert.notEqual(computeHealthScore(healthyApiFailingStore), 1.0);
	assert.ok(Math.abs(computeHealthScore(healthyApiFailingStore) - 0.91) < 1e-9);
});

test("ContextHealthSubScores requires storeErrorRate (compile-time contract)", () => {
	// If storeErrorRate were optional or absent, this would not type-check.
	const sub: ContextHealthSubScores = { ...allHealthy, storeErrorRate: 0.5 };
	assert.equal(typeof sub.storeErrorRate, "number");
});
