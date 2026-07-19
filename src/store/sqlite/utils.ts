/**
 * utils.ts — shared helpers for the SQLite store submodules.
 *
 * These are the low-level primitives (embed encode/decode, JSON guards,
 * connection cache, `openStore`, `withTx`, row mappers) that every other
 * submodule imports.  Keeping them here avoids circular dependencies:
 * submodules depend on `utils` + `schema`, never on each other (except via
 * the barrel).
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getStateDir } from "../../store.js";
import type { StoredCheckpoint } from "../../store.js";
import { initSchema } from "./schema.js";

// NOTE: normalizeSessionId is imported from ../store.js by each submodule that
// needs it — it is NOT re-exported here (the original sqlite.ts did not export
// it, and we must not add new barrel exports).

/** Encode a float vector as a little-endian Float32 BLOB for cosine scanning. */
export function encodeEmbedding(v: number[]): Buffer {
  const buf = Buffer.allocUnsafe(v.length * 4);
  for (let i = 0; i < v.length; i++) buf.writeFloatLE(v[i] ?? 0, i * 4);
  return buf;
}

/** Decode a Float32 BLOB back to a number[]. node:sqlite returns BLOBs as
 *  Uint8Array, so decode via DataView (Buffer is a Uint8Array subclass — both
 *  work). */
export function decodeEmbedding(buf: Uint8Array | null | undefined): number[] {
  if (!buf || buf.length === 0) return [];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = buf.length / 4;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}

export function jsonText(v: unknown): string {
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

/** Close and evict a cached connection (test teardown only). */
export function closeStore(stateDir: string): void {
  const db = cache.get(stateDir);
  if (db) {
    db.close();
    cache.delete(stateDir);
  }
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
export function rowToCheckpoint(row: any): StoredCheckpoint {
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
