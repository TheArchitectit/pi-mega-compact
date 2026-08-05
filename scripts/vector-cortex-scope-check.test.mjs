#!/usr/bin/env node
/**
 * Tests for vector-cortex-scope-check.mjs.
 *
 * Run: node --test scripts/vector-cortex-scope-check.test.mjs
 * (Standalone; the repo test runner only walks dist/**\/*.test.js.)
 *
 * Commit file lists are injected via `listFiles`, so the tests never depend on
 * repo history. Spec parsing is exercised against BOTH synthetic fixtures and
 * the real committed sprint specs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
	expandBraces,
	parseOwnership,
	extractOwnershipText,
	parseNamedTests,
	crossCuttingExceptions,
	isInScope,
	resolveSpecPath,
	runScopeCheck,
} from "./vector-cortex-scope-check.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REAL_SPRINTS = join(ROOT, "docs", "vector-cortex", "sprints");

/** Build a throwaway sprint-spec directory. */
function makeSpecDir(files) {
	const dir = mkdtempSync(join(tmpdir(), "vcscope-"));
	for (const [name, body] of Object.entries(files)) {
		writeFileSync(join(dir, name), body, "utf-8");
	}
	return dir;
}

const VC4B_SPEC = `# VC4B — Residual codec and numeric parity

Own **ResidualCodecV1**. Production ownership: \`src/vector-cortex/residual/types.ts\`; \`src/vector-cortex/residual/dct.ts\`; \`src/vector-cortex/residual/codec.ts\`. Algorithm: DCT4096, int16.

Exact test sources: \`src/vector-cortex/residual/codec.test.ts\`. Sprint acceptance aggregator (must exist after implementation): \`src/vector-cortex/vc4b-acceptance.test.ts\`; exact compiled command:
`;

// ---------------------------------------------------------------------------
// (c) brace expansion + X/* glob
// ---------------------------------------------------------------------------

test("expandBraces expands a single group into one path per member", () => {
	assert.deepEqual(expandBraces("src/vector-cortex/ledger/{store,sqlite,compat-journal}.ts"), [
		"src/vector-cortex/ledger/store.ts",
		"src/vector-cortex/ledger/sqlite.ts",
		"src/vector-cortex/ledger/compat-journal.ts",
	]);
});

test("expandBraces handles multiple groups and passes plain paths through", () => {
	assert.deepEqual(expandBraces("src/{a,b}/{x,y}.ts"), [
		"src/a/x.ts",
		"src/a/y.ts",
		"src/b/x.ts",
		"src/b/y.ts",
	]);
	assert.deepEqual(expandBraces("src/plain.ts"), ["src/plain.ts"]);
});

test("parseOwnership expands braces across semicolon-separated spans", () => {
	const owned = parseOwnership(
		"`src/vector-cortex/replay/{types,cut,replay}.ts; src/vector-cortex/migrations/effective-cut-v2.ts`",
	);
	assert.deepEqual(owned, [
		"src/vector-cortex/replay/types.ts",
		"src/vector-cortex/replay/cut.ts",
		"src/vector-cortex/replay/replay.ts",
		"src/vector-cortex/migrations/effective-cut-v2.ts",
	]);
});

test("X/* glob owns any path underneath, recursively", () => {
	const owned = parseOwnership("`assets/vector-cortex/encoder-v1/*`");
	assert.deepEqual(owned, ["assets/vector-cortex/encoder-v1/*"]);
	const exc = crossCuttingExceptions("VC2A");
	assert.ok(isInScope("assets/vector-cortex/encoder-v1/model.onnx", owned, exc));
	assert.ok(isInScope("assets/vector-cortex/encoder-v1/nested/deep/tok.json", owned, exc));
	// Sibling directory must NOT be swept in by the glob.
	assert.ok(!isInScope("assets/vector-cortex/encoder-v2/model.onnx", owned, exc));
});

test("parseOwnership drops trailing prose words inside backticks", () => {
	// Real specs: VC3C `src/tieredRouter.ts delegate`, VC2C `scripts/deploy.sh asset gate; ...`
	assert.deepEqual(parseOwnership("`src/tieredRouter.ts delegate`"), ["src/tieredRouter.ts"]);
	assert.deepEqual(
		parseOwnership("`scripts/deploy.sh asset gate; package asset inclusion`"),
		["scripts/deploy.sh"],
	);
});

test("extractOwnershipText stops at the Algorithm: field", () => {
	const text = extractOwnershipText(VC4B_SPEC);
	assert.ok(text.includes("residual/codec.ts"));
	assert.ok(!text.includes("DCT4096"), "must not bleed into Algorithm prose");
});

test("parseNamedTests picks up unit tests and the acceptance aggregator", () => {
	const tests = parseNamedTests(VC4B_SPEC);
	assert.ok(tests.includes("src/vector-cortex/residual/codec.test.ts"));
	assert.ok(tests.includes("src/vector-cortex/vc4b-acceptance.test.ts"));
});

// ---------------------------------------------------------------------------
// (a) passes when a commit touched only owned files
// ---------------------------------------------------------------------------

test("PASS: commit touching only owned files is in scope", () => {
	const dir = makeSpecDir({ "VC4B-residual-basis-parity.md": VC4B_SPEC });
	try {
		const res = runScopeCheck("VC4B", ["deadbee"], {
			sprintDir: dir,
			listFiles: () => [
				"src/vector-cortex/residual/types.ts",
				"src/vector-cortex/residual/dct.ts",
				"src/vector-cortex/residual/codec.ts",
				"src/vector-cortex/residual/codec.test.ts",
				"src/vector-cortex/vc4b-acceptance.test.ts",
			],
		});
		assert.equal(res.ok, true);
		assert.equal(res.checked, 5);
		assert.deepEqual(res.violations, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("PASS: cross-cutting seams (flag, fixtures, evidence, dashboard) are allowed", () => {
	const dir = makeSpecDir({ "VC4B-residual-basis-parity.md": VC4B_SPEC });
	try {
		const res = runScopeCheck("VC4B", ["cafe123"], {
			sprintDir: dir,
			listFiles: () => [
				"src/config/vector-cortex.ts",
				"src/config.ts",
				"conformance/vector-cortex/v2/residual/manifest.json",
				"docs/vector-cortex/evidence/VC4B.md",
				"extensions/dashboard-server/routes-rag-settings.ts",
				"extensions/dashboard-server/routes-vector-cortex.ts",
				"extensions/dashboard-server/routes-vector-cortex.test.ts",
				"extensions/dashboard-client/src/tabs/VectorCortexTab.tsx",
				"scripts/gen-fixtures/residual.mjs",
				"scripts/vector-cortex-publish-acceptance.mjs",
			],
		});
		assert.equal(res.ok, true, JSON.stringify(res.violations));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("PASS: mechanical dashboard build output and split route handlers are seams", () => {
	const dir = makeSpecDir({ "VC4B-residual-basis-parity.md": VC4B_SPEC });
	try {
		const res = runScopeCheck("VC4B", ["b0a7"], {
			sprintDir: dir,
			listFiles: () => [
				// Regenerated wholesale by the mandated dashboard build gate.
				"extensions/dashboard-client/dist/index.html",
				"extensions/dashboard-client/dist/assets/VectorCortexTab-BGe9hu3r.js.map",
				// Per-domain handler split to respect the 500-line hard limit.
				"extensions/dashboard-server/routes-vector-cortex-residual.ts",
				"scripts/vector-cortex-gen-fixtures.mjs",
			],
		});
		assert.equal(res.ok, true, JSON.stringify(res.violations));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("dist/ build artifacts never enter the parsed ownership set", () => {
	const spec = `Production ownership: \`src/vector-cortex/residual/codec.ts\`. Algorithm: x.

\`\`\`bash
node --test dist/vector-cortex/vc4b-acceptance.test.js
\`\`\`
`;
	assert.deepEqual(parseOwnership(extractOwnershipText(spec)), [
		"src/vector-cortex/residual/codec.ts",
	]);
});

// ---------------------------------------------------------------------------
// (b) fails on an out-of-scope file
// ---------------------------------------------------------------------------

test("FAIL: a random src/memory.ts change under a VC4B claim is a violation", () => {
	const dir = makeSpecDir({ "VC4B-residual-basis-parity.md": VC4B_SPEC });
	try {
		const res = runScopeCheck("VC4B", ["badc0de"], {
			sprintDir: dir,
			listFiles: () => ["src/vector-cortex/residual/codec.ts", "src/memory.ts"],
		});
		assert.equal(res.ok, false);
		assert.equal(res.violations.length, 1);
		assert.equal(res.violations[0].file, "src/memory.ts");
		assert.equal(res.violations[0].sha, "badc0de");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("FAIL: another sprint's evidence record is out of scope", () => {
	const dir = makeSpecDir({ "VC4B-residual-basis-parity.md": VC4B_SPEC });
	try {
		const res = runScopeCheck("VC4B", ["f00"], {
			sprintDir: dir,
			listFiles: () => ["docs/vector-cortex/evidence/VC5A.md"],
		});
		assert.equal(res.ok, false);
		assert.equal(res.violations[0].file, "docs/vector-cortex/evidence/VC5A.md");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("FAIL: violations are attributed to the right SHA across multiple commits", () => {
	const dir = makeSpecDir({ "VC4B-residual-basis-parity.md": VC4B_SPEC });
	try {
		const byS = {
			aaa: ["src/vector-cortex/residual/dct.ts"],
			bbb: ["src/engine.ts"],
		};
		const res = runScopeCheck("VC4B", ["aaa", "bbb"], {
			sprintDir: dir,
			listFiles: (sha) => byS[sha],
		});
		assert.equal(res.ok, false);
		assert.equal(res.violations.length, 1);
		assert.equal(res.violations[0].sha, "bbb");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Spec resolution + real-spec coverage
// ---------------------------------------------------------------------------

test("resolveSpecPath matches on the sprint id prefix, and rejects unknown ids", () => {
	const p = resolveSpecPath("VC4B", REAL_SPRINTS);
	assert.ok(p.endsWith("VC4B-residual-basis-parity.md"));
	assert.throws(() => resolveSpecPath("VC9Z", REAL_SPRINTS), /no sprint spec found/);
});

test("every real sprint spec yields a non-empty, path-shaped ownership set", () => {
	if (!existsSync(REAL_SPRINTS)) return; // spec tree absent → nothing to assert
	const ids = [
		"VC0A", "VC0B", "VC0C", "VC1A", "VC1B", "VC1C", "VC2A", "VC2B", "VC2C",
		"VC3A", "VC3B", "VC3C", "VC4A", "VC4B", "VC4C", "VC5A", "VC5B", "VC5C",
		"VC6A", "VC6B", "VC6C", "VC7A", "VC7B", "VC7C", "VC8A", "VC8B", "VC8C",
	];
	for (const id of ids) {
		const spec = readFileSync(resolveSpecPath(id, REAL_SPRINTS), "utf-8");
		const owned = parseOwnership(extractOwnershipText(spec));
		assert.ok(owned.length > 0, `${id}: empty ownership set`);
		for (const p of owned) {
			assert.ok(!p.includes("{"), `${id}: unexpanded brace in "${p}"`);
			assert.ok(!/\s/.test(p), `${id}: whitespace in owned path "${p}"`);
			assert.ok(
				/^(src|scripts|extensions|assets|training|conformance|docs)\//.test(p),
				`${id}: implausible owned path "${p}"`,
			);
		}
	}
});
