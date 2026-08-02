/**
 * savings.test.ts — model snapshot + priced savings tests.
 * Split from routes-cache.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordPerfSample, recordModelSnapshot } from "../../../src/store/sqlite.js";
import { freshDir, withServer, type ProviderCacheResponse } from "./_helpers.js";

test("no model snapshot → savings: null", async () => {
	const dir = freshDir("dash-pcache-nosnap-");
	recordPerfSample(dir, "cache_hit_pct", 50, { cacheRead: 200, cacheWrite: 30, input: 1000 });
	await withServer("19453", dir, async (port) => {
		const res = await fetch(`http://localhost:${port}/api/provider-cache`);
		assert.equal(res.status, 200);
		const body = (await res.json()) as ProviderCacheResponse;
		assert.equal(body.savings, null);
	});
});

test("with model snapshot → priced savings fields", async () => {
	const dir = freshDir("dash-pcache-savings-");
	recordPerfSample(dir, "cache_hit_pct", 50, { cacheRead: 2000, cacheWrite: 400, input: 10000 });
	recordModelSnapshot(
		"/tmp/test-repo",
		{
			provider: "anthropic",
			providerName: "Anthropic",
			modelId: "claude-sonnet-4-20250514",
			modelName: "Claude Sonnet 4",
			inputRate: 3e-6,
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
		assert.ok(body.savings!.cacheReadSaved > 0, "cacheReadSaved > 0");
		assert.ok(body.savings!.cacheWriteCost > 0, "cacheWriteCost > 0");
		assert.ok(
			body.savings!.netSaved === body.savings!.cacheReadSaved - body.savings!.cacheWriteCost,
			"netSaved = cacheReadSaved - cacheWriteCost",
		);
		assert.equal(body.savings!.model, "Claude Sonnet 4");
		assert.equal(body.savings!.inputRate, 3e-6);
	});
});

test("model snapshot with modelName=null → falls back to modelId", async () => {
	const dir = freshDir("dash-pcache-modelid-");
	recordPerfSample(dir, "cache_hit_pct", 10, { cacheRead: 100, cacheWrite: 10, input: 1000 });
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
	recordPerfSample(dir, "cache_hit_pct", 10, { cacheRead: 100, cacheWrite: 10, input: 1000 });
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
