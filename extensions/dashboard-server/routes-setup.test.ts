/**
 * routes-setup.test.ts — /api/setup-status and /api/setup-detect endpoint tests.
 *
 * Covers:
 * - GET /api/setup-status 200 → shape matches SetupStatusResponse
 * - GET /api/setup-detect 200 → shape matches SetupDetectResponse
 * - POST → 405
 * - MEGACOMPACT_EMBEDDING_URL env → currentEmbedder "http"
 * - MEGACOMPACT_MINILM env → currentEmbedder "minilm"
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

function freshDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

async function withServer<T>(
	port: string,
	dir: string,
	fn: (port: number) => Promise<T>,
	env?: Record<string, string>,
): Promise<T> {
	process.env.MEGACOMPACT_DASHBOARD_PORT = port;
	const childEnv = { ...process.env, ...env };
	const child = spawn(process.execPath, [SERVER_ENTRY, dir], {
		stdio: "ignore",
		env: childEnv,
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

describe("GET /api/setup-status", () => {
	test("returns 200 with correct shape", async () => {
		const dir = freshDir("dash-setup-status-");
		await withServer("19470", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/setup-status`);
			assert.equal(res.status, 200);
			const body = await res.json();
			assert.ok(typeof body === "object" && body !== null);
			assert.ok(
				["trigram", "http", "minilm", "unknown"].includes(
					body.currentEmbedder,
				),
				`unexpected currentEmbedder: ${body.currentEmbedder}`,
			);
			assert.ok(
				body.embeddingUrl === null || typeof body.embeddingUrl === "string",
			);
			assert.ok(
				body.embedCache === null || typeof body.embedCache === "string",
			);
			assert.equal(typeof body.minilm, "boolean");
		});
	});

	test("respects MEGACOMPACT_EMBEDDING_URL env var", async () => {
		const dir = freshDir("dash-setup-url-");
		await withServer(
			"19471",
			dir,
			async (port) => {
				const res = await fetch(
					`http://localhost:${port}/api/setup-status`,
				);
				const body = await res.json();
				assert.equal(body.currentEmbedder, "http");
				assert.equal(
					body.embeddingUrl,
					"http://localhost:11434/v1/embeddings",
				);
			},
			{ MEGACOMPACT_EMBEDDING_URL: "http://localhost:11434/v1/embeddings" },
		);
	});

	test("respects MEGACOMPACT_MINILM env var", async () => {
		const dir = freshDir("dash-setup-minilm-");
		await withServer(
			"19472",
			dir,
			async (port) => {
				const res = await fetch(
					`http://localhost:${port}/api/setup-status`,
				);
				const body = await res.json();
				assert.equal(body.currentEmbedder, "minilm");
				assert.equal(body.minilm, true);
			},
			{ MEGACOMPACT_MINILM: "1" },
		);
	});
});

describe("GET /api/setup-detect", () => {
	test("returns 200 with correct shape", async () => {
		const dir = freshDir("dash-setup-detect-");
		await withServer("19473", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/setup-detect`);
			assert.equal(res.status, 200);
			const body = await res.json();
			assert.ok(typeof body === "object" && body !== null);
			// ollama/llamaCpp/onnx can be null or an object with installed
			if (body.ollama !== null) {
				assert.equal(typeof body.ollama.installed, "boolean");
				assert.ok(Array.isArray(body.ollama.models));
				assert.equal(typeof body.ollama.running, "boolean");
			}
			if (body.llamaCpp !== null) {
				assert.equal(typeof body.llamaCpp.installed, "boolean");
			}
			if (body.onnx !== null) {
				assert.equal(typeof body.onnx.installed, "boolean");
			}
			assert.ok(body.error === null || typeof body.error === "string");
		});
	});
});

describe("POST /api/setup-status", () => {
	test("returns 405", async () => {
		const dir = freshDir("dash-setup-post-");
		await withServer("19474", dir, async (port) => {
			const res = await fetch(
				`http://localhost:${port}/api/setup-status`,
				{ method: "POST" },
			);
			assert.equal(res.status, 405);
		});
	});
});
