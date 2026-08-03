/**
 * curation-helpers.ts — private DB helpers for the wiki curation store.
 *
 * Pure node:sqlite primitives shared by the rename/merge/split transactions in
 * curation.ts (the factory shell). Parameterized (PREVENT-002), host-agnostic.
 */
import type { DatabaseSync } from "node:sqlite";

interface LabelRow {
	label: string;
}
interface CountRow {
	c: number;
}

/** Read a topic's current label, or null when the topic does not exist. */
export function getTopicLabel(db: DatabaseSync, topicId: string): string | null {
	const r = db
		.prepare("SELECT label FROM topics WHERE id = ?")
		.get(topicId) as LabelRow | undefined;
	return r?.label ?? null;
}

/** Recompute memory_count for a topic from its live member rows. */
export function recountTopic(db: DatabaseSync, topicId: string): void {
	const c = db
		.prepare("SELECT COUNT(*) AS c FROM memory_topics WHERE topic_id = ?")
		.get(topicId) as unknown as CountRow;
	db.prepare("UPDATE topics SET memory_count = ? WHERE id = ?").run(c.c, topicId);
}

/** Look up a custom label override; empty/blank means "no override". */
export function customLabelOverride(
	db: DatabaseSync,
	topicId: string,
): string | null {
	const r = db
		.prepare(
			`SELECT custom_label FROM topic_overrides
			 WHERE topic_id = ? AND kind = 'label'`,
		)
		.get(topicId) as { custom_label: string | null } | undefined;
	const label = r?.custom_label;
	return label && label.trim() !== "" ? label : null;
}

/** Write (or clear) a label override for a topic. */
export function writeLabelOverride(
	db: DatabaseSync,
	topicId: string,
	label: string,
	now: number,
): void {
	if (label.trim() === "") {
		db.prepare(
			"DELETE FROM topic_overrides WHERE topic_id = ? AND kind = 'label'",
		).run(topicId);
		return;
	}
	db.prepare(
		`INSERT OR REPLACE INTO topic_overrides
		   (topic_id, kind, custom_label, overridden_at)
		 VALUES (?, 'label', ?, ?)`,
	).run(topicId, label, now);
	// Keep the live topics.label in sync with the override so reads resolve directly.
	db.prepare("UPDATE topics SET label = ? WHERE id = ?").run(label, topicId);
}

/** Copy a source assignment into the target topic (idempotent, atomic caller). */
export function moveMemory(
	db: DatabaseSync,
	memoryId: string,
	toTopicId: string,
): void {
	const src = db
		.prepare(
			`SELECT topic_id, confidence, assigned_at, session_id FROM memory_topics
			 WHERE memory_id = ? LIMIT 1`,
		)
		.get(memoryId) as {
		topic_id: string;
		confidence: number | null;
		assigned_at: number | null;
		session_id: string | null;
	} | undefined;
	// Delete the source row first so a memory already present in the target just stays.
	db.prepare("DELETE FROM memory_topics WHERE memory_id = ?").run(memoryId);
	if (!src) return;
	db.prepare(
		`INSERT OR REPLACE INTO memory_topics
		   (memory_id, topic_id, confidence, assigned_at, method, session_id)
		 VALUES (?, ?, ?, ?, 'kmeans+tfidf', ?)`,
	).run(
		memoryId,
		toTopicId,
		src.confidence ?? 0,
		src.assigned_at ?? 0,
		src.session_id ?? null,
	);
}

/** Record a member's provenance evolution row (best-effort, non-fatal). */
export function recordEvolution(
	db: DatabaseSync,
	topicId: string,
	memoryId: string,
	sessionId: string | null,
	assignedAt: number,
	method: "merge" | "split",
): void {
	db.prepare(
		`INSERT OR REPLACE INTO topic_evolution
		   (topic_id, memory_id, session_id, assigned_at, method)
		 VALUES (?, ?, ?, ?, ?)`,
	).run(topicId, memoryId, sessionId, assignedAt, method);
}

/** Create a new split topic, returning its id. */
export function createSplitTopic(
	db: DatabaseSync,
	sourceId: string,
	sourceLabel: string,
	now: number,
): string {
	// Two splits in the same millisecond collide on the base id; append a
	// numeric suffix until the id is unused.
	let newId = `topic_${sourceId}_split_${now}`;
	let suffix = 2;
	let exists = db.prepare("SELECT 1 FROM topics WHERE id = ?").get(newId);
	while (exists) {
		newId = `topic_${sourceId}_split_${now}_${suffix}`;
		exists = db.prepare("SELECT 1 FROM topics WHERE id = ?").get(newId);
		suffix++;
	}
	db.prepare(
		`INSERT INTO topics (id, label, term_scores, memory_count, last_updated, cluster_model_built_at)
		 VALUES (?, ?, NULL, 0, ?, NULL)`,
	).run(newId, `${sourceLabel} (split)`, now);
	return newId;
}
