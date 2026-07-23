/**
 * maintenance.ts — S27 Task 10 DB maintenance / housekeeping primitives.
 *
 * All pi-agnostic, all parameterized (PREVENT-002), all local (PREVENT-PI-004).
 * Exposed via the /mega-db-* slash commands in extensions/mega-db-cmds.ts.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { getStateDir } from "../../store.js";
import { openStore, withTx } from "./utils.js";

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
  // dedup_mirror: the raw_transcript deletes above drop references, but
  // dedup_mirror.ref_count is only ever incremented by the dedup pipeline or
  // fully recomputed by reconcileDedupMirror — the old `WHERE ref_count <= 0`
  // delete only caught rows ALREADY at zero, never decrementing the rows whose
  // referencing transcripts were just deleted. So orphans with inflated
  // ref_count accumulated until a separate reconcile ran (L1). Recompute
  // ref_counts from the now-trimmed raw_transcript and purge true orphans here.
  const delDedup = db.prepare(`DELETE FROM dedup_mirror WHERE ref_count <= 0`).run() as {
    changes?: number;
  } | undefined;
  const dedupDeleted = delDedup?.changes ?? 0;
  // Recompute ref_count for surviving rows + delete newly-orphaned ones. Cheap
  // (two indexed UPDATE/DELETE) and closes the space leak that prune otherwise left.
  const reconciled = reconcileDedupMirror(stateDir);
  const afterBytes = fileSizeIfExists(join(stateDir, "sqlite.db"));
  const total = rtDeleted + epDeleted + dedupDeleted + reconciled.orphansDeleted;
  return {
    affected: total,
    reclaimedBytes: Math.max(0, beforeBytes - afterBytes),
    summary: `pruned ${rtDeleted} raw_transcript + ${epDeleted} epochs + ${dedupDeleted} dedup_mirror rows older than ${daysOld}d (reconciled ${reconciled.fixedRefCount} ref_counts, ${reconciled.orphansDeleted} orphans)`,
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
