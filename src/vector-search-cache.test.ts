/**
 * vector-search-cache.test.ts — QA perf/correctness regression tests for the
 * RAPTOR serve path and the per-session raptorCache.
 *
 * Guards two invariants the S42B/S25 wiring introduced:
 *   (a) Enabling RAPTOR (multilevel ON) never returns FEWER relevant hits than
 *       flat-only at the same k — no cache-hit loss / MMR starvation.
 *   (b) The per-search listCheckpoints is shared (not double-loaded): the
 *       warm-search latency at 200 checkpoints stays under the QA budget.
 *
 * No network. Real stores, temp state dirs.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore, vectorList, vectorSearch } from "./vectorStore.js";
import { runRaptor } from "./dedup/raptor/index.js";
import { compactSession } from "./engine.js";
import { loadDedupConfig } from "./config/dedup.js";
import { normalizeSessionId } from "./store.js";
import type { EngineMessage } from "./types.js";
import type { DedupConfigShape } from "./config/dedup.js";

let tmpDir: string;
let counter = 0;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "mc-vc-"));
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
		L0_ENABLED: false,
		L1_ENABLED: false,
		L2_ENABLED: true,
		...overrides,
	};
}

function msg(text: string, toolName?: string): EngineMessage {
	return toolName
		? { role: "assistant", text, toolName, input: text, output: text }
		: { role: "user", text };
}

function seedTwoTopics(store: VectorStore, sid: string, perTopic: number) {
	const topics = [
		"database connection pool postgres query optimizer",
		"user interface button render react component",
	];
	for (let i = 1; i <= perTopic * 2; i++) {
		const t = topics[i % 2];
		compactSession(
			{
				sessionId: sid,
				messages: [msg(`${t} checkpoint ${i} alpha beta gamma`), msg(`ack ${i}`, "Edit")],
				keepFrom: 2,
				timestamp: i,
			},
			store,
		);
	}
}

// ─── (a) RAPTOR ON never loses hits vs OFF ──────────────────────────────────

test("QA cache: RAPTOR-ON returns >= flat-only hits at same k (no MMR starvation)", () => {
	const k = 5;
	// Build the same session twice (isolated state dirs) so the comparison is
	// exact: same checkpoints, same embeddings, only the RAPTOR flag differs.
	const queries = ["database connection pool", "user interface button", "alpha beta gamma"];

	for (const q of queries) {
		let offHits = 0;
		let onHits = 0;
		for (const raptorOn of [false, true]) {
			const sd = stateDir();
			const s = new VectorStore({
				dedupSim: 0.9,
				stateDir: sd,
				config: raptorOn
					? cfg({ RAPTOR_MULTILEVEL_ENABLED: true, RAPTOR_LEAF_EXPANSION: true })
					: cfg({ RAPTOR_ENABLED: false }),
			});
			const sid = `cache-${q.length}-${raptorOn ? 1 : 0}`;
			seedTwoTopics(s, sid, 8); // 16 checkpoints, 2 topics
			if (raptorOn) {
				const nsid = normalizeSessionId(sid);
				runRaptor(
					vectorList(s, nsid).map((cp) => ({
						id: cp.checkpointId,
						messages: [],
						sourceText: cp.normalizedText ?? cp.summary ?? cp.regionHash,
						embedding: cp.embedding,
					})),
					{ stateDir: sd, sessionId: nsid },
				);
			}
			process.env.RAPTOR_SHADOW_MODE = raptorOn ? "false" : "true";
			const hits = vectorSearch(s, sid, q, k);
			if (raptorOn) onHits = hits.length;
			else offHits = hits.length;
		}
		assert.ok(
			onHits >= offHits,
			`RAPTOR ON (${onHits}) >= OFF (${offHits}) for query "${q}"`,
		);
	}
});

// ─── (b) Warm-search latency budget at 200 checkpoints ─────────────────────

test("QA perf: warm RAPTOR search at 200 checkpoints stays under budget (no double scan)", () => {
	const sd = stateDir();
	const s = new VectorStore({
		dedupSim: 0.9,
		stateDir: sd,
		config: cfg({ RAPTOR_MULTILEVEL_ENABLED: true }),
	});
	const sid = "perf";
	seedTwoTopics(s, sid, 100); // 200 checkpoints
	const nsid = normalizeSessionId(sid);
	runRaptor(
		vectorList(s, nsid).map((cp) => ({
			id: cp.checkpointId,
			messages: [],
			sourceText: cp.normalizedText ?? cp.summary ?? cp.regionHash,
			embedding: cp.embedding,
		})),
		{ stateDir: sd, sessionId: nsid },
	);
	process.env.RAPTOR_SHADOW_MODE = "false";
	// Warm the cache + embedder.
	vectorSearch(s, sid, "database connection pool", 5);
	vectorSearch(s, sid, "database connection pool", 5);
	// Time a burst of warm searches. The double-scan fix keeps this well under
	// the pre-fix cost. Budget is generous (10ms/search) to avoid CI flake;
	// the regression it guards is the ~2x blowup from listCheckpoints running
	// twice per search.
	const ITERS = 50;
	const t0 = Date.now();
	for (let i = 0; i < ITERS; i++)
		vectorSearch(s, sid, "database connection pool", 5);
	const perSearch = (Date.now() - t0) / ITERS;
	assert.ok(
		perSearch < 10,
		`warm search ${perSearch.toFixed(2)}ms < 10ms budget (double-scan regression guard)`,
	);
});

// ─── (c) No duplicate checkpointIds in merged results ──────────────────────

test("QA cache: RAPTOR merge produces no duplicate checkpointIds", () => {
	const sd = stateDir();
	const s = new VectorStore({
		dedupSim: 0.9,
		stateDir: sd,
		config: cfg({ RAPTOR_MULTILEVEL_ENABLED: true, RAPTOR_LEAF_EXPANSION: false }),
	});
	const sid = "dup";
	seedTwoTopics(s, sid, 8);
	const nsid = normalizeSessionId(sid);
	runRaptor(
		vectorList(s, nsid).map((cp) => ({
			id: cp.checkpointId,
			messages: [],
			sourceText: cp.normalizedText ?? cp.summary ?? cp.regionHash,
			embedding: cp.embedding,
		})),
		{ stateDir: sd, sessionId: nsid },
	);
	process.env.RAPTOR_SHADOW_MODE = "false";
	const hits = vectorSearch(s, sid, "database connection pool", 8);
	const ids = hits.map((h) => h.checkpoint.checkpointId);
	const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
	assert.equal(dupes.length, 0, "no duplicate checkpointIds in merged results");
});
