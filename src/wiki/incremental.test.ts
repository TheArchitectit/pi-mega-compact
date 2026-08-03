/**
 * incremental.test.ts — W5 incremental topic assignment (feature B).
 *
 * Real stores, no mocks: embeddings live in the main memory db
 * (`context_chunks`), topics/assignments in the turns.db. Verifies new memories
 * get assigned to their nearest centroid, unassigned ones are left pending, the
 * mean silhouette is tracked, and the silhouette degrades (→ full-rebuild
 * trigger) on a poorly separated model.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../store/sqlite/utils.js";
import { encodeEmbedding } from "../store/sqlite/utils.js";
import { createTopicStore } from "../topics/store.js";
import { openTurnStore, closeTurnStore } from "../store/turns/connection.js";
import { TurnsConfig } from "../config/turns.js";
import { assignNewMemoriesIncremental } from "./incremental.js";
import type { ClusterModel } from "../topics/types.js";

let tmpDir: string;
let counter = 0;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "mc-wiki-incremental-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function stateDir(): string {
	return join(tmpDir, `run-${counter++}`);
}

/** Insert one embedded chunk into the main memory db. */
function seedChunk(
	db: import("node:sqlite").DatabaseSync,
	id: string,
	sessionId: string,
	vec: number[],
): void {
	db.prepare(
		`INSERT INTO context_chunks (id, session_id, normalized_text, embedding_blob)
		 VALUES (?, ?, ?, ?)`,
	).run(id, sessionId, `text for ${id}`, encodeEmbedding(vec));
}

/** Build a topic model with the given (topicId, memberVecPairs). */
function modelFromTopics(
	builtAt: number,
	topics: Array<{ id: string; label: string; members: Array<[string, string, number[]]> }>,
): ClusterModel {
	const out: ClusterModel = {
		topics: [],
		assignments: [],
		k: topics.length,
		criterion: "silhouette",
		silhouetteScore: 0.5,
		totalChunks: 0,
		builtAt,
	};
	for (const t of topics) {
		out.topics.push({
			id: t.id,
			label: t.label,
			termScores: [{ term: t.label, score: 1 }],
			memoryCount: t.members.length,
			lastUpdated: builtAt,
		});
		for (const [memId, sess] of t.members) {
			out.assignments.push({
				memoryId: memId,
				sessionId: sess,
				topicId: t.id,
				confidence: 0.9,
				assignedAt: builtAt,
				method: "kmeans+tfidf",
			});
			out.totalChunks++;
		}
	}
	return out;
}

test("assigns new memories to the nearest centroid; leaves far ones pending", () => {
	const dir = stateDir();
	const db = openStore(dir);
	// Well-separated clusters on the x/y axes.
	for (const m of [
		["m_a0", "s1", [1, 0, 0, 0]],
		["m_a1", "s1", [1, 0, 0, 0]],
		["m_b0", "s2", [0, 1, 0, 0]],
		["m_b1", "s2", [0, 1, 0, 0]],
	] as Array<[string, string, number[]]>) {
		seedChunk(db, m[0], m[1], m[2]);
	}
	// New unassigned chunks: one close to topic_0, one orthogonal to both.
	seedChunk(db, "n_close", "s3", [0.95, 0.05, 0, 0]);
	seedChunk(db, "n_far", "s3", [0, 0, 1, 0]);

	createTopicStore(dir).replaceTopicModel(
		modelFromTopics(1000, [
			{ id: "topic_0", label: "alpha", members: [["m_a0", "s1", [1, 0, 0, 0]], ["m_a1", "s1", [1, 0, 0, 0]]] },
			{ id: "topic_1", label: "beta", members: [["m_b0", "s2", [0, 1, 0, 0]], ["m_b1", "s2", [0, 1, 0, 0]]] },
		]),
	);

	const result = assignNewMemoriesIncremental(db, dir);
	assert.equal(result.assigned, 1);
	assert.equal(result.pending, 1);
	// n_close landed in topic_0; n_far stayed unassigned.
	const tdb = openTurnStore(dir);
	const nClose = tdb
		.prepare("SELECT topic_id FROM memory_topics WHERE memory_id = 'n_close'")
		.get() as { topic_id: string };
	assert.equal(nClose.topic_id, "topic_0");
	const nFar = tdb
		.prepare("SELECT COUNT(*) AS c FROM memory_topics WHERE memory_id = 'n_far'")
		.get() as { c: number };
	assert.equal(nFar.c, 0);
	// Healthy, well-separated clusters → high silhouette (above the rebuild floor).
	assert.ok(result.silhouette !== null);
	assert.ok(result.silhouette! > TurnsConfig.WIKI_INCREMENTAL_SILHOUETTE_MIN);
	closeTurnStore(dir);
});

test("silhouette degrades on poorly separated clusters (rebuild trigger)", () => {
	const dir = stateDir();
	const db = openStore(dir);
	// Each "cluster" holds two members spread far apart, and both clusters are
	// identical — nearest-other-cluster is just as close as its own, so the mean
	// silhouette falls well below the default 0.2 rebuild floor.
	seedChunk(db, "p0", "s1", [1, 0, 0, 0]);
	seedChunk(db, "p1", "s1", [0, 1, 0, 0]);
	seedChunk(db, "p2", "s2", [1, 0, 0, 0]);
	seedChunk(db, "p3", "s2", [0, 1, 0, 0]);

	createTopicStore(dir).replaceTopicModel(
		modelFromTopics(1000, [
			{ id: "topic_0", label: "a", members: [["p0", "s1", [1, 0, 0, 0]], ["p1", "s1", [0, 1, 0, 0]]] },
			{ id: "topic_1", label: "b", members: [["p2", "s2", [1, 0, 0, 0]], ["p3", "s2", [0, 1, 0, 0]]] },
		]),
	);

	const result = assignNewMemoriesIncremental(db, dir);
	assert.ok(result.silhouette !== null);
	assert.ok(result.silhouette! < TurnsConfig.WIKI_INCREMENTAL_SILHOUETTE_MIN);
	closeTurnStore(dir);
});
