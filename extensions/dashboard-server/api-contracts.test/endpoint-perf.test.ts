/**
 * endpoint-perf.test.ts — runtime contract validation for GET /api/game-scores,
 * GET /api/perf and GET /api/achievements. Split out of api-contracts.test.ts;
 * test bodies are unchanged.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { assertField, assertObject } from "./_helpers.js";
describe("GET /api/game-scores", () => {
	test("sample payload (array) validates element field presence and types", () => {
		const raw = JSON.stringify([
			{
				repo_root: "/home/user/repo1",
				value: 1500,
				ts: 1700000000000,
				meta: { metric: "cache" },
			},
		]);
		const arr = JSON.parse(raw) as unknown[];
		assert.ok(Array.isArray(arr), "response must be an array");

		const first = arr[0] as Record<string, unknown>;
		assertField(first, "repo_root", ["string"]);
		assertField(first, "value", ["number"]);
		assertField(first, "ts", ["number"]);
		assert.ok("meta" in first, 'field "meta" must exist');
	});
});

describe("GET /api/perf", () => {
	test("sample payload validates field presence and types", () => {
		const raw = JSON.stringify({
			updatedAt: "2025-01-01T00:00:00Z",
			windowMinutes: 30,
			sampleCount: 100,
			turn_latency_ms: { p50: 500, p95: 2000, n: 100 },
			provider_latency_ms: { p50: 300, p95: 1500, n: 100 },
			tps: { avg: 45.5, n: 100 },
			cache_hit_pct: { avg: 30, latest: 25, n: 100 },
			db_recompute_ms: { p50: 50, p95: 200, n: 50 },
			disk_write_ms: { p50: 10, p95: 50, n: 50 },
			rss_mb: { latest: 256, n: 10 },
			heap_mb: { latest: 128, n: 10 },
			cpu_user_ms: { latest: 5000, n: 10 },
			cpu_sys_ms: { latest: 1000, n: 10 },
			diag: {
				ctxFastGate: 2,
				liveTrimFires: 5,
				liveTrimReplays: 3,
			},
		});
		const obj: Record<string, unknown> = JSON.parse(raw);

		assertField(obj, "updatedAt", ["string"]);
		assertField(obj, "windowMinutes", ["number"]);
		assertField(obj, "sampleCount", ["number"]);
		assertField(obj, "turn_latency_ms", ["object"]);
		assertField(obj, "provider_latency_ms", ["object"]);
		assertField(obj, "tps", ["object"]);
		assertField(obj, "cache_hit_pct", ["object"]);
		assertField(obj, "db_recompute_ms", ["object"]);
		assertField(obj, "disk_write_ms", ["object"]);
		assertField(obj, "rss_mb", ["object"]);
		assertField(obj, "heap_mb", ["object"]);
		assertField(obj, "cpu_user_ms", ["object"]);
		assertField(obj, "cpu_sys_ms", ["object"]);
		assertField(obj, "diag", ["object", "null"]);

		// Spot-check percentile sub-object
		const tl = assertObject(obj, "turn_latency_ms")!;
		assertField(tl, "p50", ["number"]);
		assertField(tl, "p95", ["number"]);
		assertField(tl, "n", ["number"]);

		const diag = assertObject(obj, "diag")!;
		assertField(diag, "ctxFastGate", ["number"]);
		assertField(diag, "liveTrimFires", ["number"]);
		assertField(diag, "liveTrimReplays", ["number"]);
	});

	test("null diag validates", () => {
		const raw = JSON.stringify({
			updatedAt: "2025-01-01T00:00:00Z",
			windowMinutes: 30,
			sampleCount: 0,
			turn_latency_ms: { p50: 0, p95: 0, n: 0 },
			provider_latency_ms: { p50: 0, p95: 0, n: 0 },
			tps: { avg: 0, n: 0 },
			cache_hit_pct: { avg: 0, latest: 0, n: 0 },
			db_recompute_ms: { p50: 0, p95: 0, n: 0 },
			disk_write_ms: { p50: 0, p95: 0, n: 0 },
			rss_mb: { latest: 0, n: 0 },
			heap_mb: { latest: 0, n: 0 },
			cpu_user_ms: { latest: 0, n: 0 },
			cpu_sys_ms: { latest: 0, n: 0 },
			diag: null,
		});
		const obj: Record<string, unknown> = JSON.parse(raw);

		assertField(obj, "diag", ["null"]);
	});
});

describe("GET /api/achievements", () => {
	test("sample payload (array) validates element field presence and types", () => {
		const raw = JSON.stringify([
			{
				id: "first-compact",
				title: "First Compaction",
				description: "Complete your first compaction",
				hidden: 0,
				icon: "trophy",
				unlocked_at: 1700000000,
			},
			{
				id: "secret-ach",
				title: "Secret Achievement",
				description: "???",
				hidden: 1,
				icon: null,
				unlocked_at: null,
			},
		]);
		const arr = JSON.parse(raw) as unknown[];
		assert.ok(Array.isArray(arr), "response must be an array");

		const first = arr[0] as Record<string, unknown>;
		assertField(first, "id", ["string"]);
		assertField(first, "title", ["string"]);
		assertField(first, "description", ["string"]);
		assertField(first, "hidden", ["number"]);
		assertField(first, "icon", ["string", "null"]);
		assertField(first, "unlocked_at", ["number", "null"]);

		const second = arr[1] as Record<string, unknown>;
		assertField(second, "icon", ["null"]);
		assertField(second, "unlocked_at", ["null"]);
	});
});
