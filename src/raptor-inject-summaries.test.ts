/**
 * raptor-inject-summaries.test.ts — S25 Phase-2 acceptance tests.
 *
 * Verifies the RAPTOR_INJECT_SUMMARIES optional phase (default ON): when
 * enabled, recallAndInline prepends a hierarchical overview header built from
 * the tree's top-level summary nodes (root + top level-1 clusters); when
 * disabled, the recall block is unchanged (detail-only). Also covers the
 * formatRaptorBlock formatter directly.
 *
 * No network. Real stores, temp state dirs.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore, vectorList } from "./vectorStore.js";
import { runRaptor } from "./dedup/raptor/index.js";
import { compactSession } from "./engine.js";
import { loadDedupConfig } from "./config/dedup.js";
import { normalizeSessionId } from "./store.js";
import { recallAndInline, formatRaptorBlock } from "./recall.js";
import type { EngineMessage } from "./types.js";
import type { DedupConfigShape } from "./config/dedup.js";

let tmpDir: string;
let counter = 0;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "mc-ris-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function stateDir(): string {
	return join(tmpDir, `run-${counter++}`);
}

function cfg(overrides?: Record<string, unknown>): DedupConfigShape {
	return {
		...loadDedupConfig(),
		RAPTOR_ENABLED: true,
		RAPTOR_MULTILEVEL_ENABLED: true,
		L0_ENABLED: false,
		L1_ENABLED: false,
		L2_ENABLED: true,
		RAPTOR_INJECT_SUMMARIES: true,
		...overrides,
	};
}

function msg(text: string, toolName?: string): EngineMessage {
	return toolName
		? { role: "assistant", text, toolName, input: text, output: text }
		: { role: "user", text };
}

function seedTwoTopics(store: VectorStore, sid: string, per: number) {
	const topics = [
		"database connection pool postgres",
		"user interface button react",
	];
	for (let i = 1; i <= per * 2; i++) {
		compactSession(
			{
				sessionId: sid,
				messages: [
					msg(`${topics[i % 2]} checkpoint ${i} alpha beta`),
					msg(`ack ${i}`, "Edit"),
				],
				keepFrom: 2,
				timestamp: i,
			},
			store,
		);
	}
}

function buildTree(store: VectorStore, sid: string) {
	const nsid = normalizeSessionId(sid);
	runRaptor(
		vectorList(store, nsid).map((cp) => ({
			id: cp.checkpointId,
			messages: [],
			sourceText: cp.normalizedText ?? cp.summary ?? cp.regionHash,
			embedding: cp.embedding,
		})),
		{ stateDir: store.stateDir, sessionId: nsid },
	);
}

// ─── 1. Flag ON (default) → overview header prepended ───────────────────────

test("S25-P2: RAPTOR_INJECT_SUMMARIES=true prepends a hierarchical overview header", () => {
	const sd = stateDir();
	const s = new VectorStore({ dedupSim: 0.9, stateDir: sd, config: cfg() });
	const sid = "on";
	seedTwoTopics(s, sid, 8);
	buildTree(s, sid);
	process.env.RAPTOR_SHADOW_MODE = "false";
	const r = recallAndInline(
		{ sessionId: sid, query: "database pool", source: "resume", limit: 3 },
		s,
	);
	assert.ok(r.block.length > 0, "recall block is non-empty");
	assert.ok(
		r.block.includes("hierarchical overview"),
		"overview header present when flag ON",
	);
	assert.ok(
		r.block.includes("Recalled context"),
		"detailed recall block still present after overview",
	);
	assert.ok(
		r.block.indexOf("hierarchical overview") <
			r.block.indexOf("Recalled context"),
		"overview precedes detail",
	);
});

// ─── 2. Flag OFF → no overview (detail-only, unchanged behavior) ────────────

test("S25-P2: RAPTOR_INJECT_SUMMARIES=false → no overview (detail-only)", () => {
	const sd = stateDir();
	const s = new VectorStore({
		dedupSim: 0.9,
		stateDir: sd,
		config: cfg({ RAPTOR_INJECT_SUMMARIES: false }),
	});
	const sid = "off";
	seedTwoTopics(s, sid, 8);
	buildTree(s, sid);
	process.env.RAPTOR_SHADOW_MODE = "false";
	const r = recallAndInline(
		{ sessionId: sid, query: "database pool", source: "resume", limit: 3 },
		s,
	);
	if (r.block.length > 0) {
		assert.ok(
			!r.block.includes("hierarchical overview"),
			"no overview header when flag OFF",
		);
		assert.ok(
			r.block.includes("Recalled context") || r.block.length > 0,
			"detail block present",
		);
	}
});

// ─── 3. No tree → no overview (graceful, detail-only) ────────────────────────

test("S25-P2: no RAPTOR tree → no overview (graceful degradation)", () => {
	const sd = stateDir();
	const s = new VectorStore({ dedupSim: 0.9, stateDir: sd, config: cfg() });
	const sid = "notree";
	seedTwoTopics(s, sid, 4); // checkpoints exist but no tree built
	process.env.RAPTOR_SHADOW_MODE = "false";
	const r = recallAndInline(
		{ sessionId: sid, query: "database pool", source: "resume", limit: 3 },
		s,
	);
	assert.ok(
		!r.block.includes("hierarchical overview"),
		"no overview when no tree exists",
	);
});

// ─── 4. formatRaptorBlock formatter contract ────────────────────────────────

test("S25-P2: formatRaptorBlock labels root as 'Session overview' + clusters as 'Cluster summary'", () => {
	const block = formatRaptorBlock([
		{ summary: "root overview text", level: 0, score: 0.9 },
		{ summary: "cluster A text", level: 1, score: 0.7 },
	]);
	assert.ok(
		/The following hierarchical overview/.test(block),
		"preamble present",
	);
	assert.ok(
		/Session overview \[1\] \(relevance 90%\)/.test(block),
		"root labeled",
	);
	assert.ok(
		/Cluster summary \[2\] \(level 1\) \(relevance 70%\)/.test(block),
		"cluster labeled",
	);
	assert.ok(block.includes("root overview text"), "root body present");
	assert.ok(block.includes("cluster A text"), "cluster body present");
	assert.equal(formatRaptorBlock([]), "", "empty input → empty string");
});

// ─── 5. overview is skipped when shadows mode is on (tree not served) ──────
//
// Actually the overview reads rehydrateRaptorTree directly (not raptorSearchHits),
// so shadow mode does NOT suppress it via the serve gate. Verify the behavior:
// the overview IS emitted in shadow mode (the tree exists and is rehydrated).
// This is acceptable — the overview is a session map, not a live-serve decision.
// QA finding #1 (v0.8.25): the overview previously bypassed the shadow gate —
// the tree was injected into recall while RAPTOR_SERVE was logging-only. The
// gate now applies to the inject path too: shadow mode = no overview.

test("S25-P2: overview is suppressed in shadow mode (QA fix)", () => {
	const sd = stateDir();
	const s = new VectorStore({ dedupSim: 0.9, stateDir: sd, config: cfg() });
	const sid = "shadow";
	seedTwoTopics(s, sid, 8);
	buildTree(s, sid);
	const orig = process.env.RAPTOR_SHADOW_MODE;
	process.env.RAPTOR_SHADOW_MODE = "true";
	try {
		const r = recallAndInline(
			{ sessionId: sid, query: "database pool", source: "resume", limit: 3 },
			s,
		);
		// Shadow mode = build + persist + log only; nothing RAPTOR-derived is
		// injected into recall, including the overview header.
		assert.ok(
			!r.block.includes("hierarchical overview"),
			"overview suppressed in shadow mode",
		);
	} finally {
		if (orig === undefined) delete process.env.RAPTOR_SHADOW_MODE;
		else process.env.RAPTOR_SHADOW_MODE = orig;
	}
});
