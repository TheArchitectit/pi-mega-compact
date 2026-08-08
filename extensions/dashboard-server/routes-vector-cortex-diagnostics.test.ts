/**
 * routes-vector-cortex-diagnostics.test.ts — GET
 * /api/vector-cortex/cache-diagnostics (VC7C).
 *
 * Reader-only cache miss-classification aggregate: COUNTS, breaker state, and
 * CACHE and M5 CODES ONLY. Its own file (mirroring
 * routes-vector-cortex-economics.test.ts) so the per-sprint route tests stay
 * under the 600-line test hard limit; shares the spawn-and-fetch harness.
 *
 * The privacy row matters most here: a cache MISS diagnostic explains why a
 * specific request failed to hit, so the tempting payload is the request itself
 * — the hashed request bytes, its RequestHashV2 digest, the covered ranges, the
 * span/covered digests, the profile digest, and the session id. The route must
 * expose only per-class counts drawn from a closed enumeration, which is what
 * the payload-free assertion below pins.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withServer, seedLivewireSnapshot } from "./routes-vector-cortex-helpers.js";

describe("/api/vector-cortex/cache-diagnostics (VC7C reader-only)", () => {
	test("GET returns the LIVE diagnostics aggregate (not deferred) when VC7C is ON", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc7c-diag-"));
		process.env.MEGACOMPACT_VC7C = "1";
		try {
			await seedLivewireSnapshot(dir, {
				diagnostics: {
					profileMisses: 4,
					rangeMisses: 3,
					dependencyMisses: 2,
					requestMisses: 1,
					generationMisses: 5,
					unknownMisses: 6,
					serveBlocked: 7,
					breakerState: "OPEN_B",
				},
			});
			await withServer("9496", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/vector-cortex/cache-diagnostics`);
				assert.equal(res.status, 200);
				const body = (await res.json()) as {
					enabled: boolean;
					mode: "A" | "B" | "C";
					profileMisses: number;
					rangeMisses: number;
					dependencyMisses: number;
					requestMisses: number;
					generationMisses: number;
					unknownMisses: number;
					serveBlocked: number;
					breakerState: string;
					lastFailure: string | null;
					updatedAt: string;
					deferredReason?: string;
					status?: string;
				};
				assert.equal(body.enabled, true);
				assert.equal(body.mode, "A");
				assert.equal(body.deferredReason, undefined, "live classifier is not deferred");
				assert.equal(body.status, "live");
				assert.equal(body.profileMisses, 4);
				assert.equal(body.rangeMisses, 3);
				assert.equal(body.dependencyMisses, 2);
				assert.equal(body.requestMisses, 1);
				assert.equal(body.generationMisses, 5);
				assert.equal(body.unknownMisses, 6);
				assert.equal(body.serveBlocked, 7);
				assert.equal(body.breakerState, "OPEN_B");
				assert.equal(body.lastFailure, null);
				assert.equal(typeof body.updatedAt, "string");
			});
		} finally {
			delete process.env.MEGACOMPACT_VC7C;
		}
	});

	test("GET cache-diagnostics reports mode C + disabled + deferred when VC7C is OFF", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc7c-diag-off-"));
		process.env.MEGACOMPACT_VC7C = "0";
		try {
			await withServer("9497", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/vector-cortex/cache-diagnostics`);
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
					"flag-off attests no cache serve: all-cache bypass, not a crystal hit (mode C)",
				);
				assert.equal(
					body.deferredReason,
					"cache_classifier_not_wired_v0_20_23",
					"flag-off parity: deferredReason is byte-identical to the predecessor",
				);
			});
		} finally {
			delete process.env.MEGACOMPACT_VC7C;
		}
	});

	test("GET cache-diagnostics rejects non-GET (no dashboard mutation seam)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc7c-diag-ro-"));
		await withServer("9498", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/vector-cortex/cache-diagnostics`, {
				method: "POST",
			});
			assert.equal(res.status, 405);
			assert.deepEqual(await res.json(), { error: "method_not_allowed" });
			const miss = await fetch(`http://localhost:${port}/api/vector-cortex/cache-diagnostics-x`);
			assert.notEqual(miss.status, 405);
		});
	});

	test("diagnostics body carries counts+codes ONLY — never the missed request", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc7c-diag-priv-"));
		process.env.MEGACOMPACT_VC7C = "1";
		try {
			await seedLivewireSnapshot(dir, {
				diagnostics: { profileMisses: 1, serveBlocked: 2 },
			});
			await withServer("9499", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/vector-cortex/cache-diagnostics`);
				assert.equal(res.status, 200);
				const body = (await res.json()) as Record<string, unknown>;
				assert.deepEqual(
					Object.keys(body).sort(),
					[
						"breakerState",
						"dependencyMisses",
						"enabled",
						"generationMisses",
						"lastFailure",
						"mode",
						"profileMisses",
						"rangeMisses",
						"requestMisses",
						"serveBlocked",
						"status",
						"unknownMisses",
						"updatedAt",
					],
					"diagnostics view exposes exactly the aggregate keys (no deferredReason when live)",
				);
				const json = JSON.stringify(body);
				for (const leak of [
					"bytes\"",
					"payload",
					"request\"",
					"requestHash",
					"requestDigest",
					"digest",
					"sessionId",
					"sourceRanges",
					"coveredRange",
					"coveredDigest",
					"spanDigest",
					"keyDigest",
					"profileId",
					"profileDigest",
					"generationId",
					"ledger",
				]) {
					assert.ok(!json.includes(leak), `never exposes ${leak}`);
				}
			});
		} finally {
			delete process.env.MEGACOMPACT_VC7C;
		}
	});
});
