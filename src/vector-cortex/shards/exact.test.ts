/**
 * vector-cortex/shards/exact.test.ts — exact tier partition unit tests (VC4A).
 * Drives the REAL `partitionExact` against hand-built EventV2 streams and
 * ProtectedSpans: pair-atomicity (SHD-PAIR-001), verbatim invalid-UTF-8
 * preservation (SHD-UTF8-002), group-by-budget, empty-protected, cross-session,
 * invalid-target. No mocks (no-mock-data/no-stubs).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createEventCodec } from "../ledger/event-codec.js";
import type { EventV2 } from "../ledger/types.js";
import { partitionExact } from "./exact.js";
import type { ProtectedSpan } from "./types.js";

const codec = createEventCodec();

/** Build a valid-UTF-8 event at `seq`. */
function msg(seq: number, text: string): EventV2 {
  return codec.encode({
    sessionId: "s",
    seq: BigInt(seq),
    eventId: `e${seq}`,
    role: "user",
    kind: "message",
    bytes: new TextEncoder().encode(text),
    occurredAtMs: 0n,
  });
}

/** Build an event with arbitrary (possibly invalid-UTF-8) bytes at `seq`. */
function raw(seq: number, bytes: Uint8Array): EventV2 {
  return codec.encode({
    sessionId: "s",
    seq: BigInt(seq),
    eventId: `e${seq}`,
    role: "user",
    kind: "message",
    bytes,
    occurredAtMs: 0n,
  });
}

/** A protected span of one or more events. */
function pair(...events: EventV2[]): ProtectedSpan {
  return { events, case: "tool-pair" };
}
function anchorOf(ev: EventV2): ProtectedSpan {
  return { events: [ev], case: "anchor" };
}
function invalidOf(ev: EventV2): ProtectedSpan {
  return { events: [ev], case: "invalid-utf8" };
}

describe("partitionExact", () => {
  test("pair-atomic (SHD-PAIR-001): a call/result pair spanning the boundary stays in ONE shard", () => {
    // Pair = events 1 (2 bytes) + 2 (4 bytes) = 6 bytes; budget 4 would straddle.
    const call = msg(1, "aa");
    const result = msg(2, "bbbb");
    const r = partitionExact({
      sessionId: "s",
      events: [call, result],
      protectedSpans: [pair(call, result)],
      targetSize: 4,
    });
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("unreachable");
    assert.equal(r.shards.length, 1, "pair must never be split");
    assert.equal(r.shards[0].byteCount, 6);
    assert.equal(r.shards[0].range.seqStart, 1n);
    assert.equal(r.shards[0].range.seqEnd, 2n);
    // Verbatim bytes preserved exactly (call bytes then result bytes in order).
    const joined = new TextDecoder().decode(r.shards[0].originalBytes);
    assert.equal(joined, "aabbbb");
  });

  test("pair-honors-verbatim (SHD-PAIR-001): original bytes unchanged, not re-encoded", () => {
    const call = msg(1, "call");
    const result = msg(2, "result");
    const r = partitionExact({
      sessionId: "s",
      events: [call, result],
      protectedSpans: [pair(call, result)],
      targetSize: 16,
    });
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("unreachable");
    assert.deepEqual(Array.from(r.shards[0].originalBytes), Array.from(call.originalBytes).concat(Array.from(result.originalBytes)));
  });

  test("invalid-utf8 preserved (SHD-UTF8-002): invalid bytes carried verbatim as base64-invalid, never lossy-replaced", () => {
    // 0xFF 0xFE is not valid UTF-8 (fatal decode throws).
    const bad = raw(1, new Uint8Array([0xff, 0xfe]));
    assert.equal(bad.utf8.valid, false, "fixture must be invalid UTF-8");
    const r = partitionExact({
      sessionId: "s",
      events: [bad],
      protectedSpans: [invalidOf(bad)],
      targetSize: 16,
    });
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("unreachable");
    assert.equal(r.shards[0].case, "invalid-utf8");
    // The exact shard copies originalBytes directly — the two invalid bytes are present.
    assert.equal(r.shards[0].originalBytes[0], 0xff);
    assert.equal(r.shards[0].originalBytes[1], 0xfe);
    assert.equal(r.shards[0].byteCount, 2);
  });

  test("group-by-budget: protected spans group up to the budget, closing at a complete span", () => {
    const a = msg(1, "aa"); // 2
    const b = msg(2, "bb"); // 2
    const c = msg(3, "ccc"); // 3
    const r = partitionExact({
      sessionId: "s",
      events: [a, b, c],
      protectedSpans: [anchorOf(a), anchorOf(b), anchorOf(c)],
      targetSize: 4,
    });
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("unreachable");
    // a+b = 4 fills; c=3 starts a new shard.
    assert.equal(r.shards.length, 2);
    assert.equal(r.shards[0].byteCount, 4);
    assert.equal(r.shards[1].byteCount, 3);
  });

  test("empty-protected: no protected spans yields zero exact shards", () => {
    const r = partitionExact({
      sessionId: "s",
      events: [msg(1, "aa"), msg(2, "bb")],
      protectedSpans: [],
      targetSize: 16,
    });
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("unreachable");
    assert.deepEqual(r.shards, []);
  });

  test("cross-session: a protected span referencing an absent/wrong-session event rejects", () => {
    const foreign = codec.encode({
      sessionId: "OTHER",
      seq: 1n,
      eventId: "x",
      role: "user",
      kind: "message",
      bytes: new TextEncoder().encode("x"),
      occurredAtMs: 0n,
    });
    const r = partitionExact({
      sessionId: "s",
      events: [msg(1, "aa")],
      protectedSpans: [anchorOf(foreign)],
      targetSize: 16,
    });
    assert.equal(r.ok, false);
    if (r.ok) throw new Error("unreachable");
    assert.equal(r.code, "SHD_CROSS_SESSION");
  });

  test("invalid-target: non-positive target size rejects with SHD_INVALID_TARGET_SIZE", () => {
    const r = partitionExact({
      sessionId: "s",
      events: [msg(1, "aa")],
      protectedSpans: [anchorOf(msg(1, "aa"))],
      targetSize: -1,
    });
    assert.equal(r.ok, false);
    if (r.ok) throw new Error("unreachable");
    assert.equal(r.code, "SHD_INVALID_TARGET_SIZE");
  });

  test("anchor case: bare anchors produce non-pair, non-invalid shards", () => {
    const a = msg(1, "aaaa");
    const r = partitionExact({
      sessionId: "s",
      events: [a],
      protectedSpans: [anchorOf(a)],
      targetSize: 8,
    });
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("unreachable");
    assert.equal(r.shards[0].case, "anchor");
  });
});
