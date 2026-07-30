/**
 * embedder-cache.test.ts — S53B embedder LRU cache tests.
 *
 * The embedder's in-process LRU is deterministic: same text → same vector,
 * cache hit returns a defensive copy (mutating the caller's copy doesn't
 * corrupt the cache), and the cap is respected.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { TrigramEmbedder } from "./embedder.js";

describe("TrigramEmbedder LRU cache (S53B)", () => {
	const origFlag = process.env.MEGACOMPACT_EMBED_CACHE;

	beforeEach(() => {
		delete process.env.MEGACOMPACT_EMBED_CACHE;
	});

	afterEach(() => {
		if (origFlag !== undefined) {
			process.env.MEGACOMPACT_EMBED_CACHE = origFlag;
		} else {
			delete process.env.MEGACOMPACT_EMBED_CACHE;
		}
	});

	it("returns identical vectors for repeated calls (deterministic + cached)", () => {
		const e = new TrigramEmbedder(64);
		const v1 = e.embed("hello world");
		const v2 = e.embed("hello world");
		assert.deepStrictEqual(v1, v2);
		assert.equal(e.cacheSize, 1, "second call should hit cache (size stays 1)");
	});

	it("cache hit returns a defensive copy (mutation safety)", () => {
		const e = new TrigramEmbedder(64);
		const v1 = e.embed("mutation test");
		v1[0] = 999; // mutate the caller's copy
		const v2 = e.embed("mutation test");
		assert.notEqual(v2[0], 999, "cached vector must not reflect caller mutation");
	});

	it("cache respects the cap (256 unique texts)", () => {
		const e = new TrigramEmbedder(32);
		// Fill beyond the cap — 300 unique texts.
		for (let i = 0; i < 300; i++) {
			e.embed(`unique-text-${i}`);
		}
		// Cache cap is 256 (FIFO). Verify the cache is capped.
		assert.ok(e.cacheSize <= 256, "cache should not exceed cap");
		// The first text should have been evicted (FIFO). Re-embedding it
		// won't poison the cache (it just recomputes).
		const vFresh = e.embed("unique-text-0");
		const vExpected = new TrigramEmbedder(32).embed("unique-text-0");
		assert.deepStrictEqual(vFresh, vExpected, "fresh vector must be correct after eviction");
	});

	it("MEGACOMPACT_EMBED_CACHE=0 disables caching", () => {
		process.env.MEGACOMPACT_EMBED_CACHE = "0";
		const e = new TrigramEmbedder(64);
		e.embed("hello");
		e.embed("hello");
		assert.equal(e.cacheSize, 0, "cache disabled → nothing stored");
	});
});
