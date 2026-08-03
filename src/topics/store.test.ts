/**
 * store.test.ts — S51B topic persistence tests. Temp dirs; node:sqlite only.
 * Verifies the topics/memory_topics shells (S49) are written atomically, CRUD
 * round-trips, and the every-Nth-compaction counter behaves.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createTopicStore,
	getWikiCompactCounter,
	bumpWikiCompactCounter,
	applyOverridesAfterRebuild,
} from "./store.js";
import { openTurnStore, closeTurnStore } from "../store/turns/connection.js";
import type { ClusterModel } from "./types.js";

let tmpDir: string;
let counter = 0;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "mc-topicstore-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function stateDir(): string {
	return join(tmpDir, `run-${counter++}`);
}

function makeModel(builtAt: number, topics: number): ClusterModel {
	const tops = [];
	const assigns = [];
	for (let i = 0; i < topics; i++) {
		tops.push({
			id: `topic_${i}`,
			label: `label ${i}`,
			termScores: [{ term: `t${i}`, score: i + 1 }],
			memoryCount: 2,
			lastUpdated: builtAt,
		});
		for (let m = 0; m < 2; m++) {
			assigns.push({
				memoryId: `mem_${i}_${m}`,
				sessionId: "s",
				topicId: `topic_${i}`,
				confidence: 0.9 - m * 0.1,
				assignedAt: builtAt,
				method: "kmeans+tfidf" as const,
			});
		}
	}
	return {
		topics: tops,
		assignments: assigns,
		k: topics,
		criterion: "silhouette",
		silhouetteScore: 0.5,
		totalChunks: topics * 2,
		builtAt,
	};
}

test("replaceTopicModel inserts topics + assignments; CRUD round-trips", () => {
	const dir = stateDir();
	const store = createTopicStore(dir);
	store.replaceTopicModel(makeModel(1000, 2));
	const topics = store.getTopics();
	assert.equal(topics.length, 2);
	assert.equal(topics[0].label, "label 0");
	assert.equal(topics[0].clusterModelBuiltAt, 1000);
	assert.deepEqual(topics[0].termScores, [{ term: "t0", score: 1 }]);
	const members = store.getMemoriesForTopic("topic_0");
	assert.equal(members.length, 2);
	assert.equal(members[0].memoryId, "mem_0_0"); // confidence DESC
	const a = store.getTopicForMemory("mem_1_1");
	assert.equal(a?.topicId, "topic_1");
	assert.ok(Math.abs((a?.confidence ?? 0) - 0.8) < 1e-9);
	closeTurnStore(dir);
});

test("replaceTopicModel is atomic — old model fully replaced", () => {
	const dir = stateDir();
	const store = createTopicStore(dir);
	store.replaceTopicModel(makeModel(1000, 3)); // 3 topics, 6 assignments
	store.replaceTopicModel(makeModel(2000, 1)); // 1 topic, 2 assignments
	const stats = store.getTopicStats();
	assert.equal(stats.totalTopics, 1);
	assert.equal(stats.totalAssigned, 2);
	assert.equal(stats.lastRebuildAt, 2000);
	// Old topic ids gone.
	assert.equal(store.getTopicForMemory("mem_2_0"), null);
	closeTurnStore(dir);
});

test("getTopics sorted by memory_count DESC; stats roll up", () => {
	const dir = stateDir();
	const store = createTopicStore(dir);
	const model = makeModel(500, 2);
	model.topics[1].memoryCount = 99; // make topic_1 biggest
	// give topic_1 more assignments to match memoryCount semantics loosely
	store.replaceTopicModel(model);
	const topics = store.getTopics();
	assert.equal(topics[0].id, "topic_1"); // highest count first
	const stats = store.getTopicStats();
	assert.equal(stats.totalTopics, 2);
	closeTurnStore(dir);
});

test("wiki compact counter increments + persists; default 0", () => {
	const dir = stateDir();
	const db = openTurnStore(dir);
	assert.equal(getWikiCompactCounter(db), 0);
	assert.equal(bumpWikiCompactCounter(db), 1);
	assert.equal(bumpWikiCompactCounter(db), 2);
	// Reopen handle (same cached conn) — value persists.
	assert.equal(getWikiCompactCounter(openTurnStore(dir)), 2);
	closeTurnStore(dir);
});

test("topics + memory_topics shells exist with no seed data (S49 schema)", () => {
	const dir = stateDir();
	const db = openTurnStore(dir);
	const topics = db.prepare("SELECT COUNT(*) AS c FROM topics").get() as { c: number };
	const assigns = db.prepare("SELECT COUNT(*) AS c FROM memory_topics").get() as { c: number };
	assert.equal(topics.c, 0);
	assert.equal(assigns.c, 0);
	closeTurnStore(dir);
});

test("session_id round-trips through replaceTopicModel (W1.2)", () => {
	const dir = stateDir();
	const store = createTopicStore(dir);
	const model = makeModel(1000, 1);
	// Make the assignments carry distinct, non-empty session ids.
	model.assignments[0].sessionId = "sess_alpha";
	model.assignments[1].sessionId = "sess_beta";
	store.replaceTopicModel(model);
	const members = store.getMemoriesForTopic("topic_0");
	assert.equal(members[0].sessionId, "sess_alpha");
	assert.equal(members[1].sessionId, "sess_beta");
	const direct = store.getTopicForMemory("mem_0_0");
	assert.equal(direct?.sessionId, "sess_alpha");
	// Persisted column value is non-empty, not defaulted to "".
	const db = openTurnStore(dir);
	const row = db
		.prepare("SELECT session_id FROM memory_topics WHERE memory_id = ?")
		.get("mem_0_1") as { session_id: string };
	assert.equal(row.session_id, "sess_beta");
	closeTurnStore(dir);
});

test("applyOverridesAfterRebuild re-applies custom label overrides (W1.2)", () => {
	const dir = stateDir();
	const store = createTopicStore(dir);
	const db = openTurnStore(dir);
	store.replaceTopicModel(makeModel(1000, 1));
	// Write a user label override, then simulate a rebuild (drops topics + memory_topics).
	db.prepare(
		`INSERT INTO topic_overrides (topic_id, kind, custom_label, overridden_at)
		 VALUES ('topic_0', 'label', 'My Custom Topic', ?)`,
	).run(Date.now());
	store.replaceTopicModel(makeModel(2000, 1));
	// Without re-applying, the label would be the auto-generated one.
	assert.equal(store.getTopics()[0].label, "label 0");
	// After re-applying, the custom label wins.
	applyOverridesAfterRebuild(db);
	assert.equal(store.getTopics()[0].label, "My Custom Topic");
	// Empty/blank override does not clobber the label.
	db.prepare(
		`INSERT OR REPLACE INTO topic_overrides (topic_id, kind, custom_label, overridden_at)
		 VALUES ('topic_0', 'label', '', ?)`,
	).run(Date.now());
	applyOverridesAfterRebuild(db);
	assert.equal(store.getTopics()[0].label, "My Custom Topic");
	closeTurnStore(dir);
});
