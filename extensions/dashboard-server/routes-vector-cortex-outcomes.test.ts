/**
 * routes-vector-cortex-outcomes.test.ts — GET /api/vector-cortex/outcomes (VC8A).
 *
 * Reader-only outcomes aggregate: COUNTS, OUT_* CODES ONLY. Its own file
 * (mirroring routes-vector-cortex-economics.test.ts) so the per-sprint route
 * tests stay under the 600-line test hard limit; shares the spawn-and-fetch
 * harness.
 *
 * The privacy row matters: the outcome ledger carries metrics without payload,
 * so a leaked payload field would disclose prompt bytes, response text, or
 * free-text. This route exposes only aggregate counts and OUT_* codes.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withServer } from "./routes-vector-cortex-helpers.js";

describe("/api/vector-cortex/outcomes (VC8A reader-only)", () => {
	test("GET returns the reader-only outcomes aggregate when VC8A is ON", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc8a-out-"));
		process.env.MEGACOMPACT_VC8A = "1";
		try {
			await withServer("9502", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/vector-cortex/outcomes`);
				assert.equal(res.status, 200);
				const body = (await res.json()) as {
					enabled: boolean;
					mode: "A" | "B" | "C";
					outcomeCount: number;
					consentedSessions: number;
					revokedSessions: number;
					manifestCount: number;
					excludedCount: number;
					lastFailure: string | null;
					updatedAt: string;
				};
				assert.equal(body.enabled, true);
				assert.equal(body.mode, "A");
				for (const k of [
					"outcomeCount",
					"consentedSessions",
					"revokedSessions",
					"manifestCount",
					"excludedCount",
				] as const) {
					assert.equal(typeof body[k], "number", `${k} is a count`);
				}
				assert.equal(body.lastFailure, null);
				assert.equal(typeof body.updatedAt, "string");
			});
		} finally {
			delete process.env.MEGACOMPACT_VC8A;
		}
	});

	test("GET outcomes reports mode C + disabled when VC8A is OFF", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc8a-out-off-"));
		process.env.MEGACOMPACT_VC8A = "0";
		try {
			await withServer("9503", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/vector-cortex/outcomes`);
				assert.equal(res.status, 200);
				const body = (await res.json()) as { enabled: boolean; mode: "A" | "B" | "C" };
				assert.equal(body.enabled, false);
				assert.equal(body.mode, "C");
			});
		} finally {
			delete process.env.MEGACOMPACT_VC8A;
		}
	});

	test("GET outcomes rejects non-GET (no mutation on the GET route)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc8a-out-ro-"));
		await withServer("9504", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/vector-cortex/outcomes`, {
				method: "POST",
			});
			assert.equal(res.status, 405);
			assert.deepEqual(await res.json(), { error: "method_not_allowed" });
		});
	});

	test("outcomes body carries counts+codes ONLY — never payload bytes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc8a-out-priv-"));
		process.env.MEGACOMPACT_VC8A = "1";
		try {
			await withServer("9505", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/vector-cortex/outcomes`);
				assert.equal(res.status, 200);
				const body = (await res.json()) as Record<string, unknown>;
				assert.deepEqual(
					Object.keys(body).sort(),
					[
						"consentedSessions",
						"enabled",
						"excludedCount",
						"lastFailure",
						"manifestCount",
						"mode",
						"outcomeCount",
						"revokedSessions",
						"updatedAt",
					],
					"outcomes view exposes exactly the aggregate keys",
				);
				const json = JSON.stringify(body);
				for (const leak of [
					"prompt",
					"response",
					"freeText",
					"exactBytes",
					"content",
					"payload",
					"text",
					"body",
					"message",
				]) {
					assert.ok(!json.includes(`"${leak}"`), `never exposes ${leak}`);
				}
			});
		} finally {
			delete process.env.MEGACOMPACT_VC8A;
		}
	});
});
