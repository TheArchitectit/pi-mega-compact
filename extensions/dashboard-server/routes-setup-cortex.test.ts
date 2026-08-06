/**
 * routes-setup-cortex.test.ts — GET /api/setup-cortex-status (VC9A).
 *
 * Reader-only Setup Cortex status aggregate: DIGEST PREFIXES + CODES ONLY —
 * never payload bytes, prompts, or ledger (EVAL-REDACT-002). Its own file
 * (mirroring routes-vector-cortex-platform.test.ts) so per-sprint route tests
 * stay under the 600-line test hard limit; shares the spawn-and-fetch harness.
 *
 * The privacy row matters: the blocker/qualification projection carries no
 * payload, so a leaked field would disclose model bytes or free text. This
 * route exposes only aggregate facts + machine blocker codes.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withServer, realManifestDigest } from "./routes-vector-cortex-helpers.js";

describe("/api/setup-cortex-status (VC9A reader-only)", () => {
	test("GET returns the setup-cortex aggregate when VC9A is ON", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc9a-setup-"));
		process.env.MEGACOMPACT_VC9A = "1";
		try {
			await withServer("9710", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/setup-cortex-status`);
				assert.equal(res.status, 200);
				const body = (await res.json()) as {
					enabled: boolean;
					flag: string;
					mode: "A" | "B" | "C";
					assetDigestPrefix: string | null;
					qualification: { verdict: string; thresholdFailures: string[] };
					blockers: Array<{ id: string; severity: string; status: string }>;
					encoderHealth: { assetDigestPrefix: string | null; mode: string };
					updatedAt: string;
					status: string;
				};
				assert.equal(body.enabled, true);
				assert.equal(body.flag, "MEGACOMPACT_VC9A");
				assert.ok(["A", "B", "C"].includes(body.mode), `valid triad mode, got ${body.mode}`);
				assert.ok(["qualified", "demoted", "unavailable"].includes(body.qualification.verdict));
				assert.ok(Array.isArray(body.qualification.thresholdFailures));
				assert.equal(body.blockers.length, 4, "four open hard-gate blockers");
				const ids = body.blockers.map((b) => b.id).sort();
				assert.deepEqual(ids, ["HG-1", "HG-3", "HG-4", "HG-5"]);
				for (const b of body.blockers) {
					assert.equal(b.status, "open", `${b.id} never closed`);
					assert.ok(["blocker", "high", "medium"].includes(b.severity));
				}
				assert.equal(body.encoderHealth.mode, body.mode);
				assert.equal(typeof body.updatedAt, "string");
				assert.equal(body.status, "structural");
				// When an asset is verified on-host, the digest prefix is present and
				// matches the real manifest digest prefix.
				if (body.mode !== "C") {
					assert.equal(body.assetDigestPrefix, realManifestDigest().slice(0, 12));
					assert.equal(body.encoderHealth.assetDigestPrefix, body.assetDigestPrefix);
				}
			});
		} finally {
			delete process.env.MEGACOMPACT_VC9A;
		}
	});

	test("GET reports mode C + disabled + off when VC9A is OFF", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc9a-setup-off-"));
		process.env.MEGACOMPACT_VC9A = "0";
		try {
			await withServer("9711", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/setup-cortex-status`);
				assert.equal(res.status, 200);
				const body = (await res.json()) as Record<string, unknown>;
				assert.equal(body.enabled, false);
				assert.equal(body.mode, "C");
				assert.equal(body.status, "off");
				assert.equal(body.assetDigestPrefix, null);
				assert.deepEqual(body.blockers, []);
				assert.deepEqual(
					(body.qualification as { verdict: string }).verdict,
					"unavailable",
					"flag-off leaks no qualification detail",
				);
			});
		} finally {
			delete process.env.MEGACOMPACT_VC9A;
		}
	});

	test("GET rejects non-GET (no mutation on the GET route)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc9a-setup-ro-"));
		await withServer("9712", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/setup-cortex-status`, {
				method: "POST",
			});
			assert.equal(res.status, 405);
			assert.deepEqual(await res.json(), { error: "method_not_allowed" });
		});
	});

	test("setup-cortex body carries aggregate facts ONLY — never payload bytes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc9a-setup-priv-"));
		process.env.MEGACOMPACT_VC9A = "1";
		try {
			await withServer("9713", dir, async (port) => {
				const res = await fetch(`http://localhost:${port}/api/setup-cortex-status`);
				assert.equal(res.status, 200);
				const body = (await res.json()) as Record<string, unknown>;
				const json = JSON.stringify(body);
				for (const leak of [
					"prompt",
					"response",
					"freeText",
					"exactBytes",
					"content",
					"payload",
					"text",
					"message",
					"artifactBytes",
					"outputBytes",
					"onnxBytes",
					"model.onnx",
				]) {
					assert.ok(!json.includes(`"${leak}"`), `never exposes ${leak}`);
				}
			});
		} finally {
			delete process.env.MEGACOMPACT_VC9A;
		}
	});
});
