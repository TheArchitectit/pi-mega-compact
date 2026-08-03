/**
 * recall/hydeTelemetry.test.ts — pure builder unit tests.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHydeInfo, hydeSkipped } from "./hydeTelemetry.js";

test("buildHydeInfo: ran with lift", () => {
	const info = buildHydeInfo("ran", "hypo doc", 42, 4, 6, 5);
	assert.equal(info.ran, true);
	assert.equal(info.skipped, false);
	assert.equal(info.reason, "ran");
	assert.equal(info.hypotheticalDoc, "hypo doc");
	assert.equal(info.generationMs, 42);
	assert.equal(info.rawHitCount, 4);
	assert.equal(info.hydeHitCount, 6);
	assert.equal(info.fusedHitCount, 5);
	assert.equal(info.lift, 1.25);
});

test("buildHydeInfo: generation-failed zeroes hyde-only fields", () => {
	const info = buildHydeInfo("generation-failed", "", 0, 4, 0, 4);
	assert.equal(info.ran, false);
	assert.equal(info.skipped, true);
	assert.equal(info.generationMs, 0);
	assert.equal(info.hydeHitCount, 0);
	assert.equal(info.hypotheticalDoc, "");
	assert.equal(info.lift, 1);
});

test("buildHydeInfo: no raw hits never divides by zero", () => {
	const info = buildHydeInfo("ran", "doc", 5, 0, 0, 3);
	assert.equal(info.rawHitCount, 0);
	assert.equal(info.lift, 3);
});

test("hydeSkipped: disabled shape", () => {
	const info = hydeSkipped("disabled", 4, 4);
	assert.equal(info.reason, "disabled");
	assert.equal(info.ran, false);
	assert.equal(info.hydeHitCount, 0);
});
