/**
 * dedup.ts — S27 Task 6: Fork snapshot → compress/dedupe pipeline.
 *
 * After the served window is handed to pi, asynchronously:
 * 1. Read raw_transcript rows [0..cut_index] for the epoch
 * 2. For each row, compute content_hash (reuse digest from dedup/)
 * 3. INSERT OR IGNORE INTO dedup_mirror (stores bytes once per unique hash)
 * 4. Update raw_transcript.content_ref to point to dedup_mirror
 * 5. Increment dedup_mirror.ref_count for existing hashes
 *
 * Pi-agnostic: no pi runtime imports (src/ invariant).
 */

import type { DatabaseSync } from "node:sqlite";
import {
  upsertDedupMirror,
  updateRawTranscriptRef,
  listRawTranscriptRange,
  getDedupRatio,
} from "../store/sqlite.js";
import { computeContentDigest } from "../dedup/digest.js";

/**
 * Deduplicate raw transcript rows for a session range.
 * Fire-and-forget: errors are logged, not thrown.
 *
 * @returns Number of rows deduplicated, or -1 on error.
 */
export function dedupTranscript(
  db: DatabaseSync,
  sessionId: string,
  fromSeq: number,
  toSeq: number,
): number {
  try {
    const rows = listRawTranscriptRange(db, sessionId, fromSeq, toSeq);
    let deduped = 0;
    for (const row of rows) {
      const contentHash = computeContentDigest(row.contentBytes).contentHash;
      const isNew = upsertDedupMirror(db, contentHash, row.contentBytes, row.seq);
      updateRawTranscriptRef(db, sessionId, row.seq, contentHash);
      if (!isNew) {
        deduped++;
      }
    }
    return deduped;
  } catch (err) {
    // Fire-and-forget: log but don't throw
    console.error("[mega-compact] dedupTranscript failed:", err);
    return -1;
  }
}

/**
 * Get dedup ratio for a session.
 */
export { getDedupRatio };
