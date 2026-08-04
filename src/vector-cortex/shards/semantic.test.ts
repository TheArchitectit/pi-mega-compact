/**
 * vector-cortex/shards/semantic.test.ts — semantic tier partition unit tests
 * (VC4A). Drives the REAL `partitionSemantic` against hand-built EventV2
 * streams: boundary-exact, split-at-boundary, single-over-budget, empty,
 * range-metadata, cross-session, invalid-target, contiguous-coverage,
 * count-and-bytes, deterministic-digest. No mocks (no-mock-data/no-stubs).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createEventCodec } from "../ledger/event-codec.js";
import type { EventV2 } from "../ledger/types.js";
import { partitionSemantic, cumulativeOffsets } from "./semantic.js";

const codec = createEventCodec();

/** Build an EventV2 occurrence (valid UTF-8 text bytes) at `seq`. */
function msg(sessionId: string, seq: number, text: string): EventV2 {
  return codec.encode({
    sessionId,
    seq: BigInt(seq),
    eventId: `e${seq}`,
    role: "user",
    kind: "message",
    bytes: new TextEncoder().encode(text),
    occurredAtMs: 0n,
  });
}

/** Flatten all semantic shards' covered ranges for coverage checks. */
function coveredRanges(
  shards: readonly { range: { byteStart: number; byteEnd: number } }[],
): Array<[number, number]> {
  return shards.map((s) => [s.range.byteStart, s.range.byteEnd]);
}

describe("partitionSemantic", () => {
  test("boundary-exact: a stream that fills exactly one budget yields one shard", () => {
    const events = [msg("s", 1, "aaaa"), msg("s", 2, "bbbb"), msg("s", 3, "cccc")];
    const r = partitionSemantic({ sessionId: "s", events, targetSize: 12 });
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("unreachable");
    assert.equal(r.shards.length, 1);
    assert.equal(r.shards[0].eventCount, 3);
    assert.equal(r.shards[0].byteCount, 12);
    assert.equal(r.shards[0].range.seqStart, 1n);
    assert.equal(r.shards[0].range.seqEnd, 3n);
    assert.equal(r.shards[0].range.byteStart, 0);
    assert.equal(r.shards[0].range.byteEnd, 12);
  });

  test("split-at-boundary: splits ONLY at complete record boundaries", () => {
    const events = [msg("s", 1, "aaaa"), msg("s", 2, "bbbb"), msg("s", 3, "cccc"), msg("s", 4, "dddd")];
    const r = partitionSemantic({ sessionId: "s", events, targetSize: 8 });
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("unreachable");
    assert.equal(r.shards.length, 2);
    // No shard may ever split a record: each shard's byteCount equals the sum of
    // its complete events, and ranges are contiguous.
    for (const s of r.shards) assert.equal(s.range.byteEnd - s.range.byteStart, s.byteCount);
  });

  test("single-over-budget: an over-budget record gets its own complete shard", () => {
    const events = [msg("s", 1, "abcdefgh")];
    const r = partitionSemantic({ sessionId: "s", events, targetSize: 4 });
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("unreachable");
    assert.equal(r.shards.length, 1);
    assert.equal(r.shards[0].byteCount, 8);
    assert.equal(r.shards[0].eventCount, 1);
  });

  test("empty-stream: no events yields zero shards", () => {
    const r = partitionSemantic({ sessionId: "s", events: [], targetSize: 16 });
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("unreachable");
    assert.deepEqual(r.shards, []);
  });

  test("range-metadata: preserves exact source seq + byte window", () => {
    const events = [msg("s", 1, "aaaa"), msg("s", 2, "bbbb"), msg("s", 3, "cccc"), msg("s", 4, "dddd")];
    const r = partitionSemantic({ sessionId: "s", events, targetSize: 8 });
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("unreachable");
    // Shards: [1,2] bytes[0,8) and [3,4] bytes[8,16).
    assert.deepEqual(coveredRanges(r.shards), [
      [0, 8],
      [8, 16],
    ]);
  });

  test("cross-session: mixed-session events reject with SHD_CROSS_SESSION", () => {
    const events = [msg("s", 1, "aaaa"), { ...msg("OTHER", 2, "bbbb") }];
    const r = partitionSemantic({ sessionId: "s", events, targetSize: 16 });
    assert.equal(r.ok, false);
    if (r.ok) throw new Error("unreachable");
    assert.equal(r.code, "SHD_CROSS_SESSION");
  });

  test("invalid-target: a non-positive target size rejects with SHD_INVALID_TARGET_SIZE", () => {
    const r = partitionSemantic({ sessionId: "s", events: [msg("s", 1, "a")], targetSize: 0 });
    assert.equal(r.ok, false);
    if (r.ok) throw new Error("unreachable");
    assert.equal(r.code, "SHD_INVALID_TARGET_SIZE");
  });

  test("contiguous-coverage: semantic ranges tile the stream disjointly + contiguously", () => {
    const events = [msg("s", 1, "aaa"), msg("s", 2, "bbb"), msg("s", 3, "ccc"), msg("s", 4, "ddd")];
    const r = partitionSemantic({ sessionId: "s", events, targetSize: 3 });
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("unreachable");
    const ranges = coveredRanges(r.shards);
    assert.deepEqual(ranges, [
      [0, 3],
      [3, 6],
      [6, 9],
      [9, 12],
    ]);
    // Disjoint + contiguous: each next range starts exactly where the prior ends.
    for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i][0], ranges[i - 1][1]);
  });

  test("count-and-bytes: eventCount and byteCount match the covered records", () => {
    const events = [msg("s", 1, "aaaa"), msg("s", 2, "bbbb")];
    const r = partitionSemantic({ sessionId: "s", events, targetSize: 8 });
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("unreachable");
    assert.equal(r.shards[0].eventCount, 2);
    assert.equal(r.shards[0].byteCount, 8);
  });

  test("deterministic-digest: identical input yields identical shard digests", () => {
    const events = [msg("s", 1, "aaaa"), msg("s", 2, "bbbb")];
    const a = partitionSemantic({ sessionId: "s", events, targetSize: 4 });
    const b = partitionSemantic({ sessionId: "s", events, targetSize: 4 });
    assert.equal(a.ok && b.ok, true);
    if (!a.ok || !b.ok) throw new Error("unreachable");
    assert.deepEqual(a.shards.map((s) => s.digest), b.shards.map((s) => s.digest));
  });

  test("cumulativeOffsets: total equals the stream byte length", () => {
    const events = [msg("s", 1, "aaaa"), msg("s", 2, "bbbb")];
    assert.equal(cumulativeOffsets(events).total, 8);
    assert.equal(cumulativeOffsets([]).total, 0);
  });
});
