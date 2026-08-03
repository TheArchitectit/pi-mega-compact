/**
 * durability.test.ts — W5 full override replay (label + merge + split).
 *
 * Real turns.db (no mocks), seeded via createTopicStore.replaceTopicModel. The
 * split override carries `split_memory_ids`, so splits survive a full rebuild;
 * merge member identity lives in `topic_evolution`, so the merge replay is
 * exercised against that authoritative state. All writes best-effort + non-fatal.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTopicStore } from "./store.js";
import { applyFullOverridesAfterRebuild } from "./durability.js";
import { openTurnStore, closeTurnStore } from "../store/turns/connection.js";
import type { ClusterModel } from "./types.js";

let tmpDir: string;
let counter = 0;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "mc-wiki-durability-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function stateDir(): string {
	return join(tmpDir, `run-${counter++}`);
}

/** Seed two topics with members, as a fresh auto-clustered model. */
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

test("replays a label override after a full rebuild", () => {
	const dir = stateDir();
	const db = openTurnStore(dir);
	createTopicStore(dir).replaceTopicModel(makeModel(1000));
	// Label override (survives the wipe in topic_overrides).
	db.prepare(
		`INSERT OR REPLACE INTO topic_overrides (topic_id, kind, custom_label, overridden_at)
		 VALUES ('topic_0', 'label', 'Renamed Alpha', 10)`,
	).run();
	// Simulate the W5 full-rebuild wipe + fresh model.
	createTopicStore(dir).replaceTopicModel(makeModel(2000));
	applyFullOverridesAfterRebuild(db);

	const row = db
		.prepare("SELECT label FROM topics WHERE id = 'topic_0'")
		.get() as { label: string };
	assert.equal(row.label, "Renamed Alpha");
	// Non-curated topic keeps its auto label.
	const row1 = db
		.prepare("SELECT label FROM topics WHERE id = 'topic_1'")
		.get() as { label: string };
	assert.equal(row1.label, "beta");
	closeTurnStore(dir);
});

test("replays a split override after a full rebuild (topic recreated + memories moved)", () => {
	const dir = stateDir();
	const db = openTurnStore(dir);
	createTopicStore(dir).replaceTopicModel(makeModel(1000));
	// A split override records which members belong to the new topic.
	db.prepare(
		`INSERT OR REPLACE INTO topic_overrides
		   (topic_id, kind, split_from, split_memory_ids, overridden_at)
		 VALUES ('topic_0_split', 'split', 'topic_0', '["mem_a0"]', 10)`,
	).run();
	// Simulate a rebuild — the split topic id is gone, mem_a0 is re-clustered
	// into the fresh topic_0.
	createTopicStore(dir).replaceTopicModel(makeModel(2000));
	applyFullOverridesAfterRebuild(db);

	// The split topic was recreated with exactly the listed memory.
	const members = db
		.prepare(
			"SELECT memory_id FROM memory_topics WHERE topic_id = 'topic_0_split' ORDER BY memory_id",
		)
		.all() as Array<{ memory_id: string }>;
	assert.deepEqual(members.map((m) => m.memory_id), ["mem_a0"]);
	// Source topic kept its remaining member.
	const srcMembers = db
		.prepare(
			"SELECT memory_id FROM memory_topics WHERE topic_id = 'topic_0' ORDER BY memory_id",
		)
		.all() as Array<{ memory_id: string }>;
	assert.deepEqual(srcMembers.map((m) => m.memory_id), ["mem_a1"]);
	closeTurnStore(dir);
});

test("replays a merge override — source members forced back into the target", () => {
	const dir = stateDir();
	const db = openTurnStore(dir);
	createTopicStore(dir).replaceTopicModel(makeModel(1000));
	// Merge override: topic_1 dissolved into topic_0.
	db.prepare(
		`INSERT OR REPLACE INTO topic_overrides
		   (topic_id, kind, merged_into, overridden_at)
		 VALUES ('topic_1', 'merge', 'topic_0', 10)`,
	).run();
	// The merge's member provenance is recorded under the target topic.
	db.prepare(
		`INSERT OR REPLACE INTO topic_evolution (topic_id, memory_id, session_id, assigned_at, method)
		 VALUES ('topic_0', 'mem_b0', 'sess2', 5, 'merge')`,
	).run();
	db.prepare(
		`INSERT OR REPLACE INTO topic_evolution (topic_id, memory_id, session_id, assigned_at, method)
		 VALUES ('topic_0', 'mem_b1', 'sess2', 5, 'merge')`,
	).run();

	const targetBefore = db
		.prepare("SELECT COUNT(*) AS c FROM memory_topics WHERE topic_id = 'topic_0'")
		.get() as { c: number };
	assert.equal(targetBefore.c, 2);

	// Replay (covers the no-wipe/incremental path where evolution is intact).
	applyFullOverridesAfterRebuild(db);

	// Both source members now live under the target topic.
	const targetMembers = db
		.prepare("SELECT memory_id FROM memory_topics WHERE topic_id = 'topic_0' ORDER BY memory_id")
		.all() as Array<{ memory_id: string }>;
	assert.deepEqual(targetMembers.map((m) => m.memory_id), [
		"mem_a0",
		"mem_a1",
		"mem_b0",
		"mem_b1",
	]);
	closeTurnStore(dir);
});

test("non-fatal when overrides reference topics that no longer exist", () => {
	const dir = stateDir();
	const db = openTurnStore(dir);
	createTopicStore(dir).replaceTopicModel(makeModel(1000));
	// Stale overrides pointing at ghosts.
	db.prepare(
		`INSERT OR REPLACE INTO topic_overrides (topic_id, kind, custom_label, overridden_at)
		 VALUES ('ghost_1', 'label', 'Ghost', 1)`,
	).run();
	db.prepare(
		`INSERT OR REPLACE INTO topic_overrides (topic_id, kind, merged_into, overridden_at)
		 VALUES ('ghost_2', 'merge', 'ghost_target', 2)`,
	).run();
	db.prepare(
		`INSERT OR REPLACE INTO topic_overrides
		   (topic_id, kind, split_from, split_memory_ids, overridden_at)
		 VALUES ('ghost_split', 'split', 'ghost_2', '["nope"]', 3)`,
	).run();
	// A corrupt split member list should also not throw.
	db.prepare(
		`INSERT OR REPLACE INTO topic_overrides
		   (topic_id, kind, split_from, split_memory_ids, overridden_at)
		 VALUES ('ghost_split2', 'split', 'ghost_2', 'not-json', 4)`,
	).run();

	assert.doesNotThrow(() => applyFullOverridesAfterRebuild(db));
	// The two original topics survive with all members intact. The ghost split
	// (valid member list, dissolved source) recreates its split topic; the
	// malformed one does not — neither path throws.
	const topics = db.prepare("SELECT id FROM topics ORDER BY id").all() as Array<{ id: string }>;
	assert.ok(topics.some((t) => t.id === "topic_0"));
	assert.ok(topics.some((t) => t.id === "topic_1"));
	assert.ok(topics.some((t) => t.id === "ghost_split"));
	assert.ok(!topics.some((t) => t.id === "ghost_split2"));
	const assignments = db
		.prepare("SELECT COUNT(*) AS c FROM memory_topics")
		.get() as { c: number };
	assert.equal(assignments.c, 4);
	closeTurnStore(dir);
});
