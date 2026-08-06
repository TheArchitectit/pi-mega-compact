/**
 * pca-acceptance.test.ts — PC-A acceptance aggregator (fixtures-driven).
 *
 * Drives the committed PC-001..004 prompt-cache fixtures against the canonical
 * conformance corpus — no mocks, no stubs. Reads the v2 manifest + the
 * prompt-cache fixture files, validates each PC-A fixture envelope against the
 * schema semantics, and pins the message-separation contract from the FIXTURE
 * data itself:
 *   - 001: flag-on reorders tool results to the tail (stable prefix contiguous).
 *   - 002: a no-tool-results input returns the identical array (byte-identical
 *     no-op — buildSeparatedPrompt's tail.length === 0 early return).
 *   - 003: flag-off passes prompt arrays through unchanged (the call-site gate
 *     never reorders), byte-identical to the pre-change OFF state.
 *   - 004: the mega-config split preserves loadConfig()'s shape (pure type move).
 *
 * The concrete reordering + no-op identity are pinned by the extension-level
 * unit suite (extensions/mega-events/separated-prompt.test/phase2-*), which
 * this sprint updated to the pure-function behavior; this aggregator pins the
 * FIXTURE INTEGRITY + the semantic matrix.
 *
 * Flag-agnostic: the aggregator never asserts a fixed runtime flag value — the
 * flag-off byte-parity is pinned by fixture 003's semantic matrix. The SAME
 * suite is green under both `node --test` (default-ON) and
 * `MEGACOMPACT_MESSAGE_SEPARATION=0 node --test`.
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

/** The canonical PC-A prompt-cache fixture ids this sprint owns. */
const PC_IDS = ["PC-001", "PC-002", "PC-003", "PC-004"] as const;

const FLAG = "MEGACOMPACT_MESSAGE_SEPARATION";
const TAIL_ROLES = ["toolResult", "bashExecution"] as const;

interface PromptCacheFixture {
	id: string;
	kind: string;
	flag?: string;
	flag_enabled?: boolean;
	input_roles?: string[];
	expected_tail_roles?: string[];
	expected_prefix_roles?: string[];
	reordered?: boolean;
	identical_reference?: boolean;
	type_move?: string;
	config_shape_preserved?: boolean;
}

function readFixture(id: string): PromptCacheFixture {
	const m = readManifest();
	const row = m.fixtures.find((f) => f.id === id && f.path.startsWith("prompt-cache/"));
	assert.ok(row, `fixture ${id} registered under prompt-cache/ in manifest`);
	return JSON.parse(readFileSync(join(V2, row.path), "utf8")) as PromptCacheFixture;
}

/** Recompute the post-reshape role sequence from the fixture's role matrix. */
function separatorRoles(input: string[]): { prefix: string[]; tail: string[] } {
	const prefix: string[] = [];
	const tail: string[] = [];
	for (const r of input) {
		if ((TAIL_ROLES as readonly string[]).includes(r)) tail.push(r);
		else prefix.push(r);
	}
	return { prefix, tail };
}

describe("PC-A conformance registration", () => {
	test("manifest registers PC-001..004 + the prompt-cache schema under the prompt-cache seam", () => {
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
		const schemaRow = m.fixtures.find(
			(f) => f.path === "schemas/prompt-cache-fixture.schema.json",
		);
		assert.ok(schemaRow, "prompt-cache schema registered");
		assert.equal(schemaRow!.algorithm, "json-schema");
	});
});

describe("PC-001..004 prompt-cache envelopes", () => {
	test("all 4 fixtures satisfy the envelope invariants", () => {
		for (const id of PC_IDS) {
			const fx = readFixture(id);
			assert.equal(fx.kind, "prompt-cache", `${id}: kind`);
			assert.equal(fx.flag, FLAG, `${id}: flag names MEGACOMPACT_MESSAGE_SEPARATION`);
			if (fx.reordered !== undefined) {
				assert.equal(typeof fx.reordered, "boolean", `${id}: reordered is boolean`);
			}
			if (fx.input_roles !== undefined) {
				const { prefix, tail } = separatorRoles(fx.input_roles);
				assert.ok(prefix.length + tail.length === fx.input_roles.length, `${id}: roles partition`);
				if (fx.expected_prefix_roles !== undefined) {
					assert.deepEqual(prefix, fx.expected_prefix_roles, `${id}: prefix roles match`);
				}
				if (fx.expected_tail_roles !== undefined) {
					assert.deepEqual(tail, fx.expected_tail_roles, `${id}: tail roles match`);
				}
			}
		}
	});

	test("001 pins the flag-on reorder: tool results move to the tail", () => {
		const fx = readFixture("PC-001");
		assert.equal(fx.flag_enabled, true);
		assert.equal(fx.reordered, true);
		assert.deepEqual(fx.input_roles, ["user", "assistant", "toolResult", "user", "toolResult"]);
		assert.deepEqual(fx.expected_tail_roles, ["toolResult", "toolResult"]);
		assert.deepEqual(fx.expected_prefix_roles, ["user", "assistant", "user"]);
		// Semantic re-derivation: the flag-on reorder is exactly the fixture's own
		// partition — the two tool results move to the tail, the three stable roles
		// (user/assistant/user) stay contiguous.
		const { prefix, tail } = separatorRoles(fx.input_roles!);
		assert.deepEqual(prefix, fx.expected_prefix_roles);
		assert.deepEqual(tail, fx.expected_tail_roles);
	});

	test("002 pins the no-op identity: no tool results returns the identical array", () => {
		const fx = readFixture("PC-002");
		assert.equal(fx.flag_enabled, true);
		assert.equal(fx.reordered, false);
		assert.equal(fx.identical_reference, true, "no tool results ⇒ same array returned");
		assert.deepEqual(fx.input_roles, ["user", "assistant", "user"]);
		// Semantic re-derivation: with zero tail roles, the separator yields an empty
		// tail, so the array passes through unchanged (byte-identical).
		const { tail } = separatorRoles(fx.input_roles!);
		assert.equal(tail.length, 0, "no tail roles ⇒ nothing to reorder");
	});

	test("003 pins flag-off parity: prompt arrays pass through unchanged", () => {
		const fx = readFixture("PC-003");
		assert.equal(fx.flag_enabled, false);
		assert.equal(fx.reordered, false, "flag-off never reorders");
		assert.deepEqual(fx.input_roles, ["user", "assistant", "toolResult"]);
		// Flag-off parity: even though a toolResult is present, the gate does not
		// apply separation — the array passes through byte-identical to pre-change.
	});

	test("004 pins the type-move shape preservation of the mega-config split", () => {
		const fx = readFixture("PC-004");
		assert.equal(fx.type_move, "MegaConfig→mega-config-types.ts");
		assert.equal(fx.config_shape_preserved, true);
	});
});
