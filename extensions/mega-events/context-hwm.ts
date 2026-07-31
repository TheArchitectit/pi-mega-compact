/**
 * mega-events/context-hwm.ts — high-water mark for DB-mirror raw_transcript
 * incremental append (F3 sprint).
 *
 * Stores the last-processed seq + content_hash per session so the context
 * event only appends the tail on subsequent events. On fork/rewind (shorter
 * message list or hash mismatch at the boundary), the mark is dropped so the
 * next event falls back to a full reprocess.
 *
 * Non-fatal: every function logs and swallows errors; the agent loop is never
 * broken (repo invariant).
 *
 * All queries parameterized (PREVENT-002); no `any` (PREVENT-011).
 */
import type { DatabaseSync } from "node:sqlite";

export interface ContextHwm {
  sessionId: string;
  lastSeq: number;
  lastContentHash: string;
}

const TABLE_DDL = `CREATE TABLE IF NOT EXISTS context_hwm (
  session_id        TEXT PRIMARY KEY,
  last_seq          INTEGER NOT NULL,
  last_content_hash TEXT NOT NULL
)`;

/** Ensure the context_hwm table exists. Idempotent. */
export function ensureHwmTable(db: DatabaseSync): void {
  try {
    db.exec(TABLE_DDL);
  } catch {
    // non-fatal
  }
}

/** Read the high-water mark for a session. Returns undefined if none. */
export function readHwm(
  db: DatabaseSync,
  sessionId: string,
): ContextHwm | undefined {
  try {
    const row = db
      .prepare(
        "SELECT session_id, last_seq, last_content_hash FROM context_hwm WHERE session_id = ?",
      )
      .get(sessionId) as
      | { session_id: string; last_seq: number; last_content_hash: string }
      | undefined;
    if (!row) return undefined;
    return {
      sessionId: row.session_id,
      lastSeq: Number(row.last_seq),
      lastContentHash: row.last_content_hash,
    };
  } catch {
    return undefined;
  }
}

/** Write (INSERT OR REPLACE) the high-water mark for a session. */
export function writeHwm(
  db: DatabaseSync,
  hwm: ContextHwm,
): void {
  try {
    db.prepare(
      "INSERT OR REPLACE INTO context_hwm (session_id, last_seq, last_content_hash) VALUES (?, ?, ?)",
    ).run(hwm.sessionId, hwm.lastSeq, hwm.lastContentHash);
  } catch {
    // non-fatal
  }
}

/** Drop the high-water mark for a session (invalidation). */
export function dropHwm(db: DatabaseSync, sessionId: string): void {
  try {
    db.prepare("DELETE FROM context_hwm WHERE session_id = ?").run(sessionId);
  } catch {
    // non-fatal
  }
}

export const TEST_ONLY = { TABLE_DDL };
