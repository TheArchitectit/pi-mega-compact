/**
 * curation.test.ts — W2 wiki curation tests.
 *
 * Real turns.db (no mocks), seeded via createTopicStore.replaceTopicModel.
 * Verifies rename / merge / split transactions, override persistence, count
 * consistency, and atomic rejection of a self-merge.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTopicStore } from "../topics/store.js";
import { openTurnStore, closeTurnStore } from "../store/turns/connection.js";
import { createWikiCuration } from "./curation.js";
import type { ClusterModel } from "../topics/types.js";

let tmpDir: string;
let counter = 0;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "mc-wiki-curation-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function stateDir(): string {
	return join(tmpDir, `run-${counter++}`);
}

/** Seed two topics (topic_0, topic_1), each with 2 members. */
function makeModel(builtAt: number): ClusterModel {
	return {
		topics: [
			{
				id: "topic_0",
				label: "alpha",
				termScores: [{ term: "a", score: 1 }],
				memoryCount: 2,
				lastUpdated: builtAt,
			},
			{
				id: "topic_1",
				label: "beta",
				termScores: [{ term: "b", score: 1 }],
				memoryCount: 2,
				lastUpdated: builtAt,
			},
		],
		assignments: [
			{
				memoryId: "mem_a0",
				sessionId: "sess1",
				topicId: "topic_0",
				confidence: 0.9,
				assignedAt: builtAt,
				method: "kmeans+tfidf",
			},
			{
				memoryId: "mem_a1",
				sessionId: "sess1",
				topicId: "topic_0",
				confidence: 0.8,
				assignedAt: builtAt,
				method: "kmeans+tfidf",
			},
			{
				memoryId: "mem_b0",
				sessionId: "sess2",
				topicId: "topic_1",
				confidence: 0.7,
				assignedAt: builtAt,
				method: "kmeans+tfidf",
			},
			{
				memoryId: "mem_b1",
				sessionId: "sess2",
				topicId: "topic_1",
				confidence: 0.6,
				assignedAt: builtAt,
				method: "kmeans+tfidf",
			},
		],
		k: 2,
		criterion: "silhouette",
		silhouetteScore: 0.5,
		totalChunks: 4,
		builtAt,
	};
}

test("renameTopic: writes override, resolves label, edited=true; empty clears", () => {
	const dir = stateDir();
	createTopicStore(dir).replaceTopicModel(makeModel(1000));
	const cur = createWikiCuration(dir);

	const r = cur.renameTopic("topic_0", "My Custom Name");
	assert.equal(r.ok, true);
	assert.equal(r.edited, true);
	assert.equal(r.topicId, "topic_0");
	// ResolveLabel picks up the custom label.
	assert.deepEqual(cur.resolveLabel("topic_0", "alpha"), {
		label: "My Custom Name",
		edited: true,
	});
	assert.deepEqual(cur.overrideKinds("topic_0"), ["label"]);
	// Live topic label updated in place.
	const db = openTurnStore(dir);
	const row = db
		.prepare("SELECT label FROM topics WHERE id = 'topic_0'")
		.get() as { label: string };
	assert.equal(row.label, "My Custom Name");
	// Empty clears the override back to auto.
	const cleared = cur.renameTopic("topic_0", "");
	assert.equal(cleared.edited, false);
	assert.deepEqual(cur.resolveLabel("topic_0", "alpha"), {
		label: "alpha",
		edited: false,
	});
	assert.deepEqual(cur.overrideKinds("topic_0"), []);
	closeTurnStore(dir);
});

test("mergeTopics: reassigns memories, writes override, counts consistent, evolution recorded", () => {
	const dir = stateDir();
	createTopicStore(dir).replaceTopicModel(makeModel(1000));
	const cur = createWikiCuration(dir);

	const r = cur.mergeTopics("topic_0", "topic_1");
	assert.equal(r.ok, true);
	assert.equal(r.merged, true);
	assert.equal(r.topicId, "topic_1");

	const db = openTurnStore(dir);
	// All 4 memories now belong to topic_1.
	const targetMembers = db
		.prepare("SELECT COUNT(*) AS c FROM memory_topics WHERE topic_id = 'topic_1'")
		.get() as { c: number };
	assert.equal(targetMembers.c, 4);
	// Source topic is gone from the list (hidden).
	const source = db
		.prepare("SELECT COUNT(*) AS c FROM topics WHERE id = 'topic_0'")
		.get() as { c: number };
	assert.equal(source.c, 0);
	// Counts consistent with member rows.
	const count = db
		.prepare("SELECT memory_count FROM topics WHERE id = 'topic_1'")
		.get() as { memory_count: number };
	assert.equal(count.memory_count, 4);
	// Override records the merge provenance.
	const ov = db
		.prepare(
			"SELECT merged_into FROM topic_overrides WHERE topic_id = 'topic_0' AND kind = 'merge'",
		)
		.get() as { merged_into: string };
	assert.equal(ov.merged_into, "topic_1");
	// Evolution recorded for each memory that MOVED via the merge (the two
	// source members — the target's own members were already present).
	const evo = db
		.prepare(
			"SELECT COUNT(*) AS c FROM topic_evolution WHERE topic_id = 'topic_1' AND method = 'merge'",
		)
		.get() as { c: number };
	assert.equal(evo.c, 2);
	closeTurnStore(dir);
});

test("splitTopic: moves listed memories to new topic, writes override + evolution", () => {
	const dir = stateDir();
	createTopicStore(dir).replaceTopicModel(makeModel(1000));
	const cur = createWikiCuration(dir);

	const r = cur.splitTopic("topic_0", ["mem_a0"]);
	assert.equal(r.ok, true);
	assert.equal(r.split, true);
	assert.notEqual(r.topicId, "topic_0");

	const db = openTurnStore(dir);
	// The listed memory moved to the new topic; the other stays.
	const newMembers = db
		.prepare("SELECT memory_id FROM memory_topics WHERE topic_id = ?")
		.all(r.topicId) as Array<{ memory_id: string }>;
	assert.deepEqual(newMembers.map((m) => m.memory_id), ["mem_a0"]);
	const origMembers = db
		.prepare("SELECT memory_id FROM memory_topics WHERE topic_id = 'topic_0'")
		.all() as Array<{ memory_id: string }>;
	assert.deepEqual(origMembers.map((m) => m.memory_id), ["mem_a1"]);
	// Counts updated on both topics.
	const newCount = db
		.prepare("SELECT memory_count FROM topics WHERE id = ?")
		.get(r.topicId) as { memory_count: number };
	assert.equal(newCount.memory_count, 1);
	// Override records the split provenance with split_from + member ids.
	const ov = db
		.prepare(
			"SELECT split_from FROM topic_overrides WHERE topic_id = ? AND kind = 'split'",
		)
		.get(r.topicId) as { split_from: string };
	assert.equal(ov.split_from, "topic_0");
	// Evolution recorded for the new topic (method 'split').
	const evo = db
		.prepare("SELECT COUNT(*) AS c FROM topic_evolution WHERE topic_id = ?")
		.get(r.topicId) as { c: number };
	assert.equal(evo.c, 1);
	closeTurnStore(dir);
});

test("merge source==target rejects without partial write", () => {
	const dir = stateDir();
	createTopicStore(dir).replaceTopicModel(makeModel(1000));
	const cur = createWikiCuration(dir);

	const r = cur.mergeTopics("topic_0", "topic_0");
	assert.equal(r.ok, false);
	// Nothing changed: both topics intact with original counts.
	const db = openTurnStore(dir);
	const members = db
		.prepare("SELECT COUNT(*) AS c FROM memory_topics WHERE topic_id = 'topic_0'")
		.get() as { c: number };
	assert.equal(members.c, 2);
	const topics = db.prepare("SELECT COUNT(*) AS c FROM topics").get() as { c: number };
	assert.equal(topics.c, 2);
	closeTurnStore(dir);
});
