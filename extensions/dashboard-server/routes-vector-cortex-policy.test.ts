/**
 * routes-vector-cortex-policy.test.ts — GET /api/vector-cortex/policy (VC8B).
 *
 * Reader-only policy/shadow aggregate: COUNTS, POL_ and M7_ CODES ONLY. Its own
 * file (mirroring routes-vector-cortex-outcomes.test.ts) so the per-sprint
 * route tests stay under the 600-line test hard limit; shares the
 * spawn-and-fetch harness.
 *
 * The privacy row matters: the policy engine carries no payload, so a leaked
 * payload field would disclose prompt bytes, session content, or free-text.
 * This route exposes only aggregate counts and machine codes.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withServer } from "./routes-vector-cortex-helpers.js";

describe("/api/vector-cortex/policy (VC8B reader-only)", () => {
	test("GET returns the reader-only policy aggregate when VC8B is ON", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc8b-pol-"));
		process.env.MEGACOMPACT_VC8B = "1";
		try {
			await withServer("9602", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/vector-cortex/policy`);
				assert.equal(res.status, 200);
				const body = (await res.json()) as {
					enabled: boolean;
					mode: "A" | "B" | "C";
					shadowDecisions: number;
					clampedDecisions: number;
					rejectedInputs: number;
					liveMutations: number;
					pressureVersion: number;
					lastFailure: string | null;
					updatedAt: string;
				};
				assert.equal(body.enabled, true);
				assert.equal(body.mode, "A");
				for (const k of [
					"shadowDecisions",
					"clampedDecisions",
					"rejectedInputs",
					"liveMutations",
					"pressureVersion",
				] as const) {
					assert.equal(typeof body[k], "number", `${k} is a count`);
				}
				assert.equal(body.liveMutations, 0);
				assert.equal(body.lastFailure, null);
				assert.equal(typeof body.updatedAt, "string");
			});
		} finally {
			delete process.env.MEGACOMPACT_VC8B;
		}
	});

	test("GET policy reports mode C + disabled when VC8B is OFF", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc8b-pol-off-"));
		process.env.MEGACOMPACT_VC8B = "0";
		try {
			await withServer("9603", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/vector-cortex/policy`);
				assert.equal(res.status, 200);
				const body = (await res.json()) as { enabled: boolean; mode: "A" | "B" | "C" };
				assert.equal(body.enabled, false);
				assert.equal(body.mode, "C");
			});
		} finally {
			delete process.env.MEGACOMPACT_VC8B;
		}
	});

	test("GET policy rejects non-GET (no mutation on the GET route)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc8b-pol-ro-"));
		await withServer("9604", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/vector-cortex/policy`, {
				method: "POST",
			});
			assert.equal(res.status, 405);
			assert.deepEqual(await res.json(), { error: "method_not_allowed" });
		});
	});

	test("policy body carries counts+codes ONLY — never payload bytes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc8b-pol-priv-"));
		process.env.MEGACOMPACT_VC8B = "1";
		try {
			await withServer("9605", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/vector-cortex/policy`);
				assert.equal(res.status, 200);
				const body = (await res.json()) as Record<string, unknown>;
				assert.deepEqual(
					Object.keys(body).sort(),
					[
						"clampedDecisions",
						"enabled",
						"lastFailure",
						"liveMutations",
						"mode",
						"pressureVersion",
						"rejectedInputs",
						"shadowDecisions",
						"updatedAt",
					],
					"policy view exposes exactly the aggregate keys",
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
			delete process.env.MEGACOMPACT_VC8B;
		}
	});
});
