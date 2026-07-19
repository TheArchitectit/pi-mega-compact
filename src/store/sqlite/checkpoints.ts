/**
 * checkpoints.ts — `context_chunks` checkpoint CRUD + MinHash/LSH dedup helpers.
 */
import type { StoredCheckpoint } from "../../store.js";
import { getStateDir, normalizeSessionId } from "../../store.js";
import {
  openStore,
  withTx,
  jsonText,
  encodeEmbedding,
  rowToCheckpoint,
} from "./utils.js";

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
