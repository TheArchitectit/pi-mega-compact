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

	it("PERF_KINDS lists the 10 instrumentation kinds", () => {
		assert.equal(PERF_KINDS.length, 10);
		assert.ok(PERF_KINDS.includes("db_recompute_ms"));
		assert.ok(PERF_KINDS.includes("cache_hit_pct"));
	});
});
