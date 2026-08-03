/**
 * curation.ts — W2 user curation of the auto-categorized wiki.
 *
 * Persistent rename / merge / split over the `topic_overrides` +
 * `topic_evolution` tables (reserved in the W1.1 schema). Every mutation is
 * atomic (SAVEPOINT) so a partial write never leaks. Host-agnostic (no pi
 * imports); pure local node:sqlite (PREVENT-PI-004), all SQL parameterized
 * (PREVENT-002).
 *
 * Overrides are immutable records written once per (topic_id, kind) — re-runs
 * INSERT OR REPLACE the same key. `topics`/`memory_topics` are writable; the
 * append-only invariant applies only to the `turns` table.
 */

import type { DatabaseSync } from "node:sqlite";
import { openTurnStore, withTx } from "../store/turns/connection.js";
import { getStateDir } from "../store.js";

/** Union of the override kinds a topic may carry (badge provenance). */
export type OverrideKind = "label" | "merge" | "split";

/** Outcome of a curation mutation, shared across rename/merge/split. */
export interface CurationResult {
	ok: boolean;
	topicId: string;
	label: string;
	edited: boolean;
	merged: boolean;
	split: boolean;
}

/** Public surface of the wiki curation store. */
export interface WikiCurationStore {
	renameTopic(topicId: string, label: string): CurationResult;
	mergeTopics(sourceTopicId: string, targetTopicId: string): CurationResult;
	splitTopic(topicId: string, memoryIds: string[]): CurationResult;
	resolveLabel(topicId: string, autoLabel: string): {
		label: string;
		edited: boolean;
	};
	overrideKinds(topicId: string): OverrideKind[];
}

interface LabelRow {
	label: string;
}
interface CountRow {
	c: number;
}

/** Read a topic's current label, or null when the topic does not exist. */
function getTopicLabel(db: DatabaseSync, topicId: string): string | null {
	const r = db
		.prepare("SELECT label FROM topics WHERE id = ?")
		.get(topicId) as LabelRow | undefined;
	return r?.label ?? null;
}

/** Recompute memory_count for a topic from its live member rows. */
function recountTopic(db: DatabaseSync, topicId: string): void {
	const c = db
		.prepare("SELECT COUNT(*) AS c FROM memory_topics WHERE topic_id = ?")
		.get(topicId) as unknown as CountRow;
	db.prepare("UPDATE topics SET memory_count = ? WHERE id = ?").run(c.c, topicId);
}

/** Look up a custom label override; empty/blank means "no override". */
function customLabelOverride(
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
function writeLabelOverride(
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
function moveMemory(db: DatabaseSync, memoryId: string, toTopicId: string): void {
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
function recordEvolution(
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

/** Create a new split topic, returning its pasted provenance + count. */
function createSplitTopic(
	db: DatabaseSync,
	sourceId: string,
	sourceLabel: string,
	now: number,
): string {
	const newId = `topic_${sourceId}_split_${now}`;
	db.prepare(
		`INSERT INTO topics (id, label, term_scores, memory_count, last_updated, cluster_model_built_at)
		 VALUES (?, ?, NULL, 0, ?, NULL)`,
	).run(newId, `${sourceLabel} (split)`, now);
	return newId;
}

/** Open the wiki curation store over the shared turns.db connection. */
export function createWikiCuration(stateDir?: string): WikiCurationStore {
	const db: DatabaseSync = openTurnStore(stateDir ?? getStateDir());
	const now = (): number => Date.now();

	function tryCatchResult(
		res: CurationResult,
		fn: () => CurationResult,
	): CurationResult {
		try {
			return fn();
		} catch {
			return { ...res, ok: false };
		}
	}

	function renameTopic(topicId: string, label: string): CurationResult {
		const base: CurationResult = {
			ok: false,
			topicId,
			label,
			edited: false,
			merged: false,
			split: false,
		};
		if (!getTopicLabel(db, topicId)) return base;
		return tryCatchResult(base, (): CurationResult => {
			withTx(db, () => writeLabelOverride(db, topicId, label, now()));
			return { ...base, ok: true, edited: label.trim() !== "" };
		});
	}

	function mergeTopics(
		sourceTopicId: string,
		targetTopicId: string,
	): CurationResult {
		const base: CurationResult = {
			ok: false,
			topicId: targetTopicId,
			label: "",
			edited: false,
			merged: true,
			split: false,
		};
		if (sourceTopicId === targetTopicId) return base;
		const sourceLabel = getTopicLabel(db, sourceTopicId);
		const targetLabel = getTopicLabel(db, targetTopicId);
		if (!sourceLabel || !targetLabel) return base;
		return tryCatchResult(base, (): CurationResult => {
			withTx(db, () => {
				const t = now();
				const members = db
					.prepare(
						`SELECT memory_id, session_id FROM memory_topics
						 WHERE topic_id = ? ORDER BY memory_id ASC`,
					)
					.all(sourceTopicId) as Array<{
					memory_id: string;
					session_id: string | null;
				}>;
				for (const m of members) {
					moveMemory(db, m.memory_id, targetTopicId);
					recordEvolution(
						db,
						targetTopicId,
						m.memory_id,
						m.session_id,
						t,
						"merge",
					);
				}
				db.prepare(
					`INSERT OR REPLACE INTO topic_overrides
					   (topic_id, kind, merged_into, overridden_at)
					 VALUES (?, 'merge', ?, ?)`,
				).run(sourceTopicId, targetTopicId, t);
				// Reassign the source topic's own membership record away; it now has none.
				db.prepare("DELETE FROM memory_topics WHERE topic_id = ?").run(sourceTopicId);
				// Drop the merged-away source topic so it is hidden from the index.
				db.prepare("DELETE FROM topics WHERE id = ?").run(sourceTopicId);
				recountTopic(db, targetTopicId);
			});
			return {
				...base,
				ok: true,
				label: getTopicLabel(db, targetTopicId) ?? "",
				edited: customLabelOverride(db, targetTopicId) !== null,
			};
		});
	}

	function splitTopic(topicId: string, memoryIds: string[]): CurationResult {
		const base: CurationResult = {
			ok: false,
			topicId,
			label: "",
			edited: false,
			merged: false,
			split: true,
		};
		const sourceLabel = getTopicLabel(db, topicId);
		if (!sourceLabel || memoryIds.length === 0) return base;
		return tryCatchResult(base, (): CurationResult => {
			let newTopicId = "";
			withTx(db, () => {
				const t = now();
				newTopicId = createSplitTopic(db, topicId, sourceLabel, t);
				for (const memoryId of memoryIds) {
					// Only move memories that actually belong to this topic.
					const exists = db
						.prepare(
							"SELECT 1 FROM memory_topics WHERE memory_id = ? AND topic_id = ?",
						)
						.get(memoryId, topicId);
					if (!exists) continue;
					const sessionId = (
						db
							.prepare(
								"SELECT session_id FROM memory_topics WHERE memory_id = ? AND topic_id = ?",
							)
							.get(memoryId, topicId) as { session_id: string | null }
					).session_id;
					moveMemory(db, memoryId, newTopicId);
					recordEvolution(db, newTopicId, memoryId, sessionId, t, "split");
					recordEvolution(db, topicId, memoryId, sessionId, t, "split");
				}
				db.prepare(
					`INSERT OR REPLACE INTO topic_overrides
					   (topic_id, kind, split_from, split_memory_ids, overridden_at)
					 VALUES (?, 'split', ?, ?, ?)`,
				).run(newTopicId, topicId, JSON.stringify(memoryIds), t);
				recountTopic(db, topicId);
				recountTopic(db, newTopicId);
			});
			return {
				...base,
				ok: true,
				topicId: newTopicId,
				label: getTopicLabel(db, newTopicId) ?? "",
			};
		});
	}

	function resolveLabel(topicId: string, autoLabel: string): {
		label: string;
		edited: boolean;
	} {
		const custom = customLabelOverride(db, topicId);
		if (custom) return { label: custom, edited: true };
		return { label: autoLabel, edited: false };
	}

	function overrideKinds(topicId: string): OverrideKind[] {
		const rows = db
			.prepare(
				"SELECT kind FROM topic_overrides WHERE topic_id = ? ORDER BY kind",
			)
			.all(topicId) as Array<{ kind: OverrideKind }>;
		return rows.map((r) => r.kind);
	}

	return {
		renameTopic,
		mergeTopics,
		splitTopic,
		resolveLabel,
		overrideKinds,
	};
}
