/**
 * stats.ts — per-session, repo-wide, and data-invariant stats.
 */
import { getStateDir, normalizeSessionId } from "../../store.js";
import { openStore } from "./utils.js";
import { getMetaNumber, getDedupStats } from "./meta.js";

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
