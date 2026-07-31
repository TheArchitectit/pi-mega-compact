/**
 * prefix-break.test.ts — S53A prefix-break classification tests.
 * Pi-agnostic. No mocks, real stores.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { closeStore, openStore, recordPerfSample } from "./store/sqlite.js";
import { classifyPrefixBreak } from "./prefix-break.js";
import { readPrefixBreaks } from "./store/sqlite/perf-samples.js";

// ─── Unit tests for classifyPrefixBreak ───────────────────────────────────────

describe("classifyPrefixBreak (S53A)", () => {
	it("matches 'recall' when break is within tolerance of lastRecallAt", () => {
		const lastRecallAt = 1000;
		const result = classifyPrefixBreak(1000, { lastRecallAt, lastCompactAt: null, lastInjectAt: null });
		assert.equal(result.cause, "recall");
	});

	it("matches 'compaction' when break is within tolerance of lastCompactAt", () => {
		const result = classifyPrefixBreak(2000, { lastRecallAt: null, lastCompactAt: 2000, lastInjectAt: null });
		assert.equal(result.cause, "compaction");
	});

	it("matches 'inject' when break is within tolerance of lastInjectAt", () => {
		const result = classifyPrefixBreak(3000, { lastRecallAt: null, lastCompactAt: null, lastInjectAt: 3000 });
		assert.equal(result.cause, "inject");
	});

	it("'recall' has priority over 'compaction' when both within tolerance", () => {
		const result = classifyPrefixBreak(1000, { lastRecallAt: 1000, lastCompactAt: 1000, lastInjectAt: null });
		assert.equal(result.cause, "recall", "recall should win over compaction");
	});

	it("'compaction' has priority over 'inject' when both within tolerance", () => {
		const result = classifyPrefixBreak(2000, { lastRecallAt: null, lastCompactAt: 2000, lastInjectAt: 2000 });
		assert.equal(result.cause, "compaction", "compaction should win over inject");
	});

	it("'recall' has priority over 'inject' when both within tolerance", () => {
		const result = classifyPrefixBreak(1000, { lastRecallAt: 1000, lastCompactAt: null, lastInjectAt: 1000 });
		assert.equal(result.cause, "recall", "recall should win over inject");
	});

	it("all three match → recall wins (recall > compaction > inject priority)", () => {
		const ts = 5000;
		const result = classifyPrefixBreak(ts, {
			lastRecallAt: ts,
			lastCompactAt: ts,
			lastInjectAt: ts,
		});
		assert.equal(result.cause, "recall");
	});

	it("returns 'other' when break is outside tolerance of all events", () => {
		const result = classifyPrefixBreak(5000, {
			lastRecallAt: 1000,
			lastCompactAt: 1500,
			lastInjectAt: 2000,
		});
		assert.equal(result.cause, "other");
	});

	it("returns 'other' when all timestamps are null", () => {
		const result = classifyPrefixBreak(5000, {
			lastRecallAt: null,
			lastCompactAt: null,
			lastInjectAt: null,
		});
		assert.equal(result.cause, "other");
	});

	it("toleranceMs = 0: exact match only", () => {
		const result = classifyPrefixBreak(1000, {
			lastRecallAt: 1000,
			lastCompactAt: null,
			lastInjectAt: null,
		}, 0);
		assert.equal(result.cause, "recall");
	});

	it("toleranceMs = 0: 1ms apart → 'other'", () => {
		const result = classifyPrefixBreak(1001, {
			lastRecallAt: 1000,
			lastCompactAt: null,
			lastInjectAt: null,
		}, 0);
		assert.equal(result.cause, "other");
	});

	it("confidence is 1.0 when event matches exactly", () => {
		const result = classifyPrefixBreak(1000, {
			lastRecallAt: 1000,
			lastCompactAt: null,
			lastInjectAt: null,
		});
		assert.equal(result.confidence, 1.0);
	});

	it("confidence decreases as event approaches tolerance boundary", () => {
		// 100ms into a 2000ms tolerance → confidence ≈ 0.975 (near 1.0)
		const result = classifyPrefixBreak(100, {
			lastRecallAt: 0,
			lastCompactAt: null,
			lastInjectAt: null,
		});
		assert.ok(result.confidence > 0.9 && result.confidence <= 1.0);
	});

	it("confidence is 0.5 at tolerance boundary", () => {
		const result = classifyPrefixBreak(2000, {
			lastRecallAt: 0,
			lastCompactAt: null,
			lastInjectAt: null,
		});
		assert.equal(result.confidence, 0.5);
	});
});

// ─── Integration: readPrefixBreaks from perf_samples ──────────────────────────

describe("readPrefixBreaks (perf_samples storage)", () => {
	let dir: string;

	function freshDir(prefix: string): string {
		if (dir) {
			closeStore(dir);
			rmSync(dir, { recursive: true, force: true });
		}
		dir = mkdtempSync(join(tmpdir(), prefix));
		return dir;
	}

	after(() => {
		if (dir) {
			closeStore(dir);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("empty table → empty array", () => {
		freshDir("mc-pb-empty-");
		const breaks = readPrefixBreaks(dir, 0, Date.now() + 86_400_000);
		assert.equal(breaks.length, 0);
	});

	it("non-prefix_break rows are excluded", () => {
		freshDir("mc-pb-other-");
		recordPerfSample(dir, "cache_hit_pct", 50, { cacheRead: 100, input: 100 });
		recordPerfSample(dir, "turn_latency_ms", 123, { turnIndex: 1 });
		const breaks = readPrefixBreaks(dir, 0, Date.now() + 86_400_000);
		assert.equal(breaks.length, 0);
	});

	it("prefix_break rows are returned with parsed meta + sorted asc by ts", () => {
		freshDir("mc-pb-read-");
		const ts1 = Date.now() - 5000;
		const ts2 = Date.now() - 1000;
		// Manually insert with controlled ts (recordPerfSample uses Date.now()).
		const db = openStore(dir);
		db.prepare(
			`INSERT INTO perf_samples (ts, kind, value, meta) VALUES (?, ?, ?, ?)`,
		).run(ts1, "prefix_break", 0, JSON.stringify({
			cause: "compaction",
			confidence: 0.95,
			prevHitPct: 80,
			currHitPct: 10,
			breakAt: ts1,
		}));
		db.prepare(
			`INSERT INTO perf_samples (ts, kind, value, meta) VALUES (?, ?, ?, ?)`,
		).run(ts2, "prefix_break", 0, JSON.stringify({
			cause: "recall",
			confidence: 1.0,
			prevHitPct: 60,
			currHitPct: 5,
			breakAt: ts2,
		}));

		const breaks = readPrefixBreaks(dir, 0, Date.now() + 86_400_000);
		assert.equal(breaks.length, 2);
		// Sorted ascending by ts
		assert.equal(breaks[0].meta.cause, "compaction");
		assert.equal(breaks[1].meta.cause, "recall");
		assert.equal(breaks[0].meta.breakAt, ts1);
		assert.equal(breaks[1].meta.breakAt, ts2);
	});

	it("since/until filters correctly (only rows inside window)", () => {
		freshDir("mc-pb-filter-");
		const now = Date.now();
		const oldTs = now - 120_000;
		const recentTs = now - 10_000;
		const db = openStore(dir);
		db.prepare(
			`INSERT INTO perf_samples (ts, kind, value, meta) VALUES (?, ?, ?, ?)`,
		).run(oldTs, "prefix_break", 0, JSON.stringify({
			cause: "recall", confidence: 1.0, prevHitPct: 80, currHitPct: 5, breakAt: oldTs,
		}));
		db.prepare(
			`INSERT INTO perf_samples (ts, kind, value, meta) VALUES (?, ?, ?, ?)`,
		).run(recentTs, "prefix_break", 0, JSON.stringify({
			cause: "compaction", confidence: 0.9, prevHitPct: 70, currHitPct: 3, breakAt: recentTs,
		}));

		// 1-minute window should only include the recent one
		const windowStart = now - 60_000;
		const breaks = readPrefixBreaks(dir, windowStart, now);
		assert.equal(breaks.length, 1);
		assert.equal(breaks[0].meta.cause, "compaction");
	});

	it("since-only (until=0 means no upper bound)", () => {
		freshDir("mc-pb-since-");
		const now = Date.now();
		const oldTs = now - 300_000;
		const recentTs = now - 10_000;
		const db = openStore(dir);
		db.prepare(
			`INSERT INTO perf_samples (ts, kind, value, meta) VALUES (?, ?, ?, ?)`,
		).run(oldTs, "prefix_break", 0, JSON.stringify({
			cause: "recall", confidence: 1.0, prevHitPct: 80, currHitPct: 5, breakAt: oldTs,
		}));
		db.prepare(
			`INSERT INTO perf_samples (ts, kind, value, meta) VALUES (?, ?, ?, ?)`,
		).run(recentTs, "prefix_break", 0, JSON.stringify({
			cause: "compaction", confidence: 0.9, prevHitPct: 70, currHitPct: 3, breakAt: recentTs,
		}));

		// since=now-60s → only recentTs included; until=0 = no upper bound
		const breaks = readPrefixBreaks(dir, now - 60_000, 0);
		assert.equal(breaks.length, 1);
		assert.equal(breaks[0].meta.cause, "compaction");
	});
});