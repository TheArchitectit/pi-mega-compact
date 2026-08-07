/**
 * routes-setup-enc1b.test.ts — ENC-1b route-level tests.
 *
 * Extracted from routes-setup.test.ts so the parent stays under the 400-line
 * extensions/ soft cap (per CLAUDE.md §6 splitting pattern). Real POST/GET
 * against the spawned server over isolated tempdir `.mega-compact.env` files
 * (no mocks/stubs). The raw headers JSON (a secret-bearing JSON object) is
 * written to the disk file but NEVER echoed in any GET body — the GET reports
 * only `embeddingHeadersSet:true`. Also exercises the flag-off branch by
 * spawning with MEGACOMPACT_ENC_1B=0.
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

const TEST_HEADERS = '{"x-extra":"1"}';

describe("ENC-1b /api/setup-configure + /api/setup-status round-trip", () => {
	test("POST dim+headers+allowRemote+nativeOptIn writes all four lines to .mega-compact.env; GET echoes dim + reports booleans and never returns raw headers", async () => {
		const dir = freshDir("dash-enc1b-set-");
		await withServer("19517", dir, async (port) => {
			const post = await fetch(`http://localhost:${port}/api/setup-configure`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					embeddingDim: "384",
					embeddingHeaders: TEST_HEADERS,
					allowRemoteEmbedder: true,
					encoderNativeOptIn: true,
				}),
			});
			assert.equal(post.status, 200, "pure ENC-1b configure writes and replies 200");
			const envContent = readFileSync(join(dir, ".mega-compact.env"), "utf8");
			assert.match(envContent, /export MEGACOMPACT_EMBEDDING_DIM="384"/, "dim line written");
			assert.match(envContent, /export MEGACOMPACT_EMBEDDING_HEADERS=/, "headers line written");
			assert.match(envContent, /x-extra/, "raw headers JSON present on the persisted file (disk only)");
			assert.match(envContent, /export MEGACOMPACT_ALLOW_REMOTE_EMBEDDER="1"/, "allow-remote line written as 1");
			assert.match(envContent, /export MEGACOMPACT_ENCODER_NATIVE="1"/, "native opt-in line written as 1");

			const get = await fetch(`http://localhost:${port}/api/setup-status`);
			assert.equal(get.status, 200);
			const body = await get.json() as Record<string, unknown>;
			const bodyRaw = JSON.stringify(body);
			assert.equal(body.embeddingDim, "384", "GET echoes the dim");
			assert.equal(body.embeddingHeadersSet, true, "GET reports headersSet:true");
			assert.equal(body.allowRemoteEmbedder, true, "GET reports allowRemoteEmbedder:true");
			assert.equal(body.encoderNativeOptIn, true, "GET reports encoderNativeOptIn:true");
			assert.ok(body.encoderBackend === "wasm" || body.encoderBackend === "native", "encoderBackend is wasm|native");
			assert.ok(!("embeddingHeaders" in body), "GET never returns the embeddingHeaders field");
			assert.ok(!bodyRaw.includes(TEST_HEADERS), "GET body never contains the raw headers JSON (redaction invariant)");
		});
	});

	test("raw headers JSON is NEVER echoed in any GET body (zero-tolerance full-body scan)", async () => {
		const dir = freshDir("dash-enc1b-redact-");
		await withServer("19518", dir, async (port) => {
			await fetch(`http://localhost:${port}/api/setup-configure`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ embeddingHeaders: '{"Authorization":"Bearer sk-secret-xyz"}' }),
			});
			const get = await fetch(`http://localhost:${port}/api/setup-status`);
			const bodyRaw = JSON.stringify(await get.json());
			assert.ok(!bodyRaw.includes("sk-secret-xyz"), "GET body never contains the secret header value");
			assert.ok(!bodyRaw.includes("x-extra"), "GET body never contains the headers JSON object");
			assert.ok(!bodyRaw.includes("Bearer"), "GET body never contains the Authorization header value");
		});
	});

	test("dim over the ENC-1b cap (or non-integer) is rejected with 400 invalid_embedding_dim and the file is left byte-unchanged", async () => {
		const dir = freshDir("dash-enc1b-dimcap-");
		await withServer("19519", dir, async (port) => {
			const bad = await fetch(`http://localhost:${port}/api/setup-configure`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ embeddingDim: "999999999" }),
			});
			assert.equal(bad.status, 400, "over-cap dim rejected with 400");
			assert.equal((await bad.json() as { error: string }).error, "invalid_embedding_dim");
			const nom = await fetch(`http://localhost:${port}/api/setup-configure`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ embeddingDim: "abc" }),
			});
			assert.equal(nom.status, 400, "non-integer dim rejected with 400");
			assert.equal((await nom.json() as { error: string }).error, "invalid_embedding_dim");
			assert.ok(!existsSync(join(dir, ".mega-compact.env")) || !readFileSync(join(dir, ".mega-compact.env"), "utf8").includes("MEGACOMPACT_EMBEDDING_DIM="), "rejected dim never writes the dim line");
		});
	});

	test("invalid headers JSON (not a JSON object) is rejected with 400 invalid_embedding_headers and the file is left byte-unchanged", async () => {
		const dir = freshDir("dash-enc1b-badheaders-");
		await withServer("19520", dir, async (port) => {
			for (const h of ['["not-an-object"]', '"just-a-string"', "{bad json}"]) {
				const bad = await fetch(`http://localhost:${port}/api/setup-configure`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ embeddingHeaders: h }),
				});
				assert.equal(bad.status, 400, `reject ${h} with 400`);
				assert.equal((await bad.json() as { error: string }).error, "invalid_embedding_headers");
			}
			assert.ok(!existsSync(join(dir, ".mega-compact.env")) || !readFileSync(join(dir, ".mega-compact.env"), "utf8").includes("MEGACOMPACT_EMBEDDING_HEADERS="), "rejected headers never writes the headers line");
		});
	});

	test("allowRemoteEmbedder defaults to false when the line is absent; present 1 -> true", async () => {
		const dir = freshDir("dash-enc1b-remotedefault-");
		await withServer("19521", dir, async (port) => {
			const get0 = await fetch(`http://localhost:${port}/api/setup-status`);
			const body0 = await get0.json() as Record<string, unknown>;
			assert.equal(body0.allowRemoteEmbedder, false, "absent line -> allowRemoteEmbedder:false (default off)");
			await fetch(`http://localhost:${port}/api/setup-configure`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ allowRemoteEmbedder: true }),
			});
			const get1 = await fetch(`http://localhost:${port}/api/setup-status`);
			const body1 = await get1.json() as Record<string, unknown>;
			assert.equal(body1.allowRemoteEmbedder, true, "present 1 -> allowRemoteEmbedder:true");
		});
	});

	test("flag-off: GET omits all new fields; POST with the new keys is not recognized (byte-identical predecessor)", async () => {
		const dir = freshDir("dash-enc1b-off-");
		await withServer(
			"19522",
			dir,
			async (port) => {
				const get = await fetch(`http://localhost:${port}/api/setup-status`);
				const body = await get.json() as Record<string, unknown>;
				assert.ok(!("embeddingDim" in body), "flag-off GET omits embeddingDim");
				assert.ok(!("embeddingHeadersSet" in body), "flag-off GET omits embeddingHeadersSet");
				assert.ok(!("allowRemoteEmbedder" in body), "flag-off GET omits allowRemoteEmbedder");
				assert.ok(!("encoderNativeOptIn" in body), "flag-off GET omits encoderNativeOptIn");
				assert.ok(!("encoderBackend" in body), "flag-off GET omits encoderBackend");
				assert.ok(!("encoderDemotionReason" in body), "flag-off GET omits encoderDemotionReason");
				// POST with the new keys, no valid embedder selection: falls through
				// to the pre-ENC-1b embedder path (invalid_embedder 400).
				const post = await fetch(`http://localhost:${port}/api/setup-configure`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ embeddingDim: "384", embeddingHeaders: TEST_HEADERS, allowRemoteEmbedder: true, encoderNativeOptIn: true }),
				});
				assert.notEqual(post.status, 200, "flag-off POST with new keys is not accepted");
				assert.ok(!existsSync(join(dir, ".mega-compact.env")) || !readFileSync(join(dir, ".mega-compact.env"), "utf8").includes("MEGACOMPACT_ENCODER_NATIVE="), "flag-off never writes the ENC-1b lines");
			},
			{ MEGACOMPACT_ENC_1B: "0" },
		);
	});
});

// ── ENC-1b combined-payload defects caught in live review (Worker B) ─────
// The pure-ENC-1b path validates dim/headers and rejects malformed payloads
// with a 400. The combined path (payload carries a valid embedder AND the
// ENC-1b keys) bypassed that validation because tryEnc1bConfigure only
// handles the pure shape — and the primary embedder write rewrote the whole
// .mega-compact.env, wiping previously-persisted ENC-1a/1b lines. Both are
// pinned here against the cross-sub-tab live interaction.

describe("ENC-1b combined-payload validation + additive persistence (live-review pinning)", () => {
	test("POST embedder=custom + invalid headers JSON returns 400 invalid_embedding_headers and the persisted file stays byte-unchanged", async () => {
		const dir = freshDir("dash-enc1b-combined-headers-");
		await withServer("19600", dir, async (port) => {
			const seed = await fetch(`http://localhost:${port}/api/setup-configure`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					embedder: "custom",
					url: "http://127.0.0.1:11434/v1/embeddings",
					embeddingEndpointUrl: "http://127.0.0.1:11434/v1/embeddings",
					embeddingApiKey: "sk-local-test",
					embeddingDim: "384",
				}),
			});
			assert.equal(seed.status, 200);
			const before = readFileSync(join(dir, ".mega-compact.env"), "utf8");

			const bad = await fetch(`http://localhost:${port}/api/setup-configure`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					embedder: "custom",
					url: "http://127.0.0.1:11434/v1/embeddings",
					embeddingHeaders: "{not valid json",
				}),
			});
			assert.equal(bad.status, 400, "combined invalid headers rejected with 400");
			assert.equal((await bad.json() as { error: string }).error, "invalid_embedding_headers");
			const after = readFileSync(join(dir, ".mega-compact.env"), "utf8");
			assert.equal(after, before, "the persisted file is byte-unchanged after the rejected combined POST");
		});
	});

	test("POST embedder=custom + dim over the cap returns 400 invalid_embedding_dim and the persisted file stays byte-unchanged", async () => {
		const dir = freshDir("dash-enc1b-combined-dim-");
		await withServer("19601", dir, async (port) => {
			const seed = await fetch(`http://localhost:${port}/api/setup-configure`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					embedder: "custom",
					url: "http://127.0.0.1:11434/v1/embeddings",
					embeddingApiKey: "sk-local-test",
				}),
			});
			assert.equal(seed.status, 200);
			const before = readFileSync(join(dir, ".mega-compact.env"), "utf8");

			const bad = await fetch(`http://localhost:${port}/api/setup-configure`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					embedder: "custom",
					url: "http://127.0.0.1:11434/v1/embeddings",
					embeddingDim: "999999999",
				}),
			});
			assert.equal(bad.status, 400);
			assert.equal((await bad.json() as { error: string }).error, "invalid_embedding_dim");
			const after = readFileSync(join(dir, ".mega-compact.env"), "utf8");
			assert.equal(after, before, "the persisted file is byte-unchanged after the rejected combined POST");
		});
	});

	test("Cortex sub-tab native-opt-in POST preserves previously-persisted ENC-1a/1b embedder keys (additive upsert, not rewrite)", async () => {
		const dir = freshDir("dash-enc1b-preserve-");
		await withServer("19602", dir, async (port) => {
			const seed = await fetch(`http://localhost:${port}/api/setup-configure`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					embedder: "custom",
					url: "http://127.0.0.1:11434/v1/embeddings",
					embeddingEndpointUrl: "http://127.0.0.1:11434/v1/embeddings",
					embeddingApiKey: "sk-local-test",
					embeddingDim: "384",
					embeddingHeaders: TEST_HEADERS,
					allowRemoteEmbedder: true,
				}),
			});
			assert.equal(seed.status, 200);
			const pre = readFileSync(join(dir, ".mega-compact.env"), "utf8");
			for (const k of ["MEGACOMPACT_EMBEDDING_URL", "MEGACOMPACT_EMBEDDING_KEY", "MEGACOMPACT_EMBEDDING_DIM", "MEGACOMPACT_EMBEDDING_HEADERS"]) {
				assert.ok(pre.includes(`export ${k}=`), `seed wrote ${k}`);
			}

			// Cortex sub-tab native opt-in toggle — body carries only the
			// native flag, no dim/headers/key. MUST NOT wipe the prior keys.
			const toggle = await fetch(`http://localhost:${port}/api/setup-configure`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ encoderNativeOptIn: true }),
			});
			assert.equal(toggle.status, 200);
			const post = readFileSync(join(dir, ".mega-compact.env"), "utf8");
			for (const k of ["MEGACOMPACT_EMBEDDING_URL", "MEGACOMPACT_EMBEDDING_KEY", "MEGACOMPACT_EMBEDDING_DIM", "MEGACOMPACT_EMBEDDING_HEADERS", "MEGACOMPACT_ALLOW_REMOTE_EMBEDDER", "MEGACOMPACT_ENCODER_NATIVE"]) {
				assert.ok(post.includes(`export ${k}=`), `after native-opt-in POST, ${k} line is preserved`);
			}

			// GET still reports all the surface booleans + the persisted dim.
			const get = await fetch(`http://localhost:${port}/api/setup-status`);
			const body = await get.json() as Record<string, unknown>;
			assert.equal(body.embeddingApiKeySet, true);
			assert.equal(body.embeddingHeadersSet, true);
			assert.equal(body.allowRemoteEmbedder, true);
			assert.equal(body.encoderNativeOptIn, true);
			assert.equal(body.embeddingDim, "384");
		});
	});
});
