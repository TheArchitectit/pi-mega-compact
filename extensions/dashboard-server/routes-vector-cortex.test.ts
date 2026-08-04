/**
 * routes-vector-cortex.test.ts — GET /api/vector-cortex/evaluation route (VC0A).
 *
 * Reader-only aggregate. Spawn-and-fetch harness (same as routes-model-thresholds.
 * test.ts) — the dashboard-server.js main block fires when the entry argv includes
 * "dashboard-server", so tests under dist/extensions/dashboard-server/ MUST spawn
 * the server as a child process rather than importing launchDashboardServer.
 *
 * The route reads the redacted eval JSONL under the state dir (argv[2] dir) via
 * persist.ts readEvalRows, then summarizes. No payload bytes are ever returned.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

/** Locate the repo root (the directory holding `conformance/vector-cortex`). */
const HERE = dirname(fileURLToPath(import.meta.url));
function repoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "conformance", "vector-cortex"))) return dir;
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  throw new Error("conformance corpus not found above " + from);
}
const REPO_ROOT = repoRoot(HERE);
/** SHA-256 of the REAL committed ModelManifestV1 — the health card's digest. */
function realManifestDigest(): string {
  // guardrails-allow PREVENT-PI-004: local committed asset filesystem read (loopback)
  return createHash("sha256")
    .update(readFileSync(join(REPO_ROOT, "assets", "vector-cortex", "encoder-v1", "manifest.json")))
    .digest("hex");
}

const SERVER_ENTRY = new URL("./server.js", import.meta.url).pathname;

function waitFor(
	cond: () => boolean | Promise<boolean>,
	timeoutMs = 6000,
): Promise<void> {
	const start = Date.now();
	return new Promise((resolve, reject) => {
		const tick = async () => {
			if (await cond()) return resolve();
			if (Date.now() - start > timeoutMs) return reject(new Error("timeout"));
			setTimeout(tick, 50);
		};
		tick();
	});
}

async function withServer<T>(
	port: string,
	dir: string,
	fn: (port: number) => Promise<T>,
): Promise<T> {
	process.env.MEGACOMPACT_DASHBOARD_PORT = port;
	const child = spawn(process.execPath, [SERVER_ENTRY, dir], {
		stdio: "ignore",
		env: {
			...process.env,
			MEGACOMPACT_INDEX_DIR: dir,
		},
	});
	try {
		await waitFor(async () => {
			try {
				const raw = JSON.parse(readFileSync(join(dir, "port.pid"), "utf-8"));
				const res = await fetch(`http://localhost:${raw.port}/api/version`);
				return res.ok;
			} catch {
				return false;
			}
		});
		const raw = JSON.parse(readFileSync(join(dir, "port.pid"), "utf-8"));
		return await fn(raw.port);
	} finally {
		child.kill("SIGTERM");
		delete process.env.MEGACOMPACT_DASHBOARD_PORT;
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Seed redacted metric rows directly on disk so the server's reader sees them. */
async function seedEval(dir: string): Promise<void> {
	const { appendEvalRow } = await import(
		"../../src/vector-cortex/eval/persist.js"
	);
	// Buckets (inclusive): 1,5,10,25,50,100,250. 1ms→cell0, 12ms→cell3
	// (<=25), 250ms→cell6, 300ms→overflow.
	appendEvalRow(dir, [
		{ session: "s1", seq: 1, event: "encode", value: 1, unit: "ms", mode: "A" },
		{ session: "s1", seq: 2, event: "encode", value: 250, unit: "ms", mode: "A" },
		{ session: "s1", seq: 3, event: "encode", value: 300, unit: "ms", mode: "A" },
		{ session: "s1", seq: 4, event: "encode", value: 12, unit: "ms", mode: "A" },
	]);
}

describe("/api/vector-cortex/evaluation", () => {
	test("GET returns empty summary when no eval data", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc-empty-"));
		await withServer("9410", dir, async (port) => {
			const res = await fetch(
				`http://localhost:${port}/api/vector-cortex/evaluation`,
			);
			assert.equal(res.status, 200);
			const body = await res.json();
			assert.equal(body.samples, 0);
			assert.equal(body.enabled, true);
			assert.equal(body.mode, "A");
			assert.equal(
				body.histogram.cells.reduce((a: number, b: number) => a + b, 0),
				0,
			);
		});
	});

	test("GET aggregates seeded redacted rows into the histogram", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc-seeded-"));
		await seedEval(dir);
		await withServer("9411", dir, async (port) => {
			const res = await fetch(
				`http://localhost:${port}/api/vector-cortex/evaluation`,
			);
			assert.equal(res.status, 200);
			const body = await res.json();
			assert.equal(body.samples, 4);
			assert.equal(body.byMode.A, 4);
			// 1ms→cell0, 12ms→cell3 (<=25), 250ms→cell6, 300ms→overflow
			assert.equal(body.histogram.cells[0], 1);
			assert.equal(body.histogram.cells[3], 1);
			assert.equal(body.histogram.cells[6], 1);
			assert.equal(body.histogram.overflow, 1);
			assert.equal(body.histogram.total, 4);
			assert.deepEqual(body.histogram.edges, [1, 5, 10, 25, 50, 100, 250]);
			// No payload fields ever appear.
			assert.equal("payload" in body, false);
			assert.equal("prompt" in body, false);
			assert.equal("ledger" in body, false);
		});
	});

	test("reader-only: non-GET is rejected, no mutation endpoint", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc-readonly-"));
		await withServer("9412", dir, async (port) => {
			const res = await fetch(
				`http://localhost:${port}/api/vector-cortex/evaluation`,
				{ method: "POST" },
			);
			assert.equal(res.status, 405);
			assert.deepEqual(await res.json(), { error: "method_not_allowed" });
		});
	});
});

describe("/api/vector-cortex/health (VC0C)", () => {
	test("GET returns default CLOSED_A health card, reader-only shape", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc0c-health-"));
		await withServer("9415", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/vector-cortex/health`);
			assert.equal(res.status, 200);
			const body = await res.json();
			assert.equal(body.enabled, true);
			assert.equal(body.mode, "A");
			assert.equal(body.state, "CLOSED_A");
			assert.equal(body.subsystem, "provider");
			assert.equal(typeof body.windowMs, "number");
			assert.equal(typeof body.probeCount, "number");
			assert.equal(typeof body.backoffDelayMs, "number");
			assert.equal(typeof body.frontierFrozen, "boolean");
			assert.equal(typeof body.spoolLag, "number");
			assert.equal(body.aggregate, "CLOSED_A");
			// LIVENESS HONESTY (VC0C-Q01): the per-request breaker is ephemeral —
			// never present the exactly-default CLOSED_A as a LIVE circuit breaker.
			assert.equal(body.stateSource, "ephemeral");
			// VC2C encoder health (task 5): the committed qualified manifest digest
			// and triad mode are surfaced as reader-only aggregates. The digest is
			// the REAL SHA-256 of the committed manifest.json — the exact value the
			// VC2C assetDigest seam pins (Q01) — so the cross-seam reconciliation
			// is verified, not just checked for shape.
			assert.equal(typeof body.encoderAssetDigest, "string");
			assert.equal(body.encoderAssetDigest.length, 64);
			assert.equal(body.encoderAssetDigest, realManifestDigest());
			assert.ok(["A", "B", "C"].includes(body.encoderMode), "encoderMode a triad member");
			// The committed encoder asset is a package invariant of this sprint, so
			// the health card reports mode A (verified on the bundle's platform) or
			// a legit demotion on an off-platform host — never a missing mode type.
			assert.ok(typeof body.encoderMode === "string");
			// Reader-only: never payload/prompt/ledger fields.
			assert.equal("payload" in body, false);
			assert.equal("prompt" in body, false);
			assert.equal("ledger" in body, false);
		});
	});

	test("GET health rejects non-GET (reader-only path has no mutation)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc0c-health-ro-"));
		await withServer("9416", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/vector-cortex/health`, {
				method: "POST",
			});
			assert.equal(res.status, 405);
			assert.deepEqual(await res.json(), { error: "method_not_allowed" });
		});
	});
});

describe("/api/vector-cortex/breakers/reset (VC0C admin)", () => {
	test("POST reset clears cooldown, retains evidence (0 on fresh breaker)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc0c-reset-"));
		await withServer("9417", dir, async (port) => {
			const res = await fetch(
				`http://localhost:${port}/api/vector-cortex/breakers/reset`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ subsystem: "provider" }),
				},
			);
			assert.equal(res.status, 200);
			const body = await res.json();
			assert.equal(body.subsystem, "provider");
			assert.equal(body.state, "CLOSED_A");
			assert.equal(body.cooldownCleared, true);
			assert.equal(typeof body.failures, "number");
			assert.equal(typeof body.attempts, "number");
		});
	});

	test("POST reset rejects missing subsystem", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc0c-reset-sub-"));
		await withServer("9418", dir, async (port) => {
			const res = await fetch(
				`http://localhost:${port}/api/vector-cortex/breakers/reset`,
				{ method: "POST", body: "{}" },
			);
			assert.equal(res.status, 400);
		});
	});

	test("POST reset returns 409 when VC0C is disabled", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc0c-reset-off-"));
		process.env.MEGACOMPACT_VC0C = "0";
		try {
			await withServer("9419", dir, async (port) => {
				const res = await fetch(
					`http://localhost:${port}/api/vector-cortex/breakers/reset`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ subsystem: "provider" }),
					},
				);
				assert.equal(res.status, 409);
			});
		} finally {
			delete process.env.MEGACOMPACT_VC0C;
		}
	});

	test("GET ledger (VC1B) returns identity rows (never source payloads)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc1b-ledger-"));
		// Seed the occurrence-v2 ledger in the SAME state dir the server reads.
		const { createLedgerStore } = await import(
			"../../src/vector-cortex/ledger/store.js"
		);
		const store = createLedgerStore({ stateDir: dir });
		store
			.writer()
			.append({
				session: "default",
				seq: 1n,
				eventId: "c9",
				kind: "tool_call",
				sourceBytes: new TextEncoder().encode("echo"),
			});
		store
			.writer()
			.append({
				session: "default",
				seq: 2n,
				eventId: "r1",
				kind: "tool_result",
				toolCallId: "c9",
				sourceBytes: new TextEncoder().encode("done"),
			});
		store.close();

		process.env.MEGACOMPACT_VC1B = "1";
		try {
			await withServer("9420", dir, async (port) => {
				const res = await fetch(
					`http://localhost:${port}/api/vector-cortex/ledger?session=default`,
				);
				assert.equal(res.status, 200);
				const body = (await res.json()) as {
					enabled: boolean;
					count: number;
					occurrences: Array<{ seq: string; kind: string; toolCallId?: string }>;
				};
				assert.equal(body.enabled, true);
				assert.equal(body.count, 2);
				assert.equal(body.occurrences.length, 2);
				assert.equal(body.occurrences[0]!.kind, "tool_call");
				assert.equal(body.occurrences[1]!.toolCallId, "c9");
				// Reader-only: no source bytes / payload text in the view.
				const json = JSON.stringify(body);
				assert.ok(!json.includes("echo"), "no source payload text");
				assert.ok(!json.includes("done"), "no source payload text");
			});
		} finally {
			delete process.env.MEGACOMPACT_VC1B;
		}
	});

	test("GET ledger (VC1B) reports disabled when flag is OFF", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc1b-ledger-off-"));
		process.env.MEGACOMPACT_VC1B = "0";
		try {
			await withServer("9421", dir, async (port) => {
				const res = await fetch(
					`http://localhost:${port}/api/vector-cortex/ledger`,
				);
				assert.equal(res.status, 200);
				const body = (await res.json()) as { enabled: boolean; count: number };
				assert.equal(body.enabled, false);
				assert.equal(body.count, 0);
			});
		} finally {
			delete process.env.MEGACOMPACT_VC1B;
		}
	});
});

describe("/api/vector-cortex/topology (VC3A reader-only)", () => {
	test("GET returns reader-only topology summary from a seeded cortex DB", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc3a-topology-"));
		// Seed the cortex DB in the SAME state dir the server reads: append two
		// records via the writer, then rebuild a generation via the admin.
		const { createCortexStore } = await import(
			"../../src/vector-cortex/cortex/store.js"
		);
		const store = createCortexStore({ stateDir: dir });
		store.writer().append({
			sourceHighWater: 3n,
			algorithmVersion: 1,
			id: "a",
			kind: "semantic",
			payloadBytes: new TextEncoder().encode("alpha"),
		});
		store
			.writer()
			.append({
				sourceHighWater: 4n,
				algorithmVersion: 1,
				id: "b",
				kind: "semantic",
				payloadBytes: new TextEncoder().encode("beta"),
			});
		const rebuilt = store.admin().rebuild();
		assert.equal(rebuilt.ok, true);
		const rootDigest = rebuilt.ok ? rebuilt.generation.rootDigest : "";
		store.close();

		process.env.MEGACOMPACT_VC3A = "1";
		try {
			await withServer("9422", dir, async (port) => {
				const res = await fetch(
					`http://localhost:${port}/api/vector-cortex/topology`,
				);
				assert.equal(res.status, 200);
				const body = (await res.json()) as {
					enabled: boolean;
					recordCount: number;
					sourceHighWater: string;
					rootDigest: string | null;
					generationId: string | null;
					ordinal: string | null;
				};
				assert.equal(body.enabled, true);
				assert.equal(body.recordCount, 2);
				// Derived frontier is the max sourceHighWater across accepted records.
				assert.equal(body.sourceHighWater, "4");
				// One deterministic root digest + active generation identity.
				assert.equal(body.rootDigest, rootDigest);
				assert.equal(body.rootDigest?.length, 64, "sha256 hex root digest");
				assert.ok(body.generationId, "generationId present");
				assert.equal(body.ordinal, "1");
				// Reader-only: no payload/prompt text leaks through the summary.
				const json = JSON.stringify(body);
				assert.ok(!json.includes("alpha"), "no record payload text");
				assert.ok(!json.includes("beta"), "no record payload text");
			});
		} finally {
			delete process.env.MEGACOMPACT_VC3A;
		}
	});

	test("GET topology rejects non-GET (reader-only path has no mutation)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc3a-topology-ro-"));
		await withServer("9423", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/vector-cortex/topology`, {
				method: "POST",
			});
			assert.equal(res.status, 405);
			assert.deepEqual(await res.json(), { error: "method_not_allowed" });
		});
	});

	test("GET topology reports disabled (enabled:false) when flag is OFF", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc3a-topology-off-"));
		process.env.MEGACOMPACT_VC3A = "0";
		try {
			await withServer("9424", dir, async (port) => {
				const res = await fetch(
					`http://localhost:${port}/api/vector-cortex/topology`,
				);
				assert.equal(res.status, 200);
				const body = (await res.json()) as { enabled: boolean; recordCount: number };
				assert.equal(body.enabled, false);
				assert.equal(body.recordCount, 0);
			});
		} finally {
			delete process.env.MEGACOMPACT_VC3A;
		}
	});
});
