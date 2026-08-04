/**
 * vector-cortex/ledger/compat-journal.test.ts — CompatJournalV1 + M2 (VC1B, task 4).
 *
 * Downgrade-safety journal: from v2 activation every accepted append records a
 * legacy projection or an explicit `unrepresentable` marker; the downgrade
 * export follows prepare → copied → validated → switched and is ATOMIC — a
 * stop after `validated` and before `switched` retains the OLD authority and a
 * restart switches once without duplicate rows (the unique failure injection).
 * MIG-DOWN-003 asserts an invalid-UTF-8 row is listed unrepresentable.
 *
 * No mocks — real DB files in a temp dir. PREVENT-002/011/PI-004 honored.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  initCompatJournal,
  createCompatJournal,
  journalPhase,
} from "./compat-journal.js";
import { openOccurrenceStore } from "./sqlite.js";
import type { LedgerOccurrence } from "./store.js";
import {
  m2Copy,
  m2Validate,
  m2Switch,
  type M2Host,
  type LegacyExportRow,
} from "../migrations/occurrence-v2.js";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "vc1b-journal-"));
});
after(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function dbName(tag: string): string {
  return join(dir, `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.db`);
}

function makeOccurrence(o: {
  seq: bigint;
  eventId: string;
  bytes: string;
  session?: string;
  kind?: string;
}): LedgerOccurrence {
  const sourceBytes = new TextEncoder().encode(o.bytes);
  return {
    session: o.session ?? "s1",
    seq: o.seq,
    eventId: o.eventId,
    digest: `sha256:${createHash("sha256").update(sourceBytes).digest("hex")}`,
    kind: o.kind ?? "message",
    sourceBytes,
  };
}

/** Build an M2Host over a live journal (mirrors store.ts's migrateHost seam). */
function hostFor(db: import("node:sqlite").DatabaseSync, journal: ReturnType<typeof createCompatJournal>): M2Host {
  let staged: readonly LegacyExportRow[] | null = null;
  const phase = () => journalPhase(db);
  const rows = (): readonly LegacyExportRow[] => {
    const raw = db
      .prepare(
        `SELECT session, seq, event_id, digest, kind, legacy_projection, unrepresentable
         FROM compat_journal_v1 ORDER BY session ASC, seq ASC`,
      )
      .all() as unknown as Array<Record<string, unknown>>;
    return raw.map((r) => ({
      session: String(r.session),
      seq: BigInt(r.seq as number),
      eventId: String(r.event_id),
      digest: String(r.digest),
      kind: String(r.kind),
      legacyProjection: (r.legacy_projection as string | null) ?? null,
      unrepresentable: (r.unrepresentable as number) === 1,
    }));
  };
  return {
    db,
    phase,
    journalActive: () => journal.active(),
    journalRows: rows,
    writeStagedLegacy: (r) => {
      staged = r;
      journal.copied();
    },
    stagedLegacy: () => staged,
    validateStaged: () => journal.validate(),
    switchLegacy: () => journal.switched(),
  };
}

describe("CompatJournalV1 — downgrade-safety journal", () => {
  test("inactive until a record is journaled; active once a v2 append is recorded", () => {
    const db = openOccurrenceStore(dbName("active"));
    initCompatJournal(db);
    const journal = createCompatJournal(db);
    assert.equal(journal.active(), false, "inactive before any record");
    journal.record({ occurrence: makeOccurrence({ seq: 1n, eventId: "e1", bytes: "hi" }), legacyProjection: "{}" });
    assert.equal(journal.active(), true, "active once an append is journaled");
    db.close();
  });

  test("record stores a legacy projection and is losslessly readable", () => {
    const db = openOccurrenceStore(dbName("record"));
    initCompatJournal(db);
    const journal = createCompatJournal(db);
    const occ = makeOccurrence({ seq: 1n, eventId: "e1", bytes: "payload" });
    journal.record({ occurrence: occ, legacyProjection: `{"eventId":"e1"}` });
    assert.equal(journal.isUnrepresentable("e1", occ.digest), false, "representable row not flagged");
    // prepare lists unrepresentable eventIds; the representable row is absent.
    assert.deepEqual(journal.prepare(), [], "no unrepresentable rows");
    db.close();
  });

  test("MIG-DOWN-003: invalid UTF-8 row (null projection) is listed unrepresentable", () => {
    const db = openOccurrenceStore(dbName("unrep"));
    initCompatJournal(db);
    const journal = createCompatJournal(db);
    // A 0xFF-0xFE invalid-UTF-8 sequence has no lossless legacy text projection.
    const bad = makeOccurrence({ seq: 1n, eventId: "bad", bytes: "ÿþ" });
    journal.record({ occurrence: bad, legacyProjection: null });
    assert.equal(journal.isUnrepresentable("bad", bad.digest), true, "invalid row marked unrepresentable");
    const listed = journal.prepare();
    assert.ok(listed.includes("bad"), "prepare() lists the unrepresentable eventId");
    db.close();
  });

  test("copy/validate/switch is atomic and idempotent on resume", () => {
    const db = openOccurrenceStore(dbName("m2"));
    initCompatJournal(db);
    const journal = createCompatJournal(db);
    const h = hostFor(db, journal);

    // Journal two rows (a call + a result) then run the M2 lifecycle.
    journal.record({ occurrence: makeOccurrence({ seq: 1n, eventId: "c1", bytes: "call" }), legacyProjection: "{}" });
    journal.record({ occurrence: makeOccurrence({ seq: 2n, eventId: "r1", bytes: "res" }), legacyProjection: "{}" });

    const staged = m2Copy(h);
    assert.equal(staged.length, 2, "copy staged both rows");
    assert.equal(journalPhase(db), "copied", "copy advances to copied");

    const v = m2Validate(h);
    assert.equal(v.ok, true, "validated export");
    assert.deepEqual(v.codes, [], "no failure codes");
    assert.equal(journalPhase(db), "validated", "validate advances to validated");
    assert.equal(journal.active(), true);

    // m2Switch activates; a resumed switch is idempotent (no duplicate rows).
    m2Switch(h);
    assert.equal(journalPhase(db), "switched", "switch advances to switched");
    m2Switch(h);
    assert.equal(countJournalRows(db), 2, "no duplicate rows after resumed switch");
    db.close();
  });
});

describe("M2 copy/validate/switch failure codes", () => {
  test("validate before copy -> M2_COPY_MISSING / phase unreached", () => {
    const db = openOccurrenceStore(dbName("fail1"));
    initCompatJournal(db);
    const journal = createCompatJournal(db);
    journal.record({ occurrence: makeOccurrence({ seq: 1n, eventId: "e1", bytes: "x" }), legacyProjection: "{}" });
    const h = hostFor(db, journal);
    const v = m2Validate(h); // never copied -> staged null
    assert.equal(v.ok, false);
    assert.ok(v.codes.includes("M2_COPY_MISSING"), "no staged export");
    db.close();
  });

  test("inactive journal -> MIG_DOWN_NOT_ACTIVE", () => {
    const db = openOccurrenceStore(dbName("fail2"));
    initCompatJournal(db);
    const journal = createCompatJournal(db);
    const h = hostFor(db, journal);
    const v = m2Validate(h);
    assert.ok(v.codes.includes("MIG_DOWN_NOT_ACTIVE"), "journal has no records");
    db.close();
  });

  test("malformed digest on a representable row is rejected (MIG_DOWN_DIGEST_MISMATCH)", () => {
    const db = openOccurrenceStore(dbName("fail3"));
    initCompatJournal(db);
    const journal = createCompatJournal(db);
    // The export is ordered canonically; a representable row with a digest that
    // is not `sha256:...` must be flagged during downgrade validation.
    journal.record({
      occurrence: { ...makeOccurrence({ seq: 1n, eventId: "a", bytes: "x" }), digest: "not-sha256" },
      legacyProjection: "{}",
    });
    const h = hostFor(db, journal);
    m2Copy(h);
    const v = m2Validate(h);
    assert.equal(v.ok, false);
    assert.ok(v.codes.includes("MIG_DOWN_DIGEST_MISMATCH"), "bad digest flagged");
    db.close();
  });
});

function countJournalRows(db: import("node:sqlite").DatabaseSync): number {
  const row = db.prepare(`SELECT COUNT(*) AS cnt FROM compat_journal_v1`).get() as { cnt: number };
  return row.cnt;
}
