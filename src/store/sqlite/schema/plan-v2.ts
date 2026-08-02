/**
 * plan-v2.ts — PLAN_V2 Phase 2/3 message-separation, cache-striping, and
 * context-health DDL (extracted from schema.ts). Executed via db.exec in
 * initSchema. No user input reaches this SQL (PREVENT-002).
 */

export const PLAN_V2_DDL = `
    -- A1 PLAN_V2 Phase 2: Message Separation tables (SCHEMA_VERSION 3).
    -- Stable conversation thread: user + assistant turns ONLY. Tool results are
    -- stored in tool_results to keep the conversation thread cache-predictable.
    -- Parameterized queries only (PREVENT-002). CREATE TABLE IF NOT EXISTS is
    -- a no-op on re-open — no migration needed.
    CREATE TABLE IF NOT EXISTS conversation_thread (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      role            TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content         TEXT NOT NULL,
      turn_index      INTEGER NOT NULL,
      timestamp       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conv_thread_conv_turn
      ON conversation_thread(conversation_id, turn_index);

    -- Volatile tool results: appended at END so they never disrupt the
    -- conversation thread prefix (the prompt-cache-friendly prefix).
    CREATE TABLE IF NOT EXISTS tool_results (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      tool_call_id    TEXT NOT NULL,
      tool_result     TEXT NOT NULL,
      turn_index      INTEGER NOT NULL,
      timestamp       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tool_results_conv_turn
      ON tool_results(conversation_id, turn_index);

    -- A2 PLAN_V2 Phase 3: Vector-Aware Cache Striping (SCHEMA_VERSION 4).
    -- Cache stripe assignments: maps each context chunk to a cache stability
    -- tier (stripe). Layer 0=permanent, 1=epoch, 2=topic, 3=thread, 4=volatile.
    -- stability is the composite score (0.0-1.0) from computeStabilityScore.
    -- Primary key is (chunk_id, epoch_id) so the same chunk can be reassigned
    -- across epochs without conflict. See cache-stripe.ts for scoring details.
    -- Parameterized queries only (PREVENT-002). IF NOT EXISTS is a no-op on re-open.
    CREATE TABLE IF NOT EXISTS cache_stripes (
      chunk_id      TEXT NOT NULL,
      stripe        INTEGER NOT NULL,
      stability     REAL NOT NULL,
      assigned_at   INTEGER NOT NULL,
      epoch_id      TEXT,
      PRIMARY KEY (chunk_id, epoch_id)
    );
    CREATE INDEX IF NOT EXISTS idx_cs_stripe_stability
      ON cache_stripes(stripe, stability DESC);

    -- Embedding computation cache: avoids re-embedding content every time
    -- stability scores are recomputed across epochs. Keyed by content_hash
    -- (SHA-256 64-hex-char string). Embeddings are serialized via
    -- Float64Array-to-Buffer to match the embedding_blob convention.
    CREATE TABLE IF NOT EXISTS embedding_cache (
      content_hash  TEXT PRIMARY KEY,
      embedding     BLOB NOT NULL,
      computed_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_emb_cache_computed
      ON embedding_cache(computed_at DESC);

    -- A2 PLAN_V2 Phase 2 (SCHEMA_VERSION 5): Context Health metrics. One row
    -- per turn recorded during compactSession. drift_score / output_quality /
    -- error_score / cache_health / cache_poison / composite are the core signal
    -- columns; repetition_ratio / coherence_score / prefix_hash are optional
    -- enrichment. Parameterized accessors in context-health.ts (PREVENT-002).
    CREATE TABLE IF NOT EXISTS context_health (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      ts              INTEGER NOT NULL,
      turn_index      INTEGER NOT NULL,
      session_id      TEXT NOT NULL,
      drift_score     REAL,
      output_quality  REAL,
      error_score     REAL,
      cache_health    REAL,
      cache_poison    REAL,
      composite       REAL,
      model_id        TEXT,
      repetition_ratio REAL,
      coherence_score REAL,
      prefix_hash     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ctx_health_ts
      ON context_health(ts);
    CREATE INDEX IF NOT EXISTS idx_ctx_health_session
      ON context_health(session_id, ts);

    -- A2 PLAN_V2 Phase 2 (SCHEMA_VERSION 5): Cache poison advisory events.
    -- Emitted when cache corruption / inconsistency is detected at a given
    -- layer during compactSession. Drives the R13 advisory channel redesign.
    -- Parameterized accessors in context-health.ts (PREVENT-002).
    CREATE TABLE IF NOT EXISTS cache_poison_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL,
      turn_index  INTEGER NOT NULL,
      session_id  TEXT NOT NULL,
      layer       INTEGER,
      detail      TEXT,
      severity    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cache_poison_ts
      ON cache_poison_events(ts);
`;
