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
import { withServer } from "./routes-vector-cortex-helpers.js";

describe("/api/vector-cortex/cache-economics (VC7B reader-only)", () => {
	test("GET returns the reader-only economics aggregate when VC7B is ON", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc7b-econ-"));
		process.env.MEGACOMPACT_VC7B = "1";
		try {
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
				};
				assert.equal(body.enabled, true);
				assert.equal(body.mode, "A");
				for (const k of [
					"profileCount",
					"provenExclusions",
					"unprovenExclusions",
				] as const) {
					assert.equal(typeof body[k], "number", `${k} is a count`);
				}
				assert.equal(body.lastFailure, null);
				assert.equal(typeof body.updatedAt, "string");
			});
		} finally {
			delete process.env.MEGACOMPACT_VC7B;
		}
	});

	test("GET cache-economics reports mode C + disabled when VC7B is OFF", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc7b-econ-off-"));
		process.env.MEGACOMPACT_VC7B = "0";
		try {
			await withServer("9493", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/vector-cortex/cache-economics`);
				assert.equal(res.status, 200);
				const body = (await res.json()) as { enabled: boolean; mode: "A" | "B" | "C" };
				assert.equal(body.enabled, false);
				assert.equal(
					body.mode,
					"C",
					"flag-off serves nothing from cache economics: bypassed, not priced (mode C)",
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
			await withServer("9495", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/vector-cortex/cache-economics`);
				assert.equal(res.status, 200);
				const body = (await res.json()) as Record<string, unknown>;
				assert.deepEqual(
					Object.keys(body).sort(),
					[
						"deferredReason",
						"enabled",
						"lastFailure",
						"mode",
						"profileCount",
						"provenExclusions",
						"unprovenExclusions",
						"updatedAt",
					],
					"economics view exposes exactly the aggregate keys",
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
