/**
 * memory-server.test.ts — S53B /api/memory-status endpoint (GET aggregates +
 * 405). Self-contained spawn-and-fetch harness matching the cache-server.test.ts
 * pattern.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { addMemory } from "../../src/store/sqlite/memories.js";
import { closeStore } from "../../src/store/sqlite/utils.js";

const SERVER_ENTRY = new URL("./server.js", import.meta.url).pathname;
const usedDirs: string[] = [];

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
	const d = mkdtempSync(join(tmpdir(), prefix));
	usedDirs.push(d);
	return d;
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
	}
}

afterEach(() => {
	for (const d of usedDirs.splice(0)) {
		try { closeStore(d); } catch { /* ok */ }
		rmSync(d, { recursive: true, force: true });
	}
});

interface MemoryStatusResp {
	updatedAt: string;
	scope: string | null;
	totals: { memories: number; neverReferenced: number; stable: number | null };
	recall: { windowDays: number; events30d: number; distinctMemories30d: number; avgScore: number | null };
	topStable: Array<{ id: number; kind: string; stability: number; events30d: number }>;
	stabilityEnabled: boolean;
}

describe("S53B /api/memory-status", () => {
	test("GET with no memories returns zeroed aggregates", async () => {
		const dir = freshDir("dash-mem-empty-");
		await withServer("19460", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/memory-status`);
			assert.equal(res.status, 200);
			const d = (await res.json()) as MemoryStatusResp;
			assert.equal(d.totals.memories, 0);
			assert.equal(d.totals.neverReferenced, 0);
			assert.equal(d.recall.events30d, 0);
			assert.deepEqual(d.topStable, []);
			assert.equal(d.scope, null);
		});
	});

	test("GET with seeded memories returns correct counts", async () => {
		const dir = freshDir("dash-mem-seeded-");
		addMemory({ content: "first memory" }, null, dir);
		addMemory({ content: "second memory" }, null, dir);
		await withServer("19461", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/memory-status`);
			assert.equal(res.status, 200);
			const d = (await res.json()) as MemoryStatusResp;
			assert.equal(d.totals.memories, 2);
			assert.equal(d.totals.neverReferenced, 2);
			assert.equal(d.stabilityEnabled, true);
		});
	});

	test("non-GET (POST) -> 405", async () => {
		const dir = freshDir("dash-mem-meth-");
		await withServer("19462", dir, async (port) => {
			const res = await fetch(
				`http://localhost:${port}/api/memory-status`,
				{ method: "POST" },
			);
			assert.equal(res.status, 405);
		});
	});
});
