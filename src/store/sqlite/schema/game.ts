/**
 * game.ts — game-mode + perf-samples DDL (extracted from schema.ts). Executed
 * via db.exec in initSchema. No user input reaches this SQL (PREVENT-002).
 */

export const GAME_DDL = `
    -- S27 Task 6: dedup_mirror for space-efficient deduplicated storage.
    -- Each unique content_hash stores its bytes ONCE; raw_transcript rows
    -- reference this table via content_ref instead of storing duplicate content_bytes inline.
    CREATE TABLE IF NOT EXISTS dedup_mirror (
      content_hash    TEXT PRIMARY KEY,
      content_bytes   TEXT NOT NULL,
      ref_count       INTEGER NOT NULL DEFAULT 1,
      first_seen_seq  INTEGER NOT NULL,
      created_at      INTEGER NOT NULL
    );

    -- S30 game mode: global toggle state (single row, id=1). Holds the
    -- game-mode on/off switch, the active visual-effect theme id, and the TUI
    -- widget display mode. Global across all repos; written by /mega-game and
    -- the dashboard settings strip (S32). Local SQLite (PREVENT-PI-004).
    CREATE TABLE IF NOT EXISTS game_state (
      id                 INTEGER PRIMARY KEY CHECK(id = 1),
      game_mode_on       INTEGER NOT NULL DEFAULT 0,
      theme              TEXT NOT NULL DEFAULT 'transparent',
      tui_display_mode   TEXT NOT NULL DEFAULT 'full'
                          CHECK(tui_display_mode IN ('full','minimal'))
    );
    -- S33 game mode: per-repo leaderboard metrics. One row per recorded event
    -- (turn_end / session_compact); leaderboard() derives rankings. 'repos' is
    -- derived (COUNT DISTINCT, never recorded). Local SQLite (PREVENT-PI-004).
    CREATE TABLE IF NOT EXISTS game_scores (
      repo_root TEXT NOT NULL,
      metric    TEXT NOT NULL CHECK(metric IN ('cache','dedupe','turns','repos','mega_cache')),
      ts        INTEGER NOT NULL,
      value     REAL NOT NULL,
      meta      TEXT,
      PRIMARY KEY(repo_root, metric, ts)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_game_scores_metric_ts ON game_scores(metric, ts);

    -- S35 game mode: achievements (9 rows, seeded idempotently on first open).
    -- hidden=1 AND unlocked_at IS NULL => render NOTHING (no teaser). Local SQLite.
    CREATE TABLE IF NOT EXISTS game_achievements (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      description TEXT NOT NULL,
      hidden      INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1)),
      icon        TEXT,
      unlocked_at INTEGER NULL
    ) WITHOUT ROWID;

    -- v0.8.8 Perf dashboard: append-only local instrumentation samples (one row
    -- per turn / provider round-trip / 5s cpu-mem tick / snapshot-recompute).
    -- Drives the dashboard Perf tab. Local SQLite (PREVENT-PI-004); parameterized
    -- accessors in perf-samples.ts (PREVENT-002).
    CREATE TABLE IF NOT EXISTS perf_samples (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      ts    INTEGER NOT NULL,
      kind  TEXT NOT NULL,
      value REAL NOT NULL,
      meta  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_perf_samples_ts ON perf_samples(ts);
    CREATE INDEX IF NOT EXISTS idx_perf_samples_kind_ts ON perf_samples(kind, ts);
`;
