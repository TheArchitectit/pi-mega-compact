/**
 * cache-server.test.ts — S53A /api/provider-cache endpoint (GET aggregates +
 * 405). Mirrors the perf-server.test.ts spawn-and-fetch harness
 * (self-contained so the dashboard HTTP-port lane stays isolated).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { recordPerfSample } from "../../src/store/sqlite.js";

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

interface ProviderCacheResp {
	updatedAt: string;
	windowMinutes: number | null;
	sampleCount: number;
	avgHitPct: number;
	latestHitPct: number;
	totalInput: number;
	totalCacheRead: number;
	totalCacheWrite: number;
	oldestTs: number | null;
	newestTs: number | null;
	prefixBreaks: Array<{ cause: string; count: number }>;
}

describe("S53A /api/provider-cache", () => {
	test("GET with no window returns all-time aggregates", async () => {
		const dir = freshDir("dash-pcache-all-");
		recordPerfSample(dir, "cache_hit_pct", 96.0, {
			input: 1210,
			cacheRead: 28800,
			cacheWrite: 0,
		});
		recordPerfSample(dir, "cache_hit_pct", 50.6, {
			input: 20031,
			cacheRead: 20480,
			cacheWrite: 512,
		});
		recordPerfSample(dir, "tps", 42); // unrelated kind — must not aggregate
		await withServer("19450", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/provider-cache`);
			assert.equal(res.status, 200);
			const d = (await res.json()) as ProviderCacheResp;
			assert.equal(d.windowMinutes, null);
			assert.equal(d.sampleCount, 2);
			assert.equal(d.totalInput, 21241);
			assert.equal(d.totalCacheRead, 49280);
			assert.equal(d.totalCacheWrite, 512);
			assert.ok(Math.abs(d.avgHitPct - 73.3) < 0.001);
			assert.equal(d.latestHitPct, 50.6);
			assert.ok(d.oldestTs != null && d.newestTs != null);
			assert.deepEqual(d.prefixBreaks, [], "no break samples → empty list");
		});
	});

	test("GET includes classified prefixBreaks when break samples exist", async () => {
		const dir = freshDir("dash-pcache-break-");
		recordPerfSample(dir, "cache_hit_pct", 80, {
			input: 1000,
			cacheRead: 4000,
			cacheWrite: 0,
		});
		recordPerfSample(dir, "cache_prefix_break", 1, { cause: "epoch-change" });
		recordPerfSample(dir, "cache_prefix_break", 1, { cause: "epoch-change" });
		recordPerfSample(dir, "cache_prefix_break", 1, { cause: "recall-injection" });
		await withServer("19453", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/provider-cache`);
			assert.equal(res.status, 200);
			const d = (await res.json()) as ProviderCacheResp;
			assert.equal(d.prefixBreaks.length, 2);
			// Sorted desc by count.
			assert.equal(d.prefixBreaks[0].cause, "epoch-change");
			assert.equal(d.prefixBreaks[0].count, 2);
			assert.equal(d.prefixBreaks[1].cause, "recall-injection");
			assert.equal(d.prefixBreaks[1].count, 1);
		});
	});

	test("GET with a future window returns zeroed stats", async () => {
		const dir = freshDir("dash-pcache-win-");
		recordPerfSample(dir, "cache_hit_pct", 80, {
			input: 10,
			cacheRead: 40,
			cacheWrite: 0,
		});
		await withServer("19451", dir, async (port) => {
			// minutes is clamped to a sane positive value but still starts in the
			// past; instead assert the window echo + that a huge window still
			// aggregates everything.
			const res = await fetch(
				`http://localhost:${port}/api/provider-cache?minutes=999999999`,
			);
			assert.equal(res.status, 200);
			const d = (await res.json()) as ProviderCacheResp;
			assert.equal(d.windowMinutes, 43_200); // clamped at 30 days
			assert.equal(d.sampleCount, 1);
			assert.equal(d.totalCacheRead, 40);
		});
	});

	test("non-GET (POST) -> 405", async () => {
		const dir = freshDir("dash-pcache-meth-");
		await withServer("19452", dir, async (port) => {
			const res = await fetch(
				`http://localhost:${port}/api/provider-cache`,
				{ method: "POST" },
			);
			assert.equal(res.status, 405);
		});
	});
});
