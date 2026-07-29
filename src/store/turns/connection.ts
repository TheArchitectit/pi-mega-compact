/**
 * connection.ts — Private SQLite connection manager for turns.db.
 *
 * Own connection cache (separate from the main sqlite.db cache in store.ts).
 * WAL mode for concurrent read/write. Foreign keys ON.
 *
 * PREVENT-PI-004: node:sqlite in-process only. No network.
 * PREVENT-002: all queries use bound parameters (none in this file — DDL only).
 */

import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

/** Connection cache: stateDir → DatabaseSync. */
const cache = new Map<string, DatabaseSync>();

/** Open (or return cached) turn database connection. */
export function openTurnDb(
	stateDir: string,
	options?: { dbPath?: string; inMemory?: boolean },
): DatabaseSync {
	const resolvedPath =
		options?.inMemory === true
			? ":memory:"
			: (options?.dbPath ?? join(stateDir, "turns.db"));

	// Cache key must distinguish in-memory from file-backed
	const cacheKey = options?.inMemory ? `:memory:${stateDir}` : resolvedPath;

	const cached = cache.get(cacheKey);
	if (cached) return cached;

	const db = new DatabaseSync(resolvedPath);

	// WAL mode for concurrent read/write
	db.exec("PRAGMA journal_mode = WAL");
	// Foreign keys ON
	db.exec("PRAGMA foreign_keys = ON");
	// Busy timeout: 5s
	db.exec("PRAGMA busy_timeout = 5000");

	initSchema(db);

	cache.set(cacheKey, db);
	return db;
}

/** Close and remove from cache. Idempotent. */
export function closeTurnDb(
	stateDir: string,
	options?: { dbPath?: string; inMemory?: boolean },
): void {
	const resolvedPath =
		options?.inMemory === true
			? ":memory:"
			: (options?.dbPath ?? join(stateDir, "turns.db"));

	const cacheKey = options?.inMemory ? `:memory:${stateDir}` : resolvedPath;

	const db = cache.get(cacheKey);
	if (!db) return;
	db.close();
	cache.delete(cacheKey);
}

/** Close all cached connections (test teardown). */
export function closeAllTurnDbs(): void {
	for (const db of cache.values()) {
		try {
			db.close();
		} catch {
			// best-effort
		}
	}
	cache.clear();
}

/** Schema version marker. */
const SCHEMA_VERSION = 1;

/** Create tables + indexes. Idempotent (IF NOT EXISTS). */
function initSchema(db: DatabaseSync): void {
	db.exec(`
    CREATE TABLE IF NOT EXISTS turns_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS turns (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id  TEXT    NOT NULL,
      session_id       TEXT    NOT NULL,
      turn_index       INTEGER NOT NULL,
      role             TEXT    NOT NULL CHECK(role IN ('user','assistant','system','tool')),
      ended_at         INTEGER NOT NULL,
      ctx_tokens       INTEGER,
      ctx_percent      REAL,
      pressure_band    TEXT    CHECK(pressure_band IS NULL OR pressure_band IN ('green','yellow','red')),
      model            TEXT,

      UNIQUE(conversation_id, turn_index)
    );

    CREATE INDEX IF NOT EXISTS idx_turns_conversation
      ON turns(conversation_id, turn_index);
    CREATE INDEX IF NOT EXISTS idx_turns_session
      ON turns(session_id);
    CREATE INDEX IF NOT EXISTS idx_turns_ended_at
      ON turns(ended_at);
    CREATE INDEX IF NOT EXISTS idx_turns_pressure
      ON turns(pressure_band) WHERE pressure_band IS NOT NULL;

    CREATE TABLE IF NOT EXISTS turn_recall (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      turn_id        INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      checkpoint_id  TEXT    NOT NULL,
      score          REAL    NOT NULL,
      source         TEXT    NOT NULL CHECK(source IN ('checkpoint','cluster_summary','memory')),
      raptor_level   INTEGER,

      UNIQUE(turn_id, checkpoint_id)
    );

    CREATE INDEX IF NOT EXISTS idx_turn_recall_turn
      ON turn_recall(turn_id);

    CREATE TABLE IF NOT EXISTS conversation_forks (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_conversation_id  TEXT NOT NULL,
      child_conversation_id   TEXT NOT NULL,
      fork_turn_index         INTEGER NOT NULL,
      created_at              INTEGER NOT NULL,

      UNIQUE(child_conversation_id)
    );

    CREATE INDEX IF NOT EXISTS idx_forks_parent
      ON conversation_forks(parent_conversation_id);
  `);

	// Stamp schema version
	const existing = db
		.prepare("SELECT value FROM turns_meta WHERE key = 'schema_version'")
		.get() as { value: string } | undefined;
	if (!existing) {
		db.prepare(
			"INSERT INTO turns_meta (key, value) VALUES ('schema_version', ?)",
		).run(String(SCHEMA_VERSION));
	}
}
