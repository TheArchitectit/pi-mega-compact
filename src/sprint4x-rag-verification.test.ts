/**
 * sprint4x-rag-verification.test.ts — run the S40–S47 RAG suite once against
 * the current implementation and assert the documented "default enable" claims.
 *
 * This is the verification pass demanded by the roadmap/backlog: each spec
 * claims its feature flags DEFAULT ON. The honest check (not a re-statement of
 * the spec) is: which flags actually exist in code, what do they default to,
 * and is the consuming path wired?
 *
 * Findings recorded here, per spec:
 *   S40 importance-scoring     — module src/importance.ts exists (S40A) but is
 *                                NOT consumed by compactSession/vector-paths;
 *                                no shipped flag, no adapter wiring.
 *   S41 self-rag-quality-gate  — spec-only; NO flag, NO consumer.
 *   S42 raptor-multilevel      — PARTIALLY SHIPPED: RAPTOR_MULTILEVEL_ENABLED
 *                                and RAPTOR_LEAF_EXPANSION both default true
 *                                with real consumers; the spec's claim holds.
 *   S43 hyde-vague-queries     — spec-only (QUERY_REFORMULATION_ENABLED absent).
 *   S44 three-tier-latency-routing — spec-only (TIERED_ROUTING_ENABLED absent).
 *   S45 crag-quality-metrics   — spec-only (CRAG_ENABLED absent).
 *   S46 visual-memory-map      — spec-only (MEMORY_MAP_ENABLED absent;
 *                                memory-graph endpoint not in dashboard-server).
 *   S47 auto-categorizing-wiki — spec-only (AUTO_WIKI_ENABLED absent).
 *
 * Policy: the suite runs against the flags that EXIST today. Unimplemented spec
 * claims are pinned by the S4X_SPEC_ONLY tests so regressions can't silently
 * add them in the wrong state, and this file records exactly which
 * spec-vs-implementation gaps remain.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDedupConfig } from "./config/dedup.js";

/**
 * Clear any env pollution so the default is measured, not the override.
 */
function fresh<T extends string>(envKey: T, get: () => unknown): unknown {
	delete process.env[envKey];
	try {
		return get();
	} finally {
		delete process.env[envKey];
	}
}

// ---- S42: shipped flags default ON (claim holds) ----------------------------

test("S42 RAPTOR_MULTILEVEL_ENABLED defaults ON and honors env off", () => {
	const d = fresh("MEGACOMPACT_RAPTOR_MULTILEVEL", () => loadDedupConfig());
	assert.ok(
		(d as { RAPTOR_MULTILEVEL_ENABLED: boolean }).RAPTOR_MULTILEVEL_ENABLED,
		"ship claim: multi-level on by default",
	);
	process.env.MEGACOMPACT_RAPTOR_MULTILEVEL = "false";
	const off = loadDedupConfig();
	assert.ok(
		!off.RAPTOR_MULTILEVEL_ENABLED,
		"env override: MEGACOMPACT_RAPTOR_MULTILEVEL=false turns it off",
	);
});

test("S42 RAPTOR_LEAF_EXPANSION defaults ON and honors env off", () => {
	const d = fresh("MEGACOMPACT_RAPTOR_LEAF_EXPANSION", () => loadDedupConfig());
	assert.ok(
		(d as { RAPTOR_LEAF_EXPANSION: boolean }).RAPTOR_LEAF_EXPANSION,
		"ship claim: leaf-expansion on by default",
	);
	process.env.MEGACOMPACT_RAPTOR_LEAF_EXPANSION = "false";
	const off = loadDedupConfig();
	assert.ok(!off.RAPTOR_LEAF_EXPANSION, "env override off");
});

// ---- S40: module exists, claims do NOT yet hold at the flag/consumer level --

test("S40 importance module exists in-tree (S40A artifact)", async () => {
	// Load the module and confirm it exports the scoring surface the spec
	// describes. This proves the S40A implementation exists even though nothing
	// wires it into compaction/vector paths yet (documented gap).
	const mod = await import("./importance.js");
	assert.ok(mod && typeof mod === "object", "importance.ts loads");
	// Exports per spec: score() plus item-type enum.
	assert.ok(typeof (mod as Record<string, unknown>).score === "function",
		"importance.ts exports score() function",
	);
});

test("S40 has no shipped consumer flag in the current codebase (gap pinned)", async () => {
	// The S40 spec claims an IMPORTANCE_SCORING flag defaults ON. In the
	// current code no such flag exists, and no vector/compact path reads
	// importance scores. This test documents the gap so a future wiring does
	// not silently flip it on in the wrong shape.
	const cfg = loadDedupConfig();
	assert.ok(
		!("IMPORTANCE_SCORING" in cfg),
		"no IMPORTANCE_SCORING flag yet (S40 consumer wiring missing)",
	);
});

// ---- S41/S43–S47: spec-only modules — pin the absence ------------------------

test("S4X spec-only flags absent from DedupConfig", () => {
	const cfg = loadDedupConfig();
	const specFlags = [
		"CRITIQUE_ENABLED", // S41
		"QUERY_REFORMULATION_ENABLED", // S43
		"TIERED_ROUTING_ENABLED", // S44
		"CRAG_ENABLED", // S45
		"CRAG_EXPANSION_ENABLED", // S45
		"MEMORY_MAP_ENABLED", // S46
		"AUTO_WIKI_ENABLED", // S47
	] as const;
	for (const f of specFlags) {
		assert.ok(
			!(f in cfg),
			`${f} is spec-only — should not be present in DedupConfig`,
		);
	}
});
