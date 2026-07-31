/**
 * routes-cache.test.ts — Sprint A /api/provider-cache endpoint tests.
 *
 * Covers the A.4 spec:
 * - GET 200 → shape matches ProviderCacheResponse
 * - POST → 405
 * - empty perf_samples → zeros/nulls
 * - no model snapshot → savings: null
 * - with model snapshot → priced savings fields
 *
 * Uses the same spawn-and-fetch harness as perf-server.test.ts.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
	openStore,
	recordPerfSample,
	recordModelSnapshot,
} from "../../src/store/sqlite.js";

const SERVER_ENTRY = new URL("./server.js", import.meta.url).pathname;

function waitFor(
	cond: () => boolean | Promise<boolean>,
	timeoutMs = 6000,
): Promise<void> {
	const start = Date.now();
	return new Promise((resolve, reject) => {
		const tick = async () => {
			if (await cond()) return resolve();
			if (Date.now() - start > timeoutMs) return reject(new Error("timeout"));
			setTimeout(tick, 50);
		};
		tick();
	});
}

function freshDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

async function withServer<T>(
	port: string,
	dir: string,
	fn: (port: number) => Promise<T>,
): Promise<T> {
	process.env.MEGACOMPACT_DASHBOARD_PORT = port;
	const child = spawn(process.execPath, [SERVER_ENTRY, dir], {
		stdio: "ignore",
	});
	try {
		await waitFor(async () => {
			try {
				const raw = JSON.parse(readFileSync(join(dir, "port.pid"), "utf-8"));
				const res = await fetch(`http://localhost:${raw.port}/api/version`);
				return res.ok;
			} catch {
				return false;
			}
		});
		const raw = JSON.parse(readFileSync(join(dir, "port.pid"), "utf-8"));
		return await fn(raw.port);
	} finally {
		child.kill("SIGTERM");
		delete process.env.MEGACOMPACT_DASHBOARD_PORT;
		rmSync(dir, { recursive: true, force: true });
	}
}

interface ProviderCacheByModel {
	model: string;
	hitPct: number;
	totalCacheRead: number;
	totalCacheWrite: number;
	sampleCount: number;
}

interface ProviderCacheResponse {
	cache: {
		avgHitPct: number;
		turnCount: number;
		totalCacheRead: number;
		totalCacheWrite: number;
		totalInput: number;
		firstTurnAt: string | null;
		latestTurnAt: string | null;
		byModel: ProviderCacheByModel[];
	};
	savings: {
		cacheReadSaved: number;
		cacheWriteCost: number;
		netSaved: number;
		model: string;
		inputRate: number;
	} | null;
	updatedAt: string;
	windowMinutes?: number | null;
}

describe("/api/provider-cache", () => {
	test("GET 200 — shape matches ProviderCacheResponse", async () => {
		const dir = freshDir("dash-pcache-agg-");
		// Seed one cache_hit_pct sample with full meta.
		recordPerfSample(dir, "cache_hit_pct", 42, {
			cacheRead: 100,
			cacheWrite: 20,
			input: 500,
		});
		await withServer("19450", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/provider-cache`);
			assert.equal(res.status, 200);
			const body = (await res.json()) as ProviderCacheResponse;
			// Shape assertions
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
			const res = await fetch(`http://localhost:${port}/api/provider-cache`, {
				method: "POST",
			});
			assert.equal(res.status, 405);
			const body = (await res.json()) as { error: string };
			assert.equal(body.error, "method_not_allowed");
		});
	});

	test("no model snapshot → savings: null", async () => {
		const dir = freshDir("dash-pcache-nosnap-");
		recordPerfSample(dir, "cache_hit_pct", 50, {
			cacheRead: 200,
			cacheWrite: 30,
			input: 1000,
		});
		await withServer("19453", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/provider-cache`);
			assert.equal(res.status, 200);
			const body = (await res.json()) as ProviderCacheResponse;
			assert.equal(body.savings, null);
		});
	});

	test("with model snapshot → priced savings fields", async () => {
		const dir = freshDir("dash-pcache-savings-");
		recordPerfSample(dir, "cache_hit_pct", 50, {
			cacheRead: 2000,
			cacheWrite: 400,
			input: 10000,
		});
		// Record a model snapshot with a known input rate.
		recordModelSnapshot(
			"/tmp/test-repo",
			{
				provider: "anthropic",
				providerName: "Anthropic",
				modelId: "claude-sonnet-4-20250514",
				modelName: "Claude Sonnet 4",
				inputRate: 3e-6, // $3 / 1M tokens
				outputRate: 15e-6,
				contextWindow: 200000,
				maxTokens: 32000,
				reasoning: false,
			},
			dir,
		);
		await withServer("19454", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/provider-cache`);
			assert.equal(res.status, 200);
			const body = (await res.json()) as ProviderCacheResponse;
			assert.ok(body.savings, "savings should not be null");
			// cacheReadSaved = 2000 * 3e-6 * 0.9 = 0.0054
			assert.ok(body.savings!.cacheReadSaved > 0, "cacheReadSaved > 0");
			// cacheWriteCost = 400 * 3e-6 * 0.25 = 0.0003
			assert.ok(body.savings!.cacheWriteCost > 0, "cacheWriteCost > 0");
			assert.ok(
				body.savings!.netSaved ===
					body.savings!.cacheReadSaved - body.savings!.cacheWriteCost,
				"netSaved = cacheReadSaved - cacheWriteCost",
			);
			assert.equal(body.savings!.model, "Claude Sonnet 4");
			assert.equal(body.savings!.inputRate, 3e-6);
		});
	});

	test("partial meta (missing fields) → treated as 0", async () => {
		const dir = freshDir("dash-pcache-partial-");
		// Only input in meta; cacheRead/cacheWrite missing → treated as 0.
		recordPerfSample(dir, "cache_hit_pct", 30, { input: 800 });
		// Only cacheRead in meta; input/cacheWrite missing → treated as 0.
		recordPerfSample(dir, "cache_hit_pct", 60, { cacheRead: 150 });
		await withServer("19455", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/provider-cache`);
			assert.equal(res.status, 200);
			const body = (await res.json()) as ProviderCacheResponse;
			// First sample: input=800, cacheRead=0, cacheWrite=0
			// Second sample: cacheRead=150, input=0, cacheWrite=0
			assert.equal(body.cache.turnCount, 2);
			assert.equal(body.cache.totalCacheRead, 150);
			assert.equal(body.cache.totalCacheWrite, 0);
			assert.equal(body.cache.totalInput, 800);
		});
	});

	test("NULL meta → counted in turnCount, contributes 0 tokens + 0 avg", async () => {
		const dir = freshDir("dash-pcache-nullmeta-");
		// avgHitPct is derived from (cacheRead / (cacheRead + input + cacheWrite)) * 100,
		// NOT from the `value` column. NULL meta → no tokens → avg 0, not 25.
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

	test("model snapshot with modelName=null → falls back to modelId", async () => {
		const dir = freshDir("dash-pcache-modelid-");
		recordPerfSample(dir, "cache_hit_pct", 10, {
			cacheRead: 100,
			cacheWrite: 10,
			input: 1000,
		});
		recordModelSnapshot(
			"/tmp/test-repo",
			{
				provider: "openai",
				providerName: null,
				modelId: "gpt-4o",
				modelName: null,
				inputRate: 2.5e-6,
				outputRate: 10e-6,
				contextWindow: 128000,
				maxTokens: 16384,
				reasoning: false,
			},
			dir,
		);
		await withServer("19457", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/provider-cache`);
			assert.equal(res.status, 200);
			const body = (await res.json()) as ProviderCacheResponse;
			assert.ok(body.savings);
			assert.equal(body.savings!.model, "gpt-4o");
		});
	});

	test("model snapshot with zero inputRate → savings: null", async () => {
		const dir = freshDir("dash-pcache-zerorate-");
		recordPerfSample(dir, "cache_hit_pct", 10, {
			cacheRead: 100,
			cacheWrite: 10,
			input: 1000,
		});
		recordModelSnapshot(
			"/tmp/test-repo",
			{
				provider: "local",
				providerName: null,
				modelId: "local-llm",
				modelName: null,
				inputRate: 0,
				outputRate: 0,
				contextWindow: 4096,
				maxTokens: 2048,
				reasoning: false,
			},
			dir,
		);
		await withServer("19458", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/provider-cache`);
			assert.equal(res.status, 200);
			const body = (await res.json()) as ProviderCacheResponse;
			assert.equal(body.savings, null);
		});
	});

	test("GET 200 — windowMinutes: null when no minutes param", async () => {
		const dir = freshDir("dash-pcwin-none-");
		recordPerfSample(dir, "cache_hit_pct", 50, {
			cacheRead: 100,
			cacheWrite: 20,
			input: 500,
		});
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
		const oldTs = now - 120_000; // 2 min ago, outside 1-min window
		const recentTs = now - 10_000; // 10 sec ago, inside 1-min window
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
		recordPerfSample(dir, "cache_hit_pct", 50, {
			cacheRead: 100,
			cacheWrite: 20,
			input: 500,
		});
		await withServer("19461", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/provider-cache?minutes=abc`);
			assert.equal(res.status, 200);
			const body = (await res.json()) as ProviderCacheResponse;
			assert.equal(body.windowMinutes, null);
			assert.equal(body.cache.turnCount, 1);
		});
	});
});
test("GET 200 — byModel in lifetime and windowed (F4)", async () => {
	const dir = freshDir("dash-f4bm-");
	const now = Date.now();
	const db = openStore(dir);

	// Model A: 2 samples
	db.prepare(
		`INSERT INTO perf_samples (ts, kind, value, meta) VALUES (?, ?, ?, ?)`,
	).run(now - 120_000, "cache_hit_pct", 90, JSON.stringify({
		cacheRead: 900, cacheWrite: 50, input: 50,
		modelName: "Sonnet Model",
	}));
	db.prepare(
		`INSERT INTO perf_samples (ts, kind, value, meta) VALUES (?, ?, ?, ?)`,
	).run(now - 10_000, "cache_hit_pct", 80, JSON.stringify({
		cacheRead: 800, cacheWrite: 100, input: 100,
		modelName: "Sonnet Model",
	}));

	// Model B: 1 sample
	db.prepare(
		`INSERT INTO perf_samples (ts, kind, value, meta) VALUES (?, ?, ?, ?)`,
	).run(now - 5_000, "cache_hit_pct", 50, JSON.stringify({
		cacheRead: 500, cacheWrite: 200, input: 300,
		modelName: "GPT Model",
	}));

	// Untagged: 1 sample
	db.prepare(
		`INSERT INTO perf_samples (ts, kind, value, meta) VALUES (?, ?, ?, ?)`,
	).run(now, "cache_hit_pct", 60, JSON.stringify({
		cacheRead: 100, cacheWrite: 50, input: 50,
	}));

	await withServer("19462", dir, async (port) => {
		// Lifetime
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

		// Windowed (30 min): should include all 4 (all within 30 min)
		const res2 = await fetch(`http://localhost:${port}/api/provider-cache?minutes=30`);
		assert.equal(res2.status, 200);
		const body2 = (await res2.json()) as ProviderCacheResponse;
		assert.equal(body2.windowMinutes, 30);
		assert.equal(body2.cache.byModel.length, 2, "windowed also has 2 models");
	});
});
