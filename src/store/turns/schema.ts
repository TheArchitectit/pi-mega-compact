/**
 * schema.ts — S49 unified turn-store schema (isolated turns.db).
 *
 * RECONCILIATION (s49-turn-db ∪ master): the contract-first shapes from
 * master's SqliteTurnStore (`turns` / `turn_recall` / `conversation_forks` /
 * `session_conversations` / `turns_meta`, with the strict enums the contract
 * `TurnEntry`/`TurnRecallEntry` requires) PLUS the additive shells from this
 * branch's program: `turns.epoch_id` (S50B epoch linking), `pending_fork`
 * (S52 rewind handshake), and `topics` / `memory_topics` (S51 wiki). No other
 * sprint needs a new migration — everything is pre-created here.
 *
 * Idempotent (all `IF NOT EXISTS`). Single statement per `exec` so a failure
 * names the exact table. Pi-agnostic (PREVENT-PI-004: pure node:sqlite).
 * PREVENT-002: DDL only; all runtime queries are parameterized elsewhere.
 */
import type { DatabaseSync } from "node:sqlite";

/** Schema version stamp (written once into turns_meta). */
const SCHEMA_VERSION = 3;

/** Create the unified turn-store schema if absent. Idempotent. */
export function initTurnSchema(db: DatabaseSync): void {
	// Migration: v1 had a pressure_band CHECK constraint that only allowed
	// 'green','yellow','red' — but the runtime sends 'low','medium','high',
	// 'ultra','mega'. Every INSERT failed silently. Since the constraint
	// blocked ALL writes, the turns table is guaranteed empty — safe to
	// drop and recreate with the widened constraint.
	try {
		const tableSql = db
			.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='turns'")
			.get() as { sql?: string } | undefined;
		if (tableSql?.sql && tableSql.sql.includes("'green'") && !tableSql.sql.includes("'low'")) {
			db.exec("DROP TABLE IF EXISTS turns");
		}
	} catch {
		/* non-fatal: table may not exist yet */
	}

	// ── Contract tables (master's SqliteTurnStore shape) ──────────────────
	db.exec(`
    CREATE TABLE IF NOT EXISTS turns_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

	// One row per turn_end. role/source/pressure_band use the contract enums.
	// epoch_id is the S50B additive column (links a turn to the compact epoch).
	db.exec(`
    CREATE TABLE IF NOT EXISTS turns (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT    NOT NULL,
      session_id      TEXT    NOT NULL,
      turn_index      INTEGER NOT NULL,
      role            TEXT    NOT NULL CHECK(role IN ('user','assistant','system','tool')),
      started_at      INTEGER,
      ended_at        INTEGER NOT NULL,
      ctx_tokens      INTEGER,
      ctx_percent     REAL,
      pressure_band   TEXT    CHECK(pressure_band IS NULL OR pressure_band IN ('low','medium','high','ultra','mega','green','yellow','red')),
      model           TEXT,
      epoch_id        TEXT,
      UNIQUE(conversation_id, turn_index)
    )
  `);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_turns_conversation ON turns(conversation_id, turn_index)`,
	);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_turns_ended_at ON turns(ended_at)`);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_turns_pressure ON turns(pressure_band) WHERE pressure_band IS NOT NULL`,
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_turns_epoch ON turns(epoch_id) WHERE epoch_id IS NOT NULL`,
	);

	// Recall provenance — which checkpoints / cluster summaries were injected
	// at a turn, with score + source path. source uses the contract enum.
	db.exec(`
    CREATE TABLE IF NOT EXISTS turn_recall (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      turn_id       INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      checkpoint_id TEXT    NOT NULL,
      score         REAL    NOT NULL,
      source        TEXT    NOT NULL CHECK(source IN ('checkpoint','cluster_summary','memory')),
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

	// Conversation fork registry (contract: ConversationFork).
	db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_forks (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_conversation_id TEXT NOT NULL,
      child_conversation_id  TEXT NOT NULL,
      fork_turn_index        INTEGER NOT NULL,
      created_at             INTEGER NOT NULL,
      UNIQUE(child_conversation_id)
    )
  `);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_forks_parent ON conversation_forks(parent_conversation_id)`,
	);

	// Session → active conversation map (contract: one current conversation per session).
	db.exec(`
    CREATE TABLE IF NOT EXISTS session_conversations (
      session_id      TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL
    )
  `);

	// ── Program additive shells (this branch) ───────────────────────────
	// S52: rewind-and-fork intents written by an external surface (dashboard)
	// and consumed by the host at a safe lifecycle point. Pre-created → S52
	// adds no migration.
	db.exec(`
    CREATE TABLE IF NOT EXISTS pending_fork (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      target_conversation_id TEXT NOT NULL,
      target_turn_id         INTEGER NOT NULL,
      requested_at           INTEGER NOT NULL,
      consumed_at            INTEGER
    )
  `);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_pending_fork_unconsumed ON pending_fork(consumed_at) WHERE consumed_at IS NULL`,
	);

	// S51: auto-categorizing wiki topics (k-means over real embeddings + TF-IDF
	// labels — see docs/specs/s47-auto-categorizing-wiki.md). Pre-created → S51
	// adds no migration. Derived at rebuild time; no seed data.
	db.exec(`
    CREATE TABLE IF NOT EXISTS topics (
      id                     TEXT PRIMARY KEY,
      label                  TEXT NOT NULL,
      term_scores            TEXT,
      memory_count           INTEGER DEFAULT 0,
      last_updated           INTEGER,
      cluster_model_built_at INTEGER
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

	// H1: additive HyDE + recall-quality telemetry columns. ALTER TABLE ADD
	// COLUMN (idempotent via PRAGMA guard) — turns stays append-only; these land
	// in the single INSERT at turn-record time, never via UPDATE.
	const ensureCol = (name: string, ddl: string): void => {
		const has = (
			db.prepare("PRAGMA table_info(turns)").all() as Array<{ name: string }>
		).some((c) => c.name === name);
		if (!has) db.exec(`ALTER TABLE turns ADD COLUMN ${ddl}`);
	};
	ensureCol("hyde_ran", "hyde_ran INTEGER DEFAULT 0");
	ensureCol("hyde_doc", "hyde_doc TEXT DEFAULT ''");
	ensureCol("hyde_raw_count", "hyde_raw_count INTEGER DEFAULT 0");
	ensureCol("hyde_hyde_count", "hyde_hyde_count INTEGER DEFAULT 0");
	ensureCol("hyde_fused_count", "hyde_fused_count INTEGER DEFAULT 0");
	ensureCol("hyde_lift", "hyde_lift REAL DEFAULT 0");
	ensureCol("hyde_generation_ms", "hyde_generation_ms INTEGER DEFAULT 0");
	ensureCol("recall_score", "recall_score REAL DEFAULT 0");
	ensureCol("recall_pass", "recall_pass INTEGER DEFAULT 0");
	ensureCol("recall_relevance", "recall_relevance REAL DEFAULT 0");
	ensureCol("recall_coverage", "recall_coverage REAL DEFAULT 0");
	ensureCol("recall_diversity", "recall_diversity REAL DEFAULT 0");
	ensureCol("recall_specificity", "recall_specificity REAL DEFAULT 0");

	// ── Wiki Revival (Spec 3): user curation + topic evolution ────────
	const sessionCol = (
		db.prepare("PRAGMA table_info(memory_topics)").all() as Array<{ name: string }>
	).some((c) => c.name === "session_id");
	if (!sessionCol) {
		db.exec("ALTER TABLE memory_topics ADD COLUMN session_id TEXT");
	}
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_memory_topics_session ON memory_topics(session_id)`,
	);

	db.exec(`
    CREATE TABLE IF NOT EXISTS topic_overrides (
      topic_id      TEXT NOT NULL,
      kind          TEXT NOT NULL CHECK(kind IN ('label','merge','split')),
      custom_label  TEXT,
      merged_into   TEXT,
      split_from    TEXT,
      split_memory_ids TEXT,
      overridden_at INTEGER NOT NULL,
      PRIMARY KEY (topic_id, kind)
    )
  `);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_topic_overrides_topic ON topic_overrides(topic_id)`,
	);

	db.exec(`
    CREATE TABLE IF NOT EXISTS topic_evolution (
      topic_id     TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      memory_id    TEXT NOT NULL,
      session_id   TEXT,
      assigned_at  INTEGER NOT NULL,
      method       TEXT NOT NULL CHECK(method IN ('kmeans+tfidf','merge','split','manual')),
      PRIMARY KEY (topic_id, memory_id)
    )
  `);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_topic_evolution_topic ON topic_evolution(topic_id, assigned_at)`,
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_topic_evolution_ts   ON topic_evolution(assigned_at)`,
	);

	// Migration: topic_evolution.topic_id FK lacked ON DELETE CASCADE when the
	// table was first created (W1). Without it, deleting a topic (merge source or
	// replaceTopicModel rebuild) throws SQLITE_CONSTRAINT when evolution rows
	// reference it, rolling back the delete. Recreate the table with CASCADE when
	// the live FK definition is missing it. Non-fatal: a failure just leaves the
	// old definition (rebuilds remain best-effort).
	try {
		// PRAGMA foreign_key_list exposes the referenced table + on-delete rule.
		const fkList = db
			.prepare("PRAGMA foreign_key_list(topic_evolution)")
			.all() as Array<{ table: string; from: string; on_delete: string }>;
		const topicFk = fkList.find((f) => f.from === "topic_id");
		if (topicFk && topicFk.on_delete !== "CASCADE") {
			db.exec("DROP TABLE IF EXISTS topic_evolution_mig");
			db.exec(`
	        CREATE TABLE topic_evolution_mig (
	          topic_id     TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
	          memory_id    TEXT NOT NULL,
	          session_id   TEXT,
	          assigned_at  INTEGER NOT NULL,
	          method       TEXT NOT NULL CHECK(method IN ('kmeans+tfidf','merge','split','manual')),
	          PRIMARY KEY (topic_id, memory_id)
	        )
	      `);
			db.exec(
				`INSERT INTO topic_evolution_mig (topic_id, memory_id, session_id, assigned_at, method)
	           SELECT topic_id, memory_id, session_id, assigned_at, method FROM topic_evolution`,
			);
			db.exec("DROP TABLE topic_evolution");
			db.exec("ALTER TABLE topic_evolution_mig RENAME TO topic_evolution");
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_topic_evolution_topic ON topic_evolution(topic_id, assigned_at)`,
			);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_topic_evolution_ts   ON topic_evolution(assigned_at)`,
			);
		}
	} catch {
		/* non-fatal: migration never breaks turn-DB open */
	}

	// Stamp schema version once.
	const existing = db
		.prepare("SELECT value FROM turns_meta WHERE key = 'schema_version'")
		.get() as { value: string } | undefined;
	if (!existing) {
		db.prepare(
			"INSERT INTO turns_meta (key, value) VALUES ('schema_version', ?)",
		).run(String(SCHEMA_VERSION));
	}
}
