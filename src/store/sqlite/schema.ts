/**
 * schema.ts — table creation, migrations, `ensureColumn`, PRAGMA setup.
 *
 * Thin pointer: the table DDL is grouped by concern in ./schema/* (core /
 * turns / game / plan-v2) and composed here by initSchema. The schema_version
 * seeding, idempotent column migrations, and achievement seeding stay in this
 * file. Public API (initSchema / ensureColumn) is unchanged for callers.
 */
import type { DatabaseSync } from "node:sqlite";
import { ACHIEVEMENT_DEFS } from "../../game/scoring.js";
import { CORE_DDL } from "./schema/core.js";
import { TURNS_DDL } from "./schema/turns.js";
import { GAME_DDL } from "./schema/game.js";
import { PLAN_V2_DDL } from "./schema/plan-v2.js";

const SCHEMA_VERSION = 5;

/**
 * Add `column` (with `decl`, e.g. "INTEGER") to `table` if it does not already
 * exist. Idempotent: checks PRAGMA table_info first, so it is safe to run on
 * every open. Table/column/decl are code-controlled constants (never user
 * input), so the unavoidable identifier interpolation here does not violate
 * PREVENT-002 (no external data reaches this SQL).
 */
export function ensureColumn(
	db: DatabaseSync,
	table: string,
	column: string,
	decl: string,
): void {
	const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
		name: string;
	}>;
	if (cols.some((c) => c.name === column)) return;
	db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

export function initSchema(db: DatabaseSync): void {
	db.exec(CORE_DDL);
	db.exec(TURNS_DDL);
	db.exec(GAME_DDL);
	db.exec(PLAN_V2_DDL);
	// Idempotent column migrations. `CREATE TABLE IF NOT EXISTS` is a no-op on a
	// pre-existing table, so new columns added to context_chunks after a store was
	// first created (e.g. original_token_estimate in v0.4.2) must be ALTERed in for
	// databases created by an older version — otherwise repoStats()/upsert crash
	// with "no such column" and the extension fails to load. Additive only.
	ensureColumn(db, "context_chunks", "original_token_estimate", "INTEGER");
	// S27 Task 6: content_ref column in raw_transcript for dedup_mirror references.
	ensureColumn(db, "raw_transcript", "content_ref", "TEXT");
	// S20 memory-RAG extension: additive columns for auto-review ops. Idempotent —
	// only alters DBs created by an older version that lack these columns.
	ensureColumn(db, "memories", "category", "TEXT");
	ensureColumn(db, "memories", "target", "TEXT");
	ensureColumn(db, "memories", "last_referenced", "INTEGER");
	ensureColumn(db, "memories", "source_turn", "INTEGER");
	// S25: RAPTOR freshness-guard timestamp. Additive; old DBs have NULL → 0 →
	// treated as stale → flat fallback (safe).
	ensureColumn(db, "raptor_nodes", "built_at", "INTEGER");
	// S42D/QA perf: session-scoped built_at ordering. Must follow ensureColumn
	// above — old DBs already have raptor_nodes without built_at, so CREATE TABLE
	// IF NOT EXISTS is a no-op that doesn't add the column, and moving this index
	// inside the DDL block caused "no such column: built_at" on upgrade.
	db.exec(
		"CREATE INDEX IF NOT EXISTS idx_raptor_session_built ON raptor_nodes(session_id, built_at DESC)",
	);
	// S43: turn_index on raw_transcript so a message points directly at its
	// conversation turn (otherwise it must be inferred from seq ordering). NULL
	// for legacy rows — turns written before S43 have no turn link.
	ensureColumn(db, "raw_transcript", "turn_index", "INTEGER");
	// S43: conversation_id + last_turn_id on session_state (legacy DBs have NULL).
	ensureColumn(db, "session_state", "conversation_id", "TEXT");
	ensureColumn(db, "session_state", "last_turn_id", "INTEGER");
	// S35: idempotent seed of the 9 achievement rows. ON CONFLICT(id) DO
	// NOTHING so a re-open never clobbers an already-unlocked row's
	// unlocked_at. No user input reaches this SQL (PREVENT-002 safe).
	const seedAch = db.prepare(
		`INSERT INTO game_achievements (id, title, description, hidden, icon)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
	);
	for (const d of ACHIEVEMENT_DEFS) {
		seedAch.run(d.id, d.title, d.description, d.hidden ? 1 : 0, d.icon);
	}

	const v = db
		.prepare("SELECT value FROM meta WHERE key='schema_version'")
		.get() as { value: string } | undefined;
	if (!v) {
		db.prepare("INSERT INTO meta(key, value) VALUES(?, ?)").run(
			"schema_version",
			String(SCHEMA_VERSION),
		);
	}
}
