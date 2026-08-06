/**
 * vc9c-acceptance.test.ts — VC9C acceptance aggregator (fixtures-driven).
 *
 * Drives the committed SETUP-CORTEX-020..022 UI fixtures against the canonical
 * conformance corpus — no mocks, no stubs. Reads the v2 manifest + the
 * setup-dashboard fixture files, validates each VC9C UI-fixture envelope
 * against the schema semantics, and pins the render / hide / status-transition
 * rules the SetupTab Cortex sub-tab must satisfy from the FIXTURE data itself:
 *   - 020: the sub-tab renders mode A/B/C deterministically (visible).
 *   - 021: the off/disabled shape (status:off, enabled:false) filters the
 *     sub-tab from SUB_TABS.
 *   - 022: the poll hook drives the VcStatusBadge across the
 *     live/awaiting_data/deferred/off status values (badge mirrors status).
 *
 * The actual React components live in extensions/dashboard-client (bundled by
 * Vite, not importable from this published dist/vector-cortex/ offset), so
 * their rendering is exercised by `cd extensions/dashboard-client && npm run
 * typecheck && npm run build`; this aggregator pins the FIXTURE INTEGRITY + the
 * status -> visibility/badge matrix.
 *
 * Flag-off parity: MEGACOMPACT_VC9C gates only the client sub-tab's visible
 * state; the fixtures + flag function are byte-identical either way, so this
 * SAME suite is green under both flag states.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VC9C_ENABLED } from "../config/vector-cortex.js";

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

/** The canonical VC9C UI-fixture ids this sprint owns. */
const UI_IDS = ["SETUP-CORTEX-020", "SETUP-CORTEX-021", "SETUP-CORTEX-022"] as const;

const STATUS_ENUM = ["live", "awaiting_data", "deferred", "structural", "off"] as const;
const MODE_ENUM = ["A", "B", "C"] as const;

interface StatusBadgePair {
	status: string;
	expected_badge: string;
}

interface UiFixture {
	id: string;
	kind: string;
	mode: "A" | "B" | "C";
	flag_enabled: boolean;
	status?: string;
	expected_subtab_visible?: boolean;
	expected_badge?: string | null;
	verdict?: "qualified" | "demoted" | "unavailable";
	threshold_failures?: string[];
	blocker_ids?: string[];
	render_modes?: string[];
	status_badge_pairs?: StatusBadgePair[];
}

function readUiFixture(id: string): UiFixture {
	const m = readManifest();
	const row = m.fixtures.find((f) => f.id === id && f.path.startsWith("setup-dashboard/"));
	assert.ok(row, `fixture ${id} registered under setup-dashboard/ in manifest`);
	return JSON.parse(readFileSync(join(V2, row.path), "utf8")) as UiFixture;
}

describe("VC9C conformance registration", () => {
	test("manifest registers SETUP-CORTEX-020..022 + the UI schema under the setup seam", () => {
		const m = readManifest();
		const ids = new Set(m.fixtures.map((f) => f.id));
		for (const id of UI_IDS) assert.ok(ids.has(id), `missing ${id}`);
		for (const id of UI_IDS) {
			const row = m.fixtures.find((f) => f.id === id);
			assert.ok(row, `${id} has a manifest row`);
			assert.equal(row!.algorithm, "setup-cortex-ui", `${id} algorithm`);
			assert.equal(
				row!.schema,
				"schemas/setup-cortex-ui-fixture.schema.json",
				`${id} schema ref`,
			);
		}
		const schemaRow = m.fixtures.find((f) => f.path === "schemas/setup-cortex-ui-fixture.schema.json");
		assert.ok(schemaRow, "setup-cortex UI schema registered");
		assert.equal(schemaRow!.algorithm, "json-schema");
	});
});

describe("SETUP-CORTEX-020..022 UI-fixture envelopes", () => {
	test("all 3 UI fixtures satisfy the envelope invariants", () => {
		for (const id of UI_IDS) {
			const fx = readUiFixture(id);
			assert.equal(fx.kind, "setup-cortex-ui", `${id}: kind`);
			assert.ok(MODE_ENUM.includes(fx.mode), `${id}: mode enum`);
			assert.equal(typeof fx.flag_enabled, "boolean", `${id}: flag_enabled boolean`);
			if (fx.status !== undefined) {
				assert.ok(
					STATUS_ENUM.includes(fx.status as (typeof STATUS_ENUM)[number]),
					`${id}: status enum`,
				);
			}
			assert.equal(
				typeof fx.expected_subtab_visible,
				"boolean",
				`${id}: expected_subtab_visible boolean`,
			);
			if (fx.expected_badge !== undefined && fx.expected_badge !== null) {
				assert.ok(
					STATUS_ENUM.includes(fx.expected_badge as (typeof STATUS_ENUM)[number]),
					`${id}: expected_badge enum`,
				);
			}
		}
	});

	test("020 pins the mode A/B/C render projection deterministically (sub-tab visible)", () => {
		const fx = readUiFixture("SETUP-CORTEX-020");
		assert.equal(fx.flag_enabled, true);
		assert.equal(fx.mode, "A");
		assert.equal(fx.verdict, "qualified");
		assert.deepEqual(fx.threshold_failures, []);
		assert.equal(fx.expected_subtab_visible, true);
		// The render projection covers ALL three modes deterministically.
		assert.deepEqual([...(fx.render_modes ?? [])].sort(), ["A", "B", "C"]);
		// A visible sub-tab reports a non-"off" status + no off badge.
		assert.notEqual(fx.status, "off");
		assert.notEqual(fx.expected_badge, "off");
	});

	test("021 pins that the off/disabled shape hides the sub-tab (filtered from SUB_TABS)", () => {
		const fx = readUiFixture("SETUP-CORTEX-021");
		assert.equal(fx.flag_enabled, false);
		assert.equal(fx.mode, "C");
		assert.equal(fx.status, "off");
		assert.equal(fx.expected_badge, "off");
		assert.equal(fx.expected_subtab_visible, false);
		assert.deepEqual(fx.blocker_ids, [], "off/disabled leaks no blockers");
	});

	test("022 pins the badge matrix: the poll hook mirrors the live/awaiting_data/deferred/off status", () => {
		const fx = readUiFixture("SETUP-CORTEX-022");
		const expected: Record<string, string> = {
			live: "live",
			awaiting_data: "awaiting_data",
			deferred: "deferred",
			off: "off",
		};
		const pairs = fx.status_badge_pairs ?? [];
		assert.ok(pairs.length >= 4, "badge matrix covers the status values");
		for (const p of pairs) {
			assert.ok(p.status in expected, `badge pair status ${p.status} is in the set`);
			assert.equal(p.expected_badge, expected[p.status], `${p.status} badge mirrors status`);
		}
		// The off branch also drives the badge's default/off rendering.
		assert.equal(fx.expected_badge, "off");
	});

	test("the flag function exports a live boolean regardless of env state", () => {
		// The aggregator must stay green under BOTH flag states (default-ON run
		// AND the MEGACOMPACT_VC9C=0 parity run), so it never asserts a fixed
		// runtime value — the client's off-gating is exercised by the fixture
		// matrix (021) and the dashboard-client typecheck+build.
		assert.equal(typeof VC9C_ENABLED(), "boolean");
	});
});
