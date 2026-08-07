/**
 * routes-setup.test.ts — tests for /api/setup-status + /api/setup-detect.
 *
 * Uses the same spawn-and-fetch harness as routes-cache.test.ts.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
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
	extraEnv: Record<string, string> = {},
): Promise<T> {
	process.env.MEGACOMPACT_DASHBOARD_PORT = port;
	process.env.MEGACOMPACT_DASHBOARD_HOST = "127.0.0.1";
	for (const [k, v] of Object.entries(extraEnv)) process.env[k] = v;
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
		delete process.env.MEGACOMPACT_DASHBOARD_HOST;
		for (const k of Object.keys(extraEnv)) delete process.env[k];
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
			assert.ok(typeof body.embedCache === "string" || body.embedCache === null);
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

// ── ENC-1a: external embedder API key + endpoint Settings round-trip ─────────
// Real POST/GET against the spawned server over an isolated tempdir
// `.mega-compact.env` (no mocks/stubs). Also exercises the flag-off branch by
// spawning with MEGACOMPACT_ENC_1A=0.
const TEST_KEY = "sk-local-test";
const TEST_URL = "http://127.0.0.1:11434/v1/embeddings";

describe("ENC-1a /api/setup-configure + /api/setup-status round-trip", () => {
	test("POST URL+key writes both lines to .mega-compact.env; GET echoes URL + apiKeySet:true and never returns the raw key", async () => {
		const dir = freshDir("dash-enc1a-set-");
		await withServer("19514", dir, async (port) => {
			const post = await fetch(`http://localhost:${port}/api/setup-configure`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ embeddingEndpointUrl: TEST_URL, embeddingApiKey: TEST_KEY }),
			});
			assert.equal(post.status, 200, "pure ENC-1a configure writes and replies 200");
			const envContent = readFileSync(join(dir, ".mega-compact.env"), "utf8");
			assert.match(envContent, /export MEGACOMPACT_EMBEDDING_URL="http:\/\/127\.0\.0\.1:11434\/v1\/embeddings"/, "URL line written");
			assert.match(envContent, /export MEGACOMPACT_EMBEDDING_KEY="sk-local-test"/, "key line written");
			assert.match(envContent, /sk-local-test/, "raw key present in the persisted file (disk only)");

			const get = await fetch(`http://localhost:${port}/api/setup-status`);
			assert.equal(get.status, 200);
			const body = await get.json() as Record<string, unknown>;
			const bodyRaw = JSON.stringify(body);
			assert.equal(body.embeddingEndpointUrl, TEST_URL, "GET echoes the endpoint URL");
			assert.equal(body.embeddingApiKeySet, true, "GET reports apiKeySet:true");
			assert.ok(!bodyRaw.includes(TEST_KEY), "GET body never contains the raw API key (redaction invariant)");
			assert.ok(!("embeddingApiKey" in body), "GET never returns the embeddingApiKey field");
		});
	});

	test("POST URL only (no key) writes only the URL line; GET reports apiKeySet:false (absent-key non-fatal)", async () => {
		const dir = freshDir("dash-enc1a-urlonly-");
		await withServer("19515", dir, async (port) => {
			const post = await fetch(`http://localhost:${port}/api/setup-configure`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ embeddingEndpointUrl: TEST_URL }),
			});
			assert.equal(post.status, 200);
			const envContent = readFileSync(join(dir, ".mega-compact.env"), "utf8");
			assert.match(envContent, /export MEGACOMPACT_EMBEDDING_URL="http:\/\/127\.0\.0\.1:11434\/v1\/embeddings"/, "URL line written");
			assert.ok(!envContent.includes("MEGACOMPACT_EMBEDDING_KEY="), "no key line written when key absent");

			const get = await fetch(`http://localhost:${port}/api/setup-status`);
			const body = await get.json() as Record<string, unknown>;
			assert.equal(body.embeddingEndpointUrl, TEST_URL, "GET echoes the endpoint URL");
			assert.equal(body.embeddingApiKeySet, false, "GET reports apiKeySet:false");
		});
	});

	test("flag-off: GET omits both new fields; POST with the new keys is not recognized (byte-identical predecessor)", async () => {
		const dir = freshDir("dash-enc1a-off-");
		await withServer(
			"19516",
			dir,
			async (port) => {
				const get = await fetch(`http://localhost:${port}/api/setup-status`);
				const body = await get.json() as Record<string, unknown>;
				assert.ok(!("embeddingEndpointUrl" in body), "flag-off GET omits embeddingEndpointUrl");
				assert.ok(!("embeddingApiKeySet" in body), "flag-off GET omits embeddingApiKeySet");
				// POST with the new keys, no valid embedder selection: pre-ENC-1a
				// handler behaviour (invalid_embedder 400 at that point).
				const post = await fetch(`http://localhost:${port}/api/setup-configure`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ embeddingEndpointUrl: TEST_URL, embeddingApiKey: TEST_KEY }),
				});
				assert.notEqual(post.status, 200, "flag-off POST with new keys is not accepted");
				assert.ok(!existsSync(join(dir, ".mega-compact.env")) || !readFileSync(join(dir, ".mega-compact.env"), "utf8").includes("MEGACOMPACT_EMBEDDING_KEY="), "flag-off never writes the key line");
			},
			{ MEGACOMPACT_ENC_1A: "0" },
		);
	});
});
