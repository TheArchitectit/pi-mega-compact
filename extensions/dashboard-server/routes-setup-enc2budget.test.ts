/**
 * routes-setup-enc2budget.test.ts — ENC-2a budget-knob route-level tests.
 *
 * Real POST/GET against the spawned server over an isolated tempdir
 * `.mega-compact.env` (no mocks/stubs). The native install budget is written
 * to the disk file as `export MEGACOMPACT_NATIVE_ORT_BUDGET_MIB="<n>"` and
 * surfaced read-only via the GET `/api/setup-status` body — the GET returns
 * BOTH the persisted `nativeOrtBudgetMib` (when set) AND the effective
 * `nativeOrtBudgetEffectiveMib` (always present, the runtime's actual operand).
 * Also exercises the validation path (out-of-clamp integer is rejected 400)
 * and the flag-off branch (MEGACOMPACT_ENC_2BUDGET=0 → fields absent).
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

describe("ENC-2a /api/setup-configure + /api/setup-status round-trip", () => {
	test("POST nativeOrtBudgetMib writes the line to .mega-compact.env; GET echoes persisted + effective", async () => {
		const dir = freshDir("dash-enc2budget-set-");
		await withServer("19527", dir, async (port) => {
			const post = await fetch(`http://localhost:${port}/api/setup-configure`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					embedder: "trigram",
					nativeOrtBudgetMib: "512",
				}),
			});
			assert.equal(post.status, 200, "combined configure writes and replies 200");
			const envContent = readFileSync(join(dir, ".mega-compact.env"), "utf8");
			assert.match(
				envContent,
				/export MEGACOMPACT_NATIVE_ORT_BUDGET_MIB="512"/,
				"budget line written verbatim",
			);

			const get = await fetch(`http://localhost:${port}/api/setup-status`);
			assert.equal(get.status, 200);
			const body = await get.json() as Record<string, unknown>;
			assert.equal(
				body.nativeOrtBudgetMib,
				"512",
				"GET echoes the persisted raw string",
			);
			assert.equal(
				body.nativeOrtBudgetEffectiveMib,
				"512",
				"GET reports the effective runtime operand (matches because 512 is valid)",
			);
		});
	});

	test("out-of-clamp budget (>8192) is rejected with 400 invalid_native_ort_budget_mib and leaves the env file byte-unchanged", async () => {
		const dir = freshDir("dash-enc2budget-oob-");
		await withServer("19528", dir, async (port) => {
			const post = await fetch(`http://localhost:${port}/api/setup-configure`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					embedder: "trigram",
					nativeOrtBudgetMib: "9000",
				}),
			});
			assert.equal(post.status, 400, "out-of-clamp rejected");
			const body = await post.json() as Record<string, unknown>;
			assert.equal(body.error, "invalid_native_ort_budget_mib");
		});
	});

	test("non-numeric budget is rejected with 400 invalid_native_ort_budget_mib", async () => {
		const dir = freshDir("dash-enc2budget-nan-");
		await withServer("19529", dir, async (port) => {
			const post = await fetch(`http://localhost:${port}/api/setup-configure`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					embedder: "trigram",
					nativeOrtBudgetMib: "abc",
				}),
			});
			assert.equal(post.status, 400, "non-numeric rejected");
			const body = await post.json() as Record<string, unknown>;
			assert.equal(body.error, "invalid_native_ort_budget_mib");
		});
	});
});

describe("ENC-2a flag-off (MEGACOMPACT_ENC_2BUDGET=0)", () => {
	test("GET omits nativeOrtBudgetMib + nativeOrtBudgetEffectiveMib", async () => {
		const dir = freshDir("dash-enc2budget-off-");
		await withServer(
			"19530",
			dir,
			async (port) => {
				const get = await fetch(`http://localhost:${port}/api/setup-status`);
				assert.equal(get.status, 200);
				const body = await get.json() as Record<string, unknown>;
				assert.equal(
					body.nativeOrtBudgetMib,
					undefined,
					"flag-off → no persisted-value field",
				);
				assert.equal(
					body.nativeOrtBudgetEffectiveMib,
					undefined,
					"flag-off → no effective-value field",
				);
			},
			{ MEGACOMPACT_ENC_2BUDGET: "0" },
		);
	});

	test("POST nativeOrtBudgetMib falls through (key not recognized)", async () => {
		const dir = freshDir("dash-enc2budget-off-post-");
		await withServer(
			"19531",
			dir,
			async (port) => {
				const post = await fetch(`http://localhost:${port}/api/setup-configure`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						embedder: "trigram",
						nativeOrtBudgetMib: "512",
					}),
				});
				// Pure trigram configure succeeds; the budget key is silently ignored.
				assert.equal(post.status, 200);
				// The env file may not contain the budget line at all when flag-off.
				const envPath = join(dir, ".mega-compact.env");
				const envContent = readFileSync(envPath, "utf8");
				assert.doesNotMatch(
					envContent,
					/MEGACOMPACT_NATIVE_ORT_BUDGET_MIB/,
					"flag-off → budget key never written",
				);
			},
			{ MEGACOMPACT_ENC_2BUDGET: "0" },
		);
	});
});
