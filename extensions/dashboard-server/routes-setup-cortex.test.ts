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
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withServer, realManifestDigest } from "./routes-vector-cortex-helpers.js";

/**
 * ENC-0g: write a fake QualificationV1 record into an isolated state dir and
 * serve the status route against it. Reads the REAL record reader + route
 * against a real temp file — no mocks, no stubs. env is set BEFORE the child
 * spawns (the server inherits process.env at spawn time).
 */
async function withQualificationEnv(
  seed: (stateDir: string) => string | null,
  flagOff: boolean,
  fn: (stateDir: string, port: number) => Promise<void>,
): Promise<void> {
  const stateDir = mkdtempSync(join(tmpdir(), "vc9a-qual-"));
  const appDir = mkdtempSync(join(tmpdir(), "vc9a-qual-app-"));
  process.env.MEGACOMPACT_STATE_DIR = stateDir;
  process.env.MEGACOMPACT_ENC_0G = flagOff ? "0" : "1";
  process.env.MEGACOMPACT_ENC_0F = "1";
  const body = seed(stateDir);
  if (body !== null) writeFileSync(join(stateDir, "encoder-qualification.json"), body, "utf8");
  try {
    await withServer("9714", appDir, async (port) => {
      await fn(stateDir, port);
    });
  } finally {
    delete process.env.MEGACOMPACT_STATE_DIR;
    delete process.env.MEGACOMPACT_ENC_0G;
    delete process.env.MEGACOMPACT_ENC_0F;
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(appDir, { recursive: true, force: true });
  }
}

const QUALIFIED_RECORD = JSON.stringify({
  schema: "qualification-v1",
  verdict: "qualified",
  reasons: [],
  platform: "linux-x64",
  p95Ms: 20,
  rssMib: 120,
  opset: 21,
  digest: "abc",
});

const FAILED_RECORD = JSON.stringify({
  schema: "qualification-v1",
  verdict: "failed",
  reasons: ["latency", "rss", "bench_gates_not_green"],
  platform: "linux-x64",
  p95Ms: 186.53,
  rssMib: 294,
  opset: 21,
  digest: "def",
});

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
				const enc0gOn = process.env.MEGACOMPACT_ENC_0G !== "0";
				for (const b of body.blockers) {
					if (enc0gOn) {
						if (b.id === "HG-1") assert.equal(b.status, "closed", "HG-1 closes on 5-head manifest");
						else if (b.id === "HG-3") assert.equal(b.status, "open", "HG-3 stays genuinely open");
						else if (b.id === "HG-4") assert.equal(b.status, "open", "HG-4 binary gap persists");
						else if (b.id === "HG-5")
							assert.ok(["closed", "superseded"].includes(b.status), `HG-5 measured or superseded, got ${b.status}`);
					} else {
						assert.equal(b.status, "open", `${b.id} never closed (flag-off)`);
					}
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

	describe("ENC-0g qualification-record verdict override", () => {
		test("qualified record overrides a structurally-OK verify to qualified (no sentinel)", async () => {
			await withQualificationEnv(() => QUALIFIED_RECORD, false, async (_stateDir, port) => {
				process.env.MEGACOMPACT_VC9A = "1";
				try {
					const res = await fetch(`http://localhost:${port}/api/setup-cortex-status`);
					assert.equal(res.status, 200);
					const body = (await res.json()) as {
						qualification: { verdict: string; thresholdFailures: string[] };
						blockers: Array<{ id: string; status: string }>;
					};
					assert.equal(body.qualification.verdict, "qualified");
					assert.equal(body.qualification.thresholdFailures.length, 0);
					assert.ok(
						!body.qualification.thresholdFailures.includes("qualification_record_unavailable"),
						"no sentinel when a valid record is present",
					);
					// A five-head manifest closes HG-1 (ENC-0c) under the computed list.
					const hg1 = body.blockers.find((b) => b.id === "HG-1");
					assert.equal(hg1?.status, "closed");
				} finally {
					delete process.env.MEGACOMPACT_VC9A;
				}
			});
		});

		test("failed record overrides a structurally-OK verify to demoted with reasons, mode stays A", async () => {
			await withQualificationEnv(() => FAILED_RECORD, false, async (_stateDir, port) => {
				process.env.MEGACOMPACT_VC9A = "1";
				try {
					const res = await fetch(`http://localhost:${port}/api/setup-cortex-status`);
					assert.equal(res.status, 200);
					const body = (await res.json()) as {
						mode: string;
						qualification: { verdict: string; thresholdFailures: string[] };
					};
					// A structurally-OK verify on the committed real asset => mode A,
					// while the failed record demotes the qualification verdict.
					assert.equal(body.mode, "A");
					assert.equal(body.qualification.verdict, "demoted");
					assert.deepEqual(body.qualification.thresholdFailures, [
						"latency",
						"rss",
						"bench_gates_not_green",
					]);
				} finally {
					delete process.env.MEGACOMPACT_VC9A;
				}
			});
		});

		test("no record + gate on -> verify verdict kept, thresholdFailures carries sentinel", async () => {
			await withQualificationEnv(() => null, false, async (_stateDir, port) => {
				process.env.MEGACOMPACT_VC9A = "1";
				try {
					const res = await fetch(`http://localhost:${port}/api/setup-cortex-status`);
					assert.equal(res.status, 200);
					const body = (await res.json()) as {
						qualification: { verdict: string; thresholdFailures: string[] };
					};
					assert.ok(
						body.qualification.thresholdFailures.includes("qualification_record_unavailable"),
						"sentinel appended in the no-record case",
					);
				} finally {
					delete process.env.MEGACOMPACT_VC9A;
				}
			});
		});

		test("corrupt JSON record degrades to the verify-only sentinel path", async () => {
			await withQualificationEnv(() => "{not json", false, async (_stateDir, port) => {
				process.env.MEGACOMPACT_VC9A = "1";
				try {
					const res = await fetch(`http://localhost:${port}/api/setup-cortex-status`);
					assert.equal(res.status, 200);
					const body = (await res.json()) as {
						qualification: { verdict: string; thresholdFailures: string[] };
					};
					assert.ok(
						body.qualification.thresholdFailures.includes("qualification_record_unavailable"),
						"corrupt record degrades gracefully, never crashes",
					);
				} finally {
					delete process.env.MEGACOMPACT_VC9A;
				}
			});
		});

		test("shape-mismatched record degrades to the verify-only sentinel path", async () => {
			await withQualificationEnv(
				() => JSON.stringify({ schema: "wrong", verdict: "failed" }),
				false,
				async (_stateDir, port) => {
					process.env.MEGACOMPACT_VC9A = "1";
					try {
						const res = await fetch(`http://localhost:${port}/api/setup-cortex-status`);
						assert.equal(res.status, 200);
						const body = (await res.json()) as {
							qualification: { verdict: string; thresholdFailures: string[] };
						};
						assert.ok(
							body.qualification.thresholdFailures.includes("qualification_record_unavailable"),
							"shape-mismatch degrades, never crashes",
						);
					} finally {
						delete process.env.MEGACOMPACT_VC9A;
					}
				},
			);
		});

		test("ENC_0G flag-off ignores the record entirely (no override, no sentinel)", async () => {
			await withQualificationEnv(() => FAILED_RECORD, true, async (_stateDir, port) => {
				process.env.MEGACOMPACT_VC9A = "1";
				try {
					const res = await fetch(`http://localhost:${port}/api/setup-cortex-status`);
					assert.equal(res.status, 200);
					const body = (await res.json()) as {
						qualification: { verdict: string; thresholdFailures: string[] };
						blockers: Array<{ id: string; status: string }>;
					};
					// A structurally-OK verify on the real asset => verified qualified
					// regardless of the failed record on disk (byte-identical flag-off).
					assert.equal(body.qualification.verdict, "qualified");
					assert.ok(
						!body.qualification.thresholdFailures.includes("qualification_record_unavailable"),
						"flag-off never leaks the sentinel semantics",
					);
					// Static blockers (all open) — HG-1 NOT closed under flag-off.
					const hg1 = body.blockers.find((b) => b.id === "HG-1");
					assert.equal(hg1?.status, "open");
				} finally {
					delete process.env.MEGACOMPACT_VC9A;
				}
			});
		});
	});
});
