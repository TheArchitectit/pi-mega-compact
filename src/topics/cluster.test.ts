/**
 * cluster.test.ts — S51A clustering + labeling tests. No network, temp dirs.
 * Includes the honest-boundary grep-asserts (no ollama/llm/fetch, no fabricated
 * keyword literals) required by the s47/s51 acceptance criteria.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "../store/sqlite/utils.js";
import { upsertCheckpoint } from "../store/sqlite/checkpoints.js";
import type { StoredCheckpoint } from "../store.js";
import { loadEmbeddings, buildTopicModel, DEFAULT_CLUSTER_CONFIG } from "./cluster.js";
import { tfidfScores, membershipConfidence } from "./labels.js";
import type { EmbeddedChunk } from "./types.js";

let tmpDir: string;
let counter = 0;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "mc-topics-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function stateDir(): string {
	return join(tmpDir, `run-${counter++}`);
}

/** Unit vector along axis `axis` (dim = total dims). */
function axisVec(axis: number, dim: number): number[] {
	const v = new Array<number>(dim).fill(0);
	v[axis] = 1;
	return v;
}

function cp(id: string, text: string, embedding: number[], session = "sess_t"): StoredCheckpoint {
	return {
		checkpointId: id,
		sessionId: session,
		summary: text,
		normalizedText: text,
		keyDecisions: [],
		nextSteps: [],
		filesModified: [],
		tokenEstimate: 0,
		regionHash: "r",
		embedding,
		timestamp: 1,
	};
}

/** Seed N clusters of M chunks each: cluster i sits near axis i with distinct terms. */
function seedClusters(dir: string, clusters: number, perCluster: number, dim: number): void {
	openStore(dir);
	const terms = ["sqlite", "wal", "checkpoint", "recovery", "backup", "replay", "fork", "merge"];
	for (let c = 0; c < clusters; c++) {
		for (let m = 0; m < perCluster; m++) {
			// Near-axis vector with slight per-member jitter (stays closest to its axis).
			const v = axisVec(c, dim).map((x, i) => x + (i === c ? 0 : (m + 1) * 1e-4 * (i + 1)));
			const term = terms[(c * 2) % terms.length];
			const term2 = terms[(c * 2 + 1) % terms.length];
			upsertCheckpoint(
				cp(`chkpt_c${c}_${m}`, `${term} ${term2} work item ${m} details`, v),
				dir,
			);
		}
	}
}

test("loadEmbeddings returns only chunks with embeddings + text", () => {
	const dir = stateDir();
	openStore(dir);
	upsertCheckpoint(cp("a", "hello world", axisVec(0, 4)), dir);
	upsertCheckpoint(cp("b", "", axisVec(1, 4)), dir); // empty text → skipped
	upsertCheckpoint(cp("c", "no embedding here", [], "sess_t"), dir); // empty embedding → skipped
	const chunks = loadEmbeddings(openStore(dir));
	assert.equal(chunks.length, 1);
	assert.equal(chunks[0].chunkId, "a");
	assert.equal(chunks[0].text, "hello world");
});

test("buildTopicModel finds 3 well-separated clusters (silhouette picks k=3)", () => {
	const dir = stateDir();
	seedClusters(dir, 3, 6, 8); // 18 chunks, 3 tight clusters
	const model = buildTopicModel(openStore(dir), { ...DEFAULT_CLUSTER_CONFIG, kRange: [2, 5] });
	assert.equal(model.totalChunks, 18);
	assert.equal(model.k, 3);
	assert.equal(model.topics.length, 3);
	// Every chunk assigned; assignment count == chunk count.
	assert.equal(model.assignments.length, 18);
	// Labels reflect the seeded discriminative terms (sqlite/wal, checkpoint/recovery, backup/replay).
	const labels = model.topics.map((t) => t.label).join(" | ");
	assert.ok(/sqlite|checkpoint|backup/.test(labels), `labels should carry seeded terms: ${labels}`);
});

test("corpus too small → single general cluster, no crash", () => {
	const dir = stateDir();
	openStore(dir);
	upsertCheckpoint(cp("only", "lone chunk about sqlite", axisVec(0, 4)), dir);
	const model = buildTopicModel(openStore(dir), DEFAULT_CLUSTER_CONFIG); // kRange[0]=3 > 1 chunk
	assert.equal(model.k, 1);
	assert.equal(model.topics.length, 1);
	assert.equal(model.topics[0].memoryCount, 1);
	assert.equal(model.silhouetteScore, null);
});

test("empty corpus → zero topics, no crash", () => {
	const dir = stateDir();
	openStore(dir);
	const model = buildTopicModel(openStore(dir), DEFAULT_CLUSTER_CONFIG);
	assert.equal(model.k, 0);
	assert.equal(model.topics.length, 0);
	assert.equal(model.assignments.length, 0);
});

test("tfidfScores surfaces discriminative terms, down-weights common ones", () => {
	const mk = (text: string): EmbeddedChunk => ({
		chunkId: text, sessionId: "s", vec: [1], text,
	});
	const corpus = [
		mk("sqlite wal sqlite pragma"),
		mk("sqlite wal journal"),
		mk("react component render"),
		mk("react hooks state"),
	];
	const members = corpus.slice(0, 2); // the sqlite cluster
	const scores = tfidfScores(members, corpus);
	const top = scores[0]?.term;
	assert.ok(top === "sqlite" || top === "wal", `top term should be discriminative, got ${top}`);
	// 'react' never appears in members → not scored for this cluster.
	assert.ok(!scores.some((s) => s.term === "react"));
});

test("membershipConfidence maps cosine [-1,1] → [0,1]", () => {
	assert.equal(membershipConfidence(1), 1);
	assert.equal(membershipConfidence(-1), 0);
	assert.equal(membershipConfidence(0), 0.5);
});

test("buildTopicModel is deterministic for a fixed seed", () => {
	const dir = stateDir();
	seedClusters(dir, 3, 5, 8);
	const db = openStore(dir);
	const a = buildTopicModel(db, { ...DEFAULT_CLUSTER_CONFIG, kRange: [2, 5] });
	const b = buildTopicModel(db, { ...DEFAULT_CLUSTER_CONFIG, kRange: [2, 5] });
	assert.equal(a.k, b.k);
	assert.deepEqual(
		a.topics.map((t) => t.label).sort(),
		b.topics.map((t) => t.label).sort(),
	);
});

test("honest boundary: no LLM/Ollama/network/keyword-literals in src/topics", () => {
const here = dirname(fileURLToPath(import.meta.url));
const srcTopics = join(here, "..", "..", "..", "src", "topics"); // dist/src/topics → src/topics
const files = readdirSync(srcTopics).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
const banned = [/ollama/i, /\bllm\b/i, /\bfetch\s*\(/, /\bhybrid\b/i];
const fabricated = ["graphql", "docker", "stacktrace", "bottleneck", "trade-off"];
for (const f of files) {
const text = readFileSync(join(srcTopics, f), "utf8");
for (const re of banned) {
assert.ok(!re.test(text), `${f} must not contain ${re} (PREVENT-PI-004 / no-LLM boundary)`);
}
for (const word of fabricated) {
assert.ok(
!text.toLowerCase().includes(`"${word}"`),
`${f} must not hardcode fabricated taxonomy term "${word}"`,
);
}
}
});
