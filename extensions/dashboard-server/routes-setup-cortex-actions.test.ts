/**
 * routes-setup-cortex-actions.test.ts — VC9B action routes.
 *
 * POST /api/setup-cortex-action (confirmation-gated, hard-gate aware) and
 * GET /api/setup-cortex-action-log (bounded, redacted). ACTOR/READER-only:
 * never payload bytes / prompts / ledger (EVAL-REDACT-002). Uses the real server
 * spawn-and-fetch harness (withServer) — no mocks, no stubs.
 *
 * The hard gates (HG-1/HG-3) stay OPEN in-workstream, so fetch-model and bench
 * are always blocked and NO subprocess spawns — verified by asserting no log
 * file appears under <stateDir>/logs/vc9b/. verify-asset re-runs the committed
 * encoder verification seam (real, no subprocess).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withServer } from "./routes-vector-cortex-helpers.js";

/** The vc9b log dir for a server stateDir (mirrors the driver's naming). */
function logDir(dir: string): string {
	return join(dir, "logs", "vc9b");
}

/** Assert the stateDir has no vc9b log files (proves NO subprocess spawned). */
function assertNoLogs(dir: string): void {
	const d = logDir(dir);
	if (existsSync(d)) {
		assert.deepEqual(readdirSync(d), [], "no vc9b log file may be created when the action is blocked/not run");
	}
}

const ACTION_BODY = (action: string, confirm: boolean) =>
	JSON.stringify({ action, confirm });

describe("/api/setup-cortex-action (VC9B)", () => {
	test("confirm missing (not true) yields 400 confirmation_required", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc9b-confirm-"));
		process.env.MEGACOMPACT_VC9B = "1";
		try {
			await withServer("9720", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/setup-cortex-action`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: ACTION_BODY("bench", false),
				});
				assert.equal(res.status, 400);
				assert.deepEqual(await res.json(), { error: "confirmation_required" });
				assertNoLogs(dir);
			});
		} finally {
			delete process.env.MEGACOMPACT_VC9B;
		}
	});

	test("a hard-gate-blocked action returns 4xx + blockers and does NOT spawn a subprocess", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc9b-blocked-"));
		process.env.MEGACOMPACT_VC9B = "1";
		try {
			await withServer("9721", dir, async (port) => {
				for (const action of ["fetch-model", "bench"]) {
					const res = await fetch(`http://localhost:${port}/api/setup-cortex-action`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: ACTION_BODY(action, true),
					});
					assert.equal(res.status, 423, `${action} blocked`);
					const body = (await res.json()) as { error: string; blockers: string[] };
					assert.equal(body.error, "action_blocked_by_open_item");
					assert.deepEqual(body.blockers.sort(), ["HG-1", "HG-3"]);
					assertNoLogs(dir); // NO spawn — no log file created
				}
			});
		} finally {
			delete process.env.MEGACOMPACT_VC9B;
		}
	});

	test("verify-asset runs the real encoder-verify seam (no subprocess) and writes a log", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc9b-verify-"));
		process.env.MEGACOMPACT_VC9B = "1";
		try {
			await withServer("9722", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/setup-cortex-action`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: ACTION_BODY("verify-asset", true),
				});
				assert.equal(res.status, 200);
				const result = (await res.json()) as {
					action: string;
					ok: boolean;
					spawned: boolean;
					exitCode: number | null;
					logName: string;
					logPath: string;
				};
				assert.equal(result.action, "verify-asset");
				assert.equal(result.ok, true);
				assert.equal(result.spawned, false, "verify-asset never spawns a subprocess");
				assert.equal(result.exitCode, null);
				assert.match(result.logName, /^verify-asset-\d+\.log$/);
			});
		} finally {
			delete process.env.MEGACOMPACT_VC9B;
		}
	});

	test("invalid action or invalid body yields 400", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc9b-invalid-"));
		process.env.MEGACOMPACT_VC9B = "1";
		try {
			await withServer("9723", dir, async (port) => {
				const badAction = await fetch(`http://localhost:${port}/api/setup-cortex-action`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: ACTION_BODY("train", true),
				});
				assert.equal(badAction.status, 400);
				assert.deepEqual(await badAction.json(), { error: "invalid_action" });

				const badBody = await fetch(`http://localhost:${port}/api/setup-cortex-action`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: "{not json",
				});
				assert.equal(badBody.status, 400);
			});
		} finally {
			delete process.env.MEGACOMPACT_VC9B;
		}
	});

	test("non-POST is rejected 405 on the action route", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc9b-method-"));
		process.env.MEGACOMPACT_VC9B = "1";
		try {
			await withServer("9724", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/setup-cortex-action`, { method: "GET" });
				assert.equal(res.status, 405);
				assert.deepEqual(await res.json(), { error: "method_not_allowed" });
			});
		} finally {
			delete process.env.MEGACOMPACT_VC9B;
		}
	});

	test("flag-off returns the 404 disabled shape byte-identically (no action runs)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc9b-off-"));
		process.env.MEGACOMPACT_VC9B = "0";
		try {
			await withServer("9725", dir, async (port) => {
				for (const action of ["fetch-model", "bench", "verify-asset"]) {
					const res = await fetch(`http://localhost:${port}/api/setup-cortex-action`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: ACTION_BODY(action, true),
					});
					assert.equal(res.status, 404);
					assert.deepEqual(await res.json(), { error: "disabled" });
				}
				assertNoLogs(dir);
			});
		} finally {
			delete process.env.MEGACOMPACT_VC9B;
		}
	});

	test("action responses never carry payload bytes (privacy)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc9b-priv-"));
		process.env.MEGACOMPACT_VC9B = "1";
		try {
			await withServer("9726", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/setup-cortex-action`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: ACTION_BODY("verify-asset", true),
				});
				const body = await res.text();
				for (const leak of [
					'"prompt"',
					'"response"',
					'"freeText"',
					'"exactBytes"',
					'"content"',
					'"ontology"',
					'"ledger"',
					'"model.onnx"',
				]) {
					assert.ok(!body.includes(leak), `action response never exposes ${leak}`);
				}
			});
		} finally {
			delete process.env.MEGACOMPACT_VC9B;
		}
	});
});

describe("/api/setup-cortex-action-log (VC9B)", () => {
	test("log tail is bounded at 8 KiB and redacted", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc9b-log-"));
		process.env.MEGACOMPACT_VC9B = "1";
		try {
			await withServer("9727", dir, async (port) => {
				// Produce a real verify-asset log.
				const act = await fetch(`http://localhost:${port}/api/setup-cortex-action`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: ACTION_BODY("verify-asset", true),
				});
				const result = (await act.json()) as { logName: string };
				const tail = await fetch(
					`http://localhost:${port}/api/setup-cortex-action-log?name=${result.logName}`,
				);
				assert.equal(tail.status, 200);
				const body = (await tail.json()) as { name: string; tail: string; complete: boolean };
				assert.equal(body.name, result.logName);
				assert.ok(body.tail.length > 0);
				assert.ok(body.tail.length <= 8192, `bounded at 8 KiB, got ${body.tail.length}`);
				// Redacted: any long hex digest is collapsed to a prefix, never full bytes.
				assert.ok(!/[0-9a-f]{64}/i.test(body.tail), "no full-length sha256 in the tail");
			});
		} finally {
			delete process.env.MEGACOMPACT_VC9B;
		}
	});

	test("path traversal in name is rejected (404, never reads outside the log dir)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc9b-trav-"));
		process.env.MEGACOMPACT_VC9B = "1";
		try {
			await withServer("9728", dir, async (port) => {
				for (const evil of ["../dashboard.json", "..%2F..%2Fetc%2Fpasswd", "a/b.log", ".."]) {
					const res = await fetch(
						`http://localhost:${port}/api/setup-cortex-action-log?name=${encodeURIComponent(evil)}`,
					);
					assert.equal(res.status, 404, `traversal '${evil}' rejected`);
				}
			});
		} finally {
			delete process.env.MEGACOMPACT_VC9B;
		}
	});

	test("non-GET is rejected 405 on the log route", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc9b-log-method-"));
		process.env.MEGACOMPACT_VC9B = "1";
		try {
			await withServer("9729", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/setup-cortex-action-log`, {
					method: "POST",
				});
				assert.equal(res.status, 405);
				assert.deepEqual(await res.json(), { error: "method_not_allowed" });
			});
		} finally {
			delete process.env.MEGACOMPACT_VC9B;
		}
	});

	test("missing name yields 400", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc9b-log-noname-"));
		process.env.MEGACOMPACT_VC9B = "1";
		try {
			await withServer("9730", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/setup-cortex-action-log`);
				assert.equal(res.status, 400);
				assert.deepEqual(await res.json(), { error: "invalid_log_name" });
			});
		} finally {
			delete process.env.MEGACOMPACT_VC9B;
		}
	});
});
