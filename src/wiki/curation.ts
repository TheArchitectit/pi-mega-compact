/**
 * curation.ts — W2 user curation of the auto-categorized wiki (factory shell).
 *
 * Persist rename / merge / split over the `topic_overrides` +
 * `topic_evolution` tables (reserved in the W1.1 schema). Every mutation is
 * atomic (SAVEPOINT via withTx) so a partial write never leaks. The DB
 * primitives live in curation-helpers.ts; this file owns the three
 * transactions (renameTopic / mergeTopics / splitTopic) + label resolution.
 *
 * Host-agnostic (no pi imports); pure local node:sqlite (PREVENT-PI-004), all
 * SQL parameterized (PREVENT-002). Overrides are immutable per (topic_id, kind).
 * `topics`/`memory_topics` are writable; the append-only invariant applies only
 * to the `turns` table.
 */

import type { DatabaseSync } from "node:sqlite";
import { openTurnStore, withTx } from "../store/turns/connection.js";
import { getStateDir } from "../store.js";
import {
	getTopicLabel,
	recountTopic,
	customLabelOverride,
	writeLabelOverride,
	moveMemory,
	recordEvolution,
	createSplitTopic,
} from "./curation-helpers.js";

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
				db.prepare("DELETE FROM memory_topics WHERE topic_id = ?").run(sourceTopicId);
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
					const row = db
						.prepare(
							"SELECT session_id FROM memory_topics WHERE memory_id = ? AND topic_id = ?",
						)
						.get(memoryId, topicId) as { session_id: string | null } | undefined;
					if (!row) continue;
					moveMemory(db, memoryId, newTopicId);
					recordEvolution(db, newTopicId, memoryId, row.session_id, t, "split");
					recordEvolution(db, topicId, memoryId, row.session_id, t, "split");
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
