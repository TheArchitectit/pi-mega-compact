/**
 * routes-vector-cortex-repair.test.ts — GET /api/vector-cortex/repair (VC6C).
 *
 * Reader-only self-healing derived-state aggregate: COUNTS and HEAL_REPAIR_*
 * codes only. Its own file (mirroring routes-vector-cortex-restore.test.ts) so
 * the per-sprint route tests stay under the 600-line test hard limit; shares
 * the spawn-and-fetch harness below.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withServer } from "./routes-vector-cortex-helpers.js";

describe("/api/vector-cortex/repair (VC6C reader-only)", () => {
	test("GET returns the reader-only repair aggregate when VC6C is ON", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc6c-repair-"));
		process.env.MEGACOMPACT_VC6C = "1";
		try {
			await withServer("9484", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/vector-cortex/repair`);
				assert.equal(res.status, 200);
				const body = (await res.json()) as {
					enabled: boolean;
					mode: "A" | "B" | "C";
					repairAttempts: number;
					repairsPlanned: number;
					pointersSwitched: number;
					backoffs: number;
					lastBackoffMs: number | null;
					lastFailure: string | null;
					updatedAt: string;
				};
				assert.equal(body.enabled, true);
				assert.equal(body.mode, "A");
				// Reader-only: aggregate counts only.
				assert.equal(typeof body.repairAttempts, "number");
				assert.equal(typeof body.repairsPlanned, "number");
				assert.equal(typeof body.pointersSwitched, "number");
				assert.equal(typeof body.backoffs, "number");
				assert.equal(body.lastBackoffMs, null);
				assert.equal(body.lastFailure, null);
				assert.equal(typeof body.updatedAt, "string");
			});
		} finally {
			delete process.env.MEGACOMPACT_VC6C;
		}
	});

	test("GET repair reports mode C + disabled when VC6C is OFF", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc6c-repair-off-"));
		process.env.MEGACOMPACT_VC6C = "0";
		try {
			await withServer("9485", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/vector-cortex/repair`);
				assert.equal(res.status, 200);
				const body = (await res.json()) as { enabled: boolean; mode: "A" | "B" | "C" };
				assert.equal(body.enabled, false);
				assert.equal(
					body.mode,
					"C",
					"flag-off runs no controller: derived state is disabled, not healed (mode C)",
				);
			});
		} finally {
			delete process.env.MEGACOMPACT_VC6C;
		}
	});

	test("GET repair rejects non-GET (reader-only path has no mutation)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc6c-repair-ro-"));
		await withServer("9486", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/vector-cortex/repair`, {
				method: "POST",
			});
			assert.equal(res.status, 405);
			assert.deepEqual(await res.json(), { error: "method_not_allowed" });
		});
	});

	test("repair body carries counts+codes ONLY — never a payload surface", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc6c-repair-priv-"));
		process.env.MEGACOMPACT_VC6C = "1";
		try {
			await withServer("9487", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/vector-cortex/repair`);
				assert.equal(res.status, 200);
				const body = (await res.json()) as Record<string, unknown>;
				// Exhaustive key check: any new key is a deliberate contract change.
				assert.deepEqual(
					Object.keys(body).sort(),
					[
						"backoffs",
						"enabled",
						"lastBackoffMs",
						"lastFailure",
						"mode",
						"pointersSwitched",
						"repairAttempts",
						"repairsPlanned",
						"status",
						"updatedAt",
					],
					"repair view exposes exactly the aggregate keys",
				);
				const json = JSON.stringify(body);
				for (const leak of [
					"bytes",
					"payload",
					"subsystem",
					"highWater",
					"ledger",
					"digest",
					"range",
					"pointer\"",
				]) {
					assert.ok(!json.includes(leak), `never exposes ${leak}`);
				}
			});
		} finally {
			delete process.env.MEGACOMPACT_VC6C;
		}
	});
});
