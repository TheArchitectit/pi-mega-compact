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
import { withServer } from "./routes-vector-cortex-helpers.js";

describe("/api/vector-cortex/cache-diagnostics (VC7C reader-only)", () => {
	test("GET returns the reader-only diagnostics aggregate when VC7C is ON", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc7c-diag-"));
		process.env.MEGACOMPACT_VC7C = "1";
		try {
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
				};
				assert.equal(body.enabled, true);
				assert.equal(body.mode, "A");
				for (const k of [
					"profileMisses",
					"rangeMisses",
					"dependencyMisses",
					"requestMisses",
					"generationMisses",
					"unknownMisses",
					"serveBlocked",
				] as const) {
					assert.equal(typeof body[k], "number", `${k} is a count`);
				}
				assert.equal(typeof body.breakerState, "string");
				assert.equal(body.lastFailure, null);
				assert.equal(typeof body.updatedAt, "string");
			});
		} finally {
			delete process.env.MEGACOMPACT_VC7C;
		}
	});

	test("GET cache-diagnostics reports mode C + disabled when VC7C is OFF", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc7c-diag-off-"));
		process.env.MEGACOMPACT_VC7C = "0";
		try {
			await withServer("9497", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/vector-cortex/cache-diagnostics`);
				assert.equal(res.status, 200);
				const body = (await res.json()) as { enabled: boolean; mode: "A" | "B" | "C" };
				assert.equal(body.enabled, false);
				assert.equal(
					body.mode,
					"C",
					"flag-off attests no cache serve: all-cache bypass, not a crystal hit (mode C)",
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
			await withServer("9499", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/vector-cortex/cache-diagnostics`);
				assert.equal(res.status, 200);
				const body = (await res.json()) as Record<string, unknown>;
				assert.deepEqual(
					Object.keys(body).sort(),
					[
						"breakerState",
						"deferredReason",
						"dependencyMisses",
						"enabled",
						"generationMisses",
						"lastFailure",
						"mode",
						"profileMisses",
						"rangeMisses",
						"requestMisses",
						"serveBlocked",
						"unknownMisses",
						"updatedAt",
					],
					"diagnostics view exposes exactly the aggregate keys",
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
