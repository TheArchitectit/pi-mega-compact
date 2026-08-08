/**
 * routes-vector-cortex-economics.test.ts — GET /api/vector-cortex/cache-economics
 * (VC7B).
 *
 * Reader-only cache-economics aggregate: COUNTS, ECON_* CODES ONLY. Its own file
 * (mirroring routes-vector-cortex-crystals.test.ts) so the per-sprint route tests
 * stay under the 600-line test hard limit; shares the spawn-and-fetch harness.
 *
 * The privacy row matters: cache economics price a FROZEN RENDERED PROMPT's reuse,
 * so a leaked payload field would disclose the framed conversation's covered
 * ranges, span/covered digests, request digests, or session ids. This route
 * exposes only aggregate counts and the observable ECON_* outcome code.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withServer, seedLivewireSnapshot } from "./routes-vector-cortex-helpers.js";

describe("/api/vector-cortex/cache-economics (VC7B reader-only)", () => {
	test("GET returns the LIVE economics aggregate (not deferred) when VC7B is ON", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc7b-econ-"));
		process.env.MEGACOMPACT_VC7B = "1";
		try {
			await seedLivewireSnapshot(dir, {
				economics: { computed: true, profileCount: 4, provenExclusions: 1, unprovenExclusions: 0 },
			});
			await withServer("9492", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/vector-cortex/cache-economics`);
				assert.equal(res.status, 200);
				const body = (await res.json()) as {
					enabled: boolean;
					mode: "A" | "B" | "C";
					profileCount: number;
					provenExclusions: number;
					unprovenExclusions: number;
					lastFailure: string | null;
					updatedAt: string;
					deferredReason?: string;
					status?: string;
				};
				assert.equal(body.enabled, true);
				assert.equal(body.mode, "A");
				assert.equal(body.deferredReason, undefined, "computed economics are not deferred");
				assert.equal(body.status, "live");
				assert.equal(body.profileCount, 4);
				assert.equal(body.provenExclusions, 1);
				assert.equal(body.unprovenExclusions, 0);
				assert.equal(body.lastFailure, null);
				assert.equal(typeof body.updatedAt, "string");
			});
		} finally {
			delete process.env.MEGACOMPACT_VC7B;
		}
	});

	test("economics not yet computed reads awaiting_data (not deferred) when VC7B is ON", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc7b-econ-notcomputed-"));
		process.env.MEGACOMPACT_VC7B = "1";
		try {
			await withServer("9496", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/vector-cortex/cache-economics`);
				assert.equal(res.status, 200);
				const body = (await res.json()) as {
					enabled: boolean;
					deferredReason?: string;
					status?: string;
				};
				assert.equal(body.enabled, true);
				assert.equal(body.deferredReason, undefined, "economics is wired, so never deferred");
				assert.equal(body.status, "awaiting_data");
			});
		} finally {
			delete process.env.MEGACOMPACT_VC7B;
		}
	});

	test("GET cache-economics reports mode C + disabled + deferred when VC7B is OFF", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc7b-econ-off-"));
		process.env.MEGACOMPACT_VC7B = "0";
		try {
			await withServer("9493", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/vector-cortex/cache-economics`);
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
					"flag-off serves nothing from cache economics: bypassed, not priced (mode C)",
				);
				assert.equal(
					body.deferredReason,
					"economics_not_computed_v0_20_23",
					"flag-off parity: deferredReason is byte-identical to the predecessor",
				);
			});
		} finally {
			delete process.env.MEGACOMPACT_VC7B;
		}
	});

	test("GET cache-economics rejects non-GET (no dashboard mutation seam)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc7b-econ-ro-"));
		await withServer("9494", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/vector-cortex/cache-economics`, {
				method: "POST",
			});
			assert.equal(res.status, 405);
			assert.deepEqual(await res.json(), { error: "method_not_allowed" });
		});
	});

	test("economics body carries counts+codes ONLY — never the frozen prompt", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc7b-econ-priv-"));
		process.env.MEGACOMPACT_VC7B = "1";
		try {
			await seedLivewireSnapshot(dir, { economics: { computed: true } });
			await withServer("9495", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/vector-cortex/cache-economics`);
				assert.equal(res.status, 200);
				const body = (await res.json()) as Record<string, unknown>;
				assert.deepEqual(
					Object.keys(body).sort(),
					[
						"enabled",
						"lastFailure",
						"mode",
						"profileCount",
						"provenExclusions",
						"status",
						"unprovenExclusions",
						"updatedAt",
					],
					"economics view exposes exactly the aggregate keys (no deferredReason when live)",
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
					"cachedTokens",
					"basePrice",
					"readPrice",
					"writePrice",
				]) {
					assert.ok(!json.includes(leak), `never exposes ${leak}`);
				}
			});
		} finally {
			delete process.env.MEGACOMPACT_VC7B;
		}
	});
});
