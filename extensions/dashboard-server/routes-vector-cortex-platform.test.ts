/**
 * routes-vector-cortex-platform.test.ts — GET /api/vector-cortex/platform (VC8C).
 *
 * Reader-only engine parity/selection aggregate: COUNTS, RUST_ CODES ONLY. Its
 * own file (mirroring routes-vector-cortex-policy.test.ts) so the per-sprint
 * route tests stay under the 600-line test hard limit; shares the
 * spawn-and-fetch harness.
 *
 * The privacy row matters: the engine selector carries no payload, so a leaked
 * payload field would disclose artifact bytes, output bytes, or free-text.
 * This route exposes only aggregate counts and machine codes.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withServer } from "./routes-vector-cortex-helpers.js";

describe("/api/vector-cortex/platform (VC8C reader-only)", () => {
	test("GET returns the reader-only platform aggregate when VC8C is ON", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc8c-plat-"));
		process.env.MEGACOMPACT_VC8C = "1";
		try {
			await withServer("9702", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/vector-cortex/platform`);
				assert.equal(res.status, 200);
				const body = (await res.json()) as {
					enabled: boolean;
					mode: "A" | "B" | "C";
					fixtureCount: number;
					passed: number;
					failed: number;
					externalRunnerConfigured: boolean;
					lastFailure: string | null;
					updatedAt: string;
				};
				assert.equal(body.enabled, true);
				assert.equal(body.mode, "A");
				for (const k of [
					"fixtureCount",
					"passed",
					"failed",
				] as const) {
					assert.equal(typeof body[k], "number", `${k} is a count`);
				}
				assert.equal(typeof body.externalRunnerConfigured, "boolean");
				assert.equal(body.lastFailure, null);
				assert.equal(typeof body.updatedAt, "string");
			});
		} finally {
			delete process.env.MEGACOMPACT_VC8C;
		}
	});

	test("GET platform reports mode C + disabled when VC8C is OFF", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc8c-plat-off-"));
		process.env.MEGACOMPACT_VC8C = "0";
		try {
			await withServer("9703", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/vector-cortex/platform`);
				assert.equal(res.status, 200);
				const body = (await res.json()) as { enabled: boolean; mode: "A" | "B" | "C" };
				assert.equal(body.enabled, false);
				assert.equal(body.mode, "C");
			});
		} finally {
			delete process.env.MEGACOMPACT_VC8C;
		}
	});

	test("GET platform rejects non-GET (no mutation on the GET route)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc8c-plat-ro-"));
		await withServer("9704", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/vector-cortex/platform`, {
				method: "POST",
			});
			assert.equal(res.status, 405);
			assert.deepEqual(await res.json(), { error: "method_not_allowed" });
		});
	});

	test("platform body carries counts+codes ONLY — never payload bytes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc8c-plat-priv-"));
		process.env.MEGACOMPACT_VC8C = "1";
		try {
			await withServer("9705", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/vector-cortex/platform`);
				assert.equal(res.status, 200);
				const body = (await res.json()) as Record<string, unknown>;
				assert.deepEqual(
					Object.keys(body).sort(),
					[
						"enabled",
						"externalRunnerConfigured",
						"failed",
						"fixtureCount",
						"lastFailure",
						"mode",
						"passed",
						"status",
						"updatedAt",
					],
					"platform view exposes exactly the aggregate keys",
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
					"artifactBytes",
					"outputBytes",
				]) {
					assert.ok(!json.includes(`"${leak}"`), `never exposes ${leak}`);
				}
			});
		} finally {
			delete process.env.MEGACOMPACT_VC8C;
		}
	});
});
