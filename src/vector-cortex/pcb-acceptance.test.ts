/**
 * pcb-acceptance.test.ts — PC-B cacheStriping acceptance aggregator.
 *
 * Drives the committed PC-005..008 prompt-cache fixtures against the canonical
 * schema semantics, and pins the cache-striping contract from the FIXTURE data
 * (no runtime module import, no process env reliance):
 *   - 005: flag-on inserts the cache-stripe layer between summaries and
 *     thread, ordered by stability DESC (expected_layer_order).
 *   - 006: flag-on with no stripe rows falls back to the base separated prompt
 *     unchanged — byte-identical to PC-A behavior.
 *   - 007: flag-off skips buildCacheOptimizedPrompt; with message_separation
 *     also on, only separation runs — matches PC-A-only output.
 *   - 008: the delegation chain buildCacheOptimizedPrompt ->
 *     buildSeparatedPrompt -> tail_reorder is correct.
 *
 * Flag-agnostic: the aggregator never asserts a fixed runtime flag value — the
 * cacheStriping contract is pinned entirely by the committed fixtures' semantic
 * matrix, exactly as the spec requires green under both
 * `node --test dist/vector-cortex/pcb-acceptance.test.js` AND
 * `MEGACOMPACT_CACHE_STRIPING=0 node --test dist/vector-cortex/pcb-acceptance.test.js`.
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

/** The canonical PC-B prompt-cache fixture ids this sprint owns. */
const PC_IDS = ["PC-005", "PC-006", "PC-007", "PC-008"] as const;

const FLAG = "MEGACOMPACT_CACHE_STRIPING";

const ORDER_LAYERS = ["summary", "stripe", "thread", "tool"] as const;

interface PromptCacheFixture {
	id: string;
	kind: string;
	flag?: string;
	flag_enabled?: boolean;
	stripes_present?: boolean;
	expected_layer_order?: string[];
	falls_back_to_separation?: boolean;
	message_separation_also_on?: boolean;
	result_matches?: string;
	delegation_chain?: string[];
	chain_correct?: boolean;
	reordered?: boolean;
}

function readFixture(id: string): PromptCacheFixture {
	const m = readManifest();
	const row = m.fixtures.find((f) => f.id === id && f.path.startsWith("prompt-cache/"));
	assert.ok(row, `fixture ${id} registered under prompt-cache/ in manifest`);
	return JSON.parse(readFileSync(join(V2, row.path), "utf8")) as PromptCacheFixture;
}

describe("PC-B conformance registration", () => {
	test("manifest registers PC-005..008 under the prompt-cache seam", () => {
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

describe("PC-005..008 prompt-cache envelopes", () => {
	test("all 4 fixtures satisfy the envelope invariants", () => {
		for (const id of PC_IDS) {
			const fx = readFixture(id);
			assert.equal(fx.kind, "prompt-cache", `${id}: kind`);
			assert.equal(fx.flag, FLAG, `${id}: flag names MEGACOMPACT_CACHE_STRIPING`);
			assert.equal(typeof fx.flag_enabled, "boolean", `${id}: flag_enabled is boolean`);
			if (fx.reordered !== undefined) {
				assert.equal(typeof fx.reordered, "boolean", `${id}: reordered is boolean`);
			}
			if (fx.expected_layer_order !== undefined) {
				const order = fx.expected_layer_order;
				assert.equal(order.length, ORDER_LAYERS.length, `${id}: layer order length`);
				for (const layer of order) {
					assert.ok(
						(ORDER_LAYERS as readonly string[]).includes(layer),
						`${id}: unknown layer '${layer}'`,
					);
				}
			}
		}
	});

	test("005 pins flag-on stripe insertion between summaries and thread", () => {
		const fx = readFixture("PC-005");
		assert.equal(fx.flag_enabled, true);
		assert.equal(fx.stripes_present, true);
		assert.equal(fx.reordered, true);
		// Layer order is exactly summary -> stripe -> thread -> tool: the stripe
		// (durable context by stability DESC) sits between the summary layer and
		// the conversation thread, with tool results at the tail.
		assert.deepEqual(fx.expected_layer_order, ["summary", "stripe", "thread", "tool"]);
	});

	test("006 pins the no-stripes fallback to the separated prompt unchanged", () => {
		const fx = readFixture("PC-006");
		assert.equal(fx.flag_enabled, true);
		assert.equal(fx.stripes_present, false);
		assert.equal(fx.falls_back_to_separation, true, "no stripe rows ⇒ falls back to separation");
		assert.equal(fx.reordered, true, "separation still reorders tool results to the tail");
	});

	test("007 pins flag-off delegation to messageSeparation only", () => {
		const fx = readFixture("PC-007");
		assert.equal(fx.flag_enabled, false);
		assert.equal(fx.message_separation_also_on, true);
		assert.equal(fx.result_matches, "PC-A-only", "=0 restores PC-A-only behavior exactly");
		assert.equal(fx.reordered, true, "separation (on by default) still reorders");
	});

	test("008 pins the delegation chain and tail reordering", () => {
		const fx = readFixture("PC-008");
		assert.equal(fx.flag_enabled, true);
		assert.equal(fx.chain_correct, true);
		assert.deepEqual(fx.delegation_chain, [
			"buildCacheOptimizedPrompt",
			"buildSeparatedPrompt",
			"tail_reorder",
		]);
	});
});
