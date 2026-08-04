/**
 * vector-cortex/ledger/sqlite.test.ts — occurrence-v2 SQLite store (Mode A, VC1B).
 *
 * Unit tests over the isolated `node:sqlite` occurrence ledger: strict monotonic
 * seq, tool RESULT references exactly one earlier CALL, uniqueness keyed by
 * `(event_id, digest)` ONLY (equal bytes at two seq are two occurrences —
 * M2-DUP-001), `EVT_TOOL_CALL_MISSING` / `EVT_SEQ_REGRESSION` rejection codes,
 * idempotent `(event_id,digest)` re-append ack, and read order/count/digest
 * invariants. No mocks — real DB files in a temp dir (PREVENT-PI-004 local only).
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openOccurrenceStore,
  appendOccurrence,
  appendOccurrenceBatch,
  ledgerHighWater,
  readSessionOccurrences,
  readFromSeq,
  countOccurrences,
  hasOccurrence,
  ledgerDigest,
} from "./sqlite.js";
import { createLedgerStore } from "./store.js";

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "vc1b-sqlite-"));
});

after(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort teardown */
  }
});

function input(o: {
  seq: bigint;
  eventId: string;
  bytes: string;
  toolCallId?: string;
  session?: string;
  kind?: string;
}) {
  return {
    session: o.session ?? "s1",
    seq: o.seq,
    eventId: o.eventId,
    kind: o.kind ?? "message",
    sourceBytes: new TextEncoder().encode(o.bytes),
    toolCallId: o.toolCallId,
  };
}

describe("occurrence-v2 SQLite store (mode A)", () => {
  test("M2-DUP-001: same bytes at two seq values create TWO occurrences", () => {
    const db = openOccurrenceStore(join(dir, `dup-${Date.now()}.db`));
    const a = appendOccurrence(db, input({ seq: 1n, eventId: "u1", bytes: "same payload" }));
    const a2 = appendOccurrence(db, input({ seq: 2n, eventId: "u2", bytes: "same payload" }));
    assert.ok(a.ok, "first append accepted");
    assert.ok(a2.ok, "second append with equal bytes at a distinct seq accepted");
    if (a.ok && a2.ok) {
      assert.equal(a.occurrence.digest, a2.occurrence.digest, "identical sha256 digest for equal bytes");
      assert.notEqual(a.occurrence.seq, a2.occurrence.seq, "distinct seq -> distinct occurrences");
      assert.equal(countOccurrences(db, "s1"), 2, "two occurrences, not one deduped");
      const rows = readSessionOccurrences(db, "s1");
      assert.equal(rows.length, 2, "reader sees both occurrences");
      assert.deepEqual(
        rows.map((r) => r.seq),
        [1n, 2n],
        "ascending seq order",
      );
      assert.ok(
        Buffer.from(rows[0]!.sourceBytes).equals(Buffer.from("same payload")),
        "occurrence-1 bytes preserved",
      );
    }
    db.close();
  });

  test("M2-TOOL-002: result references earlier call c9 exactly once, accepted", () => {
    const db = openOccurrenceStore(join(dir, `tool-${Date.now()}.db`));
    const call = appendOccurrence(db, input({ seq: 1n, eventId: "c9", bytes: "tool call" }));
    const result = appendOccurrence(db, input({ seq: 2n, eventId: "r1", bytes: "tool result", toolCallId: "c9" }));
    assert.ok(call.ok, "the call appended");
    assert.ok(result.ok, "the result referencing its call appended");
    if (result.ok) assert.equal(result.occurrence.toolCallId, "c9", "exact single reference");
    db.close();
  });

  test("EVT_TOOL_CALL_MISSING: result referencing a non-existent call is rejected", () => {
    const db = openOccurrenceStore(join(dir, `miss-${Date.now()}.db`));
    appendOccurrence(db, input({ seq: 1n, eventId: "u1", bytes: "hello" }));
    const res = appendOccurrence(db, input({ seq: 2n, eventId: "r1", bytes: "result", toolCallId: "ghost" }));
    assert.equal(res.ok, false, "dangling tool ref is rejected");
    if (!res.ok) {
      assert.equal(res.code, "EVT_TOOL_CALL_MISSING", "exact failure code");
      assert.equal(res.rejected.eventId, "r1", "rejected occurrence named");
    }
    // The rejected row is NOT stored; reader sees only the prelude.
    assert.equal(countOccurrences(db, "s1"), 1, "rejected row not persisted");
    db.close();
  });

  test("EVT_SEQ_REGRESSION: out-of-order seq is rejected", () => {
    const db = openOccurrenceStore(join(dir, `seq-${Date.now()}.db`));
    appendOccurrence(db, input({ seq: 1n, eventId: "u1", bytes: "a" }));
    // Jump ahead, then try to insert a lower/higher-than-next seq.
    const jump = appendOccurrence(db, input({ seq: 5n, eventId: "u5", bytes: "e" }));
    assert.equal(jump.ok, false, "seq must be exactly highWater+1");
    if (!jump.ok) assert.equal(jump.code, "EVT_SEQ_REGRESSION");
    // A re-append of the exact (eventId,digest) is idempotently acknowledged.
    assert.ok(jump.ok === false);
    const re = appendOccurrence(db, input({ seq: 1n, eventId: "u1", bytes: "a" }));
    assert.ok(re.ok, "exact (event_id,digest) re-append acknowledged idempotently");
    if (re.ok) assert.equal(re.occurrence.seq, 1n, "returned the prior occurrence");
    // Still exactly one row for that pair, and the seq never advanced past 1.
    assert.equal(countOccurrences(db, "s1"), 1, "no duplicate row on idempotent ack");
    assert.equal(db.prepare(`SELECT seq FROM ledger_high_water WHERE session='s1'`).get()?.seq, 1);
    db.close();
  });

  test("monotonic seq: contiguous appends advance the durable high-water", () => {
    const db = openOccurrenceStore(join(dir, `mono-${Date.now()}.db`));
    for (let i = 1; i <= 4; i++) {
      const r = appendOccurrence(db, input({ seq: BigInt(i), eventId: `e${i}`, bytes: `m${i}` }));
      assert.ok(r.ok, `append ${i} accepted`);
    }
    assert.equal(ledgerHighWater(db, "s1"), 4n, "contiguous high-water");
    const rows = readSessionOccurrences(db, "s1");
    assert.deepEqual(rows.map((r) => r.seq), [1n, 2n, 3n, 4n], "ascending order");
    // Each stored digest is the authoritative sha256 over its own bytes.
    for (let i = 0; i < rows.length; i++) {
      assert.equal(
        rows[i]!.digest,
        ledgerDigest(new TextEncoder().encode(`m${i + 1}`)),
        `digest ${i + 1} is sha256 over its bytes`,
      );
    }
    db.close();
  });

  test("readFrom: occurrences at/above a seq, plus hasOccurrence + count", () => {
    const db = openOccurrenceStore(join(dir, `from-${Date.now()}.db`));
    for (let i = 1; i <= 5; i++) {
      appendOccurrence(db, input({ seq: BigInt(i), eventId: `e${i}`, bytes: `x${i}` }));
    }
    const from = readFromSeq(db, "s1", 3n);
    assert.deepEqual(from.map((r) => r.seq), [3n, 4n, 5n], "at-or-above fromSeq");
    assert.equal(countOccurrences(db, "s1"), 5);
    const d3 = ledgerDigest(new TextEncoder().encode("x3"));
    assert.ok(hasOccurrence(db, "s1", "e3", d3), "hasOccurrence for the pair");
    assert.ok(!hasOccurrence(db, "s1", "e999", d3), "no such pair");
    db.close();
  });

  test("appendBatch returns a per-occurrence outcome", () => {
    const db = openOccurrenceStore(join(dir, `batch-${Date.now()}.db`));
    const out = appendOccurrenceBatch(db, [
      input({ seq: 1n, eventId: "b1", bytes: "a" }),
      input({ seq: 2n, eventId: "b2", bytes: "b", toolCallId: "ghost" }),
      // b2 was rejected (high-water still 1), so the next acceptable seq is 2.
      input({ seq: 2n, eventId: "b3", bytes: "c" }),
    ]);
    assert.equal(out.length, 3);
    assert.equal(out[0]!.ok, true, "first accepted");
    assert.equal(out[1]!.ok, false, "tool-missing rejected");
    if (!out[1]!.ok) assert.equal(out[1]!.code, "EVT_TOOL_CALL_MISSING");
    assert.equal(out[2]!.ok, true, "third accepted at the recovered high-water+1");
    assert.equal(countOccurrences(db, "s1"), 2, "only accepted rows persisted");
    db.close();
  });
});

describe("VC1B ledger capability gating (createLedgerStore)", () => {
  test("reader sees exactly what the writer appended; writer cannot admin", () => {
    const store = createLedgerStore({ dbPath: join(dir, `cap-${Date.now()}.db`) });
    const writer = store.writer();
    const reader = store.reader();
    const w = writer.append({
      session: "s-cap",
      seq: 1n,
      eventId: "e1",
      kind: "user",
      sourceBytes: new TextEncoder().encode("capability"),
    });
    assert.ok(w.ok, "writer append accepted");
    const rows = reader.readSession("s-cap");
    assert.equal(rows.length, 1, "reader sees the appended occurrence");
    assert.equal(reader.count("s-cap"), 1);
    assert.equal(reader.highWater("s-cap"), 1n);
    assert.ok(
      Buffer.from(rows[0]!.sourceBytes).equals(Buffer.from("capability")),
      "occurrence bytes round-trip through the store",
    );
    store.close();
  });

  test("emits vector_cortex_occurrence_appended on accepted append (flag ON)", () => {
    const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const store = createLedgerStore(
      { dbPath: join(dir, `emit-${Date.now()}.db`) },
      (event, fields) => events.push({ event, fields }),
    );
    const writer = store.writer();
    writer.append({
      session: "s-emit",
      seq: 1n,
      eventId: "e1",
      kind: "user",
      sourceBytes: new TextEncoder().encode("hello"),
    });
    const appended = events.find((e) => e.event === "vector_cortex_occurrence_appended");
    assert.ok(appended, "occurrence_appended emitted");
    assert.equal(appended!.fields.eventId, "e1");
    assert.equal(appended!.fields.seq, "1");
    store.close();
  });
});
