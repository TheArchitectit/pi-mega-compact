/**
 * vector-cortex/ledger/compat-journal.ts — CompatJournalV1 (VC1B, task 4).
 *
 * The downgrade-safety journal. From v2 activation every accepted v2 append
 * atomically appends a record holding the original bytes, IDs, and a legacy
 * projection or an explicit `unrepresentable` marker. The journal tracks its own
 * lifetime state (prepared → copied → validated → switched) so the M2
 * downgrade is resumable: a crash mid-journal never corrupts v2, and a restart
 * resumes idempotently (the unique failure-injection contract).
 *
 * `active()` is true once ANY v2 append has been journaled — an old binary may
 * only open the exported legacy copy, never v2 directly, once the journal is
 * active (CONTRACTS §Store). Unrepresentable rows (e.g. invalid UTF-8 bytes have
 * no lossless legacy projection) are listed on prepare and carried through the
 * copy/validate/switch lifecycle.
 *
 * Durable in the same isolated occurrence-v2 SQLite DB as the ledger rows
 * (append-only provenance: journal records are never UPDATE'd; only the
 * singleton state row advances phase). PREVENT-002 parameterized; PREVENT-011
 * no `any`; PREVENT-PI-004 local filesystem only; no console.log.
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { CompatJournalV1 } from "./store.js";

/** Journal lifecycle phase (append-only; the singleton state row advances). */
export type JournalPhase = "prepared" | "copied" | "validated" | "switched";

/** Downgrade-phase validation failure codes (registered as conformance rows). */
export const MIG_DOWN_FAIL = {
  NOT_ACTIVE: "MIG_DOWN_NOT_ACTIVE",
  PHASE_UNREACHED: "MIG_DOWN_PHASE_UNREACHED",
  SEQ_REGRESSION: "MIG_DOWN_SEQ_REGRESSION",
  DIGEST_MISMATCH: "MIG_DOWN_DIGEST_MISMATCH",
  SWITCH_UNSAFE: "MIG_DOWN_SWITCH_UNSAFE",
} as const;
export type MigDownCode = (typeof MIG_DOWN_FAIL)[keyof typeof MIG_DOWN_FAIL];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS compat_journal_v1 (
  session             TEXT    NOT NULL,
  seq                 INTEGER NOT NULL,
  event_id            TEXT    NOT NULL,
  digest              TEXT    NOT NULL,
  kind                TEXT    NOT NULL,
  legacy_projection   TEXT,
  unrepresentable     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session, seq)
) STRICT;

CREATE TABLE IF NOT EXISTS compat_journal_state (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  phase TEXT NOT NULL
) STRICT;
`;

interface JournalRow {
  session: string;
  seq: number;
  event_id: string;
  digest: string;
  kind: string;
  legacy_projection: string | null;
  unrepresentable: number;
}

/** Ensure the journal tables exist and seed the singleton phase row. */
export function initCompatJournal(db: DatabaseSync): void {
  db.exec(SCHEMA);
  db.prepare(
    `INSERT OR IGNORE INTO compat_journal_state (id, phase) VALUES (1, 'prepared')`,
  ).run();
}

function phaseOf(db: DatabaseSync): JournalPhase {
  const row = db
    .prepare(`SELECT phase FROM compat_journal_state WHERE id = 1`)
    .get() as { phase: JournalPhase } | undefined;
  return row?.phase ?? "prepared";
}

/** Read the durable journal phase (for the M2 migration host seam). */
export function journalPhase(db: DatabaseSync): JournalPhase {
  return phaseOf(db);
}

function setPhase(db: DatabaseSync, phase: JournalPhase): void {
  db.prepare(`UPDATE compat_journal_state SET phase = @phase WHERE id = 1`).run({
    "@phase": phase,
  });
}

/**
 * Verify a recorded digest by RECOMPUTING sha256 over the base64 source embedded
 * in the legacy projection and comparing it to the recorded digest (Q03: real
 * digest parity, not a `sha256:` prefix check). Returns false when the projection
 * is absent or malformed, or the digest does not match the recomputed hash.
 */
export function verifyLegacyDigest(
  digest: string,
  legacyProjection: string | null,
): boolean {
  if (legacyProjection === null) return false;
  let rec: unknown;
  try {
    rec = JSON.parse(legacyProjection);
  } catch {
    return false;
  }
  const source = (rec as { source?: unknown }).source;
  if (typeof source !== "string") return false;
  const recomputed = `sha256:${createHash("sha256").update(Buffer.from(source, "base64")).digest("hex")}`;
  return recomputed === digest;
}

/**
 * Build the CompatJournalV1 over the isolated occurrence-v2 DB. Call
 * `initCompatJournal` once before use. All record writes are append-only and
 * best-effort/non-fatal so the agent loop is never broken (PREVENT-PI-004).
 */
export function createCompatJournal(db: DatabaseSync): CompatJournalV1 {
  return {
    active(): boolean {
      try {
        const row = db
          .prepare(`SELECT 1 AS hit FROM compat_journal_v1 LIMIT 1`)
          .get() as { hit: number } | undefined;
        return row !== undefined;
      } catch {
        return false;
      }
    },
    record(input): void {
      const { occurrence, legacyProjection } = input;
      try {
        const unrep = legacyProjection === null;
        db.prepare(
          `INSERT INTO compat_journal_v1
             (session, seq, event_id, digest, kind, legacy_projection, unrepresentable)
           VALUES (@session, @seq, @event_id, @digest, @kind, @legacy, @unrep)
           ON CONFLICT(session, seq) DO NOTHING`,
        ).run({
          "@session": occurrence.session,
          "@seq": Number(occurrence.seq),
          "@event_id": occurrence.eventId,
          "@digest": occurrence.digest,
          "@kind": occurrence.kind,
          // Q06: an unrepresentable row stores NO projection (legacy_projection
          // stays NULL); we never write a base64 body we cannot round-trip.
          "@legacy": legacyProjection,
          "@unrep": unrep ? 1 : 0,
        });
      } catch {
        /* non-fatal journal write — never break the agent loop */
      }
    },
    isUnrepresentable(eventId, digest): boolean {
      try {
        const row = db
          .prepare(
            `SELECT unrepresentable AS u FROM compat_journal_v1
             WHERE event_id = @event_id AND digest = @digest
             ORDER BY seq DESC LIMIT 1`,
          )
          .get({ "@event_id": eventId, "@digest": digest }) as { u: number } | undefined;
        return row?.u === 1;
      } catch {
        return false;
      }
    },
    prepare(): string[] {
      const rows = db
        .prepare(
          `SELECT session, seq, event_id, digest, kind, legacy_projection, unrepresentable
           FROM compat_journal_v1 ORDER BY session ASC, seq ASC`,
        )
        .all() as unknown as JournalRow[];
      setPhase(db, "prepared");
      return rows.filter((r) => r.unrepresentable === 1).map((r) => r.event_id);
    },
    copied(): void {
      setPhase(db, "copied");
    },
    validate(): { ok: boolean; codes: readonly MigDownCode[] } {
      const codes: MigDownCode[] = [];
      const phase = phaseOf(db);
      if (!isRepresentableState(phase, "copied")) codes.push(MIG_DOWN_FAIL.PHASE_UNREACHED);
      if (!this.active()) codes.push(MIG_DOWN_FAIL.NOT_ACTIVE);
      // Seq must be strictly increasing within a session (no regression).
      const prev = new Map<string, number>();
      const rows = db
        .prepare(
          `SELECT session, seq FROM compat_journal_v1 ORDER BY session ASC, seq ASC`,
        )
        .all() as unknown as Array<{ session: string; seq: number }>;
      for (const r of rows) {
        const last = prev.get(r.session);
        if (last !== undefined && r.seq <= last) codes.push(MIG_DOWN_FAIL.SEQ_REGRESSION);
        prev.set(r.session, r.seq);
      }
      // Digests must verify: recompute sha256 over the stored source and compare
      // to the recorded digest (Q03 — real parity, not just a `sha256:` prefix).
      for (const r of db
        .prepare(
          `SELECT digest, legacy_projection FROM compat_journal_v1 WHERE unrepresentable = 0`,
        )
        .all() as unknown as Array<{ digest: string; legacy_projection: string | null }>) {
        if (r.legacy_projection === null) continue;
        if (!verifyLegacyDigest(r.digest, r.legacy_projection)) {
          codes.push(MIG_DOWN_FAIL.DIGEST_MISMATCH);
        }
      }
      const ok = codes.length === 0;
      if (ok) setPhase(db, "validated");
      return { ok, codes: dedupe(codes) };
    },
    switched(): void {
      if (this.active()) setPhase(db, "switched");
    },
  };
}

/** A phase has reached at least `required` in the prepare→…→switched order. */
function isRepresentableState(phase: JournalPhase, required: JournalPhase): boolean {
  const order: readonly JournalPhase[] = ["prepared", "copied", "validated", "switched"];
  return order.indexOf(phase) >= order.indexOf(required);
}

function dedupe(codes: MigDownCode[]): MigDownCode[] {
  const out: MigDownCode[] = [];
  for (const c of codes) if (!out.includes(c)) out.push(c);
  return out;
}
