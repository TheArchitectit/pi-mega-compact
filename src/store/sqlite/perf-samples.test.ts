/**
 * perf-samples.test.ts — v0.8.8 perf_samples table round-trip + filtering.
 * Pi-agnostic. Uses an isolated state dir (never the real user dir — G7).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { closeStore, openStore } from "./utils.js";
import {
	recordPerfSample,
	readPerfSamples,
	PERF_KINDS,
	readProviderCacheLifetime,
	readLatestCacheHitPct,
	readProviderCacheForRepo,
	readProviderCacheWindow,
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

	it("PERF_KINDS lists the 11 instrumentation kinds", () => {
		assert.equal(PERF_KINDS.length, 11);
		assert.ok(PERF_KINDS.includes("db_recompute_ms"));
		assert.ok(PERF_KINDS.includes("cache_hit_pct"));
		assert.ok(PERF_KINDS.includes("prefix_break"));
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

	it("readProviderCacheForRepo aggregates correctly and ignores other dirs", () => {
		const seededDir = mkdtempSync(join(tmpdir(), "mc-pcrepo-"));
		const emptyDir = mkdtempSync(join(tmpdir(), "mc-pcrepo-empty-"));
		try {
			// Seed cache_hit_pct samples WITH meta (readProviderCacheForRepo
			// derives avgHitPct from meta.cacheRead/cacheWrite/input, not value).
			// Sample 1: 900 read / 50 write / 50 input → hit = 900/(900+50+50)*100 = 90%
			recordPerfSample(seededDir, "cache_hit_pct", 90, {
				cacheRead: 900,
				cacheWrite: 50,
				input: 50,
			});
			// Sample 2: 800 read / 100 write / 100 input → hit = 800/(800+100+100)*100 = 80%
			recordPerfSample(seededDir, "cache_hit_pct", 80, {
				cacheRead: 800,
				cacheWrite: 100,
				input: 100,
			});

			const result = readProviderCacheForRepo(seededDir);
			// avgHitPct = (90 + 80) / 2 = 85
			assert.ok(Math.abs(result.avgHitPct - 85) < 0.01, `avgHitPct ~85, got ${result.avgHitPct}`);
			assert.equal(result.totalCacheRead, 1700, "900 + 800");
			assert.equal(result.totalCacheWrite, 150, "50 + 100");
			assert.equal(result.totalInput, 150, "50 + 100");
			assert.equal(result.sampleCount, 2, "two samples seeded");

			// Empty dir (different state dir = different SQLite DB) returns zeros
			const empty = readProviderCacheForRepo(emptyDir);
			assert.equal(empty.avgHitPct, 0);
			assert.equal(empty.totalCacheRead, 0);
			assert.equal(empty.totalCacheWrite, 0);
			assert.equal(empty.totalInput, 0);
			assert.equal(empty.sampleCount, 0);
		} finally {
			closeStore(seededDir);
			closeStore(emptyDir);
			rmSync(seededDir, { recursive: true, force: true });
			rmSync(emptyDir, { recursive: true, force: true });
		}
	});

	it("readProviderCacheWindow: only recent samples when window excludes old", () => {
		const wDir = mkdtempSync(join(tmpdir(), "mc-pcwin-"));
		try {
			const now = Date.now();
			const oldTs = now - 120_000; // 2 min ago
			const recentTs = now - 10_000; // 10 sec ago
			const db = openStore(wDir);
			// seed old sample (outside 1-minute window)
			db.prepare(
				`INSERT INTO perf_samples (ts, kind, value, meta) VALUES (?, ?, ?, ?)`,
			).run(oldTs, "cache_hit_pct", 50, JSON.stringify({ cacheRead: 100, cacheWrite: 100, input: 800 }));
			// seed recent sample (inside 1-minute window)
			db.prepare(
				`INSERT INTO perf_samples (ts, kind, value, meta) VALUES (?, ?, ?, ?)`,
			).run(recentTs, "cache_hit_pct", 80, JSON.stringify({ cacheRead: 800, cacheWrite: 100, input: 100 }));

			const lifetime = readProviderCacheLifetime(wDir);
			assert.equal(lifetime.sampleCount, 2, "lifetime sees both samples");

			const windowed = readProviderCacheWindow(wDir, 1); // 1-minute window
			assert.equal(windowed.sampleCount, 1, "windowed sees only the recent sample");
			assert.equal(windowed.totalCacheRead, 800);
			assert.equal(windowed.totalCacheWrite, 100);
			assert.equal(windowed.totalInput, 100);
			assert.ok(windowed.firstSampleAt != null);
			assert.ok(windowed.latestSampleAt != null);
		} finally {
			closeStore(wDir);
			rmSync(wDir, { recursive: true, force: true });
		}
	});

	it("readProviderCacheWindow: empty window returns zeros", () => {
		const eDir = mkdtempSync(join(tmpdir(), "mc-pcwin2-"));
		try {
			const result = readProviderCacheWindow(eDir, 30);
			assert.equal(result.sampleCount, 0);
			assert.equal(result.avgHitPct, 0);
			assert.equal(result.totalCacheRead, 0);
			assert.equal(result.totalCacheWrite, 0);
			assert.equal(result.totalInput, 0);
			assert.equal(result.firstSampleAt, null);
			assert.equal(result.latestSampleAt, null);
		} finally {
			closeStore(eDir);
			rmSync(eDir, { recursive: true, force: true });
		}
	});

	// -----------------------------------------------------------------------
	// F4: Per-model breakdown
	// -----------------------------------------------------------------------

	it("byModel: groups correctly for 2+ models + untagged rows", () => {
		const mDir = mkdtempSync(join(tmpdir(), "mc-f4bm-"));
		try {
			// Model A: 2 samples
			// 900 read / 50 write / 50 input → hitPct = 90
			recordPerfSample(mDir, "cache_hit_pct", 90, {
				cacheRead: 900, cacheWrite: 50, input: 50,
				modelName: "Claude Sonnet 4",
			});
			// 800 read / 100 write / 100 input → hitPct = 80
			recordPerfSample(mDir, "cache_hit_pct", 80, {
				cacheRead: 800, cacheWrite: 100, input: 100,
				modelName: "Claude Sonnet 4",
			});

			// Model B: 1 sample
			// 500 read / 200 write / 300 input → hitPct = 50
			recordPerfSample(mDir, "cache_hit_pct", 50, {
				cacheRead: 500, cacheWrite: 200, input: 300,
				modelName: "GPT-4o",
			});

			// Untagged: 1 sample (no modelName/modelId)
			recordPerfSample(mDir, "cache_hit_pct", 60, {
				cacheRead: 100, cacheWrite: 50, input: 50,
			});

			const r = readProviderCacheLifetime(mDir);

			// Flat totals include all 4 samples
			assert.equal(r.sampleCount, 4);
			assert.equal(r.totalCacheRead, 2300, "900+800+500+100");
			assert.equal(r.totalCacheWrite, 400, "50+100+200+50");
			assert.equal(r.totalInput, 500, "50+100+300+50");

			// byModel: 2 entries, sorted by sampleCount desc → Claude Sonnet 4 first
			assert.equal(r.byModel.length, 2, "two models, untagged omitted");

			// Claude Sonnet 4: 2 samples, sumCr=1700, sumCw=150, avgHitPct=(90+80)/2=85
			{
				const m = r.byModel[0];
				assert.equal(m.model, "Claude Sonnet 4");
				assert.equal(m.sampleCount, 2);
				assert.equal(m.totalCacheRead, 1700);
				assert.equal(m.totalCacheWrite, 150);
				assert.ok(Math.abs(m.hitPct - 85) < 0.01);
			}

			// GPT-4o: 1 sample, sumCr=500, sumCw=200, hitPct=50
			{
				const m = r.byModel[1];
				assert.equal(m.model, "GPT-4o");
				assert.equal(m.sampleCount, 1);
				assert.equal(m.totalCacheRead, 500);
				assert.equal(m.totalCacheWrite, 200);
				assert.ok(Math.abs(m.hitPct - 50) < 0.01);
			}
		} finally {
			closeStore(mDir);
			rmSync(mDir, { recursive: true, force: true });
		}
	});

	it("byModel: windowed + grouped combination", () => {
		const wDir = mkdtempSync(join(tmpdir(), "mc-f4wg-"));
		try {
			const now = Date.now();
			const oldTs = now - 120_000; // 2 min ago (outside 1-min window)
			const recentTs = now - 10_000; // 10 sec ago (inside 1-min window)

			const db = openStore(wDir);
			// Old sample — Model A
			db.prepare(
				`INSERT INTO perf_samples (ts, kind, value, meta) VALUES (?, ?, ?, ?)`,
			).run(oldTs, "cache_hit_pct", 90, JSON.stringify({
				cacheRead: 900, cacheWrite: 50, input: 50,
				modelName: "claude",
			}));
			// Recent sample — Model A
			db.prepare(
				`INSERT INTO perf_samples (ts, kind, value, meta) VALUES (?, ?, ?, ?)`,
			).run(recentTs, "cache_hit_pct", 80, JSON.stringify({
				cacheRead: 800, cacheWrite: 100, input: 100,
				modelName: "claude",
			}));
			// Recent sample — Model B
			db.prepare(
				`INSERT INTO perf_samples (ts, kind, value, meta) VALUES (?, ?, ?, ?)`,
			).run(recentTs, "cache_hit_pct", 50, JSON.stringify({
				cacheRead: 500, cacheWrite: 200, input: 300,
				modelName: "gpt4",
			}));

			// Lifetime: 3 samples, 2 models at oldTs+recentTs
			const lifetime = readProviderCacheLifetime(wDir);
			assert.equal(lifetime.sampleCount, 3);
			assert.equal(lifetime.byModel.length, 2);

			// Windowed (1 min): only 2 recent samples, 2 models
			const windowed = readProviderCacheWindow(wDir, 1);
			assert.equal(windowed.sampleCount, 2);
			assert.equal(windowed.totalCacheRead, 1300, "800+500");
			assert.equal(windowed.byModel.length, 2, "both models in window");

			// claude in window: 1 sample, 800 read / 100 write / 100 input
			const claude = windowed.byModel.find((m) => m.model === "claude")!;
			assert.ok(claude != null);
			assert.equal(claude.sampleCount, 1);
			assert.equal(claude.totalCacheRead, 800);
			assert.equal(claude.hitPct, 80);
		} finally {
			closeStore(wDir);
			rmSync(wDir, { recursive: true, force: true });
		}
	});
});