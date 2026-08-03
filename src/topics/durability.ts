/**
 * durability.ts — W5 full user-override replay over the topic tables.
 *
 * `replaceTopicModel` rebuilds `topics` + `memory_topics` from scratch, which
 * would silently discard user curation (rename / merge / split). The small
 * `applyOverridesAfterRebuild` in store.ts only replays label overrides; this
 * module is the comprehensive replay — it replays label, merge, AND split
 * overrides in chronological (`overridden_at`) order so the topic model stays
 * durable across rebuilds and the incremental-assignment path (wiki/incremental.ts).
 *
 * Host-agnostic (no pi imports), pure local node:sqlite (PREVENT-PI-004), all
 * SQL parameterized (PREVENT-002). Every override step is wrapped in try/catch
 * and best-effort — a single bad row never aborts the rest of the replay.
 */
import type { DatabaseSync } from "node:sqlite";
import { withTx } from "../store/turns/connection.js";
import {
	moveMemory,
	recordEvolution,
} from "../wiki/curation-helpers.js";

/** One `topic_overrides` row ordered by override time. */
interface OverrideRow {
	topic_id: string;
	kind: "label" | "merge" | "split";
	custom_label: string | null;
	merged_into: string | null;
	split_from: string | null;
	split_memory_ids: string | null;
	merged_memory_ids: string | null;
}

/** Read all overrides in chronological order (oldest first). */
function loadOverrides(db: DatabaseSync): OverrideRow[] {
	return db
		.prepare(
			`SELECT topic_id, kind, custom_label, merged_into, split_from, split_memory_ids, merged_memory_ids
			 FROM topic_overrides ORDER BY overridden_at ASC`,
		)
		.all() as unknown as OverrideRow[];
}

/** Does a topic row with this id exist? */
function topicExists(db: DatabaseSync, topicId: string): boolean {
	return !!db.prepare("SELECT 1 FROM topics WHERE id = ?").get(topicId);
}

/** All existing topic ids (for nearest-by-label-overlap fallback). */
function allTopicIds(db: DatabaseSync): string[] {
	const rows = db
		.prepare("SELECT id FROM topics")
		.all() as Array<{ id: string }>;
	return rows.map((r) => r.id);
}

/**
 * When a curated target topic dissolved in a rebuild, fall back to whichever
 * surviving topic shares the most label tokens, so merged memories still land
 * somewhere sensible. Returns "" when no overlap candidate exists.
 */
function nearestByLabelOverlap(db: DatabaseSync, label: string): string {
	const tokens = new Set(
		label.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0),
	);
	if (tokens.size === 0) return "";
	let bestId = "";
	let bestOverlap = 0;
	for (const id of allTopicIds(db)) {
		const r = db
			.prepare("SELECT label FROM topics WHERE id = ?")
			.get(id) as { label: string } | undefined;
		if (!r) continue;
		const labelTokens = new Set(
			r.label.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0),
		);
		let overlap = 0;
		for (const t of tokens) if (labelTokens.has(t)) overlap++;
		if (overlap > bestOverlap) {
			bestOverlap = overlap;
			bestId = id;
		}
	}
	return bestOverlap > 0 ? bestId : "";
}

/**
 * Replay a single merge override: force the source topic's merged members back
 * into the target topic (or its nearest-by-label-overlap survivor if the target
 * dissolved). Member ids are read from `merged_memory_ids` on the override row
 * (W5 — survives `replaceTopicModel` because `topic_overrides` is never wiped).
 * Falls back to `topic_evolution` for pre-W5 merges (only works when evolution
 * rows are intact, i.e. the incremental path or no rebuild has fired since).
 */
function replayMerge(
	db: DatabaseSync,
	row: OverrideRow,
): void {
	const target = row.merged_into;
	if (!target) return;
	// Primary source: merged_memory_ids on the override row itself.
	let memoryIds: string[] = [];
	if (row.merged_memory_ids) {
		try {
			const parsed = JSON.parse(row.merged_memory_ids) as unknown;
			if (Array.isArray(parsed)) {
				memoryIds = parsed.filter(
					(m): m is string => typeof m === "string",
				);
			}
		} catch {
			/* non-fatal: malformed member list falls through to evolution */
		}
	}
	// Fallback: topic_evolution rows (only intact when no rebuild has fired).
	let members: Array<{ memory_id: string; session_id: string | null }> = [];
	if (memoryIds.length === 0) {
		members = db
			.prepare(
				`SELECT memory_id, session_id FROM topic_evolution
				 WHERE topic_id = ? AND method = 'merge' ORDER BY memory_id ASC`,
			)
			.all(target) as Array<{ memory_id: string; session_id: string | null }>;
		if (members.length === 0) return;
	} else {
		// Resolve session_id for each member from its current assignment (if any).
		for (const mid of memoryIds) {
			const r = db
				.prepare(
					"SELECT session_id FROM memory_topics WHERE memory_id = ? LIMIT 1",
				)
				.get(mid) as { session_id: string | null } | undefined;
			members.push({
				memory_id: mid,
				session_id: r?.session_id ?? null,
			});
		}
	}
	let dest = target;
	if (!topicExists(db, target)) {
		dest = nearestByLabelOverlap(db, target);
		if (!dest) return;
	}
	withTx(db, () => {
		const t = Date.now();
		for (const m of members) {
			moveMemory(db, m.memory_id, dest);
			recordEvolution(db, dest, m.memory_id, m.session_id, t, "merge");
		}
	});
}

/**
 * Replay a single split override: recreate the split topic (if the source
 * still exists or the memories are somewhere in the model) and move the listed
 * memory ids into it.
 */
function replaySplit(db: DatabaseSync, row: OverrideRow): void {
	let memoryIds: string[] = [];
	if (row.split_memory_ids) {
		try {
			const parsed = JSON.parse(row.split_memory_ids) as unknown;
			if (Array.isArray(parsed)) {
				memoryIds = parsed.filter(
					(m): m is string => typeof m === "string",
				);
			}
		} catch {
			/* non-fatal: malformed member list is skipped */
		}
	}
	if (memoryIds.length === 0 || topicExists(db, row.topic_id)) return;
	// Recreate the split topic reusing its original id + source label.
	const sourceLabel =
		row.split_from && topicExists(db, row.split_from)
			? (db.prepare("SELECT label FROM topics WHERE id = ?")
				.get(row.split_from) as { label: string }).label
			: row.topic_id;
	withTx(db, () => {
		db.prepare(
			`INSERT INTO topics (id, label, term_scores, memory_count, last_updated, cluster_model_built_at)
			 VALUES (?, ?, NULL, 0, ?, NULL)`,
		).run(row.topic_id, `${sourceLabel} (split)`, Date.now());
		const t = Date.now();
		// Only memories that still exist in the model move; drop the rest.
		for (const memoryId of memoryIds) {
			const src = db
				.prepare(
					"SELECT session_id FROM memory_topics WHERE memory_id = ? LIMIT 1",
				)
				.get(memoryId) as { session_id: string | null } | undefined;
			if (!src) continue;
			moveMemory(db, memoryId, row.topic_id);
			recordEvolution(db, row.topic_id, memoryId, src.session_id, t, "split");
		}
	});
}

/**
 * Apply all user overrides (label / merge / split) after a topic-model rebuild,
 * in `overridden_at` order. Non-fatal end-to-end: each override is isolated so a
 * single corruption never aborts the replay. This is the W5 high-fidelity replay (feature A).
 */
export function applyFullOverridesAfterRebuild(db: DatabaseSync): void {
	if (!db) return;
	let rows: OverrideRow[];
	try {
		rows = loadOverrides(db);
	} catch {
		return; // non-fatal: no overrides table / unreadable → nothing to replay
	}
	for (const row of rows) {
		try {
			if (row.kind === "label") {
				// Same fast path as store.applyOverridesAfterRebuild, inline here
				// so the full replay owns label + merge + split in one pass.
				if (row.custom_label && row.custom_label.trim() !== "") {
					db.prepare("UPDATE topics SET label = ? WHERE id = ?").run(
						row.custom_label,
						row.topic_id,
					);
				}
			} else if (row.kind === "merge") {
				replayMerge(db, row);
			} else if (row.kind === "split") {
				replaySplit(db, row);
			}
		} catch {
			/* non-fatal: skip this override, keep replaying the rest */
		}
	}
}
