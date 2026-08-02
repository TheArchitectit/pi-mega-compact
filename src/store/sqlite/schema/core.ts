/**
 * core.ts — core table DDL (extracted from schema.ts). Executed via db.exec in
 * initSchema. CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS are
 * idempotent no-ops on re-open. No user input reaches this SQL (PREVENT-002).
 */

export const CORE_DDL = `
    CREATE TABLE IF NOT EXISTS context_chunks (
      id                  TEXT NOT NULL,
      session_id         TEXT NOT NULL,
      region_hash        TEXT,
      content_hash       TEXT,
      content_hash2      TEXT,
      content_hash_version INTEGER,
      normalized_text    TEXT,
      summary            TEXT,
      topic_summary      TEXT,
      summary_hash       TEXT,
      key_decisions      TEXT,           -- JSON array
      next_steps         TEXT,           -- JSON array
      files_modified     TEXT,           -- JSON array
      embedding_blob     BLOB,           -- float32 vector
      token_estimate     INTEGER,
      original_token_estimate INTEGER,    -- dropped region size (tokens saved = orig − stored)
      timestamp          INTEGER,
      dedup_status       TEXT DEFAULT 'active',
      compressed_original BLOB           -- optional DR copy
    );
    -- Primary key is (session_id, id): checkpoint ids are unique per session
    -- (chkpt_001 per session), not globally, so a bare id PK would collide
    -- across sessions on the nextCheckpointId sequence.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_pk
      ON context_chunks(session_id, id);
    CREATE INDEX IF NOT EXISTS idx_chunks_session ON context_chunks(session_id);
    -- S42D/QA perf: session-scoped timestamp ordering so the S25 RAPTOR
    -- freshness guard's MAX(timestamp) (run on every RAPTOR search) is
    -- index-satisfied rather than a full partition scan as checkpoints grow.
    CREATE INDEX IF NOT EXISTS idx_chunks_session_ts
      ON context_chunks(session_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_chunks_region ON context_chunks(region_hash);
    CREATE INDEX IF NOT EXISTS idx_chunks_content ON context_chunks(content_hash);
    -- Partial UNIQUE (QA #1): null content_hash rows never violate the constraint;
    -- ON CONFLICT DO NOTHING makes backfill + L0 inserts safe.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_content_hash
      ON context_chunks(session_id, content_hash) WHERE content_hash IS NOT NULL;

    -- Sprint 11: MinHash signature + LSH bucket tables for L1 near-dup dedup.
    CREATE TABLE IF NOT EXISTS minhash_signatures (
      chunk_id          TEXT NOT NULL,
      session_id        TEXT NOT NULL,
      signature_version INTEGER NOT NULL,
      signatures        TEXT NOT NULL,   -- JSON array of 256 uint32
      PRIMARY KEY (chunk_id, signature_version)
    );
    CREATE INDEX IF NOT EXISTS idx_minhash_session ON minhash_signatures(session_id);

    CREATE TABLE IF NOT EXISTS dedup_lsh_buckets (
      bucket_key        TEXT NOT NULL,
      chunk_id          TEXT NOT NULL,
      session_id        TEXT NOT NULL,
      signature_version INTEGER NOT NULL,
      PRIMARY KEY (bucket_key, chunk_id)
    );
    CREATE INDEX IF NOT EXISTS idx_lsh_bucket ON dedup_lsh_buckets(bucket_key, session_id);

    CREATE TABLE IF NOT EXISTS session_state (
      session_id               TEXT PRIMARY KEY,
      injected_checkpoint_ids TEXT,      -- JSON array
      stored_region_hashes    TEXT,      -- JSON array
      conversation_id         TEXT,       -- S43: groups turns across resumes (/clear → new root)
      last_turn_id            INTEGER     -- S43: most recent turn id (stable fork refs)
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    -- Sprint 13 (RAPTOR): hierarchical summary tree nodes. children are a JSON
    -- array of child node ids (or raw leaf ids at the bottom); embedding_blob
    -- is the node centroid. Additive; retrieval ignores this table until
    -- Sprint 14 promotes RAPTOR out of shadow mode.
    CREATE TABLE IF NOT EXISTS raptor_nodes (
      id            TEXT NOT NULL,
      session_id   TEXT NOT NULL,
      level        INTEGER NOT NULL,
      parent_id    TEXT,
      children     TEXT,           -- JSON array of child ids
      summary      TEXT,
      embedding_blob BLOB,         -- float32 centroid
      quality_marker TEXT DEFAULT 'low',
      token_estimate INTEGER,
      built_at     INTEGER,        -- S25: epoch ms when the tree was built (freshness guard)
      PRIMARY KEY (session_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_raptor_session ON raptor_nodes(session_id);
    CREATE INDEX IF NOT EXISTS idx_raptor_parent ON raptor_nodes(parent_id);

    -- S42D: structured RAPTOR build history. One row per tree build; the
    -- freshness check (buildHistory.ts) uses completed_at + leaf_count to skip
    -- unnecessary rebuilds when the tree is recent and the chunk count is stable.
    CREATE TABLE IF NOT EXISTS raptor_build_history (
      build_id        TEXT PRIMARY KEY,
      session_id      TEXT NOT NULL,
      state_dir       TEXT NOT NULL,
      started_at      INTEGER NOT NULL,
      completed_at    INTEGER NOT NULL,
      node_count      INTEGER NOT NULL,
      leaf_count      INTEGER NOT NULL,
      depth           INTEGER NOT NULL,
      config_json     TEXT NOT NULL,    -- serialized BuildOptions
      coherence_score REAL,            -- avg intra-cluster cosine (post-build)
      timed_out       INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_raptor_build_session ON raptor_build_history(session_id);

    -- Foundation for future features (resume sessions, daily log, lessons
    -- learned). Scaffolded now so all store data lives in SQLite from day one;
    -- population is minimal (touchSession / logDaily on compact) and the full
    -- UI/recall for these lands in later sprints.

    -- Per-session registry (resume + per-repo session history).
    CREATE TABLE IF NOT EXISTS sessions (
      session_id    TEXT PRIMARY KEY,
      repo          TEXT,
      started_at    INTEGER,
      ended_at      INTEGER,
      last_compacted_at INTEGER,
      status        TEXT DEFAULT 'active'
    );

    -- Append-only daily activity log (the "daily log" feature seed).
    CREATE TABLE IF NOT EXISTS daily_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      day           TEXT NOT NULL,     -- YYYY-MM-DD
      session_id    TEXT,
      event         TEXT,             -- e.g. 'compact'
      detail        TEXT,
      tokens_saved  INTEGER DEFAULT 0,
      ts            INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_daily_log_day ON daily_log(day);

    -- Active model/provider for cost estimation + the future multi-repo
    -- dashboard (Phase 5b). One row per (repo, model change); latest wins.
    CREATE TABLE IF NOT EXISTS model_snapshots (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_root     TEXT NOT NULL,
      provider      TEXT NOT NULL,
      provider_name TEXT,
      model_id      TEXT NOT NULL,
      model_name    TEXT,
      input_rate    REAL,          -- USD per input token (Model.cost.input)
      output_rate   REAL,          -- USD per output token (Model.cost.output)
      context_window INTEGER,
      max_tokens    INTEGER,
      reasoning     INTEGER DEFAULT 0,
      captured_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_model_repo ON model_snapshots(repo_root);

    -- Lessons learned (future recall/browse feature seed).
    CREATE TABLE IF NOT EXISTS lessons (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT,
      repo          TEXT,
      lesson        TEXT,
      ts            INTEGER
    );

    -- Durable "save to memory" store (taken over from memory extensions).
    -- One row per saved memory; scoped by repo so memory travels with the
    -- clone. All params are parameterized (PREVENT-002).
    CREATE TABLE IF NOT EXISTS memories (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      repo              TEXT,
      kind              TEXT DEFAULT 'note',   -- note | fact | decision | preference
      content           TEXT NOT NULL,
      tags              TEXT,                   -- JSON array of strings
      created_at        INTEGER,
      last_recalled_at  INTEGER,
      -- S20 memory-RAG extension (auto-review add/replace/remove ops).
      category          TEXT,                   -- typed bucket, e.g. decision | fact | preference
      target            TEXT,                   -- optional subject/scope this memory targets
      last_referenced   INTEGER,               -- last time memory was referenced by recall (epoch s)
      source_turn       INTEGER                -- conversation turn that produced this memory
    );
    CREATE INDEX IF NOT EXISTS idx_memories_repo ON memories(repo);

    -- FTS5 trigram virtual table (Sprint 9+ pg_trgm-equivalent verification).
    CREATE VIRTUAL TABLE IF NOT EXISTS context_chunks_trgm USING fts5(
      id UNINDEXED,
      normalized_text,
      tokenize='trigram'
    );

    -- S27: durable raw-transcript mirror (MEGACOMPACT_DB_MIRROR). Appended
    -- RAW message bytes per session so a compacted window can be rehydrated
    -- from the local store instead of the pi runtime transcript (which is
    -- trimmed). PK is (content_hash, session_id) — NOT content_hash alone —
    -- so identical content in different sessions never collides. Additive:
    -- CREATE TABLE IF NOT EXISTS leaves existing DBs untouched on open until
    -- the S27 mirror flag is flipped on. All queries parameterized (PREVENT-002).
    CREATE TABLE IF NOT EXISTS raw_transcript (
      content_hash      TEXT NOT NULL,
      session_id        TEXT NOT NULL,
      seq               INTEGER NOT NULL,
      role              TEXT NOT NULL,
      content_bytes     TEXT NOT NULL,
      tool_name         TEXT,
      message_timestamp INTEGER,          -- ORIGINAL msg ts at append, NOT served
      checkpoint_epoch  TEXT NOT NULL,
      PRIMARY KEY (content_hash, session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_rt_session_seq ON raw_transcript(session_id, seq);
    CREATE INDEX IF NOT EXISTS idx_rt_epoch ON raw_transcript(checkpoint_epoch);

    -- S27: checkpoint-epoch registry. One row per compaction epoch; the
    -- summary_message_text is the verbatim system message that replaced the
    -- trimmed prefix. Informational bookkeeping (the raw_transcript rows are
    -- authoritative); refresh-safe via ON CONFLICT(epoch_id) DO UPDATE.
    CREATE TABLE IF NOT EXISTS checkpoint_epochs (
      epoch_id             TEXT PRIMARY KEY,
      session_id           TEXT NOT NULL,
      started_seq          INTEGER NOT NULL,
      committed_seq        INTEGER NOT NULL,
      summary_message_text TEXT NOT NULL,
      cut_index            INTEGER NOT NULL,
      checkpoint_id        TEXT NOT NULL,
      created_at           INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_epoch_session ON checkpoint_epochs(session_id, created_at DESC);
`;
