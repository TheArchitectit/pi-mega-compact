/**
 * windowing-prefixbreaks.test.ts — ?minutes= windowing + byModel + prefixBreaks tests.
 * Split from routes-cache.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordPerfSample, openStore } from "../../../src/store/sqlite.js";
import { freshDir, withServer, type ProviderCacheResponse, type ProviderCacheByModel } from "./_helpers.js";

test("GET 200 — windowMinutes: null when no minutes param", async () => {
	const dir = freshDir("dash-pcwin-none-");
	recordPerfSample(dir, "cache_hit_pct", 50, { cacheRead: 100, cacheWrite: 20, input: 500 });
	await withServer("19459", dir, async (port) => {
		const res = await fetch(`http://localhost:${port}/api/provider-cache`);
		assert.equal(res.status, 200);
		const body = (await res.json()) as ProviderCacheResponse;
		assert.equal(body.windowMinutes, null);
	});
});

test("GET 200 — ?minutes=30 filters to recent samples only", async () => {
	const dir = freshDir("dash-pcwin30-");
	const now = Date.now();
	const oldTs = now - 120_000;
	const recentTs = now - 10_000;
	const db = openStore(dir);
	db.prepare(
		`INSERT INTO perf_samples (ts, kind, value, meta) VALUES (?, ?, ?, ?)`,
	).run(oldTs, "cache_hit_pct", 50, JSON.stringify({ cacheRead: 100, cacheWrite: 100, input: 800 }));
	db.prepare(
		`INSERT INTO perf_samples (ts, kind, value, meta) VALUES (?, ?, ?, ?)`,
	).run(recentTs, "cache_hit_pct", 80, JSON.stringify({ cacheRead: 800, cacheWrite: 100, input: 100 }));
	await withServer("19460", dir, async (port) => {
		const res = await fetch(`http://localhost:${port}/api/provider-cache?minutes=1`);
		assert.equal(res.status, 200);
		const body = (await res.json()) as ProviderCacheResponse;
		assert.equal(body.windowMinutes, 1);
		assert.equal(body.cache.turnCount, 1, "only the recent sample");
		assert.equal(body.cache.totalCacheRead, 800);
	});
});

test("GET 200 — ?minutes=abc falls back to lifetime, windowMinutes null", async () => {
	const dir = freshDir("dash-pcwin-bad-");
	recordPerfSample(dir, "cache_hit_pct", 50, { cacheRead: 100, cacheWrite: 20, input: 500 });
	await withServer("19461", dir, async (port) => {
		const res = await fetch(`http://localhost:${port}/api/provider-cache?minutes=abc`);
		assert.equal(res.status, 200);
		const body = (await res.json()) as ProviderCacheResponse;
		assert.equal(body.windowMinutes, null);
		assert.equal(body.cache.turnCount, 1);
	});
});

test("GET 200 — byModel in lifetime and windowed (F4)", async () => {
	const dir = freshDir("dash-f4bm-");
	const now = Date.now();
	const db = openStore(dir);
	db.prepare(
		`INSERT INTO perf_samples (ts, kind, value, meta) VALUES (?, ?, ?, ?)`,
	).run(now - 120_000, "cache_hit_pct", 90, JSON.stringify({ cacheRead: 900, cacheWrite: 50, input: 50, modelName: "Sonnet Model" }));
	db.prepare(
		`INSERT INTO perf_samples (ts, kind, value, meta) VALUES (?, ?, ?, ?)`,
	).run(now - 10_000, "cache_hit_pct", 80, JSON.stringify({ cacheRead: 800, cacheWrite: 100, input: 100, modelName: "Sonnet Model" }));
	db.prepare(
		`INSERT INTO perf_samples (ts, kind, value, meta) VALUES (?, ?, ?, ?)`,
	).run(now - 5_000, "cache_hit_pct", 50, JSON.stringify({ cacheRead: 500, cacheWrite: 200, input: 300, modelName: "GPT Model" }));
	db.prepare(
		`INSERT INTO perf_samples (ts, kind, value, meta) VALUES (?, ?, ?, ?)`,
	).run(now, "cache_hit_pct", 60, JSON.stringify({ cacheRead: 100, cacheWrite: 50, input: 50 }));

	await withServer("19462", dir, async (port) => {
		const res1 = await fetch(`http://localhost:${port}/api/provider-cache`);
		assert.equal(res1.status, 200);
		const body1 = (await res1.json()) as ProviderCacheResponse;
		assert.equal(body1.cache.turnCount, 4, "4 samples total");
		assert.ok(Array.isArray(body1.cache.byModel), "byModel is array");
		assert.equal(body1.cache.byModel.length, 2, "2 models; untagged omitted");

		const sonnet = body1.cache.byModel.find((m: ProviderCacheByModel) => m.model === "Sonnet Model")!;
		assert.ok(sonnet, "Sonnet Model present");
		assert.equal(sonnet.sampleCount, 2);
		assert.equal(sonnet.totalCacheRead, 1700);

		const gpt = body1.cache.byModel.find((m: ProviderCacheByModel) => m.model === "GPT Model")!;
		assert.ok(gpt, "GPT Model present");
		assert.equal(gpt.sampleCount, 1);
		assert.equal(gpt.totalCacheRead, 500);

		const res2 = await fetch(`http://localhost:${port}/api/provider-cache?minutes=30`);
		assert.equal(res2.status, 200);
		const body2 = (await res2.json()) as ProviderCacheResponse;
		assert.equal(body2.windowMinutes, 30);
		assert.equal(body2.cache.byModel.length, 2, "windowed also has 2 models");
	});
});

test("GET 200 — prefixBreaks: empty array when no prefix_break rows", async () => {
	const dir = freshDir("dash-pb-empty-");
	recordPerfSample(dir, "cache_hit_pct", 50, { cacheRead: 100, input: 100 });
	await withServer("19463", dir, async (port) => {
		const res = await fetch(`http://localhost:${port}/api/provider-cache`);
		assert.equal(res.status, 200);
		const body = (await res.json()) as ProviderCacheResponse;
		assert.ok(Array.isArray(body.prefixBreaks), "prefixBreaks is an array");
		assert.equal(body.prefixBreaks.length, 0, "no prefix_break rows → empty array");
	});
});

test("GET 200 — prefixBreaks: returned when prefix_break rows exist", async () => {
	const dir = freshDir("dash-pb-read-");
	const now = Date.now();
	const db = openStore(dir);
	db.prepare(
		`INSERT INTO perf_samples (ts, kind, value, meta) VALUES (?, ?, ?, ?)`,
	).run(now - 5000, "cache_hit_pct", 80, JSON.stringify({ cacheRead: 80, cacheWrite: 10, input: 10 }));
	db.prepare(
		`INSERT INTO perf_samples (ts, kind, value, meta) VALUES (?, ?, ?, ?)`,
	).run(now - 5000, "prefix_break", 0, JSON.stringify({ cause: "compaction", confidence: 0.95, prevHitPct: 80, currHitPct: 10, breakAt: now - 5000 }));
	db.prepare(
		`INSERT INTO perf_samples (ts, kind, value, meta) VALUES (?, ?, ?, ?)`,
	).run(now - 1000, "prefix_break", 0, JSON.stringify({ cause: "recall", confidence: 1.0, prevHitPct: 60, currHitPct: 5, breakAt: now - 1000 }));

	await withServer("19464", dir, async (port) => {
		const res = await fetch(`http://localhost:${port}/api/provider-cache`);
		assert.equal(res.status, 200);
		const body = (await res.json()) as ProviderCacheResponse;
		assert.equal(body.prefixBreaks.length, 2, "two prefix_break rows");
		assert.equal(body.prefixBreaks[0].cause, "compaction");
		assert.equal(body.prefixBreaks[0].confidence, 0.95);
		assert.equal(body.prefixBreaks[0].prevHitPct, 80);
		assert.equal(body.prefixBreaks[0].currHitPct, 10);
		assert.equal(body.prefixBreaks[1].cause, "recall");
		assert.equal(body.prefixBreaks[1].confidence, 1.0);
		assert.equal(body.prefixBreaks[1].prevHitPct, 60);
		assert.equal(body.prefixBreaks[1].currHitPct, 5);
		assert.equal(typeof body.prefixBreaks[0].id, "number");
		assert.equal(typeof body.prefixBreaks[0].ts, "number");
		assert.equal(typeof body.prefixBreaks[0].breakAt, "number");
	});
});

test("GET 200 — ?since=&until= filters prefixBreaks by time window", async () => {
	const dir = freshDir("dash-pb-win-");
	const now = Date.now();
	const db = openStore(dir);
	db.prepare(
		`INSERT INTO perf_samples (ts, kind, value, meta) VALUES (?, ?, ?, ?)`,
	).run(now - 5000, "cache_hit_pct", 80, JSON.stringify({ cacheRead: 80, cacheWrite: 10, input: 10 }));
	db.prepare(
		`INSERT INTO perf_samples (ts, kind, value, meta) VALUES (?, ?, ?, ?)`,
	).run(now - 120_000, "prefix_break", 0, JSON.stringify({ cause: "recall", confidence: 1.0, prevHitPct: 80, currHitPct: 5, breakAt: now - 120_000 }));
	db.prepare(
		`INSERT INTO perf_samples (ts, kind, value, meta) VALUES (?, ?, ?, ?)`,
	).run(now - 10_000, "prefix_break", 0, JSON.stringify({ cause: "compaction", confidence: 0.9, prevHitPct: 70, currHitPct: 3, breakAt: now - 10_000 }));

	await withServer("19465", dir, async (port) => {
		const since = now - 60_000;
		const res = await fetch(`http://localhost:${port}/api/provider-cache?since=${since}&until=${now}`);
		assert.equal(res.status, 200);
		const body = (await res.json()) as ProviderCacheResponse;
		assert.equal(body.prefixBreaks.length, 1, "only the recent prefix_break in window");
		assert.equal(body.prefixBreaks[0].cause, "compaction");
	});
});

test("GET 200 — ?since= with no until → no upper bound", async () => {
	const dir = freshDir("dash-pb-since-");
	const now = Date.now();
	const db = openStore(dir);
	db.prepare(
		`INSERT INTO perf_samples (ts, kind, value, meta) VALUES (?, ?, ?, ?)`,
	).run(now - 5000, "cache_hit_pct", 80, JSON.stringify({ cacheRead: 80, cacheWrite: 10, input: 10 }));
	db.prepare(
		`INSERT INTO perf_samples (ts, kind, value, meta) VALUES (?, ?, ?, ?)`,
	).run(now - 300_000, "prefix_break", 0, JSON.stringify({ cause: "recall", confidence: 1.0, prevHitPct: 80, currHitPct: 5, breakAt: now - 300_000 }));
	db.prepare(
		`INSERT INTO perf_samples (ts, kind, value, meta) VALUES (?, ?, ?, ?)`,
	).run(now - 5000, "prefix_break", 0, JSON.stringify({ cause: "inject", confidence: 0.8, prevHitPct: 60, currHitPct: 4, breakAt: now - 5000 }));

	await withServer("19466", dir, async (port) => {
		const since = now - 60_000;
		const res = await fetch(`http://localhost:${port}/api/provider-cache?since=${since}`);
		assert.equal(res.status, 200);
		const body = (await res.json()) as ProviderCacheResponse;
		assert.equal(body.prefixBreaks.length, 1, "only recent prefix_break with since-only");
		assert.equal(body.prefixBreaks[0].cause, "inject");
	});
});

test("GET 200 — invalid since/until fall back to lifetime (prefixBreaks empty)", async () => {
	const dir = freshDir("dash-pb-bad-");
	recordPerfSample(dir, "cache_hit_pct", 50, { cacheRead: 100, input: 100 });
	await withServer("19467", dir, async (port) => {
		const res = await fetch(`http://localhost:${port}/api/provider-cache?since=abc&until=xyz`);
		assert.equal(res.status, 200);
		const body = (await res.json()) as ProviderCacheResponse;
		assert.ok(Array.isArray(body.prefixBreaks));
	});
});
