/**
 * sqlite.cachehit.test.ts — tests for the live dashboard counters
 * (incCompactCount / getCompactCount, incRecallInjected / getRecallInjected,
 * incCacheHitTokens / getCacheHitTokensSaved). These reuse the schemaless
 * `meta` integer counter, so no migration is required and the same on-disk
 * SQLite store persists the tallies across (re)opens.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	openStore,
	incCompactCount,
	getCompactCount,
	incRecallInjected,
	getRecallInjected,
	incCacheHitTokens,
	getCacheHitTokensSaved,
} from "./sqlite.js";

describe("live dashboard counters (meta integers)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cachehit-test-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("increments + reads compact_count and persists on reopen", () => {
		incCompactCount(dir);
		incCompactCount(dir);
		assert.equal(getCompactCount(dir), 2);
		// Ensure the store handle is (re)opened and the value is read back from disk.
		openStore(dir);
		assert.equal(getCompactCount(dir), 2);
	});

	it("accumulates recall injections + cache-hit tokens", () => {
		incRecallInjected(3, dir);
		incRecallInjected(2, dir);
		assert.equal(getRecallInjected(dir), 5);
		incCacheHitTokens(1200, dir);
		incCacheHitTokens(800, dir);
		assert.equal(getCacheHitTokensSaved(dir), 2000);
	});

	it("ignores non-positive increments (no-op)", () => {
		incRecallInjected(0, dir);
		incRecallInjected(-5, dir);
		incCacheHitTokens(0, dir);
		assert.equal(getRecallInjected(dir), 0);
		assert.equal(getCacheHitTokensSaved(dir), 0);
	});

	it("persists all three counters across a fresh openStore handle", () => {
		incCompactCount(dir);
		incRecallInjected(4, dir);
		incCacheHitTokens(500, dir);
		// openStore returns the canonical (on-disk) handle; reading back proves durability.
		openStore(dir);
		assert.equal(getCompactCount(dir), 1);
		assert.equal(getRecallInjected(dir), 4);
		assert.equal(getCacheHitTokensSaved(dir), 500);
	});
});
