/**
 * raw-transcript.ts — S27 durable raw-transcript mirror + checkpoint-epoch registry.
 *
 * ADDITIVE + flag-default-OFF (MEGACOMPACT_DB_MIRROR). No behavior change
 * until the flag is flipped on; the tables are created IF NOT EXISTS on
 * open so existing stores are untouched. These helpers are storage primitives
 * only — the runtime hook (Task 5) wires them into the compaction flow. All
 * queries use @-parameterized placeholders (PREVENT-002); no `any` types
 * (PREVENT-011).
 */
import type { DatabaseSync } from "node:sqlite";
import { withTx } from "./utils.js";

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
