/**
 * aggregation.test.ts — basic GET /api/provider-cache shape + aggregation tests.
 * Split from routes-cache.test.ts; test bodies are unchanged.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { recordPerfSample } from "../../../src/store/sqlite.js";
import { freshDir, withServer, type ProviderCacheResponse } from "./_helpers.js";

describe("/api/provider-cache", () => {
	test("GET 200 — shape matches ProviderCacheResponse", async () => {
		const dir = freshDir("dash-pcache-agg-");
		recordPerfSample(dir, "cache_hit_pct", 42, { cacheRead: 100, cacheWrite: 20, input: 500 });
		await withServer("19450", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/provider-cache`);
			assert.equal(res.status, 200);
			const body = (await res.json()) as ProviderCacheResponse;
			assert.ok("cache" in body, "should have cache");
			assert.ok("savings" in body, "should have savings");
			assert.ok("updatedAt" in body, "should have updatedAt");
			assert.equal(body.cache.turnCount, 1);
			assert.equal(body.cache.totalCacheRead, 100);
			assert.equal(body.cache.totalCacheWrite, 20);
			assert.equal(body.cache.totalInput, 500);
			assert.ok(typeof body.cache.firstTurnAt === "string");
			assert.ok(typeof body.cache.latestTurnAt === "string");
			assert.ok(typeof body.updatedAt === "string");
		});
	});

	test("GET 200 — empty perf_samples returns zeros/nulls", async () => {
		const dir = freshDir("dash-pcache-empty-");
		await withServer("19451", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/provider-cache`);
			assert.equal(res.status, 200);
			const body = (await res.json()) as ProviderCacheResponse;
			assert.equal(body.cache.turnCount, 0);
			assert.equal(body.cache.avgHitPct, 0);
			assert.equal(body.cache.totalCacheRead, 0);
			assert.equal(body.cache.totalCacheWrite, 0);
			assert.equal(body.cache.totalInput, 0);
			assert.equal(body.cache.firstTurnAt, null);
			assert.equal(body.cache.latestTurnAt, null);
			assert.equal(body.savings, null);
		});
	});

	test("POST → 405", async () => {
		const dir = freshDir("dash-pcache-meth-");
		await withServer("19452", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/provider-cache`, { method: "POST" });
			assert.equal(res.status, 405);
			const body = (await res.json()) as { error: string };
			assert.equal(body.error, "method_not_allowed");
		});
	});

	test("partial meta (missing fields) → treated as 0", async () => {
		const dir = freshDir("dash-pcache-partial-");
		recordPerfSample(dir, "cache_hit_pct", 30, { input: 800 });
		recordPerfSample(dir, "cache_hit_pct", 60, { cacheRead: 150 });
		await withServer("19455", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/provider-cache`);
			assert.equal(res.status, 200);
			const body = (await res.json()) as ProviderCacheResponse;
			assert.equal(body.cache.turnCount, 2);
			assert.equal(body.cache.totalCacheRead, 150);
			assert.equal(body.cache.totalCacheWrite, 0);
			assert.equal(body.cache.totalInput, 800);
		});
	});

	test("NULL meta → counted in turnCount, contributes 0 tokens + 0 avg", async () => {
		const dir = freshDir("dash-pcache-nullmeta-");
		recordPerfSample(dir, "cache_hit_pct", 25, undefined);
		await withServer("19456", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/provider-cache`);
			assert.equal(res.status, 200);
			const body = (await res.json()) as ProviderCacheResponse;
			assert.equal(body.cache.turnCount, 1);
			assert.equal(body.cache.avgHitPct, 0);
			assert.equal(body.cache.totalCacheRead, 0);
			assert.equal(body.cache.totalCacheWrite, 0);
			assert.equal(body.cache.totalInput, 0);
		});
	});
});
