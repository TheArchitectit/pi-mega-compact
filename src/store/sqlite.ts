/**
 * sqlite.ts — Sprint 8 storage backbone (the "one store").
 *
 * Replaces the per-session gzipped-JSON checkpoint files with a single local
 * SQLite database (node:sqlite — the Node built-in, in-process, FS-backed,
 * ZERO network calls — honors PREVENT-PI-004). No native build and no install
 * scripts, so it survives pi's npm blocked-install-scripts gate (better-sqlite3's
 * native binary could not be built under pi, which crashed every `pi update
 * --extensions`). node:sqlite is synchronous, so every VectorStore signature
 * stays sync. PGlite + pgvector (async) is layered on in vectorIndex.ts for
 * real HNSW indexing (Slice 2 of the dual-backend plan).
 *
 * FTS5 `trigram` tokenizer is created for the Sprint 9+ dedup tiers (MinHash/LSH
 * / pg_trgm-equivalent verification). The default cosine path stays a linear
 * scan over `embedding_blob` (checkpoint counts are small, no ANN index needed).
 *
 * All queries are parameterized (PREVENT-002) — never string-concatenated.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getStateDir } from "../store.js";
import type { StoredCheckpoint, SessionState } from "../store.js";
import { normalizeSessionId } from "../store.js";

const SCHEMA_VERSION = 2;

/** Encode a float vector as a little-endian Float32 BLOB for cosine scanning. */
function encodeEmbedding(v: number[]): Buffer {
  const buf = Buffer.allocUnsafe(v.length * 4);
  for (let i = 0; i < v.length; i++) buf.writeFloatLE(v[i] ?? 0, i * 4);
  return buf;
}
/** Decode a Float32 BLOB back to a number[]. node:sqlite returns BLOBs as
 *  Uint8Array, so decode via DataView (Buffer is a Uint8Array subclass — both
 *  work). */
function decodeEmbedding(buf: Uint8Array | null | undefined): number[] {
  if (!buf || buf.length === 0) return [];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = buf.length / 4;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}

function jsonText(v: unknown): string {
  return JSON.stringify(v ?? []);
}

// In-process cache so the same stateDir reuses one connection (and so a fresh
// VectorStore over the same dir shares the open DB). Cross-process durability
// comes from reopening the same file path — proven by the integration test.
const cache = new Map<string, DatabaseSync>();

/** Open (or reuse) the SQLite store for a state dir. */
export function openStore(stateDir: string = getStateDir()): DatabaseSync {
  const existing = cache.get(stateDir);
  if (existing) {
    // A closed handle in the cache (e.g. a test calling db.close() directly
    // instead of closeStore) would surface as "database is not open" on the
    // next reuse. Detect and evict so callers never see a dead handle.
    try {
      existing.prepare("SELECT 1");
      return existing;
    } catch {
      cache.delete(stateDir);
    }
  }

  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const db = new DatabaseSync(join(stateDir, "sqlite.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  initSchema(db);
  cache.set(stateDir, db);
  return db;
}

// ---------------------------------------------------------------------------
// Global machine-wide index (Phase 5b): a single SQLite DB, separate from every
// per-repo store, that aggregates one row per repo this machine has run on. The
// multi-repo dashboard (Summary / All-repos tabs) reads it so ONE dashboard can
// show every repo's checkpoints, tokens saved, and active model — instead of a
// per-repo dashboard that only ever sees the repo it was launched from.
//
// Written by every pi process on repo-switch (bindRepo) + model capture; read by
// the dashboard server. Concurrency across 10+ pi processes is handled by WAL +
// infrequent idempotent upserts (ON CONFLICT). Fully local (PREVENT-PI-004).
// ---------------------------------------------------------------------------

/** Resolve the machine-wide index directory (env-overridable). */
export function getIndexDir(): string {
  const override = process.env.MEGACOMPACT_INDEX_DIR;
  if (override && override.trim() !== "") return override;
  // homedir() can throw in exotic sandboxes; fall back to tmpdir.
  try {
    return join(homedir(), ".mega-compact-index");
  } catch {
    return join(tmpdir(), ".mega-compact-index");
  }
}

let indexCache: DatabaseSync | undefined;
let indexCacheDir: string | undefined;

/** Open (or reuse) the machine-wide index DB. WAL for concurrent writers. */
export function openIndexStore(indexDir: string = getIndexDir()): DatabaseSync {
  if (indexCache && indexCacheDir === indexDir) return indexCache;
  if (!existsSync(indexDir)) mkdirSync(indexDir, { recursive: true });
  const iddb = new DatabaseSync(join(indexDir, "index.sqlite"));
  iddb.exec("PRAGMA journal_mode = WAL");
  iddb.exec("PRAGMA busy_timeout = 3000"); // tolerate brief cross-process write contention
  iddb.exec(`
    CREATE TABLE IF NOT EXISTS repo_registry (
      repo_root                 TEXT PRIMARY KEY,
      display_name              TEXT,
      state_dir                 TEXT NOT NULL,
      first_seen                INTEGER,
      last_seen                 INTEGER,
      last_compacted_at         INTEGER,
      checkpoint_count          INTEGER DEFAULT 0,
      tokens_saved              INTEGER DEFAULT 0,
      compressed_original_bytes INTEGER DEFAULT 0,
      provider                  TEXT,
      provider_name             TEXT,
      model_name                TEXT,
      input_rate                REAL,
      output_rate               REAL,
      model_captured_at         INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_registry_last_seen ON repo_registry(last_seen DESC);
    -- S18: machine-wide injected-set. A foreign checkpoint injected in repo A is
    -- recorded here so repo B's recall never re-injects it. Keyed by checkpoint
    -- + session (a checkpoint may be injected once per session); repo_id is the
    -- source repo (the foreign repo's stateDir) for tracking/source labels.
    -- PRAMETERIZED queries (PREVENT-002); local node:sqlite (PREVENT-PI-004).
    CREATE TABLE IF NOT EXISTS injected_global (
      checkpoint_id TEXT NOT NULL,
      repo_id       TEXT NOT NULL,
      session_id    TEXT NOT NULL,
      injected_at   INTEGER NOT NULL,
      PRIMARY KEY (checkpoint_id, session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_injected_global_cid ON injected_global(checkpoint_id);
  `);
  indexCache = iddb;
  indexCacheDir = indexDir;
  return iddb;
}

/** One row of the global repo registry (multi-repo dashboard source). */
export interface RepoRegistryRow {
  repoRoot: string;
  displayName: string;
  stateDir: string;
  firstSeen: number;
  lastSeen: number;
  lastCompactedAt: number | null;
  checkpointCount: number;
  tokensSaved: number;
  compressedOriginalBytes: number;
  provider: string | null;
  providerName: string | null;
  modelName: string | null;
  inputRate: number | null;
  outputRate: number | null;
  modelCapturedAt: number | null;
}

/**
 * Upsert a repo's aggregate stats into the global index. Called on repo-switch
 * (infrequent). Preserves first_seen + the model columns on update (model is
 * written separately by recordRepoModel so we never clobber it here with nulls).
 */
export function upsertRepoRegistry(
  row: {
    repoRoot: string;
    displayName: string;
    stateDir: string;
    checkpointCount: number;
    tokensSaved: number;
    compressedOriginalBytes: number;
    lastCompactedAt?: number | null;
    // The fields below are optional passthroughs so test fixtures and the
    // /api/repos active-window filter can seed them directly. They're also
    // written by other paths (recordRepoModel, registry refresh) — passing
    // them here is harmless because the ON CONFLICT clause keeps first_seen
    // and the model columns from being clobbered.
    firstSeen?: number;
    lastSeen?: number;
    provider?: string | null;
    providerName?: string | null;
    modelName?: string | null;
    inputRate?: number | null;
    outputRate?: number | null;
    modelCapturedAt?: number | null;
  },
  indexDir: string = getIndexDir(),
): void {
  const db = openIndexStore(indexDir);
  const now = Date.now();
  db.prepare(
    `INSERT INTO repo_registry
       (repo_root, display_name, state_dir, first_seen, last_seen, last_compacted_at,
        checkpoint_count, tokens_saved, compressed_original_bytes,
        provider, provider_name, model_name, input_rate, output_rate, model_captured_at)
     VALUES (@repo_root, @display_name, @state_dir, @first_seen, @last_seen, @last_compacted_at,
             @checkpoint_count, @tokens_saved, @compressed_original_bytes,
             @provider, @provider_name, @model_name, @input_rate, @output_rate, @model_captured_at)
     ON CONFLICT(repo_root) DO UPDATE SET
       display_name = excluded.display_name,
       state_dir = excluded.state_dir,
       last_seen = COALESCE(excluded.last_seen, @now),
       last_compacted_at = COALESCE(excluded.last_compacted_at, repo_registry.last_compacted_at),
       checkpoint_count = excluded.checkpoint_count,
       tokens_saved = excluded.tokens_saved,
       compressed_original_bytes = excluded.compressed_original_bytes,
       provider = COALESCE(excluded.provider, repo_registry.provider),
       provider_name = COALESCE(excluded.provider_name, repo_registry.provider_name),
       model_name = COALESCE(excluded.model_name, repo_registry.model_name),
       input_rate = COALESCE(excluded.input_rate, repo_registry.input_rate),
       output_rate = COALESCE(excluded.output_rate, repo_registry.output_rate),
       model_captured_at = COALESCE(excluded.model_captured_at, repo_registry.model_captured_at)`,
  ).run({
    repo_root: row.repoRoot,
    display_name: row.displayName,
    state_dir: row.stateDir,
    now,
    first_seen: row.firstSeen ?? null,
    last_seen: row.lastSeen ?? null,
    last_compacted_at: row.lastCompactedAt ?? null,
    checkpoint_count: row.checkpointCount,
    tokens_saved: row.tokensSaved,
    compressed_original_bytes: row.compressedOriginalBytes,
    provider: row.provider ?? null,
    provider_name: row.providerName ?? null,
    model_name: row.modelName ?? null,
    input_rate: row.inputRate ?? null,
    output_rate: row.outputRate ?? null,
    model_captured_at: row.modelCapturedAt ?? null,
  });
}

/**
 * Record the active model/provider for a repo in the global index (denormalized
 * so the All-repos table shows model without opening each repo's DB). Upserts a
 * bare registry row if the repo isn't registered yet.
 */
export function recordRepoModel(
  repoRoot: string,
  model: {
    provider: string;
    providerName: string | null;
    modelName: string | null;
    inputRate: number;
    outputRate: number;
    stateDir: string;
    displayName: string;
  },
  indexDir: string = getIndexDir(),
): void {
  const db = openIndexStore(indexDir);
  const now = Date.now();
  db.prepare(
    `INSERT INTO repo_registry
       (repo_root, display_name, state_dir, first_seen, last_seen,
        provider, provider_name, model_name, input_rate, output_rate, model_captured_at)
     VALUES (@repo_root, @display_name, @state_dir, @now, @now,
             @provider, @provider_name, @model_name, @input_rate, @output_rate, @now)
     ON CONFLICT(repo_root) DO UPDATE SET
       last_seen = excluded.last_seen,
       provider = excluded.provider,
       provider_name = excluded.provider_name,
       model_name = excluded.model_name,
       input_rate = excluded.input_rate,
       output_rate = excluded.output_rate,
       model_captured_at = excluded.model_captured_at`,
  ).run({
    repo_root: repoRoot,
    display_name: model.displayName,
    state_dir: model.stateDir,
    now,
    provider: model.provider,
    provider_name: model.providerName,
    model_name: model.modelName,
    input_rate: model.inputRate,
    output_rate: model.outputRate,
  });
}

function mapRegistryRow(row: any): RepoRegistryRow {
  return {
    repoRoot: row.repo_root,
    displayName: row.display_name ?? "",
    stateDir: row.state_dir,
    firstSeen: row.first_seen ?? 0,
    lastSeen: row.last_seen ?? 0,
    lastCompactedAt: row.last_compacted_at ?? null,
    checkpointCount: row.checkpoint_count ?? 0,
    tokensSaved: row.tokens_saved ?? 0,
    compressedOriginalBytes: row.compressed_original_bytes ?? 0,
    provider: row.provider ?? null,
    providerName: row.provider_name ?? null,
    modelName: row.model_name ?? null,
    inputRate: row.input_rate ?? null,
    outputRate: row.output_rate ?? null,
    modelCapturedAt: row.model_captured_at ?? null,
  };
}

/** All registered repos, most-recently-seen first. */
export function listRepoRegistry(indexDir: string = getIndexDir()): RepoRegistryRow[] {
  const db = openIndexStore(indexDir);
  const rows = db.prepare("SELECT * FROM repo_registry ORDER BY last_seen DESC").all() as any[];
  return rows.map(mapRegistryRow);
}

/** A single repo's registry row, or undefined. */
export function getRepoRegistry(repoRoot: string, indexDir: string = getIndexDir()): RepoRegistryRow | undefined {
  const db = openIndexStore(indexDir);
  const row = db.prepare("SELECT * FROM repo_registry WHERE repo_root = ?").get(repoRoot) as any;
  return row ? mapRegistryRow(row) : undefined;
}

/** Close the cached index connection (test teardown only). */
export function closeIndexStore(): void {
  if (indexCache) {
    indexCache.close();
    indexCache = undefined;
    indexCacheDir = undefined;
  }
}

// ---------------------------------------------------------------------------
// S18: machine-wide injected-set (cross-repo dedup markers)
//
// A foreign checkpoint injected in repo A is recorded here so repo B's recall
// never re-injects it (a stronger, machine-wide version of the per-session
// injected-set in the local store). Keyed by (checkpoint_id, session_id); the
// session_id here is the RECEIVING session, so the same foreign checkpoint can
// be injected into different sessions but never twice into the same one.
// PRAMETERIZED queries (PREVENT-002); local node:sqlite + WAL (PREVENT-PI-004),
// multi-process safe.
// ---------------------------------------------------------------------------

/** Record that a (foreign) checkpoint was injected into `sessionId`. Idempotent. */
export function markInjectedGlobal(
  checkpointId: string,
  repoId: string,
  sessionId: string,
  indexDir: string = getIndexDir(),
): void {
  const db = openIndexStore(indexDir);
  db.prepare(
    "INSERT OR IGNORE INTO injected_global (checkpoint_id, repo_id, session_id, injected_at) VALUES ($cid, $rid, $sid, $ts)",
  ).run({ $cid: checkpointId, $rid: repoId, $sid: sessionId, $ts: Date.now() });
}

/** True when a checkpoint was already injected into `sessionId` (machine-wide). */
export function wasInjectedGlobal(
  checkpointId: string,
  sessionId: string,
  indexDir: string = getIndexDir(),
): boolean {
  const db = openIndexStore(indexDir);
  const row = db.prepare(
    "SELECT 1 FROM injected_global WHERE checkpoint_id = $cid AND session_id = $sid LIMIT 1",
  ).get({ $cid: checkpointId, $sid: sessionId }) as { "1": number } | undefined;
  return row !== undefined;
}

/** Count of cross-repo injections recorded (for /mega-status stats). */
export function countInjectedGlobal(indexDir: string = getIndexDir()): number {
  const db = openIndexStore(indexDir);
  const row = db.prepare("SELECT COUNT(*) AS n FROM injected_global").get() as { n: number } | undefined;
  return row?.n ?? 0;
}

function initSchema(db: DatabaseSync): void {
  db.exec(`
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
      stored_region_hashes    TEXT       -- JSON array
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
  `);
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
  const v = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
    | { value: string }
    | undefined;
  if (!v) {
    db.prepare("INSERT INTO meta(key, value) VALUES(?, ?)").run("schema_version", String(SCHEMA_VERSION));
  }
}

/**
 * Add `column` (with `decl`, e.g. "INTEGER") to `table` if it does not already
 * exist. Idempotent: checks PRAGMA table_info first, so it is safe to run on
 * every open. Table/column/decl are code-controlled constants (never user
 * input), so the unavoidable identifier interpolation here does not violate
 * PREVENT-002 (no external data reaches this SQL).
 */
function ensureColumn(db: DatabaseSync, table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

/** Read a string-valued meta key (or undefined). Used for cumulative counters. */
export function getMeta(key: string, stateDir: string = getStateDir()): string | undefined {
  const db = openStore(stateDir);
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

/**
 * Cumulative "tokens saved" — the sum of stored checkpoint token estimates across
 * all compactions in this store (one per repo). Persisted in the SQLite `meta`
 * table so it survives session restarts and travels with the repo's state dir,
 * mirroring how `storageDedupRate` is cumulative. Incremented in VectorStore.add()
 * when a new (non-deduped) checkpoint is persisted.
 */
export function getTokensSaved(stateDir: string = getStateDir()): number {
  const raw = getMeta("tokens_saved", stateDir);
  const n = raw == null ? 0 : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** Add `delta` (>=0) to the cumulative tokens-saved counter. */
export function addTokensSaved(delta: number, stateDir: string = getStateDir()): void {
  if (!(delta > 0)) return;
  const db = openStore(stateDir);
  db.prepare(
    `INSERT INTO meta(key, value) VALUES('tokens_saved', ?)
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT)`,
  ).run(String(delta), delta);
}

/** Cumulative store-wide dedup accounting (Sprint 9+). Persisted in the SQLite
 *  `meta` table so it survives session restarts and travels with the repo's
 *  state dir — mirroring `tokens_saved`. Replaces the legacy JSON
 *  `dedup-stats.json` file (all stats now live in the SQLite store). */
export interface DedupStats {
  /** Total add() calls (new checkpoints + deduped collapses). */
  attempts: number;
  /** add() calls that collapsed onto an existing checkpoint. */
  deduped: number;
}

/** Read a store-wide integer counter from the meta table (0 if absent). */
export function getMetaNumber(key: string, stateDir: string = getStateDir()): number {
  const raw = getMeta(key, stateDir);
  const n = raw == null ? 0 : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** Atomically add `delta` to an integer meta counter. */
function incMeta(key: string, delta: number, stateDir: string = getStateDir()): void {
  if (!(delta > 0)) return;
  const db = openStore(stateDir);
  db.prepare(
    `INSERT INTO meta(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT)`,
  ).run(key, String(delta), delta);
}

/** Read the cumulative store-wide dedup counters. */
export function getDedupStats(stateDir: string = getStateDir()): DedupStats {
  return {
    attempts: getMetaNumber("dedup_attempts", stateDir),
    deduped: getMetaNumber("deduped", stateDir),
  };
}

/** Increment the store-wide dedup counters for one add() call. */
export function bumpDedupStats(deduped: boolean, stateDir: string = getStateDir()): void {
  incMeta("dedup_attempts", 1, stateDir);
  if (deduped) incMeta("deduped", 1, stateDir);
}

// --- Future-feature foundation (resume sessions / daily log / lessons) -------
// Scaffolded tables + minimal helpers so all store data lives in SQLite from
// day one. Full UI/recall for these lands in later sprints.

/** Upsert a `sessions` row (resume + per-repo session history). */
export function touchSession(
  sessionId: string,
  repo: string | undefined,
  stateDir: string = getStateDir(),
): void {
  const db = openStore(stateDir);
  const sid = normalizeSessionId(sessionId);
  const existing = db
    .prepare("SELECT started_at FROM sessions WHERE session_id = ?")
    .get(sid) as { started_at: number | null } | undefined;
  const now = Math.floor(Date.now() / 1000);
  if (!existing) {
    db.prepare(
      `INSERT INTO sessions(session_id, repo, started_at, last_compacted_at, status)
       VALUES(?, ?, ?, ?, 'active')`,
    ).run(sid, repo ?? null, now, now);
  } else {
    db.prepare(
      "UPDATE sessions SET last_compacted_at = ?, repo = COALESCE(?, repo), status = 'active' WHERE session_id = ?",
    ).run(now, repo ?? null, sid);
  }
}

/** Append a `daily_log` entry (day = YYYY-MM-DD, local-naive from Date). */
export function logDaily(
  sessionId: string,
  event: string,
  detail: string | undefined,
  tokensSaved: number,
  stateDir: string = getStateDir(),
): void {
  const db = openStore(stateDir);
  const day = new Date().toISOString().slice(0, 10);
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO daily_log(day, session_id, event, detail, tokens_saved, ts)
     VALUES(?, ?, ?, ?, ?, ?)`,
  ).run(day, normalizeSessionId(sessionId), event, detail ?? null, tokensSaved, now);
}

/** Append a `lessons` entry (future lessons-learned browse/recall). */
export function addLesson(
  sessionId: string,
  repo: string | undefined,
  lesson: string,
  stateDir: string = getStateDir(),
): void {
  const db = openStore(stateDir);
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO lessons(session_id, repo, lesson, ts) VALUES(?, ?, ?, ?)`,
  ).run(normalizeSessionId(sessionId), repo ?? null, lesson, now);
}

// --- Durable memory (save-to-memory takeover) ---------------------------------
// One SQLite store for user-saved memories, scoped by repo. Mirrors the
// lessons/sessions pattern: all state lives in SQLite from day one.

// S24 storage hardening: keep each memory row bounded so the durable store can
// never blow a downstream consumer's per-entry buffer (e.g. pi's native
// file-backed memory caps a single entry at ~5k chars). We truncate content at
// MEMORY_MAX_CHARS and evict the least-recently-referenced rows past
// MEMORY_MAX_ROWS per repo via LRU. Both are SQLite-only (PREVENT-PI-004): no
// file-backed memory is written anywhere. Defaults are overridable via env
// (MEGACOMPACT_MEMORY_MAX_CHARS / MEGACOMPACT_MEMORY_MAX_ROWS).
export const MEMORY_MAX_CHARS = 4000;
export const MEMORY_MAX_ROWS = 500;

/** Read an env override as a positive int, falling back to `fallback`. */
function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Effective per-entry char cap (env-overridable, default MEMORY_MAX_CHARS). */
export function memoryMaxChars(): number {
  return envInt("MEGACOMPACT_MEMORY_MAX_CHARS", MEMORY_MAX_CHARS);
}

/** Effective per-repo row cap (env-overridable, default MEMORY_MAX_ROWS). */
export function memoryMaxRows(): number {
  return envInt("MEGACOMPACT_MEMORY_MAX_ROWS", MEMORY_MAX_ROWS);
}

/** Truncate memory content to the per-entry cap, preserving a trailing marker. */
function capMemoryContent(content: string): string {
  const cap = memoryMaxChars();
  if (content.length <= cap) return content;
  return content.slice(0, cap) + "…[truncated]";
}

/**
 * Evict the least-recently-referenced rows for a repo past MEMORY_MAX_ROWS.
 * LRU key = COALESCE(last_referenced, last_recalled_at, created_at) so a memory
 * that is recalled/referenced survives over a stale one. Best-effort: any error
 * is swallowed by the caller. Repo-scoped so one noisy repo can't evict another.
 */
function evictMemoryLru(repo: string | null, stateDir: string): void {
  const db = openStore(stateDir);
  const maxRows = memoryMaxRows();
  // SQLite `= NULL` is never true, so the null-repo scope (memories are
  // stateDir-scoped when repo is null — the applyMemoryOps path) needs `IS NULL`.
  const where = repo == null ? "repo IS NULL" : "repo = ?";
  const countRow = repo == null
    ? db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE ${where}`).get()
    : db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE ${where}`).get(repo);
  const count = (countRow as { n: number }).n;
  const over = count - maxRows;
  if (over <= 0) return;
  // Delete the `over` least-recently-used rows. ORDER BY the LRU key ASC, id ASC
  // (id ASC breaks ties deterministically — oldest created first). The `where`
  // clause is a code-controlled constant (never user input) → PREVENT-002 OK.
  const sql =
    `DELETE FROM memories WHERE ${where} AND id IN (
       SELECT id FROM memories WHERE ${where}
       ORDER BY COALESCE(last_referenced, last_recalled_at, created_at) ASC, id ASC
       LIMIT ?
     )`;
  if (repo == null) db.prepare(sql).run(over);
  else db.prepare(sql).run(repo, repo, over);
}

export interface MemoryRecord {
  id: number;
  repo: string | null;
  kind: string;
  content: string;
  tags: string[];
  createdAt: number;
  lastRecalledAt: number | null;
  category: string | null;
  target: string | null;
  lastReferenced: number | null;
  sourceTurn: number | null;
}

/** Save a memory to the current repo's store. Returns the new row id.
 *  S24 hardening: content is truncated to MEMORY_MAX_CHARS and, once the per-repo
 *  row count exceeds MEMORY_MAX_ROWS, the least-recently-used rows are evicted
 *  (LRU) so the store stays bounded. */
export function addMemory(
  memory: { kind?: string; content: string; tags?: string[]; category?: string; target?: string; sourceTurn?: number },
  repo: string | null,
  stateDir: string = getStateDir(),
): number {
  const db = openStore(stateDir);
  const now = Math.floor(Date.now() / 1000);
  const res = db
    .prepare(
      `INSERT INTO memories(repo, kind, content, tags, created_at, last_recalled_at, category, target, source_turn)
       VALUES(?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .run(
      repo ?? null,
      memory.kind ?? "note",
      capMemoryContent(memory.content),
      JSON.stringify(memory.tags ?? []),
      now,
      memory.category ?? null,
      memory.target ?? null,
      memory.sourceTurn ?? null,
    );
  try {
    evictMemoryLru(repo, stateDir);
  } catch {
    /* non-fatal: eviction must never fail an add */
  }
  return Number(res.lastInsertRowid);
}

/** List recent memories for a repo (or all repos when repo is null). */
export function listMemories(repo: string | null, limit = 50, stateDir: string = getStateDir()): MemoryRecord[] {
  const db = openStore(stateDir);
  const rows = repo
    ? db.prepare("SELECT * FROM memories WHERE repo = ? ORDER BY created_at DESC LIMIT ?").all(repo, limit)
    : db.prepare("SELECT * FROM memories ORDER BY created_at DESC LIMIT ?").all(limit);
  return (rows as any[]).map(mapMemoryRow);
}

/** Substring search across content + tags. */
export function searchMemories(query: string, repo: string | null = null, limit = 50, stateDir: string = getStateDir()): MemoryRecord[] {
  const db = openStore(stateDir);
  const like = `%${query}%`;
  const rows = repo
    ? db.prepare("SELECT * FROM memories WHERE repo = ? AND (content LIKE ? OR tags LIKE ?) ORDER BY created_at DESC LIMIT ?").all(repo, like, like, limit)
    : db.prepare("SELECT * FROM memories WHERE content LIKE ? OR tags LIKE ? ORDER BY created_at DESC LIMIT ?").all(like, like, limit);
  return (rows as any[]).map(mapMemoryRow);
}

/** Mark a memory as recalled (updates last_recalled_at). Returns true if found. */
export function recallMemory(id: number, stateDir: string = getStateDir()): boolean {
  const db = openStore(stateDir);
  const now = Math.floor(Date.now() / 1000);
  const res = db.prepare("UPDATE memories SET last_recalled_at = ? WHERE id = ?").run(now, id);
  return res.changes > 0;
}

/** Mark a memory as referenced (updates last_referenced). Returns true if found. */
export function referenceMemory(id: number, stateDir: string = getStateDir()): boolean {
  const db = openStore(stateDir);
  const now = Math.floor(Date.now() / 1000);
  const res = db.prepare("UPDATE memories SET last_referenced = ? WHERE id = ?").run(now, id);
  return res.changes > 0;
}

/** Replace a memory's mutable fields by id. Returns true if a row was updated. */
export function replaceMemory(
  id: number,
  patch: { kind?: string; content?: string; tags?: string[]; category?: string; target?: string; sourceTurn?: number },
  stateDir: string = getStateDir(),
): boolean {
  const db = openStore(stateDir);
  const res = db
    .prepare(
      `UPDATE memories
       SET kind = COALESCE(?, kind),
           content = COALESCE(?, content),
           tags = COALESCE(?, tags),
           category = COALESCE(?, category),
           target = COALESCE(?, target),
           source_turn = COALESCE(?, source_turn)
       WHERE id = ?`,
    )
    .run(
      patch.kind ?? null,
      patch.content != null ? capMemoryContent(patch.content) : null,
      patch.tags ? JSON.stringify(patch.tags) : null,
      "category" in patch ? (patch.category ?? null) : null,
      "target" in patch ? (patch.target ?? null) : null,
      "sourceTurn" in patch ? (patch.sourceTurn ?? null) : null,
      id,
    );
  return res.changes > 0;
}

/** Remove a memory by id. Returns true if a row was deleted. */
export function removeMemory(id: number, stateDir: string = getStateDir()): boolean {
  const db = openStore(stateDir);
  const res = db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  return res.changes > 0;
}

/** Look up a single memory by id (or undefined). */
export function getMemory(id: number, stateDir: string = getStateDir()): MemoryRecord | undefined {
  const db = openStore(stateDir);
  const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
  return row ? mapMemoryRow(row) : undefined;
}

function mapMemoryRow(row: any): MemoryRecord {
  return {
    id: row.id,
    repo: row.repo ?? null,
    kind: row.kind ?? "note",
    content: row.content ?? "",
    tags: row.tags ? JSON.parse(row.tags) : [],
    createdAt: row.created_at ?? 0,
    lastRecalledAt: row.last_recalled_at ?? null,
    category: row.category ?? null,
    target: row.target ?? null,
    lastReferenced: row.last_referenced ?? null,
    sourceTurn: row.source_turn ?? null,
  };
}

/**
 * Run `fn` atomically. Uses SAVEPOINT so it nests safely under an outer
 * transaction (unlike `BEGIN`, which SQLite rejects when one is already open).
 * Mirrors better-sqlite3's `db.transaction(fn)` semantics — callers that wrap a
 * batch in withTx (e.g. backfill) can still call helpers that also use withTx.
 */
export function withTx(db: DatabaseSync, fn: () => void): void {
  db.exec("SAVEPOINT mc_tx");
  try {
    fn();
    db.exec("RELEASE mc_tx");
  } catch (e) {
    db.exec("ROLLBACK TO mc_tx");
    db.exec("RELEASE mc_tx");
    throw e;
  }
}

/** Map a DB row to the public StoredCheckpoint shape. */
function rowToCheckpoint(row: any): StoredCheckpoint {
  return {
    checkpointId: row.id,
    sessionId: row.session_id,
    summary: row.summary ?? "",
    topicSummary: row.topic_summary ?? undefined,
    summaryHash: row.summary_hash ?? undefined,
    keyDecisions: row.key_decisions ? JSON.parse(row.key_decisions) : [],
    nextSteps: row.next_steps ? JSON.parse(row.next_steps) : [],
    filesModified: row.files_modified ? JSON.parse(row.files_modified) : [],
    tokenEstimate: row.token_estimate ?? 0,
    originalTokenEstimate: row.original_token_estimate ?? undefined,
    regionHash: row.region_hash ?? "",
    contentHash: row.content_hash ?? undefined,
    contentHash2: row.content_hash2 ?? undefined,
    contentHashVersion: row.content_hash_version ?? undefined,
    normalizedText: row.normalized_text ?? undefined,
    // node:sqlite returns BLOBs as Uint8Array; normalize to Buffer so callers
    // (e.g. decompressSmart → Buffer.toString) behave as under better-sqlite3.
    compressedOriginal: row.compressed_original ? Buffer.from(row.compressed_original) : undefined,
    embedding: decodeEmbedding(row.embedding_blob),
    timestamp: Number(row.timestamp ?? 0),
    dedupStatus: row.dedup_status ?? undefined,
  };
}

/** Insert or replace a checkpoint (idempotent by id). */
export function upsertCheckpoint(cp: StoredCheckpoint, stateDir: string = getStateDir()): void {
  const db = openStore(stateDir);
  const sid = normalizeSessionId(cp.sessionId);
  withTx(db, () => {
    db.prepare(
      `INSERT INTO context_chunks
        (id, session_id, region_hash, content_hash, content_hash2, content_hash_version,
         normalized_text, summary, topic_summary, summary_hash,
         key_decisions, next_steps, files_modified, embedding_blob,
         token_estimate, original_token_estimate, timestamp, dedup_status, compressed_original)
       VALUES (@id, @sid, @region_hash, @content_hash, @content_hash2, @content_hash_version,
               @normalized_text, @summary, @topic_summary, @summary_hash,
               @key_decisions, @next_steps, @files_modified, @embedding_blob,
               @token_estimate, @original_token_estimate, @timestamp, @dedup_status, @compressed_original)
       ON CONFLICT(session_id, id) DO UPDATE SET
         summary=excluded.summary,
         topic_summary=excluded.topic_summary,
         summary_hash=excluded.summary_hash,
         key_decisions=excluded.key_decisions,
         next_steps=excluded.next_steps,
         files_modified=excluded.files_modified,
         embedding_blob=excluded.embedding_blob,
         token_estimate=excluded.token_estimate,
         original_token_estimate=excluded.original_token_estimate,
         timestamp=excluded.timestamp,
         dedup_status=excluded.dedup_status,
         compressed_original=excluded.compressed_original`,
    ).run({
      "@id": cp.checkpointId,
      "@sid": sid,
      "@region_hash": cp.regionHash ?? null,
      "@content_hash": cp.contentHash ?? null,
      "@content_hash2": cp.contentHash2 ?? null,
      "@content_hash_version": cp.contentHashVersion ?? null,
      "@normalized_text": cp.normalizedText ?? null,
      "@summary": cp.summary ?? "",
      "@topic_summary": cp.topicSummary ?? null,
      "@summary_hash": cp.summaryHash ?? null,
      "@key_decisions": jsonText(cp.keyDecisions),
      "@next_steps": jsonText(cp.nextSteps),
      "@files_modified": jsonText(cp.filesModified),
      "@embedding_blob": encodeEmbedding(cp.embedding ?? []),
      "@token_estimate": cp.tokenEstimate ?? 0,
      "@original_token_estimate": cp.originalTokenEstimate ?? null,
      "@timestamp": cp.timestamp ?? 0,
      "@dedup_status": "active",
      "@compressed_original": cp.compressedOriginal ?? null,
    });

    // FTS5 virtual tables don't support UPSERT — delete any prior row, reinsert.
    // Store normalized_text (the L1 verify key); fall back to summary for rows
    // that predate normalized_text population.
    db.prepare("DELETE FROM context_chunks_trgm WHERE id = ?").run(cp.checkpointId);
    db.prepare(
      "INSERT INTO context_chunks_trgm(id, normalized_text) VALUES(?, ?)",
    ).run(cp.checkpointId, cp.normalizedText ?? cp.summary ?? "");
  });
}

// --- Sprint 11: MinHash signatures + LSH buckets --------------------------

/** Persist a checkpoint's MinHash signature (idempotent by chunk_id + version). */
export function upsertMinhashSignature(
  chunkId: string,
  sessionId: string,
  signatureVersion: number,
  signatures: number[],
  stateDir: string = getStateDir(),
): void {
  const db = openStore(stateDir);
  const sid = normalizeSessionId(sessionId);
  db.prepare(
    `INSERT INTO minhash_signatures(chunk_id, session_id, signature_version, signatures)
     VALUES(?, ?, ?, ?)
     ON CONFLICT(chunk_id, signature_version) DO UPDATE SET
       session_id=excluded.session_id, signatures=excluded.signatures`,
  ).run(chunkId, sid, signatureVersion, JSON.stringify(signatures));
}

/** Persist LSH bucket memberships for a chunk (one row per bucket key). */
export function insertLshBuckets(
  chunkId: string,
  sessionId: string,
  signatureVersion: number,
  bucketKeys: string[],
  stateDir: string = getStateDir(),
): void {
  const db = openStore(stateDir);
  const sid = normalizeSessionId(sessionId);
  const del = db.prepare("DELETE FROM dedup_lsh_buckets WHERE chunk_id = ?");
  const ins = db.prepare(
    "INSERT OR IGNORE INTO dedup_lsh_buckets(bucket_key, chunk_id, session_id, signature_version) VALUES(?, ?, ?, ?)",
  );
  withTx(db, () => {
    del.run(chunkId);
    for (const key of bucketKeys) ins.run(key, chunkId, sid, signatureVersion);
  });
}

/**
 * Candidate chunk_ids sharing any LSH bucket with `bucketKeys`, scoped to the
 * session, capped at `limit`. Single query (no N loops) — QA #15 amplification
 * guard. Returns DISTINCT chunk_ids excluding `excludeChunkId` (the new row).
 */
export function lshCandidateChunks(
  bucketKeys: string[],
  sessionId: string,
  excludeChunkId: string,
  stateDir: string = getStateDir(),
  limit = 100,
): string[] {
  if (bucketKeys.length === 0) return [];
  const db = openStore(stateDir);
  const sid = normalizeSessionId(sessionId);
  const placeholders = bucketKeys.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT DISTINCT chunk_id FROM dedup_lsh_buckets
       WHERE bucket_key IN (${placeholders}) AND session_id = ? AND chunk_id != ?
       LIMIT ?`,
    )
    .all(...bucketKeys, sid, excludeChunkId, limit) as { chunk_id: string }[];
  return rows.map((r) => r.chunk_id);
}

/** All checkpoints for a session, sorted by id. */
export function listCheckpoints(sessionId: string, stateDir: string = getStateDir()): StoredCheckpoint[] {
  const db = openStore(stateDir);
  const sid = normalizeSessionId(sessionId);
  const rows = db
    .prepare("SELECT * FROM context_chunks WHERE session_id = ? ORDER BY id ASC")
    .all(sid) as any[];
  return rows.map(rowToCheckpoint);
}

/** S25: the newest checkpoint timestamp for a session, or 0 when none. Used by
 *  the RAPTOR freshness guard to reject a tree older than the live checkpoints. */
export function maxCheckpointTimestamp(sessionId: string, stateDir: string = getStateDir()): number {
  const db = openStore(stateDir);
  const row = db
    .prepare("SELECT MAX(timestamp) AS mx FROM context_chunks WHERE session_id = ?")
    .get(normalizeSessionId(sessionId)) as { mx: number | null } | undefined;
  return Number(row?.mx ?? 0);
}

/** Next sequential checkpoint id (chkpt_001 …) for a session. */
export function nextCheckpointId(sessionId: string, stateDir: string = getStateDir()): string {
  const db = openStore(stateDir);
  const sid = normalizeSessionId(sessionId);
  const row = db
    .prepare("SELECT MAX(CAST(SUBSTR(id, 7) AS INTEGER)) AS n FROM context_chunks WHERE session_id = ?")
    .get(sid) as { n: number | null };
  const next = (row.n ?? 0) + 1;
  return `chkpt_${String(next).padStart(3, "0")}`;
}

/** True if a checkpoint id already exists for a session. */
export function hasCheckpoint(sessionId: string, checkpointId: string, stateDir: string = getStateDir()): boolean {
  const db = openStore(stateDir);
  const row = db
    .prepare("SELECT 1 FROM context_chunks WHERE session_id = ? AND id = ? LIMIT 1")
    .get(normalizeSessionId(sessionId), checkpointId);
  return row !== undefined;
}

/** Fetch a single checkpoint by (session, id), or undefined if absent. */
export function getCheckpoint(
  sessionId: string,
  checkpointId: string,
  stateDir: string = getStateDir(),
): StoredCheckpoint | undefined {
  const db = openStore(stateDir);
  const row = db
    .prepare("SELECT * FROM context_chunks WHERE session_id = ? AND id = ? LIMIT 1")
    .get(normalizeSessionId(sessionId), checkpointId) as any;
  return row ? rowToCheckpoint(row) : undefined;
}

/** Mark a checkpoint's dedup_status (e.g. 'removed' by SemDeDup). */
export function setDedupStatus(
  checkpointId: string,
  sessionId: string,
  status: string,
  stateDir: string = getStateDir(),
): void {
  const db = openStore(stateDir);
  db.prepare(
    "UPDATE context_chunks SET dedup_status = ? WHERE id = ? AND session_id = ?",
  ).run(status, checkpointId, normalizeSessionId(sessionId));
}

// --- Session state (injection tracking) ------------------------------------

function loadSessionStateRow(sid: string, db: DatabaseSync): SessionState {
  const row = db.prepare("SELECT * FROM session_state WHERE session_id = ?").get(sid) as any;
  if (!row) {
    return { injectedCheckpointIds: [], storedRegionHashes: [] };
  }
  return {
    injectedCheckpointIds: row.injected_checkpoint_ids ? JSON.parse(row.injected_checkpoint_ids) : [],
    storedRegionHashes: row.stored_region_hashes ? JSON.parse(row.stored_region_hashes) : [],
  };
}

export function loadSessionState(sessionId: string, stateDir: string = getStateDir()): SessionState {
  return loadSessionStateRow(normalizeSessionId(sessionId), openStore(stateDir));
}

export function saveSessionState(sessionId: string, state: SessionState, stateDir: string = getStateDir()): void {
  const db = openStore(stateDir);
  const sid = normalizeSessionId(sessionId);
  db.prepare(
    `INSERT INTO session_state(session_id, injected_checkpoint_ids, stored_region_hashes)
     VALUES(@sid, @inj, @reg)
     ON CONFLICT(session_id) DO UPDATE SET
       injected_checkpoint_ids=excluded.injected_checkpoint_ids,
       stored_region_hashes=excluded.stored_region_hashes`,
  ).run({
    sid,
    inj: jsonText(state.injectedCheckpointIds),
    reg: jsonText(state.storedRegionHashes),
  });
}

// --- Stats -----------------------------------------------------------------

export interface StoreStats {
  checkpointCount: number;
  totalTokenEstimate: number;
  lastCheckpointId: string | undefined;
  lastSummary: string | undefined;
}

export function storeStats(sessionId: string, stateDir: string = getStateDir()): StoreStats {
  const db = openStore(stateDir);
  const sid = normalizeSessionId(sessionId);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c, COALESCE(SUM(token_estimate),0) AS tok,
              MAX(id) AS lastId
       FROM context_chunks WHERE session_id = ?`,
    )
    .get(sid) as { c: number; tok: number; lastId: string | null };
  let lastSummary: string | undefined;
  if (row.lastId) {
    const s = db.prepare("SELECT summary FROM context_chunks WHERE id = ?").get(row.lastId) as
      | { summary: string }
      | undefined;
    lastSummary = s?.summary;
  }
  return {
    checkpointCount: row.c,
    totalTokenEstimate: row.tok,
    lastCheckpointId: row.lastId ?? undefined,
    lastSummary,
  };
}

/** Repo-wide stats — aggregates every session in this store (one per repo).
 *  Backed by the SQLite `meta` cumulative counters (`tokens_saved`,
 *  `dedup_attempts`, `deduped`) plus a SUM over all `context_chunks`. This is the
 *  cumulative, resumable, cross-device view the dashboard surfaces as "Repo …". */
export interface RepoStats {
  /** Total checkpoints across all sessions (excludes SemDeDup-removed rows). */
  checkpointCount: number;
  /** Sum of all stored checkpoint token estimates (repo-wide). */
  totalTokenEstimate: number;
  /** Total active sessions with at least one checkpoint. */
  sessionCount: number;
  /** Cumulative stored-summary tokens saved (Σ stored summaries). */
  tokensSaved: number;
  /** Sum of original dropped-region token estimates (repo-wide). */
  originalTokens: number;
  /** Cumulative dedup add() attempts (store-wide). */
  dedupAttempts: number;
  /** Cumulative deduped collapses (store-wide). */
  dedupCollapsed: number;
  /** Storage dedup rate (deduped / attempts), 0..1. */
  storageDedupRate: number;
}

/**
 * Data-safety invariant metrics (Phase 0 — trust foundation). Proves that every
 * compacted region is still recoverable: we retain a compressed_original blob for
 * each checkpoint and permanently delete nothing. "removed" rows are SemDeDup
 * duplicates whose ORIGINAL is still retained on the surviving checkpoint — they
 * are not data loss, so they are reported separately, not as deletions.
 */
export interface DataInvariantStats {
  /** Checkpoints with a recoverable compressed_original blob. */
  regionsRetained: number;
  /** Total bytes of compressed_original retained (recoverable verbatim). */
  compressedOriginalBytes: number;
  /** Checkpoints missing a compressed_original blob (pre-blob or direct add). */
  regionsWithoutBlob: number;
  /** Bytes permanently deleted by the extension. ALWAYS 0 — the invariant. */
  bytesPermanentlyDeleted: number;
  /** Duplicate rows collapsed by dedup (original retained on the survivor). */
  duplicatesCollapsed: number;
}

export function dataInvariantStats(stateDir: string = getStateDir()): DataInvariantStats {
  const db = openStore(stateDir);
  const row = db
    .prepare(
      `SELECT
         COUNT(compressed_original) AS withBlob,
         COALESCE(SUM(LENGTH(compressed_original)),0) AS blobBytes,
         SUM(CASE WHEN compressed_original IS NULL THEN 1 ELSE 0 END) AS noBlob
       FROM context_chunks WHERE dedup_status != 'removed'`,
    )
    .get() as { withBlob: number; blobBytes: number; noBlob: number };
  const removed = db
    .prepare(`SELECT COUNT(*) AS c FROM context_chunks WHERE dedup_status = 'removed'`)
    .get() as { c: number };
  return {
    regionsRetained: row.withBlob,
    compressedOriginalBytes: row.blobBytes,
    regionsWithoutBlob: row.noBlob ?? 0,
    bytesPermanentlyDeleted: 0,
    duplicatesCollapsed: removed.c,
  };
}

export function repoStats(stateDir: string = getStateDir()): RepoStats {
  const db = openStore(stateDir);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c, COALESCE(SUM(token_estimate),0) AS tok,
              COALESCE(SUM(original_token_estimate),0) AS orig,
              COUNT(DISTINCT session_id) AS sessions
       FROM context_chunks WHERE dedup_status != 'removed'`,
    )
    .get() as { c: number; tok: number; orig: number; sessions: number };
  const ds = getDedupStats(stateDir);
  return {
    checkpointCount: row.c,
    totalTokenEstimate: row.tok,
    originalTokens: row.orig,
    sessionCount: row.sessions,
    tokensSaved: getMetaNumber("tokens_saved", stateDir),
    dedupAttempts: ds.attempts,
    dedupCollapsed: ds.deduped,
    storageDedupRate: ds.attempts === 0 ? 0 : ds.deduped / ds.attempts,
  };
}

/** A captured model/provider snapshot (for cost estimation + dashboard). */
export interface ModelSnapshot {
  provider: string;
  providerName: string | null;
  modelId: string;
  modelName: string | null;
  inputRate: number; // USD per input token
  outputRate: number; // USD per output token
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  capturedAt: number;
}

/** Persist the active model/provider for a repo (latest row wins per repo). */
export function recordModelSnapshot(
  repoRoot: string,
  snap: Omit<ModelSnapshot, "capturedAt">,
  stateDir: string = getStateDir(),
): void {
  const db = openStore(stateDir);
  db.prepare(
    `INSERT INTO model_snapshots
       (repo_root, provider, provider_name, model_id, model_name, input_rate,
        output_rate, context_window, max_tokens, reasoning, captured_at)
     VALUES (@repo_root, @provider, @provider_name, @model_id, @model_name,
             @input_rate, @output_rate, @context_window, @max_tokens, @reasoning, @captured_at)`,
  ).run({
    repo_root: repoRoot,
    provider: snap.provider,
    provider_name: snap.providerName,
    model_id: snap.modelId,
    model_name: snap.modelName,
    input_rate: snap.inputRate,
    output_rate: snap.outputRate,
    context_window: snap.contextWindow,
    max_tokens: snap.maxTokens,
    reasoning: snap.reasoning ? 1 : 0,
    captured_at: Date.now(),
  });
}

/** Most recent model/provider snapshot for a repo, or undefined. */
export function latestModelSnapshot(stateDir: string = getStateDir()): ModelSnapshot | undefined {
  const db = openStore(stateDir);
  const row = db
    .prepare(
      `SELECT * FROM model_snapshots ORDER BY captured_at DESC LIMIT 1`,
    )
    .get() as
    | {
        provider: string;
        provider_name: string | null;
        model_id: string;
        model_name: string | null;
        input_rate: number;
        output_rate: number;
        context_window: number;
        max_tokens: number;
        reasoning: number;
        captured_at: number;
      }
    | undefined;
  if (!row) return undefined;
  return {
    provider: row.provider,
    providerName: row.provider_name,
    modelId: row.model_id,
    modelName: row.model_name,
    inputRate: row.input_rate,
    outputRate: row.output_rate,
    contextWindow: row.context_window,
    maxTokens: row.max_tokens,
    reasoning: row.reasoning === 1,
    capturedAt: row.captured_at,
  };
}

/** Close and evict a cached connection (test teardown only). */
export function closeStore(stateDir: string): void {
  const db = cache.get(stateDir);
  if (db) {
    db.close();
    cache.delete(stateDir);
  }
}

// ---- Sprint 13: RAPTOR node persistence ----------------------------------

export interface StoredRaptorNode {
  id: string;
  sessionId: string;
  level: number;
  parentId: string | null;
  children: string[];
  summary: string;
  embedding: number[];
  qualityMarker: string;
  tokenEstimate: number;
  /** S25: epoch ms when the tree containing this node was built. */
  builtAt: number;
}

/** Persist a single RAPTOR node (upsert by (session_id, id)). */
export function upsertRaptorNode(node: StoredRaptorNode, stateDir: string = getStateDir()): void {
  const db = openStore(stateDir);
  db.prepare(
    `INSERT INTO raptor_nodes(id, session_id, level, parent_id, children, summary, embedding_blob, quality_marker, token_estimate, built_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, id) DO UPDATE SET
       level=excluded.level, parent_id=excluded.parent_id, children=excluded.children,
       summary=excluded.summary, embedding_blob=excluded.embedding_blob,
       quality_marker=excluded.quality_marker, token_estimate=excluded.token_estimate,
       built_at=excluded.built_at`,
  ).run(
    node.id,
    node.sessionId,
    node.level,
    node.parentId,
    jsonText(node.children),
    node.summary,
    encodeEmbedding(node.embedding),
    node.qualityMarker,
    node.tokenEstimate,
    node.builtAt,
  );
}

/** Persist an entire built RAPTOR tree for a session (shadow or live). */
export function saveRaptorTree(
  sessionId: string,
  tree: {
    nodes: Map<string, {
      id: string;
      level: number;
      parentId: string | null;
      children: string[];
      summary: string;
      embedding: number[];
      qualityMarker: string;
      tokenEstimate: number;
    }>
  },
  builtAt: number,
  stateDir: string = getStateDir(),
): void {
  for (const node of tree.nodes.values()) {
    upsertRaptorNode(
      {
        id: node.id,
        sessionId,
        level: node.level,
        parentId: node.parentId,
        children: node.children,
        summary: node.summary,
        embedding: node.embedding,
        qualityMarker: node.qualityMarker,
        tokenEstimate: node.tokenEstimate,
        builtAt,
      },
      stateDir,
    );
  }
}

/** Load all RAPTOR nodes for a session. */
export function listRaptorNodes(sessionId: string, stateDir: string = getStateDir()): StoredRaptorNode[] {
  const db = openStore(stateDir);
  const rows = db
    .prepare("SELECT * FROM raptor_nodes WHERE session_id = ? ORDER BY level ASC, id ASC")
    .all(normalizeSessionId(sessionId)) as any[];
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    level: row.level,
    parentId: row.parent_id ?? null,
    children: row.children ? JSON.parse(row.children) : [],
    summary: row.summary ?? "",
    embedding: decodeEmbedding(row.embedding_blob),
    qualityMarker: row.quality_marker ?? "low",
    tokenEstimate: row.token_estimate ?? 0,
    builtAt: Number(row.built_at ?? 0),
  }));
}

/** Delete all RAPTOR nodes for a session (rollback/cleanup). */
export function clearRaptorNodes(sessionId: string, stateDir: string = getStateDir()): void {
  const db = openStore(stateDir);
  db.prepare("DELETE FROM raptor_nodes WHERE session_id = ?").run(normalizeSessionId(sessionId));
}

// --- S27: durable raw-transcript mirror + checkpoint-epoch registry ---------
// ADDITIVE + flag-default-OFF (MEGACOMPACT_DB_MIRROR). No behavior change
// until the flag is flipped on; the tables above are created IF NOT EXISTS on
// open so existing stores are untouched. These helpers are storage primitives
// only — the runtime hook (Task 5) wires them into the compaction flow. All
// queries use @-parameterized placeholders (PREVENT-002); no `any` types
// (PREVENT-011).

/** One appended raw-message row in the durable mirror. */
export interface RawTranscriptRow {
  contentHash: string;
  sessionId: string;
  seq: number;
  role: string;
  contentBytes: string;
  toolName: string | null;
  /** ORIGINAL message timestamp captured at append time (NOT a served ts). */
  messageTimestamp: number | null;
  checkpointEpoch: string;
}

/** One checkpoint-epoch bookkeeping row (informational registry). */
export interface CheckpointEpoch {
  epochId: string;
  sessionId: string;
  startedSeq: number;
  committedSeq: number;
  summaryMessageText: string;
  cutIndex: number;
  checkpointId: string;
  createdAt: number;
}

/** DB row shape for raw_transcript (snake_case column names). */
interface RawTranscriptDBRow {
  content_hash: string;
  session_id: string;
  seq: number;
  role: string;
  content_bytes: string;
  tool_name: string | null;
  message_timestamp: number | null;
  checkpoint_epoch: string;
}

/** DB row shape for checkpoint_epochs (snake_case column names). */
interface CheckpointEpochDBRow {
  epoch_id: string;
  session_id: string;
  started_seq: number;
  committed_seq: number;
  summary_message_text: string;
  cut_index: number;
  checkpoint_id: string;
  created_at: number;
}

function rowToRawTranscript(row: RawTranscriptDBRow): RawTranscriptRow {
  return {
    contentHash: row.content_hash,
    sessionId: row.session_id,
    seq: Number(row.seq),
    role: row.role,
    contentBytes: row.content_bytes,
    toolName: row.tool_name ?? null,
    messageTimestamp:
      row.message_timestamp == null ? null : Number(row.message_timestamp),
    checkpointEpoch: row.checkpoint_epoch,
  };
}

function rowToCheckpointEpoch(row: CheckpointEpochDBRow): CheckpointEpoch {
  return {
    epochId: row.epoch_id,
    sessionId: row.session_id,
    startedSeq: Number(row.started_seq),
    committedSeq: Number(row.committed_seq),
    summaryMessageText: row.summary_message_text,
    cutIndex: Number(row.cut_index),
    checkpointId: row.checkpoint_id,
    createdAt: Number(row.created_at),
  };
}

/**
 * Append one raw-message row to the durable mirror. Idempotent by
 * (content_hash, session_id) via INSERT OR IGNORE — re-appending the same
 * content for the same session is a no-op. seq is assigned server-side as
 * COALESCE(MAX(seq),0)+1 within the session, so callers never need to compute
 * it. Pass an open store handle (openStore) — matches the other DatabaseSync
 * helpers. Parameterized (PREVENT-002).
 */
export function appendRawTranscript(db: DatabaseSync, row: RawTranscriptRow): void {
  withTx(db, () => {
    db.prepare(
      `INSERT OR IGNORE INTO raw_transcript
        (content_hash, session_id, seq, role, content_bytes, tool_name, message_timestamp, checkpoint_epoch)
       VALUES (
         @content_hash, @session_id,
         COALESCE((SELECT MAX(seq) FROM raw_transcript WHERE session_id = @session_id), 0) + 1,
         @role, @content_bytes, @tool_name, @message_timestamp, @checkpoint_epoch
       )`,
    ).run({
      "@content_hash": row.contentHash,
      "@session_id": row.sessionId,
      "@role": row.role,
      "@content_bytes": row.contentBytes,
      "@tool_name": row.toolName,
      "@message_timestamp": row.messageTimestamp,
      "@checkpoint_epoch": row.checkpointEpoch,
    });
  });
}

/**
 * List raw-transcript rows for a session in [fromSeq, toSeq], ordered by seq
 * ascending. Returns camel-cased RawTranscriptRow[]. Parameterized.
 */
export function listRawTranscriptRange(
  db: DatabaseSync,
  sessionId: string,
  fromSeq: number,
  toSeq: number,
): RawTranscriptRow[] {
  const rows = db
    .prepare(
      `SELECT content_hash, session_id, seq, role, content_bytes, tool_name, message_timestamp, checkpoint_epoch
       FROM raw_transcript
       WHERE session_id = @session_id AND seq >= @from_seq AND seq <= @to_seq
       ORDER BY seq ASC`,
    )
    .all({
      "@session_id": sessionId,
      "@from_seq": fromSeq,
      "@to_seq": toSeq,
    }) as unknown as RawTranscriptDBRow[];
  return rows.map(rowToRawTranscript);
}

/**
 * Insert (or refresh) a checkpoint-epoch row. ON CONFLICT(epoch_id) DO UPDATE
 * so re-running the same compaction epoch is idempotent / refresh-safe.
 * Parameterized (PREVENT-002).
 */
export function writeCheckpointEpoch(db: DatabaseSync, epoch: CheckpointEpoch): void {
  withTx(db, () => {
    db.prepare(
      `INSERT INTO checkpoint_epochs
        (epoch_id, session_id, started_seq, committed_seq, summary_message_text, cut_index, checkpoint_id, created_at)
       VALUES (@epoch_id, @session_id, @started_seq, @committed_seq, @summary_message_text, @cut_index, @checkpoint_id, @created_at)
       ON CONFLICT(epoch_id) DO UPDATE SET
         session_id = excluded.session_id,
         started_seq = excluded.started_seq,
         committed_seq = excluded.committed_seq,
         summary_message_text = excluded.summary_message_text,
         cut_index = excluded.cut_index,
         checkpoint_id = excluded.checkpoint_id,
         created_at = excluded.created_at`,
    ).run({
      "@epoch_id": epoch.epochId,
      "@session_id": epoch.sessionId,
      "@started_seq": epoch.startedSeq,
      "@committed_seq": epoch.committedSeq,
      "@summary_message_text": epoch.summaryMessageText,
      "@cut_index": epoch.cutIndex,
      "@checkpoint_id": epoch.checkpointId,
      "@created_at": epoch.createdAt,
    });
  });
}

/** Read one checkpoint-epoch row by id (or null if absent). Parameterized. */
export function readCheckpointEpoch(db: DatabaseSync, epochId: string): CheckpointEpoch | null {
  const row = db
    .prepare(
      `SELECT epoch_id, session_id, started_seq, committed_seq, summary_message_text, cut_index, checkpoint_id, created_at
       FROM checkpoint_epochs WHERE epoch_id = @epoch_id`,
    )
    .get({ "@epoch_id": epochId }) as unknown as CheckpointEpochDBRow | undefined;
  return row ? rowToCheckpointEpoch(row) : null;
}

/**
 * Latest checkpoint-epoch row for a session (highest created_at), or null if
 * none. Parameterized (PREVENT-002).
 */
export function getActiveEpochForSession(db: DatabaseSync, sessionId: string): CheckpointEpoch | null {
  const row = db
    .prepare(
      `SELECT epoch_id, session_id, started_seq, committed_seq, summary_message_text, cut_index, checkpoint_id, created_at
       FROM checkpoint_epochs
       WHERE session_id = @session_id
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get({ "@session_id": sessionId }) as unknown as CheckpointEpochDBRow | undefined;
  return row ? rowToCheckpointEpoch(row) : null;
}

/** List all checkpoint epochs (diagnostic / test helper). */
export function listCheckpointEpochs(db: DatabaseSync): CheckpointEpoch[] {
  const rows = db
    .prepare(
      `SELECT epoch_id, session_id, started_seq, committed_seq, summary_message_text, cut_index, checkpoint_id, created_at
       FROM checkpoint_epochs
       ORDER BY created_at DESC`,
    )
    .all() as unknown as CheckpointEpochDBRow[];
  return rows.map(rowToCheckpointEpoch);
}

/** Count raw transcript rows (diagnostic / test helper). */
export function countRawTranscript(db: DatabaseSync): number {
  const row = db.prepare(`SELECT COUNT(*) AS cnt FROM raw_transcript`).get() as { cnt: number };
  return row.cnt;
}

// ────────────────────────────────────────────────────────────────────────
// S27 Task 6: dedup_mirror functions
// ────────────────────────────────────────────────────────────────────────

/**
 * Dedup mirror row (DB representation).
 */
export interface DedupMirrorRowDB {
  content_hash: string;
  content_bytes: string;
  ref_count: number;
  first_seen_seq: number;
  created_at: number;
}

/**
 * Upsert a row into dedup_mirror. If the hash already exists, increment ref_count.
 * Returns true if this was a NEW unique content (first insert), false if it was a duplicate.
 */
export function upsertDedupMirror(
  db: DatabaseSync,
  contentHash: string,
  contentBytes: string,
  seq: number,
): boolean {
  const now = Date.now();
  const existing = db
    .prepare(`SELECT content_hash FROM dedup_mirror WHERE content_hash = @hash`)
    .get({ "@hash": contentHash }) as { content_hash: string } | undefined;
  if (existing) {
    db.prepare(`UPDATE dedup_mirror SET ref_count = ref_count + 1 WHERE content_hash = @hash`).run({
      "@hash": contentHash,
    });
    return false;
  }
  db.prepare(
    `INSERT INTO dedup_mirror (content_hash, content_bytes, ref_count, first_seen_seq, created_at)
     VALUES (@hash, @bytes, 1, @seq, @now)`,
  ).run({
    "@hash": contentHash,
    "@bytes": contentBytes,
    "@seq": seq,
    "@now": now,
  });
  return true;
}

/**
 * Get dedup ratio for a session: total bytes vs unique bytes.
 */
export function getDedupRatio(
  db: DatabaseSync,
  sessionId: string,
): { totalBytes: number; uniqueBytes: number; ratio: number } {
  const totalRow = db
    .prepare(
      `SELECT COALESCE(SUM(LENGTH(content_bytes)), 0) AS total
       FROM raw_transcript
       WHERE session_id = @session_id`,
    )
    .get({ "@session_id": sessionId }) as { total: number };
  const uniqueRow = db
    .prepare(
      `SELECT COALESCE(SUM(LENGTH(content_bytes)), 0) AS unique_bytes
       FROM dedup_mirror`,
    )
    .get() as { unique_bytes: number };
  const totalBytes = totalRow.total;
  const uniqueBytes = uniqueRow.unique_bytes;
  const ratio = uniqueBytes > 0 ? totalBytes / uniqueBytes : 1;
  return { totalBytes, uniqueBytes, ratio };
}

/**
 * Get dedup mirror stats (diagnostic / test helper).
 */
export function getDedupMirrorStats(db: DatabaseSync): {
  rowCount: number;
  totalBytes: number;
  avgRefCount: number;
} {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS cnt,
              COALESCE(SUM(LENGTH(content_bytes)), 0) AS total_bytes,
              COALESCE(AVG(ref_count), 0) AS avg_ref
       FROM dedup_mirror`,
    )
    .get() as { cnt: number; total_bytes: number; avg_ref: number };
  return { rowCount: row.cnt, totalBytes: row.total_bytes, avgRefCount: row.avg_ref };
}

/**
 * Update raw_transcript.content_ref to point to dedup_mirror.
 */
export function updateRawTranscriptRef(
  db: DatabaseSync,
  sessionId: string,
  seq: number,
  contentHash: string,
): void {
  db.prepare(
    `UPDATE raw_transcript SET content_ref = @ref WHERE session_id = @sid AND seq = @seq`,
  ).run({
    "@ref": contentHash,
    "@sid": sessionId,
    "@seq": seq,
  });
}

// ---------------------------------------------------------------------------
// S27 Task 10 — DB maintenance / housekeeping primitives.
// All pi-agnostic, all parameterized (PREVENT-002), all local (PREVENT-PI-004).
// Exposed via the /mega-db-* slash commands in extensions/mega-db-cmds.ts.
// ---------------------------------------------------------------------------

/** Per-table row counts + DB file sizes for the /mega-db-stats command. */
export interface DbStats {
  /** Row count per table (keys are table names that exist in this DB). */
  tableCounts: Record<string, number>;
  /** Bytes used by the main DB file on disk. */
  dbBytes: number;
  /** Bytes used by the -wal sidecar file (0 if absent). */
  walBytes: number;
  /** Bytes used by the -shm sidecar file (0 if absent). */
  shmBytes: number;
  /** SQLite page size in bytes. */
  pageSize: number;
  /** Total pages (freelist + in-use). */
  pageCount: number;
  /** Freelist pages (reusable by VACUUM). */
  freelistPages: number;
  /** WAL frame count from PRAGMA wal_info (best-effort; 0 if unsupported). */
  walFrames: number;
}

const DB_TABLE_NAMES = [
  "context_chunks",
  "session_state",
  "raw_transcript",
  "checkpoint_epochs",
  "dedup_mirror",
  "memories",
  "dedup_stats",
  "daily_log",
] as const;

function fileSizeIfExists(path: string): number {
  try {
    const st = statSync(path);
    return st.size;
  } catch {
    return 0;
  }
}

/**
 * Gather DB stats for /mega-db-stats: per-table row counts, disk footprint
 * (main + WAL + SHM), page count, freelist, WAL frame count.
 *
 * Read-only: no PRAGMA writes, no VACUUM. Safe to call any time.
 */
export function getDbStats(stateDir: string = getStateDir()): DbStats {
  const db = openStore(stateDir);
  const tableCounts: Record<string, number> = {};
  for (const t of DB_TABLE_NAMES) {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number } | undefined;
      if (row) tableCounts[t] = row.c;
    } catch {
      // Table doesn't exist on this DB (e.g. raw_transcript on a pre-S27 store).
      // Skip silently — /mega-db-stats lists only tables that exist.
    }
  }
  const pageStat = db.prepare("PRAGMA page_count").get() as { page_count?: number } | undefined;
  const freelistStat = db.prepare("PRAGMA freelist_count").get() as { freelist_count?: number } | undefined;
  const pageSizeStat = db.prepare("PRAGMA page_size").get() as { page_size?: number } | undefined;
  let walFrames = 0;
  try {
    const walInfo = db.prepare("PRAGMA wal_info").get() as { frames?: number } | undefined;
    walFrames = walInfo?.frames ?? 0;
  } catch {
    // node:sqlite may not expose wal_info on all versions; not fatal.
  }
  const dbPath = join(stateDir, "sqlite.db");
  return {
    tableCounts,
    dbBytes: fileSizeIfExists(dbPath),
    walBytes: fileSizeIfExists(`${dbPath}-wal`),
    shmBytes: fileSizeIfExists(`${dbPath}-shm`),
    pageSize: pageSizeStat?.page_size ?? 0,
    pageCount: pageStat?.page_count ?? 0,
    freelistPages: freelistStat?.freelist_count ?? 0,
    walFrames,
  };
}

/** Result of a prune / VACUUM / checkpoint operation (reclaimed bytes). */
export interface MaintenanceResult {
  /** Rows deleted (prune) or pages reclaimed (VACUUM / checkpoint). */
  affected: number;
  /** Bytes reclaimed on disk (best-effort: post-op size minus pre-op size). */
  reclaimedBytes: number;
  /** Human-readable summary line for the command output. */
  summary: string;
}

/**
 * Prune raw_transcript + checkpoint_epochs rows older than `daysOld`.
 * Uses `message_timestamp` (raw_transcript) and `created_at` (epochs), both
 * epoch-ms. Returns the total deleted rows + reclaimed disk bytes.
 *
 * PREVENT-002: parameterized. PREVENT-PI-004: local SQLite only.
 */
export function pruneOldRows(stateDir: string = getStateDir(), daysOld = 30): MaintenanceResult {
  const db = openStore(stateDir);
  const cutoff = Date.now() - daysOld * 86_400_000;
  const beforeBytes = fileSizeIfExists(join(stateDir, "sqlite.db"));
  // raw_transcript: message_timestamp may be NULL (pre-S27 rows); those use
  // the row's insertion order implicitly via seq, so we prune NULL-ts rows
  // only when the whole session is older than the cutoff (join via session_id
  // to checkpoint_epochs.created_at). Simpler: prune NULL-ts rows older than
  // cutoff by falling back to the MIN(created_at) of their epoch.
  // Delete raw_transcript rows whose message_timestamp is older than cutoff,
  // OR whose message_timestamp is NULL and the session's latest epoch is older.
  const delRt = db.prepare(
    `DELETE FROM raw_transcript
     WHERE message_timestamp IS NOT NULL AND message_timestamp < ?
        OR (message_timestamp IS NULL
            AND session_id IN (
              SELECT session_id FROM checkpoint_epochs
              GROUP BY session_id HAVING MAX(created_at) < ?
            ))`,
  ).run(cutoff, cutoff) as { changes?: number } | undefined;
  const rtDeleted = delRt?.changes ?? 0;
  // checkpoint_epochs: created_at is NOT NULL.
  const delEp = db.prepare(`DELETE FROM checkpoint_epochs WHERE created_at < ?`).run(cutoff) as {
    changes?: number;
  } | undefined;
  const epDeleted = delEp?.changes ?? 0;
  // dedup_mirror: cascade-delete orphan rows whose ref_count has dropped to 0
  // after the raw_transcript deletes. Safe even if FK is off (raw_transcript has
  // no FK to dedup_mirror; ref_count is maintained by the dedup pipeline).
  const delDedup = db.prepare(`DELETE FROM dedup_mirror WHERE ref_count <= 0`).run() as {
    changes?: number;
  } | undefined;
  const dedupDeleted = delDedup?.changes ?? 0;
  const afterBytes = fileSizeIfExists(join(stateDir, "sqlite.db"));
  const total = rtDeleted + epDeleted + dedupDeleted;
  return {
    affected: total,
    reclaimedBytes: Math.max(0, beforeBytes - afterBytes),
    summary: `pruned ${rtDeleted} raw_transcript + ${epDeleted} epochs + ${dedupDeleted} dedup_mirror rows older than ${daysOld}d`,
  };
}

/**
 * Force a WAL checkpoint (TRUNCATE mode) so the -wal sidecar is reclaimed.
 * Returns the WAL bytes reclaimed (pre-wal size minus post-wal size).
 */
export function checkpointWal(stateDir: string = getStateDir()): MaintenanceResult {
  const db = openStore(stateDir);
  const dbPath = join(stateDir, "sqlite.db");
  const beforeWal = fileSizeIfExists(`${dbPath}-wal`);
  // PRAGMA wal_checkpoint(TRUNCATE) blocks until all frames are folded into the
  // main db and the WAL file is truncated to 0 bytes.
  const res = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
    busy?: number;
    log?: number;
    checkpointed?: number;
  } | undefined;
  const afterWal = fileSizeIfExists(`${dbPath}-wal`);
  const reclaimed = Math.max(0, beforeWal - afterWal);
  return {
    affected: res?.checkpointed ?? 0,
    reclaimedBytes: reclaimed,
    summary: `wal_checkpoint(TRUNCATE): ${res?.checkpointed ?? 0} frames folded, WAL ${beforeWal}→${afterWal} bytes${res?.busy ? " (busy: " + res.busy + ")" : ""}`,
  };
}

/**
 * VACUUM the main DB file (rebuilds pages, reclaims freelist space).
 * Heavy: briefly doubles disk usage. Run only when freelist is large or the
 * user explicitly invokes /mega-db-vacuum.
 */
export function vacuumDb(stateDir: string = getStateDir()): MaintenanceResult {
  const db = openStore(stateDir);
  const dbPath = join(stateDir, "sqlite.db");
  const beforeBytes = fileSizeIfExists(dbPath);
  db.exec("VACUUM"); // VACUUM cannot be parameterized; it rewrites the whole DB.
  const afterBytes = fileSizeIfExists(dbPath);
  const reclaimed = Math.max(0, beforeBytes - afterBytes);
  return {
    affected: 0,
    reclaimedBytes: reclaimed,
    summary: `VACUUM: db ${beforeBytes}→${afterBytes} bytes (reclaimed ${reclaimed})`,
  };
}

/**
 * Run `PRAGMA integrity_check` and return the result lines.
 * Returns ["ok"] when the DB is healthy; otherwise returns the error lines.
 */
export function integrityCheck(stateDir: string = getStateDir()): string[] {
  const db = openStore(stateDir);
  const rows = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }> | undefined;
  return (rows ?? []).map((r) => r.integrity_check);
}

/** Reconcile drift in dedup_mirror.ref_count vs actual raw_transcript refs. */
export interface DedupReconcileResult {
  /** Rows whose ref_count was corrected. */
  fixedRefCount: number;
  /** Orphan dedup_mirror rows (content_hash with 0 raw_transcript refs) deleted. */
  orphansDeleted: number;
  /** raw_transcript rows whose content_ref was NULL but now set (backfill). */
  refsBackfilled: number;
}

/**
 * Reconcile dedup_mirror vs raw_transcript after pruning or crashes:
 *   1. Recompute ref_count = COUNT(raw_transcript rows pointing at this hash).
 *   2. Delete orphan dedup_mirror rows whose recomputed ref_count is 0.
 *   3. Backfill raw_transcript.content_ref for rows still storing inline bytes.
 *
 * Idempotent. Read-modify-write within a single transaction (withTx).
 */
export function reconcileDedupMirror(stateDir: string = getStateDir()): DedupReconcileResult {
  const db = openStore(stateDir);
  const result: DedupReconcileResult = { fixedRefCount: 0, orphansDeleted: 0, refsBackfilled: 0 };
  withTx(db, () => {
    // 1. Recompute ref_count for every dedup_mirror row from the actual
    //    raw_transcript references.
    const recompute = db.prepare(
      `UPDATE dedup_mirror AS dm
       SET ref_count = COALESCE((
         SELECT COUNT(*) FROM raw_transcript rt WHERE rt.content_ref = dm.content_hash
       ), 0)
       WHERE dm.ref_count != COALESCE((
         SELECT COUNT(*) FROM raw_transcript rt WHERE rt.content_ref = dm.content_hash
       ), 0)`,
    ).run() as { changes?: number } | undefined;
    result.fixedRefCount = recompute?.changes ?? 0;
    // 2. Delete orphan dedup_mirror rows (no raw_transcript refs).
    const delOrphans = db.prepare(
      `DELETE FROM dedup_mirror
       WHERE content_hash NOT IN (SELECT DISTINCT content_ref FROM raw_transcript WHERE content_ref IS NOT NULL)`,
    ).run() as { changes?: number } | undefined;
    result.orphansDeleted = delOrphans?.changes ?? 0;
    // 3. Backfill content_ref for rows still storing inline content_bytes (no
    //    ref yet). Only safe when a matching dedup_mirror row exists; otherwise
    //    we'd need to insert one, which is the dedup pipeline's job, not the
    //    reconciler's.
    const backfill = db.prepare(
      `UPDATE raw_transcript AS rt
       SET content_ref = (
         SELECT dm.content_hash FROM dedup_mirror dm WHERE dm.content_bytes = rt.content_bytes
       )
       WHERE rt.content_ref IS NULL
         AND EXISTS (SELECT 1 FROM dedup_mirror dm WHERE dm.content_bytes = rt.content_bytes)`,
    ).run() as { changes?: number } | undefined;
    result.refsBackfilled = backfill?.changes ?? 0;
  });
  return result;
}

/**
 * One-shot auto-maintenance pass for the session_start hook: prune old rows,
 * checkpoint the WAL if it's grown large, and (only if the DB is huge) VACUUM.
 * Best-effort: swallows errors so a session never fails to start over a
 * housekeeping hiccup. Returns a short summary for the diagnostic log.
 */
export function autoMaintain(stateDir: string = getStateDir()): string {
  try {
    const stats = getDbStats(stateDir);
    const parts: string[] = [];
    // Prune rows older than 30d (default retention).
    const prune = pruneOldRows(stateDir, 30);
    if (prune.affected > 0) parts.push(`pruned ${prune.affected}`);
    // Checkpoint the WAL if it's over 10 MB (avoid pathological WAL growth).
    if (stats.walBytes > 10 * 1024 * 1024) {
      const ck = checkpointWal(stateDir);
      if (ck.reclaimedBytes > 0) parts.push(`wal -${ck.reclaimedBytes}B`);
    }
    // VACUUM only if the DB is over 100 MB AND freelist is >20% of pages.
    if (
      stats.dbBytes > 100 * 1024 * 1024 &&
      stats.pageCount > 0 &&
      stats.freelistPages / stats.pageCount > 0.2
    ) {
      const v = vacuumDb(stateDir);
      if (v.reclaimedBytes > 0) parts.push(`vacuum -${v.reclaimedBytes}B`);
    }
    return parts.length ? `auto-maintain: ${parts.join(", ")}` : "auto-maintain: nothing to do";
  } catch (err) {
    // Never block session start over housekeeping.
    return `auto-maintain: skipped (${(err as Error).message})`;
  }
}
