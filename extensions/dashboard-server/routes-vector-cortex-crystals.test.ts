/**
 * routes-vector-cortex-crystals.test.ts — GET /api/vector-cortex/cache-crystals
 * (VC7A).
 *
 * Reader-only frozen-crystal aggregate: COUNTS, BYTE VOLUMES, and CRY_* codes
 * only. Its own file (mirroring routes-vector-cortex-repair.test.ts) so the
 * per-sprint route tests stay under the 600-line test hard limit; shares the
 * spawn-and-fetch harness below.
 *
 * LIVEWIRE: with `MEGACOMPACT_VC7A` ON the route surfaces the LIVE `CrystalStore`
 * aggregate (rehydrated from the persisted snapshot by the spawned reader
 * process), proving the wiring by returning real counts and NO deferredReason.
 * With the flag OFF it returns the byte-identical legacy deferred view.
 *
 * The privacy row matters more here than on any prior VC route: a crystal is a
 * frozen RENDERED PROMPT, so a leaked payload field would disclose the entire
 * framed conversation rather than a diagnostic counter.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withServer, seedLivewireSnapshot } from "./routes-vector-cortex-helpers.js";

describe("/api/vector-cortex/cache-crystals (VC7A reader-only)", () => {
	test("GET returns the LIVE crystal aggregate (not deferred) when VC7A is ON", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc7a-crystals-"));
		process.env.MEGACOMPACT_VC7A = "1";
		try {
			await seedLivewireSnapshot(dir, {
				crystals: {
					crystalCount: 3,
					totalBytes: 1024,
					hits: 5,
					misses: 2,
					hitBytes: 500,
					writes: 3,
					duplicateWrites: 1,
					collisions: 1,
				},
			});
			await withServer("9488", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/vector-cortex/cache-crystals`);
				assert.equal(res.status, 200);
				const body = (await res.json()) as {
					enabled: boolean;
					mode: "A" | "B" | "C";
					crystalCount: number;
					totalBytes: number;
					hits: number;
					misses: number;
					hitBytes: number;
					writes: number;
					duplicateWrites: number;
					collisions: number;
					lastFailure: string | null;
					updatedAt: string;
					status?: string;
					deferredReason?: string;
				};
				assert.equal(body.enabled, true);
				assert.equal(body.deferredReason, undefined, "live crystal store is not deferred");
				assert.equal(body.status, "live");
				assert.equal(body.crystalCount, 3);
				assert.equal(body.totalBytes, 1024);
				assert.equal(body.hits, 5);
				assert.equal(body.misses, 2);
				assert.equal(body.hitBytes, 500);
				assert.equal(body.writes, 3);
				assert.equal(body.duplicateWrites, 1);
				assert.equal(body.collisions, 1);
				assert.equal(body.lastFailure, null);
				assert.equal(typeof body.updatedAt, "string");
			});
		} finally {
			delete process.env.MEGACOMPACT_VC7A;
		}
	});

	test("GET cache-crystals reports mode C + disabled + deferred when VC7A is OFF", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc7a-crystals-off-"));
		process.env.MEGACOMPACT_VC7A = "0";
		try {
			await withServer("9489", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/vector-cortex/cache-crystals`);
				assert.equal(res.status, 200);
				const body = (await res.json()) as {
					enabled: boolean;
					mode: "A" | "B" | "C";
					deferredReason?: string;
				};
				assert.equal(body.enabled, false);
				assert.equal(
					body.mode,
					"C",
					"flag-off serves nothing from the crystal cache: bypassed, not hit (mode C)",
				);
				assert.equal(
					body.deferredReason,
					"crystal_store_not_instantiated_v0_20_23",
					"flag-off parity: deferredReason is byte-identical to the predecessor",
				);
			});
		} finally {
			delete process.env.MEGACOMPACT_VC7A;
		}
	});

	test("an empty (no-data) live store is not deferred and reads awaiting_data", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc7a-crystals-empty-"));
		process.env.MEGACOMPACT_VC7A = "1";
		try {
			await withServer("9492", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/vector-cortex/cache-crystals`);
				assert.equal(res.status, 200);
				const body = (await res.json()) as {
					enabled: boolean;
					deferredReason?: string;
					status?: string;
					crystalCount: number;
				};
				assert.equal(body.enabled, true);
				assert.equal(body.deferredReason, undefined, "not deferred even before any data");
				assert.equal(body.status, "awaiting_data");
				assert.equal(body.crystalCount, 0);
			});
		} finally {
			delete process.env.MEGACOMPACT_VC7A;
		}
	});

	test("GET cache-crystals rejects non-GET (write-once store has no dashboard seam)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc7a-crystals-ro-"));
		await withServer("9490", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/vector-cortex/cache-crystals`, {
				method: "POST",
			});
			assert.equal(res.status, 405);
			assert.deepEqual(await res.json(), { error: "method_not_allowed" });
		});
	});

	test("crystal body carries counts+codes ONLY — never the frozen prompt", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc7a-crystals-priv-"));
		process.env.MEGACOMPACT_VC7A = "1";
		try {
			await seedLivewireSnapshot(dir, {
				crystals: { crystalCount: 3, totalBytes: 1024 },
			});
			await withServer("9491", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/vector-cortex/cache-crystals`);
				assert.equal(res.status, 200);
				const body = (await res.json()) as Record<string, unknown>;
				// Exhaustive key check: any new key is a deliberate contract change.
				assert.deepEqual(
					Object.keys(body).sort(),
					[
						"collisions",
						"crystalCount",
						"duplicateWrites",
						"enabled",
						"hitBytes",
						"hits",
						"lastFailure",
						"misses",
						"mode",
						"status",
						"totalBytes",
						"updatedAt",
						"writes",
					],
					"crystal view exposes exactly the aggregate keys (no deferredReason when live)",
				);
				const json = JSON.stringify(body);
				for (const leak of [
					"bytes\"",
					"payload",
					"digest",
					"sessionId",
					"sourceRanges",
					"coveredDigest",
					"requestDigest",
					"keyDigest",
					"profileId",
					"ledger",
				]) {
					assert.ok(!json.includes(leak), `never exposes ${leak}`);
				}
			});
		} finally {
			delete process.env.MEGACOMPACT_VC7A;
		}
	});
});
