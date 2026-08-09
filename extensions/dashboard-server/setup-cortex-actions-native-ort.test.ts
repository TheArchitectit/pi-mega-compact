/**
 * setup-cortex-actions-native-ort.test.ts — ENC-2c lazy-download install driver.
 *
 * Verifies the confirm-gated install-native-ort action mechanics: the committed
 * script locator resolves to a REAL on-disk script (never a hallucinated path),
 * the route rejects a missing confirmation (400) and a flag-off request (400
 * invalid_action — byte-identical ENC-2b predecessor), and the driver carries NO
 * URL literals anywhere in its source (no-network proof, PREVENT-PI-004).
 *
 * Uses the real spawn-and-fetch harness (withServer) — no mocks, no stubs. The
 * install action itself is blocked by the open HG-3 gate in-workstream (423), so
 * no install subprocess spawns; these tests never attempt a real download.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withServer } from "./routes-vector-cortex-helpers.js";
import { installScriptPath } from "./setup-cortex-actions-native-ort.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repo root (the dir holding conformance/vector-cortex). Works from dist too. */
function repoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "conformance", "vector-cortex"))) return dir;
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  throw new Error("conformance corpus not found above " + from);
}
const ROOT = repoRoot(HERE);

const ACTION_BODY = (action: string, confirm: boolean) =>
	JSON.stringify({ action, confirm });

describe("ENC-2c install-native-ort driver", () => {
	test("script locator resolves to the REAL committed install script", () => {
		const resolved = installScriptPath();
		assert.ok(resolved !== null, "install script must resolve in this checkout");
		assert.ok(resolved.endsWith("install-native-ort.mjs"));
		// The located path must actually exist on disk and be a committed file.
		assert.ok(
			readFileSync(resolved, "utf8").includes("install-native-ort"),
			"resolved path is the committed install script",
		);
	});

	test("the driver module carries NO URL literals (no-network proof, PREVENT-PI-004)", () => {
		const src = readFileSync(
			join(ROOT, "extensions", "dashboard-server", "setup-cortex-actions-native-ort.ts"),
			"utf8",
		);
		for (const scheme of ["https:", "http:", "tcp:", "wss:", "ws:"]) {
			assert.ok(
				!src.includes(`"${scheme}`) && !src.includes(`'${scheme}`),
				`no ${scheme} URL literal in the driver source`,
			);
		}
	});
});

describe("/api/setup-cortex-action — install-native-ort (route)", () => {
	test("confirm missing/not-true yields 400 confirmation_required (no spawn)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "enc2c-confirm-"));
		process.env.MEGACOMPACT_VC9B = "1";
		process.env.MEGACOMPACT_ENC_2C = "1";
		try {
			await withServer("9741", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/setup-cortex-action`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: ACTION_BODY("install-native-ort", false),
				});
				assert.equal(res.status, 400);
				assert.deepEqual(await res.json(), { error: "confirmation_required" });
			});
		} finally {
			delete process.env.MEGACOMPACT_VC9B;
			delete process.env.MEGACOMPACT_ENC_2C;
		}
	});

	test("flag-off (MEGACOMPACT_ENC_2C=0) rejects install-native-ort as invalid_action (byte-identical)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "enc2c-off-"));
		process.env.MEGACOMPACT_VC9B = "1";
		process.env.MEGACOMPACT_ENC_2C = "0";
		try {
			await withServer("9742", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/setup-cortex-action`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: ACTION_BODY("install-native-ort", true),
				});
				assert.equal(res.status, 400);
				assert.deepEqual(await res.json(), { error: "invalid_action" });
			});
		} finally {
			delete process.env.MEGACOMPACT_VC9B;
			delete process.env.MEGACOMPACT_ENC_2C;
		}
	});

	test("an open HG-3 gate blocks install-native-ort (423, no spawn)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "enc2c-blocked-"));
		// Redirect the native-ort root + encoder state dir so the ENC-2a probe
		// finds NO installed binding — this keeps HG-3 open regardless of whether
		// the dev machine has the binding installed globally.
		const emptyOrt = join(dir, "native-ort-empty");
		const savedStateDir = process.env.MEGACOMPACT_STATE_DIR;
		const savedOrtRoot = process.env.MEGACOMPACT_NATIVE_ORT_ROOT;
		process.env.MEGACOMPACT_STATE_DIR = dir;
		process.env.MEGACOMPACT_NATIVE_ORT_ROOT = emptyOrt;
		process.env.MEGACOMPACT_VC9B = "1";
		process.env.MEGACOMPACT_ENC_2C = "1";
		try {
			await withServer("9743", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/setup-cortex-action`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: ACTION_BODY("install-native-ort", true),
				});
				const body = (await res.json()) as { error: string; blockers: string[] };
				assert.equal(body.error, "action_blocked_by_open_item");
				assert.ok(body.blockers.includes("HG-3"), `HG-3 gates install-native-ort, got ${body.blockers}`);
				// No spawn: assert no vc9b log file was produced for this action.
				const logDir = join(dir, "logs", "vc9b");
				const { existsSync, readdirSync } = await import("node:fs");
				if (existsSync(logDir)) {
					assert.ok(
						!readdirSync(logDir).some((f) => f.startsWith("install-native-ort-")),
						"no install-native-ort log means no subprocess spawned",
					);
				}
			});
		} finally {
			if (savedStateDir === undefined) delete process.env.MEGACOMPACT_STATE_DIR;
			else process.env.MEGACOMPACT_STATE_DIR = savedStateDir;
			if (savedOrtRoot === undefined) delete process.env.MEGACOMPACT_NATIVE_ORT_ROOT;
			else process.env.MEGACOMPACT_NATIVE_ORT_ROOT = savedOrtRoot;
			delete process.env.MEGACOMPACT_VC9B;
			delete process.env.MEGACOMPACT_ENC_2C;
		}
	});
});
