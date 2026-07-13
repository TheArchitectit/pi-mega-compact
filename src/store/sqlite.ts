/**
 * sqlite.ts — Sprint 8 storage backbone (the "one store").
 *
 * Replaces the per-session gzipped-JSON checkpoint files with a single local
 * SQLite database (better-sqlite3, in-process, FS-backed, ZERO network calls —
 * honors PREVENT-PI-004). Chosen over PGlite because PGlite is async-only in
 * every published version, and VectorStore (engine.ts / recall.ts / the
 * extension) is fully synchronous — adopting PGlite would have cascaded async
 * through the whole call chain. SQLite keeps every VectorStore signature sync.
 *
 * FTS5 `trigram` tokenizer is created for the Sprint 9+ dedup tiers (MinHash/LSH
 * / pg_trgm-equivalent verification). The default cosine path stays a linear
 * scan over `embedding_blob` (checkpoint counts are small, no ANN index needed).
 *
 * All queries are parameterized (PREVENT-002) — never string-concatenated.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getStateDir } from "../store.js";
import type { StoredCheckpoint, SessionState } from "../store.js";
import { normalizeSessionId } from "../store.js";

const SCHEMA_VERSION = 1;

/** Encode a float vector as a little-endian Float32 BLOB for cosine scanning. */
function encodeEmbedding(v: number[]): Buffer {
  const buf = Buffer.allocUnsafe(v.length * 4);
  for (let i = 0; i < v.length; i++) buf.writeFloatLE(v[i] ?? 0, i * 4);
  return buf;
}
/** Decode a Float32 BLOB back to a number[]. */
function decodeEmbedding(buf: Buffer | null | undefined): number[] {
  if (!buf || buf.length === 0) return [];
  const n = buf.length / 4;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

function jsonText(v: unknown): string {
  return JSON.stringify(v ?? []);
}

// In-process cache so the same stateDir reuses one connection (and so a fresh
// VectorStore over the same dir shares the open DB). Cross-process durability
// comes from reopening the same file path — proven by the integration test.
const cache = new Map<string, Database.Database>();

/** Open (or reuse) the SQLite store for a state dir. */
export function openStore(stateDir: string = getStateDir()): Database.Database {
  const existing = cache.get(stateDir);
  if (existing) return existing;

  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const db = new Database(join(stateDir, "sqlite.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  cache.set(stateDir, db);
  return db;
}

function initSchema(db: Database.Database): void {
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
      PRIMARY KEY (session_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_raptor_session ON raptor_nodes(session_id);
    CREATE INDEX IF NOT EXISTS idx_raptor_parent ON raptor_nodes(parent_id);
  `);
  const v = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
    | { value: string }
    | undefined;
  if (!v) {
    db.prepare("INSERT INTO meta(key, value) VALUES(?, ?)").run("schema_version", String(SCHEMA_VERSION));
  }

  // FTS5 trigram virtual table (Sprint 9+ pg_trgm-equivalent verification).
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS context_chunks_trgm USING fts5(
      id UNINDEXED,
      normalized_text,
      tokenize='trigram'
    );
  `);
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
    regionHash: row.region_hash ?? "",
    contentHash: row.content_hash ?? undefined,
    contentHash2: row.content_hash2 ?? undefined,
    contentHashVersion: row.content_hash_version ?? undefined,
    normalizedText: row.normalized_text ?? undefined,
    compressedOriginal: row.compressed_original ?? undefined,
    embedding: decodeEmbedding(row.embedding_blob),
    timestamp: Number(row.timestamp ?? 0),
    dedupStatus: row.dedup_status ?? undefined,
  };
}

/** Insert or replace a checkpoint (idempotent by id). */
export function upsertCheckpoint(cp: StoredCheckpoint, stateDir: string = getStateDir()): void {
  const db = openStore(stateDir);
  const sid = normalizeSessionId(cp.sessionId);
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO context_chunks
        (id, session_id, region_hash, content_hash, content_hash2, content_hash_version,
         normalized_text, summary, topic_summary, summary_hash,
         key_decisions, next_steps, files_modified, embedding_blob,
         token_estimate, timestamp, dedup_status, compressed_original)
       VALUES (@id, @sid, @region_hash, @content_hash, @content_hash2, @content_hash_version,
               @normalized_text, @summary, @topic_summary, @summary_hash,
               @key_decisions, @next_steps, @files_modified, @embedding_blob,
               @token_estimate, @timestamp, @dedup_status, @compressed_original)
       ON CONFLICT(session_id, id) DO UPDATE SET
         summary=excluded.summary,
         topic_summary=excluded.topic_summary,
         summary_hash=excluded.summary_hash,
         key_decisions=excluded.key_decisions,
         next_steps=excluded.next_steps,
         files_modified=excluded.files_modified,
         embedding_blob=excluded.embedding_blob,
         token_estimate=excluded.token_estimate,
         timestamp=excluded.timestamp,
         dedup_status=excluded.dedup_status,
         compressed_original=excluded.compressed_original`,
    ).run({
      id: cp.checkpointId,
      sid,
      region_hash: cp.regionHash ?? null,
      content_hash: cp.contentHash ?? null,
      content_hash2: cp.contentHash2 ?? null,
      content_hash_version: cp.contentHashVersion ?? null,
      normalized_text: cp.normalizedText ?? null,
      summary: cp.summary ?? "",
      topic_summary: cp.topicSummary ?? null,
      summary_hash: cp.summaryHash ?? null,
      key_decisions: jsonText(cp.keyDecisions),
      next_steps: jsonText(cp.nextSteps),
      files_modified: jsonText(cp.filesModified),
      embedding_blob: encodeEmbedding(cp.embedding ?? []),
      token_estimate: cp.tokenEstimate ?? 0,
      timestamp: cp.timestamp ?? 0,
      dedup_status: "active",
      compressed_original: cp.compressedOriginal ?? null,
    });

    // FTS5 virtual tables don't support UPSERT — delete any prior row, reinsert.
    // Store normalized_text (the L1 verify key); fall back to summary for rows
    // that predate normalized_text population.
    db.prepare("DELETE FROM context_chunks_trgm WHERE id = ?").run(cp.checkpointId);
    db.prepare(
      "INSERT INTO context_chunks_trgm(id, normalized_text) VALUES(?, ?)",
    ).run(cp.checkpointId, cp.normalizedText ?? cp.summary ?? "");
  });
  tx();
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
  const tx = db.transaction(() => {
    del.run(chunkId);
    for (const key of bucketKeys) ins.run(key, chunkId, sid, signatureVersion);
  });
  tx();
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

function loadSessionStateRow(sid: string, db: Database.Database): SessionState {
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
}

/** Persist a single RAPTOR node (upsert by (session_id, id)). */
export function upsertRaptorNode(node: StoredRaptorNode, stateDir: string = getStateDir()): void {
  const db = openStore(stateDir);
  db.prepare(
    `INSERT INTO raptor_nodes(id, session_id, level, parent_id, children, summary, embedding_blob, quality_marker, token_estimate)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, id) DO UPDATE SET
       level=excluded.level, parent_id=excluded.parent_id, children=excluded.children,
       summary=excluded.summary, embedding_blob=excluded.embedding_blob,
       quality_marker=excluded.quality_marker, token_estimate=excluded.token_estimate`,
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
  );
}

/** Persist an entire built RAPTOR tree for a session (shadow or live). */
export function saveRaptorTree(
  sessionId: string,
  tree: { nodes: Map<string, { id: string; level: number; parentId: string | null; children: string[]; summary: string; embedding: number[]; qualityMarker: string; tokenEstimate: number }> },
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
  }));
}

/** Delete all RAPTOR nodes for a session (rollback/cleanup). */
export function clearRaptorNodes(sessionId: string, stateDir: string = getStateDir()): void {
  const db = openStore(stateDir);
  db.prepare("DELETE FROM raptor_nodes WHERE session_id = ?").run(normalizeSessionId(sessionId));
}
