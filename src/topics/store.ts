/**
 * store.ts — S51B topic persistence over the turns.db `topics`/`memory_topics`
 * shells (reserved in S49's schema, so NO migration / no schema drift).
 *
 * Host-agnostic (no pi imports). Pure local node:sqlite (PREVENT-PI-004), all
 * queries parameterized (PREVENT-002). This is a derived, read-mostly view:
 * `replaceTopicModel` rewrites ONLY the two topic tables in one transaction and
 * never touches turns/memories/checkpoints (PREVENT-PI-001/002).
 */

import type { DatabaseSync } from "node:sqlite";
import { openTurnStore, withTx } from "../store/turns/connection.js";
import { getStateDir } from "../store.js";
import type { ClusterModel, Topic, TopicAssignment } from "./types.js";

/** A topic row joined with its computed member count. */
export interface StoredTopic extends Topic {
	/** Epoch ms the owning model was built (cluster_model_built_at column). */
	clusterModelBuiltAt: number | null;
}

export interface TopicStore {
	/** Atomically replace the entire topic model (clears old topics + assignments). */
	replaceTopicModel(model: ClusterModel): void;
	/** All topics, sorted by memory_count DESC. */
	getTopics(): StoredTopic[];
	/** Member memory ids for a topic (paginated). */
	getMemoriesForTopic(
		topicId: string,
		limit?: number,
		offset?: number,
	): TopicAssignment[];
	/** The assignment for one memory, or null. */
	getTopicForMemory(memoryId: string): TopicAssignment | null;
	/** Rollup stats for the wiki index header. */
	getTopicStats(): {
		totalTopics: number;
		totalAssigned: number;
		lastRebuildAt: number | null;
	};
}

interface TopicRow {
	id: string;
	label: string;
	term_scores: string | null;
	memory_count: number;
	last_updated: number | null;
	cluster_model_built_at: number | null;
}

interface AssignmentRow {
	memory_id: string;
	topic_id: string;
	confidence: number | null;
	assigned_at: number | null;
	method: string | null;
}

function parseTermScores(
	json: string | null,
): Array<{ term: string; score: number }> {
	if (!json) return [];
	try {
		const v = JSON.parse(json) as unknown;
		return Array.isArray(v)
			? (v as Array<{ term: string; score: number }>)
			: [];
	} catch {
		return [];
	}
}

function rowToTopic(r: TopicRow): StoredTopic {
	return {
		id: r.id,
		label: r.label,
		termScores: parseTermScores(r.term_scores),
		memoryCount: r.memory_count,
		lastUpdated: r.last_updated ?? 0,
		clusterModelBuiltAt: r.cluster_model_built_at,
	};
}

function rowToAssignment(r: AssignmentRow): TopicAssignment {
	return {
		memoryId: r.memory_id,
		// memory_topics has no session_id column; the chunk id is globally unique
		// enough for the wiki view (context_chunks PK is (session_id, id)).
		// sessionId omitted — memory_topics has no session_id column;
		// the TopicAssignment type marks it optional for this reason.
		topicId: r.topic_id,
		confidence: r.confidence ?? 0,
		assignedAt: r.assigned_at ?? 0,
		method: "kmeans+tfidf",
	};
}

/** Open a TopicStore over the same turns.db the S49 TurnStore uses (shared connection cache). */
export function createTopicStore(stateDir?: string): TopicStore {
	const db: DatabaseSync = openTurnStore(stateDir ?? getStateDir());

	function replaceTopicModel(model: ClusterModel): void {
		withTx(db, () => {
			db.prepare("DELETE FROM memory_topics").run();
			db.prepare("DELETE FROM topics").run();
			const insTopic = db.prepare(
				`INSERT INTO topics (id, label, term_scores, memory_count, last_updated, cluster_model_built_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
			);
			for (const t of model.topics) {
				insTopic.run(
					t.id,
					t.label,
					JSON.stringify(t.termScores),
					t.memoryCount,
					t.lastUpdated,
					model.builtAt,
				);
			}
			const insAssign = db.prepare(
				`INSERT OR REPLACE INTO memory_topics (memory_id, topic_id, confidence, assigned_at, method)
         VALUES (?, ?, ?, ?, 'kmeans+tfidf')`,
			);
			for (const a of model.assignments) {
				insAssign.run(a.memoryId, a.topicId, a.confidence, a.assignedAt);
			}
		});
	}

	return {
		replaceTopicModel,

		getTopics(): StoredTopic[] {
			const rows = db
				.prepare("SELECT * FROM topics ORDER BY memory_count DESC, id ASC")
				.all() as unknown as TopicRow[];
			return rows.map(rowToTopic);
		},

		getMemoriesForTopic(
			topicId: string,
			limit = 50,
			offset = 0,
		): TopicAssignment[] {
			const rows = db
				.prepare(
					`SELECT memory_id, topic_id, confidence, assigned_at, method
           FROM memory_topics WHERE topic_id = ?
           ORDER BY confidence DESC, memory_id ASC LIMIT ? OFFSET ?`,
				)
				.all(topicId, limit, offset) as unknown as AssignmentRow[];
			return rows.map(rowToAssignment);
		},

		getTopicForMemory(memoryId: string): TopicAssignment | null {
			const r = db
				.prepare(
					`SELECT memory_id, topic_id, confidence, assigned_at, method
           FROM memory_topics WHERE memory_id = ? LIMIT 1`,
				)
				.get(memoryId) as unknown as AssignmentRow | undefined;
			return r ? rowToAssignment(r) : null;
		},

		getTopicStats(): {
			totalTopics: number;
			totalAssigned: number;
			lastRebuildAt: number | null;
		} {
			const t = db.prepare("SELECT COUNT(*) AS c FROM topics").get() as {
				c: number;
			};
			const a = db.prepare("SELECT COUNT(*) AS c FROM memory_topics").get() as {
				c: number;
			};
			const r = db
				.prepare("SELECT MAX(cluster_model_built_at) AS m FROM topics")
				.get() as { m: number | null };
			return {
				totalTopics: t.c,
				totalAssigned: a.c,
				lastRebuildAt: r.m ?? null,
			};
		},
	};
}

/** Turns-meta counter key for the every-Nth-compaction rebuild trigger. */
const WIKI_COUNTER_KEY = "wiki_compact_counter";

/** Read the rebuild counter (0 when unset). */
export function getWikiCompactCounter(db: DatabaseSync): number {
	const r = db
		.prepare("SELECT value FROM turns_meta WHERE key = ?")
		.get(WIKI_COUNTER_KEY) as { value: string } | undefined;
	const n = r ? Number(r.value) : 0;
	return Number.isFinite(n) ? n : 0;
}

/** Increment + persist the rebuild counter; returns the new value. */
export function bumpWikiCompactCounter(db: DatabaseSync): number {
	const next = getWikiCompactCounter(db) + 1;
	db.prepare(
		"INSERT OR REPLACE INTO turns_meta (key, value) VALUES (?, ?)",
	).run(WIKI_COUNTER_KEY, String(next));
	return next;
}
