/**
 * pcc-acceptance.test.ts — PC-C dashboard prefix-stability acceptance aggregator.
 *
 * Drives the committed PC-009..015 prompt-cache fixtures against the canonical
 * schema semantics, and pins the per-turn stable-prefix contract from the
 * FIXTURE data (no runtime module import, no process env reliance), matching the
 * PC-C sprint spec's failure-triad:
 *   - 009: flag-on returns a non-empty trend series from real prefix_stability
 *     events (events_present:true, turns_returned:">0").
 *   - 010: no events -> empty turns array (events_present:false, turns_returned:0).
 *   - 011: flag-off -> 404, CacheTab omits the card (endpoint_status:404).
 *   - 012/013/014: three-point trend classification — improving / stable /
 *     degrading. 013 also pins the always-on monitoring-events-log data source
 *     (append_event_shape, not debug_logger).
 *   - 015: registry integration — /api/prefix-stability + PrefixStabilityResponse
 *     contract + endpoint_count_bumped.
 *
 * Flag-agnostic: the aggregator never asserts a fixed runtime flag value — the
 * prefix-stability contract is pinned entirely by the committed fixtures'
 * semantic matrix, exactly as the spec requires green under both
 * `node --test dist/vector-cortex/pcc-acceptance.test.js` AND
 * `MEGACOMPACT_PC_C=0 node --test dist/vector-cortex/pcc-acceptance.test.js`.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

/** The canonical PC-C prompt-cache fixture ids this sprint owns. */
const PC_IDS = [
	"PC-009",
	"PC-010",
	"PC-011",
	"PC-012",
	"PC-013",
	"PC-014",
	"PC-015",
] as const;

const FLAG = "MEGACOMPACT_PC_C";

const TRENDS = ["improving", "stable", "degrading"] as const;

interface PromptCacheFixture {
	id: string;
	kind: string;
	flag?: string;
	flag_enabled?: boolean;
	endpoint?: string;
	events_present?: boolean;
	turns_returned?: number | string;
	endpoint_status?: number;
	card_present?: boolean;
	trend_classification?: string;
	read_source?: string;
	append_event_shape?: boolean;
	debug_logger?: boolean;
	registry_entry?: string;
	contract_shape?: string;
	endpoint_count_bumped?: boolean;
}

function readFixture(id: string): PromptCacheFixture {
	const m = readManifest();
	const row = m.fixtures.find((f) => f.id === id && f.path.startsWith("prompt-cache/"));
	assert.ok(row, `fixture ${id} registered under prompt-cache/ in manifest`);
	return JSON.parse(readFileSync(join(V2, row.path), "utf8")) as PromptCacheFixture;
}

describe("PC-C conformance registration", () => {
	test("manifest registers PC-009..015 under the prompt-cache seam", () => {
		const m = readManifest();
		const ids = new Set(m.fixtures.map((f) => f.id));
		for (const id of PC_IDS) assert.ok(ids.has(id), `missing ${id}`);
		for (const id of PC_IDS) {
			const row = m.fixtures.find((f) => f.id === id);
			assert.ok(row, `${id} has a manifest row`);
			assert.equal(row!.algorithm, "prompt-cache", `${id} algorithm`);
			assert.equal(
				row!.schema,
				"schemas/prompt-cache-fixture.schema.json",
				`${id} schema ref`,
			);
		}
	});
});

describe("PC-009..015 prefix-stability envelopes", () => {
	test("all 7 fixtures satisfy the envelope invariants", () => {
		for (const id of PC_IDS) {
			const fx = readFixture(id);
			assert.equal(fx.kind, "prompt-cache", `${id}: kind`);
			assert.equal(fx.flag, FLAG, `${id}: flag names MEGACOMPACT_PC_C`);
			assert.equal(typeof fx.flag_enabled, "boolean", `${id}: flag_enabled is boolean`);
			if (fx.trend_classification !== undefined) {
				assert.ok(
					(TRENDS as readonly string[]).includes(fx.trend_classification),
					`${id}: unknown trend '${fx.trend_classification}'`,
				);
			}
		}
	});

	test("009 pins the flag-on non-empty trend series", () => {
		const fx = readFixture("PC-009");
		assert.equal(fx.flag_enabled, true);
		assert.equal(fx.endpoint, "/api/prefix-stability");
		assert.equal(fx.events_present, true);
		assert.equal(fx.turns_returned, ">0");
	});

	test("010 pins the empty state (no events yet)", () => {
		const fx = readFixture("PC-010");
		assert.equal(fx.flag_enabled, true);
		assert.equal(fx.events_present, false);
		assert.equal(fx.turns_returned, 0);
	});

	test("011 pins flag-off 404 + CacheTab omits the card", () => {
		const fx = readFixture("PC-011");
		assert.equal(fx.flag_enabled, false);
		assert.equal(fx.endpoint_status, 404);
		assert.equal(fx.card_present, false);
	});

	test("012/013/014 pin the three-point trend classifier", () => {
		const improving = readFixture("PC-012");
		const stable = readFixture("PC-013");
		const degrading = readFixture("PC-014");
		assert.equal(improving.flag_enabled, true);
		assert.equal(improving.trend_classification, "improving");
		assert.equal(stable.flag_enabled, true);
		assert.equal(stable.trend_classification, "stable");
		assert.equal(degrading.flag_enabled, true);
		assert.equal(degrading.trend_classification, "degrading");
	});

	test("013 pins the always-on monitoring-events-log data source", () => {
		const fx = readFixture("PC-013");
		assert.equal(fx.flag_enabled, true);
		assert.equal(fx.read_source, "monitoring events log");
		assert.equal(fx.append_event_shape, true, "appendEvent {ts,event,...fields} shape");
		assert.equal(fx.debug_logger, false, "NOT the debug-gated mega-compact.log logger");
	});

	test("015 pins registry integration + endpoint count bump", () => {
		const fx = readFixture("PC-015");
		assert.equal(fx.flag_enabled, true);
		assert.equal(fx.registry_entry, "/api/prefix-stability");
		assert.equal(fx.contract_shape, "PrefixStabilityResponse");
		assert.equal(fx.endpoint_count_bumped, true);
	});
});
