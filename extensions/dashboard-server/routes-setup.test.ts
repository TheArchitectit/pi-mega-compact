/**
 * routes-setup.test.ts — tests for /api/setup-status + /api/setup-detect.
 *
 * Uses the same spawn-and-fetch harness as routes-cache.test.ts.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const SERVER_ENTRY = new URL("./server.js", import.meta.url).pathname;

function freshDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

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

describe("/api/setup-status", () => {
	test("GET 200 — returns current embedder config", async () => {
		const dir = freshDir("dash-setup-status-");
		await withServer("19510", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/setup-status`);
			assert.equal(res.status, 200);
			const body = await res.json() as Record<string, unknown>;
			assert.ok(typeof body.currentEmbedder === "string", "currentEmbedder is a string");
			assert.ok(typeof body.embeddingUrl === "string" || body.embeddingUrl === null);
			assert.ok(typeof body.minilm === "boolean");
			assert.ok(typeof body.cacheSize === "number");
		});
	});

	test("POST → 405", async () => {
		const dir = freshDir("dash-setup-post-");
		await withServer("19511", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/setup-status`, {
				method: "POST",
			});
			assert.equal(res.status, 405);
		});
	});
});

describe("/api/setup-detect", () => {
	test("GET 200 — returns detection results", async () => {
		const dir = freshDir("dash-setup-detect-");
		await withServer("19512", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/setup-detect`);
			assert.equal(res.status, 200);
			const body = await res.json() as Record<string, unknown>;
			assert.ok(typeof body.ollama === "object", "ollama detection result");
			assert.ok(typeof body.llamaCpp === "object", "llamaCpp detection result");
			assert.ok(typeof body.onnx === "object", "onnx detection result");
		});
	});

	test("POST → 405", async () => {
		const dir = freshDir("dash-setup-detect-post-");
		await withServer("19513", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/setup-detect`, {
				method: "POST",
			});
			assert.equal(res.status, 405);
		});
	});
});
