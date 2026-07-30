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
	readProviderCacheStats,
	PERF_KINDS,
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
		assert.doesNotThrow(() =>
			recordPerfSample(dir, "bogus" as never, 1),
		);
		const after = readPerfSamples(dir, 0).length;
		assert.equal(after, before);
	});

	it("PERF_KINDS lists the 11 instrumentation kinds", () => {
		assert.equal(PERF_KINDS.length, 11);
		assert.ok(PERF_KINDS.includes("db_recompute_ms"));
		assert.ok(PERF_KINDS.includes("cache_hit_pct"));
		assert.ok(PERF_KINDS.includes("cache_prefix_break"));
	});
});

describe("readProviderCacheStats (S53A)", () => {
	let dir: string;
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "mc-pcache-"));
		process.env.MEGACOMPACT_STATE_DIR = dir;
	});
	after(() => {
		closeStore(dir);
		delete process.env.MEGACOMPACT_STATE_DIR;
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns zeroed stats with null bounds on an empty table", () => {
		const s = readProviderCacheStats(dir);
		assert.equal(s.sampleCount, 0);
		assert.equal(s.totalInput, 0);
		assert.equal(s.totalCacheRead, 0);
		assert.equal(s.totalCacheWrite, 0);
		assert.equal(s.avgHitPct, 0);
		assert.equal(s.latestHitPct, 0);
		assert.equal(s.oldestTs, null);
		assert.equal(s.newestTs, null);
	});

	it("aggregates totals + averages across cache_hit_pct samples", () => {
		recordPerfSample(dir, "cache_hit_pct", 96.0, {
			input: 1210,
			cacheRead: 28800,
			cacheWrite: 0,
		});
		recordPerfSample(dir, "cache_hit_pct", 50.6, {
			input: 20031,
			cacheRead: 20480,
			cacheWrite: 0,
		});
		// Non-cache kinds must not pollute the aggregates.
		recordPerfSample(dir, "tps", 42, { outputTokens: 100 });
		const s = readProviderCacheStats(dir);
		assert.equal(s.sampleCount, 2);
		assert.equal(s.totalInput, 21241);
		assert.equal(s.totalCacheRead, 49280);
		assert.equal(s.totalCacheWrite, 0);
		assert.ok(Math.abs(s.avgHitPct - 73.3) < 0.001);
		assert.equal(s.latestHitPct, 50.6);
		assert.ok(s.oldestTs != null && s.newestTs != null);
		assert.ok(s.newestTs >= s.oldestTs);
	});

	it("skips malformed meta for totals but keeps the sample for hit %", () => {
		recordPerfSample(dir, "cache_hit_pct", 75, undefined);
		recordPerfSample(dir, "cache_hit_pct", 25, { bogus: true });
		const s = readProviderCacheStats(dir);
		assert.equal(s.sampleCount, 4); // 2 here + 2 from the previous test
		assert.equal(s.avgHitPct, (96.0 + 50.6 + 75 + 25) / 4);
		// Totals still only from the two well-formed metas.
		assert.equal(s.totalInput, 21241);
		assert.equal(s.totalCacheRead, 49280);
	});

	it("honors the sinceTs window", () => {
		const future = readProviderCacheStats(dir, Date.now() + 60_000);
		assert.equal(future.sampleCount, 0);
		assert.equal(future.oldestTs, null);
	});
});
