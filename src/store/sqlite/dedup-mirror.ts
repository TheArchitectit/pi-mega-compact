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
 *
 * L2: both halves are now SESSION-scoped so the ratio is meaningful. Previously
 * `totalBytes` was session-scoped but `uniqueBytes` summed the GLOBAL dedup_mirror
 * (which is content-hash keyed, cross-session) — mixing scopes made the per-session
 * ratio meaningless when multiple sessions shared the mirror. We now count unique
 * bytes as the dedup_mirror payloads actually referenced by THIS session's
 * raw_transcript rows, matching the total's scope.
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
      `SELECT COALESCE(SUM(LENGTH(dm.content_bytes)), 0) AS unique_bytes
       FROM dedup_mirror dm
       WHERE dm.content_hash IN (
         SELECT DISTINCT content_ref FROM raw_transcript
         WHERE session_id = @session_id AND content_ref IS NOT NULL
       )`,
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
