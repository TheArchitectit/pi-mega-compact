/**
 * vector-cortex/ledger/sqlite.ts — occurrence-v2 SQLite store, Mode A (VC1B).
 *
 * A self-contained, isolated SQLite store (`node:sqlite` `DatabaseSync`) over its
 * OWN database file — NOT the host `sqlite.db` — so the neutral v2 ledger is a
 * true independent authority, not a host table. Holds the canonical occurrence
 * rows plus per-session monotonic seq and the durable contiguous high-water.
 *
 * The defect M2 fixes: the host `raw_transcript` table keys on
 * `(content_hash, session_id)`, so repeated equal bytes at a later turn are
 * silently dropped. Here the ledger keys occurrences by `(event_id, digest)`
 * ONLY — equal bytes at a distinct seq/event-id are preserved as separate
 * occurrences (M2-DUP-001).
 *
 * Append enforces, per occurrence: (1) strictly monotonic per-session seq
 * (EVT_SEQ_REGRESSION otherwise); (2) a tool RESULT names exactly one earlier
 * call (EVT_TOOL_CALL_MISSING otherwise); (3) exact `(event_id,digest)`
 * re-appends are acknowledged idempotently, never duplicated.
 *
 * Mode A of the VC1B triad: transactional SQLite append. Mode B (`./spool.ts`)
 * is an independent fsync spool; mode C leaves the host transcript unchanged.
 *
 * PREVENT-002: every query is parameterized. PREVENT-011: no `any`.
 * PREVENT-PI-004: local filesystem only, no network. No console.log.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { LedgerAppendResult, LedgerOccurrence } from "./store.js";

/** Failure codes (re-export of the store contract union, kept local for rows). */
export type SqliteAppendCode = "EVT_TOOL_CALL_MISSING" | "EVT_SEQ_REGRESSION";

/** DB row shape for occurrence_v2 (snake_case columns). */
interface OccurrenceDBRow {
  session: string;
  seq: number;
  event_id: string;
  digest: string;
  kind: string;
  tool_call_id: string | null;
  source_bytes: Uint8Array | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS occurrence_v2 (
  session       TEXT    NOT NULL,
  seq           INTEGER NOT NULL,
  event_id      TEXT    NOT NULL,
  digest        TEXT    NOT NULL,
  kind          TEXT    NOT NULL,
  tool_call_id  TEXT,
  source_bytes  BLOB,
  PRIMARY KEY (session, seq),
  UNIQUE (session, event_id, digest)
) STRICT;

CREATE TABLE IF NOT EXISTS ledger_high_water (
  session TEXT PRIMARY KEY,
  seq     INTEGER NOT NULL
) STRICT;
`;

/** Default digest for a row when the caller omits one (sha256 over bytes). */
export function ledgerDigest(bytes: Uint8Array): string {
  const hex = createHash("sha256").update(bytes).digest("hex");
  return `sha256:${hex}`;
}

/** Open (or reuse) the isolated occurrence-v2 ledger DB handle. */
export function openOccurrenceStore(dbPath: string): DatabaseSync {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

function rowToOccurrence(row: OccurrenceDBRow): LedgerOccurrence {
  return {
    session: row.session,
    seq: BigInt(row.seq),
    eventId: row.event_id,
    digest: row.digest,
    kind: row.kind,
    toolCallId: row.tool_call_id ?? undefined,
    sourceBytes: row.source_bytes ? Buffer.from(row.source_bytes) : new Uint8Array(0),
  };
}

/** Current durable contiguous high-water for a session (0 when none). */
export function ledgerHighWater(db: DatabaseSync, session: string): bigint {
  const row = db
    .prepare(`SELECT seq FROM ledger_high_water WHERE session = @session`)
    .get({ "@session": session }) as { seq: number } | undefined;
  return row ? BigInt(row.seq) : 0n;
}

/** Read all accepted occurrences for a session in ascending (seq,eventId). */
export function readSessionOccurrences(db: DatabaseSync, session: string): LedgerOccurrence[] {
  const rows = db
    .prepare(
      `SELECT session, seq, event_id, digest, kind, tool_call_id, source_bytes
       FROM occurrence_v2 WHERE session = @session
       ORDER BY seq ASC, event_id ASC`,
    )
    .all({ "@session": session }) as unknown as OccurrenceDBRow[];
  return rows.map(rowToOccurrence);
}

/** Occurrences at or above `fromSeq` (inclusive), ascending. */
export function readFromSeq(db: DatabaseSync, session: string, fromSeq: bigint): LedgerOccurrence[] {
  const rows = db
    .prepare(
      `SELECT session, seq, event_id, digest, kind, tool_call_id, source_bytes
       FROM occurrence_v2 WHERE session = @session AND seq >= @from
       ORDER BY seq ASC, event_id ASC`,
    )
    .all({ "@session": session, "@from": Number(fromSeq) }) as unknown as OccurrenceDBRow[];
  return rows.map(rowToOccurrence);
}

/** Count accepted occurrences for a session. */
export function countOccurrences(db: DatabaseSync, session: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS cnt FROM occurrence_v2 WHERE session = @session`)
    .get({ "@session": session }) as { cnt: number };
  return row.cnt;
}

/** Whether a `(event_id, digest)` pair is already accepted in a session. */
export function hasOccurrence(db: DatabaseSync, session: string, eventId: string, digest: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS hit FROM occurrence_v2
       WHERE session = @session AND event_id = @event_id AND digest = @digest LIMIT 1`,
    )
    .get({ "@session": session, "@event_id": eventId, "@digest": digest }) as { hit: number } | undefined;
  return row !== undefined;
}

/** The stored occurrence matching a `(event_id, digest)` pair, or undefined. */
function findOccurrence(
  db: DatabaseSync,
  session: string,
  eventId: string,
  digest: string,
): LedgerOccurrence | undefined {
  const row = db
    .prepare(
      `SELECT session, seq, event_id, digest, kind, tool_call_id, source_bytes
       FROM occurrence_v2
       WHERE session = @session AND event_id = @event_id AND digest = @digest LIMIT 1`,
    )
    .get({ "@session": session, "@event_id": eventId, "@digest": digest }) as OccurrenceDBRow | undefined;
  return row ? rowToOccurrence(row) : undefined;
}

/** Whether a prior call row with the given eventId exists in the session. */
function hasCallRef(db: DatabaseSync, session: string, eventId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS hit FROM occurrence_v2
       WHERE session = @session AND event_id = @event_id LIMIT 1`,
    )
    .get({ "@session": session, "@event_id": eventId }) as { hit: number } | undefined;
  return row !== undefined;
}

/**
 * Append one occurrence within a transaction. Enforces monotonic seq, tool-call
 * reference completeness, and `(event_id,digest)` idempotent ack. Returns the
 * accepted row or a deterministic failure code.
 */
export function appendOccurrence(
  db: DatabaseSync,
  input: {
    readonly session: string;
    readonly seq: bigint;
    readonly eventId: string;
    readonly kind: string;
    readonly toolCallId?: string;
    readonly sourceBytes: Uint8Array;
    readonly digest?: string;
  },
): LedgerAppendResult {
  const digest = input.digest ?? ledgerDigest(input.sourceBytes);
  const occurrence: LedgerOccurrence = {
    session: input.session,
    seq: input.seq,
    eventId: input.eventId,
    digest,
    kind: input.kind,
    toolCallId: input.toolCallId,
    sourceBytes: input.sourceBytes,
  };

  // (3) exact (event_id,digest) re-append is acknowledged idempotently, WITHOUT
  // inserting a new row. Return the EXISTING stored occurrence (its real seq) —
  // not the caller's input — so a journal record written from this result carries
  // the existing seq, which always corresponds to a real occurrence_v2 row (Q01:
  // never a phantom journal row at a seq with no backing occurrence).
  const existing = findOccurrence(db, input.session, input.eventId, digest);
  if (existing) {
    return { ok: true, occurrence: existing };
  }

  // (1) monotonic seq: must be exactly the next expected seq (highWater+1).
  const hw = ledgerHighWater(db, input.session);
  if (input.seq !== hw + 1n) {
    return { ok: false, code: "EVT_SEQ_REGRESSION", rejected: occurrence };
  }

  // (2) a tool RESULT names exactly one earlier call in the same session.
  if (input.toolCallId !== undefined && input.toolCallId !== "") {
    if (!hasCallRef(db, input.session, input.toolCallId)) {
      return { ok: false, code: "EVT_TOOL_CALL_MISSING", rejected: occurrence };
    }
  }

  // Accept: insert the row and advance the per-session high-water atomically.
  db.exec("SAVEPOINT mc_ledger");
  try {
    db.prepare(
      `INSERT INTO occurrence_v2 (session, seq, event_id, digest, kind, tool_call_id, source_bytes)
       VALUES (@session, @seq, @event_id, @digest, @kind, @tool_call_id, @source_bytes)`,
    ).run({
      "@session": input.session,
      "@seq": Number(input.seq),
      "@event_id": input.eventId,
      "@digest": digest,
      "@kind": input.kind,
      "@tool_call_id": input.toolCallId ?? null,
      "@source_bytes": Buffer.from(input.sourceBytes),
    });
    db.prepare(
      `INSERT INTO ledger_high_water (session, seq) VALUES (@session, @seq)
       ON CONFLICT(session) DO UPDATE SET seq = excluded.seq`,
    ).run({ "@session": input.session, "@seq": Number(input.seq) });
    db.exec("RELEASE mc_ledger");
  } catch (e) {
    db.exec("ROLLBACK TO mc_ledger");
    db.exec("RELEASE mc_ledger");
    throw e;
  }
  return { ok: true, occurrence };
}

/** Append a batch; each occurrence reports its own result. */
export function appendOccurrenceBatch(
  db: DatabaseSync,
  inputs: ReadonlyArray<Parameters<typeof appendOccurrence>[1]>,
): LedgerAppendResult[] {
  return inputs.map((input) => appendOccurrence(db, input));
}

/** Diagnostic: total accepted occurrences across all sessions. */
export function countAllOccurrences(db: DatabaseSync): number {
  const row = db.prepare(`SELECT COUNT(*) AS cnt FROM occurrence_v2`).get() as { cnt: number };
  return row.cnt;
}
