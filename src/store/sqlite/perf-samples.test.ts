/**
 * perf-samples.test.ts — v0.8.8 perf_samples table round-trip + filtering.
 * Pi-agnostic. Uses an isolated state dir (never the real user dir — G7).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { closeStore } from "./utils.js";
import {
	recordPerfSample,
	readPerfSamples,
	PERF_KINDS,
	readProviderCacheLifetime,
	readLatestCacheHitPct,
} from "./perf-samples.js";

describe("perf-samples (v0.8.8)", () => {
	let dir: string;
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "mc-perfsamples-"));
		process.env.MEGACOMPACT_STATE_DIR = dir;
	});
	after(() => {
		closeStore(dir);
		delete process.env.MEGACOMPACT_STATE_DIR;
		rmSync(dir, { recursive: true, force: true });
	});

	it("records + reads back a turn_latency_ms sample with parsed meta", () => {
		recordPerfSample(dir, "turn_latency_ms", 123.4, { turnIndex: 2 });
		const rows = readPerfSamples(dir, 0);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].kind, "turn_latency_ms");
		assert.equal(rows[0].value, 123.4);
		assert.deepEqual(rows[0].meta, { turnIndex: 2 });
	});

	it("filters by kind and by sinceTs", () => {
		recordPerfSample(dir, "tps", 50);
		recordPerfSample(dir, "rss_mb", 256);
		const tps = readPerfSamples(dir, 0, "tps");
		assert.equal(tps.length, 1);
		assert.equal(tps[0].kind, "tps");
		assert.equal(tps[0].value, 50);
		const future = readPerfSamples(dir, Date.now() + 10000, "tps");
		assert.equal(future.length, 0);
	});

	it("ignores non-finite values + unknown kinds (never throws, nothing added)", () => {
		const before = readPerfSamples(dir, 0).length;
		recordPerfSample(dir, "tps", Number.NaN);
		recordPerfSample(dir, "tps", Infinity);
		assert.doesNotThrow(() => recordPerfSample(dir, "bogus" as never, 1));
		const after = readPerfSamples(dir, 0).length;
		assert.equal(after, before);
	});

	it("PERF_KINDS lists the 10 instrumentation kinds", () => {
		assert.equal(PERF_KINDS.length, 10);
		assert.ok(PERF_KINDS.includes("db_recompute_ms"));
		assert.ok(PERF_KINDS.includes("cache_hit_pct"));
	});
});

// ─── Provider cache lifetime aggregate tests (A.4) — each test uses its
//     own clean stateDir so prior inserts never pollute later assertions. ───

describe("provider cache lifetime (A.4)", () => {
	let dir2: string;

	function freshDir(prefix: string) {
		if (dir2) {
			closeStore(dir2);
			rmSync(dir2, { recursive: true, force: true });
		}
		dir2 = mkdtempSync(join(tmpdir(), prefix));
		process.env.MEGACOMPACT_STATE_DIR = dir2;
	}

	after(() => {
		if (dir2) {
			closeStore(dir2);
			delete process.env.MEGACOMPACT_STATE_DIR;
			rmSync(dir2, { recursive: true, force: true });
		}
	});

	it("empty table returns zeros/nulls", () => {
		freshDir("mc-a4e-");
		const r = readProviderCacheLifetime(dir2);
		assert.equal(r.sampleCount, 0);
		assert.equal(r.avgHitPct, 0);
		assert.equal(r.totalCacheRead, 0);
		assert.equal(r.totalCacheWrite, 0);
		assert.equal(r.totalInput, 0);
		assert.equal(r.firstSampleAt, null);
		assert.equal(r.latestSampleAt, null);
	});

	it("rows with NULL meta are counted but contribute 0 tokens", () => {
		freshDir("mc-a4n-");
		recordPerfSample(dir2, "cache_hit_pct", 50, null);
		recordPerfSample(dir2, "cache_hit_pct", 60, null);
		const r = readProviderCacheLifetime(dir2);
		assert.equal(r.sampleCount, 2);
		assert.equal(r.totalCacheRead, 0);
		assert.equal(r.totalCacheWrite, 0);
		assert.equal(r.totalInput, 0);
	});

	it("partial meta — missing keys treated as 0", () => {
		freshDir("mc-a4p-");
		recordPerfSample(dir2, "cache_hit_pct", 42, { input: 1000 });
		const r = readProviderCacheLifetime(dir2);
		assert.equal(r.sampleCount, 1);
		assert.equal(r.totalCacheRead, 0);
		assert.equal(r.totalCacheWrite, 0);
		assert.equal(r.totalInput, 1000);
	});

	it("full rows produce correct sums + avg", () => {
		freshDir("mc-a4f-");
		// cacheRead=1000, cacheWrite=500, input=100 → hit% = 1000/1600=62.5%
		// cacheRead=500, cacheWrite=100, input=400  → hit% = 500/1000=50.0%
		// cacheRead=100, cacheWrite=200, input=700  → hit% = 100/1000=10.0%
		recordPerfSample(dir2, "cache_hit_pct", 55, {
			cacheRead: 1000,
			cacheWrite: 500,
			input: 100,
		});
		recordPerfSample(dir2, "cache_hit_pct", 56, {
			cacheRead: 500,
			cacheWrite: 100,
			input: 400,
		});
		recordPerfSample(dir2, "cache_hit_pct", 57, {
			cacheRead: 100,
			cacheWrite: 200,
			input: 700,
		});
		const r = readProviderCacheLifetime(dir2);
		assert.equal(r.sampleCount, 3);
		assert.equal(r.totalCacheRead, 1600);
		assert.equal(r.totalCacheWrite, 800);
		assert.equal(r.totalInput, 1200);
		// avg: (62.5 + 50.0 + 10.0) / 3 ≈ 40.833
		assert.ok(Math.abs(r.avgHitPct - 40.833) < 0.1);
		assert.ok(r.firstSampleAt != null);
		assert.ok(r.latestSampleAt != null);
		assert.ok(
			new Date(r.firstSampleAt!).getTime() <=
				new Date(r.latestSampleAt!).getTime(),
		);
	});

	it("readLatestCacheHitPct: empty → 0", () => {
		freshDir("mc-a4le-");
		assert.equal(readLatestCacheHitPct(dir2), 0);
	});

	it("readLatestCacheHitPct: most recent by ts, tie → highest id", () => {
		freshDir("mc-a4lm-");
		recordPerfSample(dir2, "cache_hit_pct", 20);
		recordPerfSample(dir2, "cache_hit_pct", 80);
		assert.equal(readLatestCacheHitPct(dir2), 80);
	});
});
