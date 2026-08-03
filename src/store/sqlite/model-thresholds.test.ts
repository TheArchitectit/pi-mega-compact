/**
 * model-thresholds.test.ts — per-model compaction thresholds DB layer (S52).
 *
 * Tests the model_thresholds table helpers: get/put/list/delete + the
 * resolveModelThreshold fallback logic that the context-handler uses to pick
 * the safety margin + fire point per model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	putModelThreshold,
	getModelThreshold,
	listModelThresholds,
	deleteModelThreshold,
	resolveModelThreshold,
	DEFAULT_SAFETY_MARGIN_PCT,
	DEFAULT_FIRE_POINT_PCT,
	MIN_SAFETY_MARGIN_PCT,
	MAX_SAFETY_MARGIN_PCT,
	MIN_FIRE_POINT_PCT,
	MAX_FIRE_POINT_PCT,
} from "./model-thresholds.js";
import { initSchema } from "./schema.js";
import { openStore } from "./utils.js";

function freshStateDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "mt-"));
	process.env.MEGACOMPACT_STATE_DIR = dir;
	const db = openStore(dir);
	initSchema(db);
	return dir;
}

test("putModelThreshold + getModelThreshold round-trip", () => {
	const dir = freshStateDir();
	const t = putModelThreshold("glm-5.2-short", 5, 70, dir);
	assert.equal(t.modelId, "glm-5.2-short");
	assert.equal(t.safetyMarginPct, 5);
	assert.equal(t.firePointPct, 70);
	assert.ok(t.updatedAt != null);

	const got = getModelThreshold("glm-5.2-short", dir);
	assert.ok(got, "row should exist after put");
	assert.equal(got!.modelId, "glm-5.2-short");
	assert.equal(got!.safetyMarginPct, 5);
	assert.equal(got!.firePointPct, 70);
});

test("putModelThreshold is an upsert (second put updates, not inserts)", () => {
	const dir = freshStateDir();
	putModelThreshold("glm-5.2-short", 5, 70, dir);
	putModelThreshold("glm-5.2-short", 3, 65, dir);
	const all = listModelThresholds(dir);
	assert.equal(all.length, 1, "only one row after two puts on same model");
	assert.equal(all[0].safetyMarginPct, 3);
	assert.equal(all[0].firePointPct, 65);
});

test("listModelThresholds returns all rows", () => {
	const dir = freshStateDir();
	putModelThreshold("model-a", 5, 70, dir);
	putModelThreshold("model-b", 10, 75, dir);
	putModelThreshold("model-c", 2, 60, dir);
	const all = listModelThresholds(dir);
	assert.equal(all.length, 3);
	// Order by updated_at DESC; with same-ms timestamps the order is
	// insertion-order-dependent, so just check all three are present.
	const ids = new Set(all.map((r) => r.modelId));
	assert.ok(ids.has("model-a"));
	assert.ok(ids.has("model-b"));
	assert.ok(ids.has("model-c"));
});

test("deleteModelThreshold removes the row", () => {
	const dir = freshStateDir();
	putModelThreshold("glm-5.2-short", 5, 70, dir);
	assert.ok(getModelThreshold("glm-5.2-short", dir));
	const deleted = deleteModelThreshold("glm-5.2-short", dir);
	assert.equal(deleted, true);
	assert.equal(getModelThreshold("glm-5.2-short", dir), null);
	// Deleting a non-existent row returns false.
	assert.equal(deleteModelThreshold("never-existed", dir), false);
});

test("resolveModelThreshold: per-model override wins when present", () => {
	const dir = freshStateDir();
	putModelThreshold("glm-5.2-short", 3, 65, dir);
	const r = resolveModelThreshold("glm-5.2-short", {
		safetyMarginFallback: 10,
		firePointFallback: 70,
		stateDir: dir,
	});
	assert.equal(r.safetyMarginPct, 3, "override safety wins");
	assert.equal(r.firePointPct, 65, "override fire wins");
});

test("resolveModelThreshold: falls back when no override exists", () => {
	const dir = freshStateDir();
	const r = resolveModelThreshold("nope", {
		safetyMarginFallback: 10,
		firePointFallback: 70,
		stateDir: dir,
	});
	assert.equal(r.safetyMarginPct, 10, "fallback safety");
	assert.equal(r.firePointPct, 70, "fallback fire");
});

test("resolveModelThreshold: null modelId falls back", () => {
	const dir = freshStateDir();
	putModelThreshold("some-model", 3, 65, dir);
	const r = resolveModelThreshold(null, {
		safetyMarginFallback: DEFAULT_SAFETY_MARGIN_PCT,
		firePointFallback: DEFAULT_FIRE_POINT_PCT,
		stateDir: dir,
	});
	assert.equal(r.safetyMarginPct, DEFAULT_SAFETY_MARGIN_PCT);
	assert.equal(r.firePointPct, DEFAULT_FIRE_POINT_PCT);
});

test("putModelThreshold rejects out-of-range safety margin", () => {
	const dir = freshStateDir();
	assert.throws(
		() => putModelThreshold("x", MAX_SAFETY_MARGIN_PCT + 1, 70, dir),
		/must be in \[0, 20\]/,
	);
	assert.throws(
		() => putModelThreshold("x", MIN_SAFETY_MARGIN_PCT - 1, 70, dir),
		/must be in \[0, 20\]/,
	);
});

test("putModelThreshold rejects out-of-range fire point", () => {
	const dir = freshStateDir();
	assert.throws(
		() => putModelThreshold("x", 5, MAX_FIRE_POINT_PCT + 1, dir),
		/must be in \[10, 90\]/,
	);
	assert.throws(
		() => putModelThreshold("x", 5, MIN_FIRE_POINT_PCT - 1, dir),
		/must be in \[10, 90\]/,
	);
});

test("putModelThreshold rejects non-finite values", () => {
	const dir = freshStateDir();
	assert.throws(() => putModelThreshold("x", NaN, 70, dir), /finite number/);
	assert.throws(
		() => putModelThreshold("x", 5, Infinity, dir),
		/finite number/,
	);
});

test("putModelThreshold rejects empty modelId", () => {
	const dir = freshStateDir();
	assert.throws(() => putModelThreshold("", 5, 70, dir), /modelId is required/);
});
