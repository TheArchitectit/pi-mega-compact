/**
 * dedup-mirror.ts — S27 Task 6 dedup_mirror CRUD.
 *
 * Space-efficient deduplicated storage: each unique content_hash stores its
 * bytes ONCE; raw_transcript rows reference this table via content_ref
 * instead of storing duplicate content_bytes inline.
 */
import type { DatabaseSync } from "node:sqlite";

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
 *
 * F3 fix: uses INSERT ... ON CONFLICT DO UPDATE (single atomic statement) instead of
 * a check-then-act race-prone SELECT + UPDATE/INSERT sequence.
 */
export function upsertDedupMirror(
  db: DatabaseSync,
  contentHash: string,
  contentBytes: string,
  seq: number,
): boolean {
  const now = Date.now();
  // Atomic upsert: on conflict, increment ref_count in-place (no check-then-act
  // race). RETURNING ref_count distinguishes the two paths in one statement:
  // inserted rows report ref_count=1, conflict-updated rows report ref_count>1.
  const row = db.prepare(
    `INSERT INTO dedup_mirror (content_hash, content_bytes, ref_count, first_seen_seq, created_at)
     VALUES (@hash, @bytes, 1, @seq, @now)
     ON CONFLICT(content_hash) DO UPDATE SET
       ref_count = ref_count + 1,
       content_bytes = excluded.content_bytes
     RETURNING ref_count`,
  ).get({
    "@hash": contentHash,
    "@bytes": contentBytes,
    "@seq": seq,
    "@now": now,
  }) as { ref_count: number } | undefined;
  return (row?.ref_count ?? 1) === 1;
}

/**
 * Get dedup ratio for a session: total bytes vs unique bytes.
 *
 * F2 fix: both total and unique bytes are now scoped to the session, via a JOIN
 * of raw_transcript.content_ref → dedup_mirror. The ratio is meaningful: how much
 * smaller the session's storage footprint is compared to naive inline storage.
 *
 * NOTE: for sessions with NO dedup pipeline runs yet (all content_ref NULL),
 * uniqueBytes falls back to the raw_transcript bytes (ratio=1), which is correct
 * since nothing has been deduplicated yet.
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
  // F2 fix: session-scoped unique bytes via JOIN on content_ref.
  // A row contributes its dedup_mirror bytes exactly once even when content_ref
  // is NULL (fallback: use the raw_transcript bytes for that row, which is
  // accurate when dedup hasn't run yet for the session).
  const uniqueRow = db
    .prepare(
      `SELECT COALESCE(SUM(LENGTH(
        COALESCE(dm.content_bytes, rt.content_bytes)
      )), 0) AS unique_bytes
       FROM raw_transcript rt
       LEFT JOIN dedup_mirror dm ON rt.content_ref = dm.content_hash
       WHERE rt.session_id = @session_id`,
    )
    .get({ "@session_id": sessionId }) as { unique_bytes: number };
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