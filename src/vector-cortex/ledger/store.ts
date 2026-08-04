/**
 * vector-cortex/ledger/store.ts — VC1B capability-separated ledger contracts.
 *
 * Owns `LedgerReader` / `LedgerWriter` / `LedgerAdmin` and `CompatJournalV1`.
 * The ledger is append-only, seq is monotonic per session, a tool RESULT names
 * exactly one earlier call in the same session, and duplicates are identified by
 * `(eventId, digest)` only (two occurrences may share bytes at distinct seq).
 *
 * Capability gating mirrors the host `asReader/asWriter/asAdmin` pattern: a
 * consumer receives ONLY what it needs. Dashboard GET receives `LedgerReader`;
 * only ingestion receives `LedgerWriter`; only the migration coordinator
 * receives `LedgerAdmin`. This keeps the neutral byte-authority ledger closed to
 * anything but the sanctioned channels (CONTRACTS §Store and migration
 * contracts).
 *
 * Pure type/schema definitions + small pure predicates. No storage, no console,
 * no network, no side effects (PREVENT-PI-004 / PREVENT-011).
 */

/**
 * An accepted occurrence in the canonical v2 ledger. This is the durable row
 * shape: the neutral byte authority plus the reference envelope. `digest` is the
 * authoritative `sha256:${string}` of `sourceBytes`; `sourceBytes` round-trips
 * exactly (never reconstructed from normalized text).
 */
export interface LedgerOccurrence {
  /** The source session the occurrence belongs to (ledger scopes by session). */
  readonly session: string;
  /** Monotonic per-session sequence (never regresses for an accepted row). */
  readonly seq: bigint;
  /** Stable occurrence identity within the session (the EventV2 eventId). */
  readonly eventId: string;
  /** SHA-256 over sourceBytes (authoritative, `sha256:<hex>`). */
  readonly digest: string;
  /** Neutral occurrence kind (policy/user/assistant/tool/message...). */
  readonly kind: string;
  /** On a tool RESULT, references exactly one earlier call in this session. */
  readonly toolCallId?: string;
  /** Authoritative original bytes (byte authority). */
  readonly sourceBytes: Uint8Array;
}

/**
 * Identifier of a tool pair for a RESULT row: names exactly one earlier CALL's
 * (session-local) eventId. Absent on non-result rows.
 */
export interface LedgerToolRef {
  /** The session-local eventId of the CALL this RESULT closes. */
  readonly callEventId: string;
}

/** Failure codes the writer surfaces on a rejected append (write path). */
export type LedgerAppendCode = "EVT_TOOL_CALL_MISSING" | "EVT_SEQ_REGRESSION";

/** Result of a single append attempt. */
export type LedgerAppendResult =
  | { ok: true; occurrence: LedgerOccurrence }
  | { ok: false; code: LedgerAppendCode; rejected: LedgerOccurrence };

/**
 * Reader capability: read-access only. The dashboard's `GET
 * /api/vector-cortex/ledger` is built on exactly this surface and nothing more —
 * it can read counts/order/digests but never mutate.
 */
export interface LedgerReader {
  readonly kind: "LedgerReader";
  /** Accept the latest contiguous high-water (durable authority), or 0. */
  highWater(session: string): bigint;
  /** Contiguous accepted occurrences for a session in ascending `(seq,eventId)`. */
  readSession(session: string): readonly LedgerOccurrence[];
  /** Occurrences at or above `fromSeq` (inclusive) for a session. */
  readFrom(session: string, fromSeq: bigint): readonly LedgerOccurrence[];
  /** Count of accepted occurrences for a session. */
  count(session: string): number;
  /** Whether a `(eventId, digest)` pair is already accepted (unique key). */
  hasOccurrence(session: string, eventId: string, digest: string): boolean;
}

/**
 * Writer capability: append-only ingestion. Can create occurrences and advance
 * the per-session seq — but cannot read arbitrary history, run migrations, or
 * touch the compat journal. Enforces monotonic seq and tool-call reference
 * completeness on every append.
 */
export interface LedgerWriter {
  readonly kind: "LedgerWriter";
  /** Append one occurrence; rejects on seq regression or a dangling tool ref. */
  append(input: {
    readonly session: string;
    readonly seq: bigint;
    readonly eventId: string;
    readonly kind: string;
    readonly toolCallId?: string;
    readonly sourceBytes: Uint8Array;
    readonly digest?: string;
  }): LedgerAppendResult;
  /** Append a batch, all-or-nothing per occurrence (each returns its outcome). */
  appendBatch(inputs: ReadonlyArray<Parameters<LedgerWriter["append"]>[0]>): LedgerAppendResult[];
  /** Advance the durable contiguous high-water to `seq` (never regresses). */
  advanceHighWater(session: string, seq: bigint): bigint;
}

/**
 * Admin capability: maintenance + migration coordination only. The sole surface
 * with access to the compatibility journal switch and to run the M2
 * copy/validate/switch. Never exposed to ingestion or to the dashboard reader.
 */
export interface LedgerAdmin {
  readonly kind: "LedgerAdmin";
  /** The compatibility journal (downgrade safety). */
  readonly compat: CompatJournalV1;
  /** Prepare + validate + switch the v2 ledger (M2), idempotently. */
  migrateOccurrenceV2(): { ok: boolean; codes: readonly string[] };
  /** Freeze the derived frontier at the durable contiguous high-water. */
  freezeDerivedFrontier(session: string): bigint;
}

/**
 * CompatJournalV1 — the downgrade-safety journal. Every accepted v2 append
 * atomically appends a journal record holding the original bytes, IDs, and a
 * legacy projection or an explicit `unrepresentable` marker. The journal records
 * its own lifecycle state (prepared/copied/validated/switched) so M2 is
 * resumable and a stop mid-journal never corrupts v2.
 */
export interface CompatJournalV1 {
  /** Whether any v2 append has activated the journal (journal present). */
  active(): boolean;
  /**
   * Record a new v2 occurrence into the journal. `legacyProjection` holds the
   * lossless legacy copy, or null when the row has no lossless legacy form — in
   * which case the row is marked `unrepresentable` (e.g. invalid UTF-8 bytes).
   */
  record(input: {
    readonly occurrence: LedgerOccurrence;
    readonly legacyProjection: string | null;
  }): void;
  /** True when a row could not be projected to legacy and is marked. */
  isUnrepresentable(eventId: string, digest: string): boolean;
  /**
   * Prepare a downgrade export: snapshot the journal for the copy/validate/switch
   * lifecycle. Returns the list of unrepresentable rows (EVT/MIG reference).
   */
  prepare(): string[];
  /** Mark the copy phase complete. */
  copied(): void;
  /** Validate the copied legacy export (sequence/digest parity). */
  validate(): { ok: boolean; codes: readonly string[] };
  /** Atomically switch authority to the legacy export (downgrade). */
  switched(): void;
}

// ---------------------------------------------------------------------------
// Factory + capability gating (VC1B)
// ---------------------------------------------------------------------------

import type { DatabaseSync } from "node:sqlite";
import { VC1B_ENABLED } from "../../config/vector-cortex.js";
import {
  openOccurrenceStore,
  appendOccurrence,
  advanceLedgerHighWater,
  ledgerHighWater,
  ledgerDigest,
  readSessionOccurrences,
  readFromSeq,
  countOccurrences,
  hasOccurrence,
} from "./sqlite.js";
import {
  initCompatJournal,
  createCompatJournal,
  journalPhase,
} from "./compat-journal.js";
import {
  m2Copy,
  m2Validate,
  m2Switch,
  type M2Host,
  type LegacyExportRow,
} from "../migrations/occurrence-v2.js";

/** The token that gates closures to a single capability (PREVENT-011-free). */
const _capability: unique symbol = Symbol("mc-ledger-capability");

interface ReaderToken {
  readonly [_capability]: "reader";
}
interface WriterToken {
  readonly [_capability]: "writer";
}
interface AdminToken {
  readonly [_capability]: "admin";
}

/** A capability-gated ledger handle: access only what you were handed. */
export interface LedgerHandle {
  readonly reader: () => LedgerReader & ReaderToken;
  readonly writer: () => LedgerWriter & WriterToken;
  readonly admin: () => LedgerAdmin & AdminToken;
  /** Close the underlying DB handle (test/sandbox teardown). */
  readonly close: () => void;
}

/** Optional structured-event emitter (same shape as the other VC seams). */
export type LedgerEmit = (event: string, fields: Record<string, unknown>) => void;

/**
 * Create the capability-separated occurrence-v2 ledger over its OWN isolated
 * SQLite DB. `emit` is optional; occurrence-appended and compat-switch-committed
 * events are only emitted when VC1B_ENABLED() and an emitter is supplied (mode-C
 * parity: flag OFF / no emitter => zero observability writes).
 *
 * Normalization: `stateDir` gives the standard daemon location
 * `<stateDir>/vector-cortex/occurrence-v2.db`; a bare `dbPath` overrides it
 * (tests/rehearsal isolate the ledger). The compat journal shares the same DB
 * so a v2 append + its journal record commit atomically.
 */
export function createLedgerStore(
  opts: { readonly stateDir: string } | { readonly dbPath: string },
  emit?: LedgerEmit,
): LedgerHandle {
  const dbPath =
    "dbPath" in opts
      ? opts.dbPath
      : `${opts.stateDir}/vector-cortex/occurrence-v2.db`;
  const db = openOccurrenceStore(dbPath);
  initCompatJournal(db);
  const compat = createCompatJournal(db);

  const fire = (event: string, fields: Record<string, unknown>): void => {
    if (!VC1B_ENABLED()) return;
    try {
      emit?.(event, fields);
    } catch {
      /* non-fatal observability — never break the agent loop */
    }
  };

  const asReader = (): LedgerReader & ReaderToken => ({
    kind: "LedgerReader",
    [_capability]: "reader" as const,
    highWater: (session) => ledgerHighWater(db, session),
    readSession: (session) => readSessionOccurrences(db, session),
    readFrom: (session, fromSeq) => readFromSeq(db, session, fromSeq),
    count: (session) => countOccurrences(db, session),
    hasOccurrence: (session, eventId, digest) =>
      hasOccurrence(db, session, eventId, digest),
  });

  const asWriter = (): LedgerWriter & WriterToken => ({
    kind: "LedgerWriter",
    [_capability]: "writer" as const,
    append(input) {
      // S2: flag OFF => the entire write path is inert. Accept the call and
      // synthesize a NON-persisted accepted occurrence so callers keep working,
      // but write nothing and emit nothing (byte-identical predecessor).
      if (!VC1B_ENABLED()) return syntheticAppend(input);
      // The occurrence insert and its compat-journal record commit atomically
      // inside one nested savepoint (CONTRACTS §Store: atomically appends).
      db.exec("SAVEPOINT mc_ledger_app");
      try {
        const result = appendOccurrence(db, input);
        if (result.ok) {
          compat.record({
            occurrence: result.occurrence,
            legacyProjection: legacyProjectionOf(result.occurrence),
          });
        }
        if (result.ok) {
          db.exec("RELEASE mc_ledger_app");
          fire("vector_cortex_occurrence_appended", {
            session: result.occurrence.session,
            seq: result.occurrence.seq.toString(),
            eventId: result.occurrence.eventId,
            digest: result.occurrence.digest,
            kind: result.occurrence.kind,
          });
        } else {
          db.exec("ROLLBACK TO mc_ledger_app");
          db.exec("RELEASE mc_ledger_app");
        }
        return result;
      } catch (e) {
        db.exec("ROLLBACK TO mc_ledger_app");
        db.exec("RELEASE mc_ledger_app");
        throw e;
      }
    },
    appendBatch(inputs) {
      const out = [];
      for (const input of inputs) out.push(this.append(input));
      return out;
    },
    // S2: flag OFF => high-water advance is a no-op (returns the caller's seq
    // unpersisted), keeping the write path byte-identical to the predecessor.
    advanceHighWater: (session, seq) =>
      VC1B_ENABLED() ? advanceLedgerHighWater(db, session, seq) : seq,
  });

  const asAdmin = (): LedgerAdmin & AdminToken => ({
    kind: "LedgerAdmin",
    [_capability]: "admin" as const,
    compat,
    migrateOccurrenceV2() {
      // copy => validate => switch; resumable & idempotent. The M2 host wraps
      // the live DB + journal so every phase transition advances the SAME
      // singleton journal state machine (prepared→copied→validated→switched).
      const unrepresentable = compat.prepare().length;
      const mig = migrateHost(db, compat);
      m2Copy(mig);
      const v = m2Validate(mig);
      if (v.ok) {
        m2Switch(mig);
        fire("vector_cortex_compat_switch_committed", {
          session: "all",
          unrepresentable,
        });
      }
      return { ok: v.ok, codes: v.codes as unknown as string[] };
    },
    freezeDerivedFrontier(session) {
      // The derived frontier cannot exceed the contiguous durable high-water.
      return ledgerHighWater(db, session);
    },
  });

  return { reader: asReader, writer: asWriter, admin: asAdmin, close: () => db.close() };
}

/**
 * S2 flag-off writer result: a synthesized occurrence that mirrors the input
 * (computing the digest if omitted) but is NEVER persisted or emitted. Lets the
 * ingestion path keep working unchanged when MEGACOMPACT_VC1B=0, matching the
 * byte-identical-predecessor requirement (flag OFF == no ledger at all).
 */
function syntheticAppend(input: {
  readonly session: string;
  readonly seq: bigint;
  readonly eventId: string;
  readonly kind: string;
  readonly toolCallId?: string;
  readonly sourceBytes: Uint8Array;
  readonly digest?: string;
}): LedgerAppendResult {
  return {
    ok: true,
    occurrence: {
      session: input.session,
      seq: input.seq,
      eventId: input.eventId,
      kind: input.kind,
      toolCallId: input.toolCallId,
      digest: input.digest ?? ledgerDigest(input.sourceBytes),
      sourceBytes: input.sourceBytes,
    },
  };
}

/**
 * Lossless legacy projection for a v2 occurrence: its identity envelope plus
 * base64 source bytes. Returns null (→ journal `unrepresentable` marker) when the
 * source bytes do not form valid UTF-8, which the legacy pipeline cannot round-trip
 * losslessly — those rows are listed rather than silently coerced (MIG-DOWN-003).
 */
function legacyProjectionOf(occ: LedgerOccurrence): string | null {
  const source = Buffer.from(occ.sourceBytes);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    return null;
  }
  return JSON.stringify({
    session: occ.session,
    eventId: occ.eventId,
    kind: occ.kind,
    digest: occ.digest,
    source: source.toString("base64"),
  });
}

/** Build an M2Host over the live ledger DB + journal (for migrateOccurrenceV2). */
function migrateHost(
  db: DatabaseSync,
  journal: CompatJournalV1,
): M2Host {
  let staged: readonly LegacyExportRow[] | null = null;
  return {
    db,
    phase: () => journalPhase(db),
    journalActive: () => journal.active(),
    journalRows: () => journalRowsOf(db),
    writeStagedLegacy: (rows) => {
      staged = rows;
      journal.copied();
    },
    stagedLegacy: () => staged,
    validateStaged: () => journal.validate(),
    switchLegacy: () => journal.switched(),
  };
}

/** Read the journaled occurrences as legacy-export rows. */
function journalRowsOf(db: DatabaseSync): readonly LegacyExportRow[] {
  const rows = db
    .prepare(
      `SELECT session, seq, event_id, digest, kind, legacy_projection, unrepresentable
       FROM compat_journal_v1 ORDER BY session ASC, seq ASC`,
    )
    .all() as unknown as Array<{
    session: string;
    seq: number;
    event_id: string;
    digest: string;
    kind: string;
    legacy_projection: string | null;
    unrepresentable: number;
  }>;
  return rows.map((r) => ({
    session: r.session,
    seq: BigInt(r.seq),
    eventId: r.event_id,
    digest: r.digest,
    kind: r.kind,
    legacyProjection: r.legacy_projection,
    unrepresentable: r.unrepresentable === 1,
  }));
}
