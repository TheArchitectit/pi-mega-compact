/**
 * vc9d-acceptance.test.ts — VC9D acceptance aggregator (fixtures-driven).
 *
 * Drives the committed SETUP-CORTEX-030..033 detect-consolidation fixtures
 * against the canonical conformance corpus — no mocks, no stubs. Reads the v2
 * manifest + the setup-dashboard fixture files, validates each VC9D fixture
 * envelope against the schema semantics, and pins the detect-cache rules the
 * memoized embedder-detect path must satisfy from the FIXTURE data itself:
 *   - 030: an unchanged key returns identical results on the second call
 *     (cache hit — no recompute).
 *   - 031: a mutable-input change invalidates the entry (cache miss on
 *     mutation — recompute produces a fresh result).
 *   - 032: flag-off restores per-request fresh spawn (caching inactive),
 *     byte-identical to the VC9C-era behavior.
 *   - 033: the embedder + cortex sub-tabs are BOTH present in SUB_TABS.
 *
 * The concrete memo short-circuit (same-key returns the stored object) is
 * pinned by extensions/dashboard-server/routes-setup-detect-cache.test.ts with
 * stub detectors (real detection spawns are non-deterministic across hosts);
 * this aggregator pins the FIXTURE INTEGRITY + the semantic matrix.
 *
 * Flag-off parity: MEGACOMPACT_VC9D is exercised only through the fixture
 * matrix (032 pins the flag-off fresh-spawn behavior); this aggregator never
 * asserts a fixed runtime flag value, so the SAME suite is green under both
 * flag states (the 032 row records the flag-off semantic rather than the env).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VC9D_ENABLED } from "../config/vector-cortex.js";

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

/** The canonical VC9D detect-consolidation fixture ids this sprint owns. */
const DETECT_IDS = [
	"SETUP-CORTEX-030",
	"SETUP-CORTEX-031",
	"SETUP-CORTEX-032",
	"SETUP-CORTEX-033",
] as const;

const CALL_KINDS = ["cache_hit", "cache_miss", null] as const;
const TARGETS = ["ollama", "llamaCpp", "onnx"] as const;

interface DetectFixture {
	id: string;
	kind: string;
	target?: (typeof TARGETS)[number];
	calls?: number;
	second_call?: (typeof CALL_KINDS)[number];
	input_mutation?: string | null;
	result_identical?: boolean;
	flag_enabled?: boolean;
	caching_active?: boolean;
	mode?: "cached" | "fresh_spawn";
	sub_tabs?: string[];
	expected_subtabs_present?: "both";
}

function readDetectFixture(id: string): DetectFixture {
	const m = readManifest();
	const row = m.fixtures.find(
		(f) => f.id === id && f.path.startsWith("setup-dashboard/"),
	);
	assert.ok(row, `fixture ${id} registered under setup-dashboard/ in manifest`);
	return JSON.parse(readFileSync(join(V2, row.path), "utf8")) as DetectFixture;
}

describe("VC9D conformance registration", () => {
	test("manifest registers SETUP-CORTEX-030..033 + the detect schema under the setup seam", () => {
		const m = readManifest();
		const ids = new Set(m.fixtures.map((f) => f.id));
		for (const id of DETECT_IDS) assert.ok(ids.has(id), `missing ${id}`);
		for (const id of DETECT_IDS) {
			const row = m.fixtures.find((f) => f.id === id);
			assert.ok(row, `${id} has a manifest row`);
			assert.equal(row!.algorithm, "setup-cortex-detect", `${id} algorithm`);
			assert.equal(
				row!.schema,
				"schemas/setup-cortex-detect-fixture.schema.json",
				`${id} schema ref`,
			);
		}
		const schemaRow = m.fixtures.find(
			(f) => f.path === "schemas/setup-cortex-detect-fixture.schema.json",
		);
		assert.ok(schemaRow, "setup-cortex detect schema registered");
		assert.equal(schemaRow!.algorithm, "json-schema");
	});
});

describe("SETUP-CORTEX-030..033 detect-consolidation envelopes", () => {
	test("all 4 detect fixtures satisfy the envelope invariants", () => {
		for (const id of DETECT_IDS) {
			const fx = readDetectFixture(id);
			assert.equal(fx.kind, "setup-cortex-detect", `${id}: kind`);
			if (fx.target !== undefined) {
				assert.ok(
					(TARGETS as readonly string[]).includes(fx.target),
					`${id}: target enum`,
				);
			}
			if (fx.calls !== undefined) assert.ok(fx.calls >= 1, `${id}: calls >= 1`);
			if (fx.second_call !== undefined) {
				assert.ok(
					(CALL_KINDS as readonly (string | null)[]).includes(fx.second_call ?? null),
					`${id}: second_call enum`,
				);
			}
			if (fx.mode !== undefined) {
				assert.ok(
					fx.mode === "cached" || fx.mode === "fresh_spawn",
					`${id}: mode enum`,
				);
			}
		}
	});

	test("030 pins the cache hit: an unchanged key returns identical results on the second call", () => {
		const fx = readDetectFixture("SETUP-CORTEX-030");
		assert.equal(fx.target, "ollama");
		assert.equal(fx.calls, 2);
		assert.equal(fx.second_call, "cache_hit");
		assert.equal(fx.input_mutation, null, "no input mutation in the cache-hit scenario");
		assert.equal(fx.result_identical, true, "second run returns the identical object");
	});

	test("031 pins the cache miss: a mutable-input change invalidates and recomputes", () => {
		const fx = readDetectFixture("SETUP-CORTEX-031");
		assert.equal(fx.target, "llamaCpp");
		assert.equal(fx.calls, 2);
		assert.equal(fx.second_call, "cache_miss");
		assert.equal(
			fx.input_mutation,
			"binary_path_or_mtime",
			"the miss is driven by a binary path / mtime change (the mutable input)",
		);
		assert.equal(fx.result_identical, false, "a key mutation must not reuse the old object");
	});

	test("032 pins flag-off fresh spawn: caching inactive, byte-identical to VC9C-era", () => {
		const fx = readDetectFixture("SETUP-CORTEX-032");
		assert.equal(fx.target, "onnx");
		assert.equal(fx.flag_enabled, false);
		assert.equal(fx.caching_active, false, "flag-off disables memoization");
		assert.equal(fx.mode, "fresh_spawn", "flag-off spawns fresh per request");
	});

	test("033 pins the dual-sub-tab surface: embedder + cortex both present in SUB_TABS", () => {
		const fx = readDetectFixture("SETUP-CORTEX-033");
		assert.equal(
			fx.expected_subtabs_present,
			"both",
			"both sub-tabs must be present after the consolidation",
		);
		assert.deepEqual(
			[...(fx.sub_tabs ?? [])].sort(),
			["cortex", "embedder"],
			"SUB_TABS lists both the embedder and cortex sub-tabs",
		);
		assert.equal(fx.mode, "cached");
	});

	test("the flag function exports a live boolean regardless of env state", () => {
		// The aggregator must stay green under BOTH flag states (default-ON run
		// AND the MEGACOMPACT_VC9D=0 parity run), so it never asserts a fixed
		// runtime value — the flag-off fresh-spawn behavior is pinned by fixture
		// 032 and the flag-off typecheck+build, not by a runtime env assertion.
		assert.equal(typeof VC9D_ENABLED(), "boolean");
	});
});
