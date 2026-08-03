/**
 * routes-model-thresholds.test.ts — per-model threshold API routes (S52).
 *
 * Exercises GET/PUT/DELETE on /api/model-thresholds against the real dashboard
 * server (loopback), verifying the contract + validation the UI relies on.
 *
 * Spawn-and-fetch harness (same as routes-servers.test.ts) — the dashboard-
 * server.js main block fires when process.argv[1] includes "dashboard-server",
 * so tests under dist/extensions/dashboard-server/ MUST spawn the server as a
 * child process rather than importing launchDashboardServer directly.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

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

async function withServer<T>(
	port: string,
	dir: string,
	fn: (port: number) => Promise<T>,
): Promise<T> {
	process.env.MEGACOMPACT_DASHBOARD_PORT = port;
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

/** Seed a model_snapshots row by writing directly to the DB via the server's
 *  own store — done at launch time by writing a seed file the server imports.
 *  Simpler: use the /api endpoints we already have + a direct DB seed. */
async function seedSnapshot(dir: string): Promise<void> {
	const { recordModelSnapshot } = await import(
		"../../src/store/sqlite/model-snapshots.js"
	);
	const { initSchema } = await import("../../src/store/sqlite/schema.js");
	const { openStore } = await import("../../src/store/sqlite/utils.js");
	const db = openStore(dir);
	initSchema(db);
	recordModelSnapshot(
		"/test/repo",
		{
			provider: "plexus",
			providerName: "Plexus",
			modelId: "glm-5.2-short",
			modelName: "GLM-5.2 (short)",
			inputRate: 0,
			outputRate: 0,
			contextWindow: 200000,
			maxTokens: 20000,
			reasoning: false,
		},
		dir,
	);
}

describe("/api/model-thresholds", () => {
	test("GET returns defaults + known models", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mt-api-get-"));
		await seedSnapshot(dir);
		await withServer("9401", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/model-thresholds`);
			assert.equal(res.status, 200);
			const body = await res.json();
			assert.equal(body.defaults.safetyMarginPct, 5);
			assert.equal(body.defaults.firePointPct, 70);
			assert.ok(Array.isArray(body.models));
			assert.ok(body.models.length >= 1, "seeded model present");
			const glm = body.models.find((m: any) => m.modelId === "glm-5.2-short");
			assert.ok(glm, "seeded model in list");
			assert.equal(glm.threshold.isOverride, false);
			assert.equal(glm.threshold.safetyMarginPct, 5);
			assert.equal(glm.threshold.firePointPct, 70);
		});
	});

	test("PUT upserts and GET reflects the override", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mt-api-put-"));
		await seedSnapshot(dir);
		await withServer("9402", dir, async (port) => {
			const put = await fetch(`http://localhost:${port}/api/model-thresholds`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					modelId: "glm-5.2-short",
					safetyMarginPct: 3,
					firePointPct: 65,
				}),
			});
			assert.equal(put.status, 200);
			const putBody = await put.json();
			assert.equal(putBody.threshold.modelId, "glm-5.2-short");
			assert.equal(putBody.threshold.safetyMarginPct, 3);
			assert.equal(putBody.threshold.firePointPct, 65);

			const get = await fetch(`http://localhost:${port}/api/model-thresholds`);
			const getBody = await get.json();
			const glm = getBody.models.find(
				(m: any) => m.modelId === "glm-5.2-short",
			);
			assert.equal(glm.threshold.isOverride, true);
			assert.equal(glm.threshold.safetyMarginPct, 3);
			assert.equal(glm.threshold.firePointPct, 65);
		});
	});

	test("PUT rejects out-of-range safety margin", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mt-api-bad-safety-"));
		await seedSnapshot(dir);
		await withServer("9403", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/model-thresholds`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					modelId: "x",
					safetyMarginPct: 25,
					firePointPct: 70,
				}),
			});
			assert.equal(res.status, 400);
			const body = await res.json();
			assert.equal(body.error, "invalid_pct");
			assert.match(body.detail, /must be in \[0, 20\]/);
		});
	});

	test("PUT rejects out-of-range fire point", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mt-api-bad-fire-"));
		await seedSnapshot(dir);
		await withServer("9404", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/model-thresholds`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					modelId: "x",
					safetyMarginPct: 5,
					firePointPct: 95,
				}),
			});
			assert.equal(res.status, 400);
			const body = await res.json();
			assert.equal(body.error, "invalid_pct");
			assert.match(body.detail, /must be in \[10, 90\]/);
		});
	});

	test("PUT rejects missing modelId", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mt-api-bad-id-"));
		await seedSnapshot(dir);
		await withServer("9405", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/model-thresholds`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ safetyMarginPct: 5, firePointPct: 70 }),
			});
			assert.equal(res.status, 400);
			assert.equal((await res.json()).error, "missing_model_id");
		});
	});

	test("DELETE reverts to default", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mt-api-del-"));
		await seedSnapshot(dir);
		await withServer("9406", dir, async (port) => {
			// Seed an override first.
			await fetch(`http://localhost:${port}/api/model-thresholds`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					modelId: "glm-5.2-short",
					safetyMarginPct: 2,
					firePointPct: 60,
				}),
			});
			// Delete it.
			const del = await fetch(
				`http://localhost:${port}/api/model-thresholds/glm-5.2-short`,
				{ method: "DELETE" },
			);
			assert.equal(del.status, 200);
			assert.equal((await del.json()).deleted, true);
			// GET shows default again.
			const get = await fetch(`http://localhost:${port}/api/model-thresholds`);
			const body = await get.json();
			const glm = body.models.find((m: any) => m.modelId === "glm-5.2-short");
			assert.equal(glm.threshold.isOverride, false);
			assert.equal(glm.threshold.safetyMarginPct, 5);
		});
	});

	test("GET: empty model list when no snapshots", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mt-api-empty-"));
		// No seedSnapshot — empty DB.
		await withServer("9407", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/model-thresholds`);
			const body = await res.json();
			assert.equal(body.models.length, 0);
			assert.equal(body.defaults.safetyMarginPct, 5);
		});
	});
});
