/**
 * routes-servers.test.ts — E.4 /api/servers providerCache field coverage.
 *
 * Seeds perf_samples (cache_hit_pct) + dashboard.json into a temp state dir,
 * upserts a repo_registry entry into a temp index dir, spawns the dashboard
 * server, and asserts providerCache fields appear in /api/servers response.
 *
 * Uses the same port.pid-based spawn-and-fetch harness as routes-cache.test.ts.
 * Real-store (no mocks).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { recordPerfSample } from "../../src/store/sqlite/perf-samples.js";
import { upsertRepoRegistry } from "../../src/store/sqlite/global-index.js";

const SERVER_ENTRY = new URL("./server.js", import.meta.url).pathname;

function waitFor(
	cond: () => boolean | Promise<boolean>,
	timeoutMs = 6000,
): Promise<void> {
	const start = Date.now();
	return new Promise((resolve, reject) => {
		const tick = async () => {
			if (await cond()) return resolve();
			if (Date.now() - start > timeoutMs)
				return reject(new Error("timeout"));
			setTimeout(tick, 50);
		};
		tick();
	});
}

async function withServer<T>(
	port: string,
	dir: string,
	fn: (port: number) => Promise<T>,
): Promise<T> {
	process.env.MEGACOMPACT_DASHBOARD_PORT = port;
	process.env.MEGACOMPACT_DASHBOARD_HOST = "127.0.0.1";
	const child = spawn(process.execPath, [SERVER_ENTRY, dir], {
		stdio: "ignore",
		env: {
			...process.env,
			MEGACOMPACT_INDEX_DIR: dir,
		},
	});
	try {
		await waitFor(async () => {
			try {
				const raw = JSON.parse(
					readFileSync(join(dir, "port.pid"), "utf-8"),
				);
				const res = await fetch(
					`http://localhost:${raw.port}/api/version`,
				);
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
		delete process.env.MEGACOMPACT_DASHBOARD_HOST;
		rmSync(dir, { recursive: true, force: true });
	}
}

function setupDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "mc-routes-servers-"));

	// Seed perf_samples WITH meta (readProviderCacheForRepo derives
	// avgHitPct from meta.cacheRead/cacheWrite/input, not value).
	recordPerfSample(dir, "cache_hit_pct", 90, {
		cacheRead: 900,
		cacheWrite: 50,
		input: 50,
	});
	recordPerfSample(dir, "cache_hit_pct", 80, {
		cacheRead: 800,
		cacheWrite: 100,
		input: 100,
	});

	// Seed dashboard.json (server reads cacheHi/compact stats from it)
	const snap = {
		updatedAt: new Date().toISOString(),
		tier: "L4",
		context: { percent: 42 },
		session: { state: "active" },
		cacheHits: {
			session: 5,
			total: 100,
			sessionTokensSaved: 5000,
			totalTokensSaved: 100000,
		},
		compacts: { session: 2, total: 50 },
		timeSaved: {
			compact: { sessionSec: 1.5, totalSec: 120 },
			cacheHit: { sessionSec: 0.5, totalSec: 30 },
		},
	};
	writeFileSync(join(dir, "dashboard.json"), JSON.stringify(snap));

	// Seed index registry — lastSeen must be within ACTIVE_WINDOW_SEC (600s).
	// repoRoot must NOT start with /tmp/ — readIndex() filters transient paths.
	upsertRepoRegistry(
		{
			repoRoot: "/home/user001/test-repo-e4",
			displayName: "test-repo-e4",
			stateDir: dir,
			checkpointCount: 10,
			tokensSaved: 50000,
			compressedOriginalBytes: 200000,
			// lastSeen in ms — server compares with Date.now() (ms)
			lastSeen: Date.now(),
			lastCompactedAt: Date.now(),
			modelName: "claude-sonnet-4-20250514",
			providerName: "anthropic",
			inputRate: 3 / 1_000_000,
		},
		dir,
	);

	return dir;
}

describe("/api/servers providerCache (E.4)", () => {
	test("GET /api/servers returns providerCache fields", async () => {
		const dir = setupDir();
		await withServer("19440", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/servers`);
			assert.equal(res.status, 200);
			const body = (await res.json()) as {
				servers: Record<string, unknown>[];
			};
			assert.ok(Array.isArray(body.servers), "servers is array");
			assert.ok(body.servers.length >= 1, "at least 1 server");

			const s = body.servers[0];
			const pc = s.providerCache as Record<string, number> | null;
			assert.ok(pc != null, "providerCache is present");
			assert.equal(typeof pc!.avgHitPct, "number", "avgHitPct is number");
			assert.equal(typeof pc!.cacheRead, "number", "cacheRead is number");
			assert.equal(typeof pc!.cacheWrite, "number", "cacheWrite is number");
			assert.equal(
				typeof pc!.estimatedSaved,
				"number",
				"estimatedSaved is number",
			);

			// avgHitPct should be ~85 (average of 90 and 80 from seeded meta)
			assert.ok(pc!.avgHitPct > 0, "avgHitPct > 0 (seeded data)");
		});
	});
});
