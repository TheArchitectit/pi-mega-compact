/**
 * routes-vector-cortex.test.ts — GET /api/vector-cortex/* routes (VC0A–VC3C).
 *
 * Reader-only aggregates. The shared spawn-and-fetch harness lives in
 * routes-vector-cortex-helpers.ts; per-sprint route test files (e.g.
 * routes-vector-cortex-shards.test.ts) import it too. This file keeps the
 * VC0A/VC0C/VC1B/VC3A/VC3C route tests; VC4A+ live in sibling files.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  realManifestDigest,
  withServer,
  seedEval,
} from "./routes-vector-cortex-helpers.js";

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

	test("GET topology exposes VC3B node/edge shapes when VC3B is ON", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc3b-topology-"));
		const { createCortexStore } = await import(
			"../../src/vector-cortex/cortex/store.js"
		);
		const store = createCortexStore({ stateDir: dir });
		// Seed one topology candidate record (kind "topology", canonical payload).
		store.writer().append({
			sourceHighWater: 3n,
			algorithmVersion: 1,
			id: "cand-1",
			kind: "topology",
			payloadBytes: new TextEncoder().encode(
				JSON.stringify({
					source: "a",
					target: "b",
					head: "h1",
					score: 0.9,
					kind: "dependency",
				}),
			),
		});
		store.close();

		process.env.MEGACOMPACT_VC3A = "1";
		process.env.MEGACOMPACT_VC3B = "1";
		try {
			await withServer("9425", dir, async (port) => {
				const res = await fetch(
					`http://localhost:${port}/api/vector-cortex/topology`,
				);
				assert.equal(res.status, 200);
				const body = (await res.json()) as {
					enabled: boolean;
					nodes?: Array<{ id: string; kind: string }>;
					edges?: Array<{ source: string; target: string; head: string; score: number; direction: string }>;
					generationDigest?: string | null;
				};
				assert.equal(body.enabled, true);
				assert.ok(body.nodes, "nodes present when VC3B on");
				assert.ok(body.edges, "edges present when VC3B on");
				assert.ok(body.generationDigest, "generation digest present");
				// The exact node/edge shapes are exposed (TopologyV1).
				const dep = body.edges?.find((e) => e.source === "a" && e.target === "b");
				assert.ok(dep, "dependency edge rendered");
				assert.equal(dep?.head, "h1");
				assert.equal(dep?.score, 0.9);
				assert.equal(dep?.direction, "dependency");
			});
		} finally {
			delete process.env.MEGACOMPACT_VC3A;
			delete process.env.MEGACOMPACT_VC3B;
		}
	});

	test("GET topology omits node/edge shapes when VC3B is OFF (predecessor shape)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc3b-topology-off-"));
		process.env.MEGACOMPACT_VC3A = "1";
		process.env.MEGACOMPACT_VC3B = "0";
		try {
			await withServer("9426", dir, async (port) => {
				const res = await fetch(
					`http://localhost:${port}/api/vector-cortex/topology`,
				);
				assert.equal(res.status, 200);
				const body = (await res.json()) as {
					enabled: boolean;
					nodes?: unknown;
					edges?: unknown;
					generationDigest?: unknown;
				};
				assert.equal(body.enabled, true);
				assert.equal(body.nodes, undefined, "nodes omitted when VC3B off");
				assert.equal(body.edges, undefined, "edges omitted when VC3B off");
				assert.equal(body.generationDigest, undefined, "digest omitted when VC3B off");
			});
		} finally {
			delete process.env.MEGACOMPACT_VC3A;
			delete process.env.MEGACOMPACT_VC3B;
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

describe("/api/vector-cortex/query (VC3C reader-only)", () => {
	test("GET returns reader-only query diagnostics when VC3C is ON", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc3c-query-"));
		const { ROUTER_KEY_VERSION } = await import(
			"../../src/vector-cortex/topology/query.js"
		);
		process.env.MEGACOMPACT_VC3C = "1";
		try {
			await withServer("9427", dir, async (port) => {
				const res = await fetch(
					`http://localhost:${port}/api/vector-cortex/query`,
				);
				assert.equal(res.status, 200);
				const body = (await res.json()) as {
					enabled: boolean;
					routerVersion: number;
					updatedAt: string;
				};
				assert.equal(body.enabled, true);
				assert.equal(body.routerVersion, ROUTER_KEY_VERSION);
				assert.equal(body.routerVersion, 2);
				// Reader-only: this is a flag-status + structural diagnostic, so
				// the response must never carry payloads/prompts — just the
				// small fixed shape.
				const json = JSON.stringify(body);
				assert.ok(!json.includes('"payload"'), "no payload field");
				assert.ok(typeof body.updatedAt === "string", "updatedAt is a string");
			});
		} finally {
			delete process.env.MEGACOMPACT_VC3C;
		}
	});

	test("GET query reports disabled when VC3C is OFF", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc3c-query-off-"));
		process.env.MEGACOMPACT_VC3C = "0";
		try {
			await withServer("9428", dir, async (port) => {
				const res = await fetch(
					`http://localhost:${port}/api/vector-cortex/query`,
				);
				assert.equal(res.status, 200);
				const body = (await res.json()) as { enabled: boolean };
				assert.equal(body.enabled, false);
			});
		} finally {
			delete process.env.MEGACOMPACT_VC3C;
		}
	});

	test("GET query rejects non-GET (reader-only path has no mutation)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vc3c-query-ro-"));
		await withServer("9429", dir, async (port) => {
			const res = await fetch(`http://localhost:${port}/api/vector-cortex/query`, {
				method: "POST",
			});
			assert.equal(res.status, 405);
			assert.deepEqual(await res.json(), { error: "method_not_allowed" });
		});
	});
});
