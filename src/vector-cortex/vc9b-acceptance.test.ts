/**
 * vc9b-acceptance.test.ts — VC9B acceptance aggregator (fixtures-driven).
 *
 * Drives the committed SETUP-CORTEX-010..013 action fixtures against the real
 * conformance corpus + the real flag seam — no mocks, no stubs. Reads the
 * canonical v2 manifest + the setup-dashboard fixture files, validates each
 * action-fixture envelope against the action-schema semantics, and pins the
 * canonical action→open-gate matrix (fetch-model/bench gated by HG-1+HG-3;
 * verify-asset ungated) from the FIXTURE data itself.
 *
 * The route/driver live in extensions/dashboard-server (not importable from the
 * published dist/vector-cortex/ offset), so their behavior (confirm→400,
 * blocked→423 no-spawn, verify-asset happy path, log-tail redaction) is
 * exercised by routes-setup-cortex-actions.test.ts; this aggregator pins the
 * FIXTURE INTEGRITY + the canonical gate matrix.
 *
 * Flag-off parity: MEGACOMPACT_VC9B gates only the route's driving; the
 * fixtures + flag function are byte-identical either way, so this SAME suite is
 * green under both flag states.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VC9B_ENABLED } from "../config/vector-cortex.js";

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

const ROOT = repoRoot(HERE);
const V2 = join(ROOT, "conformance", "vector-cortex", "v2");

interface ManifestRow {
	id: string;
	path: string;
	algorithm: string;
	schema: string;
}
interface Manifest {
	fixtures: ManifestRow[];
}

function readManifest(): Manifest {
	return JSON.parse(readFileSync(join(V2, "manifest.json"), "utf8")) as Manifest;
}

/** The canonical VC9B action-fixture ids this sprint owns. */
const ACTION_IDS = ["SETUP-CORTEX-010", "SETUP-CORTEX-011", "SETUP-CORTEX-012", "SETUP-CORTEX-013"] as const;

/** The open hard-gate ids the action matrix expects for gated actions. */
const GATE_IDS = ["HG-1", "HG-3"] as const;

interface ActionFixture {
	id: string;
	kind: string;
	flag_enabled: boolean;
	action: "fetch-model" | "bench" | "verify-asset";
	confirm?: boolean;
	expected_status_code?: number;
	error?: string | null;
	blocker_ids?: string[];
	no_spawn?: boolean;
	expected_body_shape: string;
	log_tail_bounded_kib?: number;
	log_redacted?: boolean;
}

function readActionFixture(id: string): ActionFixture {
	const m = readManifest();
	const row = m.fixtures.find((f) => f.id === id && f.path.startsWith("setup-dashboard/"));
	assert.ok(row, `fixture ${id} registered under setup-dashboard/ in manifest`);
	return JSON.parse(readFileSync(join(V2, row.path), "utf8")) as ActionFixture;
}

describe("VC9B conformance registration", () => {
	test("manifest registers SETUP-CORTEX-010..013 + the action schema under the setup seam", () => {
		const m = readManifest();
		const ids = new Set(m.fixtures.map((f) => f.id));
		for (const id of ACTION_IDS) assert.ok(ids.has(id), `missing ${id}`);
		for (const id of ACTION_IDS) {
			const row = m.fixtures.find((f) => f.id === id);
			assert.ok(row, `${id} has a manifest row`);
			assert.equal(row!.algorithm, "setup-cortex-action", `${id} algorithm`);
			assert.equal(
				row!.schema,
				"schemas/setup-cortex-action-fixture.schema.json",
				`${id} schema ref`,
			);
		}
		const schemaRow = m.fixtures.find((f) => f.path === "schemas/setup-cortex-action-fixture.schema.json");
		assert.ok(schemaRow, "setup-cortex-action schema registered");
		assert.equal(schemaRow!.algorithm, "json-schema");
	});
});

describe("SETUP-CORTEX-010..013 fixture envelopes", () => {
	test("all 4 action fixtures satisfy the action-schema invariants", () => {
		for (const id of ACTION_IDS) {
			const fx = readActionFixture(id);
			assert.equal(fx.kind, "setup-cortex-action", `${id}: kind`);
			assert.equal(typeof fx.flag_enabled, "boolean", `${id}: flag_enabled boolean`);
			assert.ok(
				["fetch-model", "bench", "verify-asset"].includes(fx.action),
				`${id}: action enum`,
			);
			assert.ok(
				[200, 400, 405, 423, 404].includes(fx.expected_status_code ?? -1),
				`${id}: status-code enum`,
			);
			assert.ok(
				[
					"action-result",
					"blocked",
					"confirm-rejected",
					"disabled",
					"method-not-allowed",
					"log-tail",
				].includes(fx.expected_body_shape),
				`${id}: body-shape enum`,
			);
		}
	});

	test("the action matrix is canonical: fetch-model/bench gated by HG-1+HG-3, verify-asset free", () => {
		const idsByAction = new Map<string, ActionFixture>();
		for (const id of ACTION_IDS) {
			const fx = readActionFixture(id);
			if (fx.error !== "action_blocked_by_open_item") continue;
			// Each blocked fixture pins the no-spawn rule + the open hard-gate ids.
		// fetch-model is the fixture-represented gated action; bench's gate is
		// exercised at the driver level by routes-setup-cortex-actions.test.ts
		// (both return 423 HG-1/HG-3, no spawn).
			assert.equal(fx.expected_status_code, 423, `${id}: blocked status`);
			assert.equal(fx.no_spawn, true, `${id}: blocked actions never spawn`);
			const blockers = (fx.blocker_ids ?? []).sort();
			assert.deepEqual(blockers, [...GATE_IDS].sort(), `${id}: blockers are HG-1/HG-3`);
			idsByAction.set(fx.action, fx);
		}
		// The gated action is represented as blocked by an open item (no spawn).
		assert.ok(idsByAction.has("fetch-model"), "fetch-model is gated by an open item");
		// verify-asset is NOT gated: the un-gated fixture has empty blockers + no no-spawn.
		const verify = [readActionFixture("SETUP-CORTEX-010"), readActionFixture("SETUP-CORTEX-013")]
			.find((f) => f.action === "verify-asset")!;
		assert.equal(verify.no_spawn, false, "verify-asset is not gated (no no-spawn)");
		assert.deepEqual(verify.blocker_ids ?? [], [], "verify-asset surfaces no blockers");
	});

	test("confirm rejection fixture pins confirm:false → 400 confirmation_required, no spawn", () => {
		const fx = readActionFixture("SETUP-CORTEX-011");
		assert.equal(fx.action, "bench");
		assert.equal(fx.confirm, false);
		assert.equal(fx.expected_status_code, 400);
		assert.equal(fx.error, "confirmation_required");
		assert.equal(fx.no_spawn, true);
		assert.equal(fx.expected_body_shape, "confirm-rejected");
	});

	test("log-tail fixture pins the bounded 8 KiB + redacted guarantees", () => {
		const fx = readActionFixture("SETUP-CORTEX-013");
		assert.equal(fx.expected_status_code, 200);
		assert.equal(fx.expected_body_shape, "log-tail");
		assert.equal(fx.log_tail_bounded_kib, 8);
		assert.equal(fx.log_redacted, true);
	});

	test("the flag function exports a live boolean regardless of env state", () => {
		// The aggregator must stay green under BOTH flag states (default-ON run
		// AND the MEGACOMPACT_VC9B=0 parity run), so it never asserts a fixed
		// runtime value — the route's off-projection is exercised by
		// routes-setup-cortex-actions.test.ts.
		assert.equal(typeof VC9B_ENABLED(), "boolean");
	});
});
