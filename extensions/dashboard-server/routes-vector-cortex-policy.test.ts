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
import { withServer, seedLivewireSnapshot } from "./routes-vector-cortex-helpers.js";

describe("/api/vector-cortex/policy (VC8B reader-only)", () => {
	test("GET returns the LIVE policy aggregate (not deferred) when VC8B is ON", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc8b-pol-"));
		process.env.MEGACOMPACT_VC8B = "1";
		try {
			await seedLivewireSnapshot(dir, {
				policy: {
					shadowDecisions: 12,
					clampedDecisions: 4,
					rejectedInputs: 2,
					liveMutations: 0,
					pressureVersion: 2,
				},
			});
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
					deferredReason?: string;
					status?: string;
				};
				assert.equal(body.enabled, true);
				assert.equal(body.mode, "A");
				assert.equal(body.deferredReason, undefined, "shadow controller is not deferred");
				assert.equal(body.status, "live");
				assert.equal(body.shadowDecisions, 12);
				assert.equal(body.clampedDecisions, 4);
				assert.equal(body.rejectedInputs, 2);
				assert.equal(body.liveMutations, 0);
				assert.equal(body.pressureVersion, 2);
				assert.equal(body.lastFailure, null);
				assert.equal(typeof body.updatedAt, "string");
			});
		} finally {
			delete process.env.MEGACOMPACT_VC8B;
		}
	});

	test("a shadow controller with no runs yet reads awaiting_data (not deferred)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc8b-pol-empty-"));
		process.env.MEGACOMPACT_VC8B = "1";
		try {
			await withServer("9606", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/vector-cortex/policy`);
				assert.equal(res.status, 200);
				const body = (await res.json()) as {
					enabled: boolean;
					deferredReason?: string;
					status?: string;
					pressureVersion: number;
				};
				assert.equal(body.enabled, true);
				assert.equal(body.deferredReason, undefined, "shadow controller is wired, never deferred");
				assert.equal(body.status, "awaiting_data");
				assert.equal(body.pressureVersion, 1);
			});
		} finally {
			delete process.env.MEGACOMPACT_VC8B;
		}
	});

	test("GET policy reports mode C + disabled + deferred when VC8B is OFF", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc8b-pol-off-"));
		process.env.MEGACOMPACT_VC8B = "0";
		try {
			await withServer("9603", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/vector-cortex/policy`);
				assert.equal(res.status, 200);
				const body = (await res.json()) as {
					enabled: boolean;
					mode: "A" | "B" | "C";
					deferredReason?: string;
				};
				assert.equal(body.enabled, false);
				assert.equal(body.mode, "C");
				assert.equal(
					body.deferredReason,
					"shadow_controller_not_instantiated_v0_20_23",
					"flag-off parity: deferredReason is byte-identical to the predecessor",
				);
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
			await seedLivewireSnapshot(dir, {
				policy: { shadowDecisions: 1, clampedDecisions: 1, pressureVersion: 2 },
			});
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
						"status",
						"updatedAt",
					],
					"policy view exposes exactly the aggregate keys (no deferredReason when live)",
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
