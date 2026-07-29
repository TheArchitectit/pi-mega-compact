/**
 * schema.ts — S49 turn-store schema (isolated turns.db).
 *
 * Owns ALL turn-side tables. The `turns` / `turn_recall` / `conversation_branches`
 * shapes mirror S48 exactly (moved OUT of the main sqlite.db — see
 * docs/specs/s49-turn-db-foundation.md). `pending_fork` (S52) and the S51
 * `topics` / `memory_topics` shells are pre-created here so later sprints add
 * NO new migration. All CREATE TABLE IF NOT EXISTS; all queries elsewhere are
 * parameterized (PREVENT-002).
 *
 * Pi-agnostic (PREVENT-PI-004: pure node:sqlite, no network).
 */
import type { DatabaseSync } from "node:sqlite";

/**
 * Create the turn-store schema if absent. Idempotent — safe on every open.
 * Single statement per exec so a failure names the exact table.
 */
export function initTurnSchema(db: DatabaseSync): void {
	// S48 (moved out of main sqlite.db in S49): one row per turn_end. Links a
	// turn to its conversation, session, metrics, and the epoch that compacted
	// it. conversation_id groups turns across pi session resumes.
	db.exec(`
    CREATE TABLE IF NOT EXISTS turns (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      session_id      TEXT NOT NULL,
      turn_index      INTEGER NOT NULL,
      role            TEXT,
      started_at      INTEGER NOT NULL,
      ended_at        INTEGER,
      ctx_tokens      INTEGER,
      ctx_percent     REAL,
      pressure_band   TEXT,
      model_id        TEXT,
      epoch_id        TEXT,
      UNIQUE(session_id, turn_index)
    )
  `);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_turns_conv ON turns(conversation_id, turn_index)`,
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, turn_index)`,
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_turns_epoch ON turns(epoch_id) WHERE epoch_id IS NOT NULL`,
	);

	// S48: recall provenance — which checkpoints/cluster summaries were injected
	// at which turn, their score + source path. Enables recall-to-point replay.
	db.exec(`
    CREATE TABLE IF NOT EXISTS turn_recall (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      turn_id       INTEGER NOT NULL,
      checkpoint_id TEXT NOT NULL,
      score         REAL NOT NULL,
      source        TEXT NOT NULL,
      raptor_level  INTEGER,
      UNIQUE(turn_id, checkpoint_id)
    )
  `);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_turn_recall_turn ON turn_recall(turn_id)`,
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_turn_recall_cp ON turn_recall(checkpoint_id)`,
	);

	// S48: conversation fork registry. A row per fork; the child inherits the
	// parent's recall state at fork_turn_id. Root conversations have no row.
	db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_branches (
      conversation_id        TEXT PRIMARY KEY,
      parent_conversation_id TEXT NOT NULL,
      fork_turn_id           INTEGER NOT NULL,
      created_at             INTEGER NOT NULL
    )
  `);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_conv_branch_parent ON conversation_branches(parent_conversation_id)`,
	);

	// S49: migration bookkeeping. `migrated_from_main = 1` marks the one-time
	// copy main-db → turns.db so it never re-runs (S49B).
	db.exec(`
    CREATE TABLE IF NOT EXISTS turns_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

	// S52 shell: rewind-and-fork intents written by an external surface (the
	// dashboard) and consumed by the host at a safe lifecycle point. Pre-created
	// so S52 adds no migration.
	db.exec(`
    CREATE TABLE IF NOT EXISTS pending_fork (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      target_conversation_id  TEXT NOT NULL,
      target_turn_id          INTEGER NOT NULL,
      requested_at            INTEGER NOT NULL,
      consumed_at             INTEGER
    )
  `);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_pending_fork_unconsumed ON pending_fork(consumed_at) WHERE consumed_at IS NULL`,
	);

	// S51 shells: auto-categorizing wiki topics (k-means over real embeddings +
	// TF-IDF labels — see docs/specs/s47-auto-categorizing-wiki.md). Pre-created
	// so S51 adds no migration. No seed data; derived at rebuild time.
	db.exec(`
    CREATE TABLE IF NOT EXISTS topics (
      id                      TEXT PRIMARY KEY,
      label                   TEXT NOT NULL,
      term_scores             TEXT,
      memory_count            INTEGER DEFAULT 0,
      last_updated            INTEGER,
      cluster_model_built_at  INTEGER
    )
  `);
	db.exec(`
    CREATE TABLE IF NOT EXISTS memory_topics (
      memory_id   TEXT NOT NULL,
      topic_id    TEXT NOT NULL REFERENCES topics(id),
      confidence  REAL,
      assigned_at INTEGER,
      method      TEXT CHECK(method IN ('kmeans+tfidf')),
      PRIMARY KEY (memory_id, topic_id)
    )
  `);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_memory_topics_topic ON memory_topics(topic_id)`,
	);
}
