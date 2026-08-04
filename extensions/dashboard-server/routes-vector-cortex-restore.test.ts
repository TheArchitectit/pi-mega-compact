/**
 * routes-vector-cortex-restore.test.ts — GET /api/vector-cortex/restore (VC6B).
 *
 * Reader-only exact-source-restoration aggregate: COUNTS and HEAL_RESTORE_*
 * codes only. Split from routes-vector-cortex.test.ts so the parent file stays
 * under the 600-line test hard limit; shares the harness below.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withServer } from "./routes-vector-cortex-helpers.js";

describe("/api/vector-cortex/restore (VC6B reader-only)", () => {
	test("GET returns the reader-only restore aggregate when VC6B is ON", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc6b-restore-"));
		process.env.MEGACOMPACT_VC6B = "1";
		try {
			await withServer("9480", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/vector-cortex/restore`);
				assert.equal(res.status, 200);
				const body = (await res.json()) as {
					enabled: boolean;
					mode: "A" | "B" | "C";
					restoreAttempts: number;
					restoredCount: number;
					missingCount: number;
					digestRejections: number;
					lastRejection: string | null;
					updatedAt: string;
				};
				assert.equal(body.enabled, true);
				assert.equal(body.mode, "A");
				// Reader-only: aggregate counts only.
				assert.equal(typeof body.restoreAttempts, "number");
				assert.equal(typeof body.restoredCount, "number");
				assert.equal(typeof body.missingCount, "number");
				assert.equal(typeof body.digestRejections, "number");
				assert.equal(body.lastRejection, null);
				assert.equal(typeof body.updatedAt, "string");
			});
		} finally {
			delete process.env.MEGACOMPACT_VC6B;
		}
	});

	test("GET restore reports mode C + disabled when VC6B is OFF", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc6b-restore-off-"));
		process.env.MEGACOMPACT_VC6B = "0";
		try {
			await withServer("9481", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/vector-cortex/restore`);
				assert.equal(res.status, 200);
				const body = (await res.json()) as { enabled: boolean; mode: "A" | "B" | "C" };
				assert.equal(body.enabled, false);
				assert.equal(body.mode, "C", "flag-off has no exact source: loss is disclosed (mode C)");
			});
		} finally {
			delete process.env.MEGACOMPACT_VC6B;
		}
	});

	test("GET restore rejects non-GET (reader-only path has no mutation)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc6b-restore-ro-"));
		await withServer("9482", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/vector-cortex/restore`, {
				method: "POST",
			});
			assert.equal(res.status, 405);
			assert.deepEqual(await res.json(), { error: "method_not_allowed" });
		});
	});

	test("restore body carries counts+codes ONLY — never a payload surface", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc6b-restore-priv-"));
		process.env.MEGACOMPACT_VC6B = "1";
		try {
			await withServer("9483", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/vector-cortex/restore`);
				assert.equal(res.status, 200);
				const body = (await res.json()) as Record<string, unknown>;
				// Exhaustive key check: any new key is a deliberate contract change.
				assert.deepEqual(
					Object.keys(body).sort(),
					[
						"digestRejections",
						"enabled",
						"lastRejection",
						"missingCount",
						"mode",
						"restoreAttempts",
						"restoredCount",
						"updatedAt",
					],
					"restore view exposes exactly the aggregate keys",
				);
				const json = JSON.stringify(body);
				for (const leak of ["bytes", "payload", "span", "node", "ledger", "digest\"", "range"]) {
					assert.ok(!json.includes(leak), `never exposes ${leak}`);
				}
			});
		} finally {
			delete process.env.MEGACOMPACT_VC6B;
		}
	});
});
