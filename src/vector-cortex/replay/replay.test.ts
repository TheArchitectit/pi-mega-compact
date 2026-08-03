/**
 * vector-cortex/replay/replay.test.ts — ReplayCutV2 replay scan tests (VC0B).
 *
 * Generates balanced call/result streams and legal anchor floors, runs the v2
 * replay over many turns, and asserts the hard invariants: output is a
 * source-order prefix, zero reordered pairs, zero split pairs, zero orphan tool
 * events. Real logic + generated streams, no mocks.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runReplayV2, extractToolPairs, largestPairSafeSeq, compareOccurrences } from "./replay.js";
import type { ReplayOccurrenceV2 } from "./types.js";

/** Build a balanced tool call/result stream with surrounding message events. */
function buildBalancedStream(
  sessionId: string,
  turns: number,
): ReplayOccurrenceV2[] {
  const out: ReplayOccurrenceV2[] = [];
  let seq = 0n;
  for (let t = 0; t < turns; t++) {
    const callId = `tc-${t}`;
    out.push({
      sessionId,
      seq: ++seq,
      eventId: `msg-${t}-a`,
      role: "assistant",
      kind: "message",
      originalBytes: new TextEncoder().encode(`assistant message ${t}`),
    });
    out.push({
      sessionId,
      seq: ++seq,
      eventId: `call-${t}`,
      role: "assistant",
      kind: "tool_call",
      toolCallId: callId,
      originalBytes: new TextEncoder().encode(`call ${t}`),
    });
    out.push({
      sessionId,
      seq: ++seq,
      eventId: `res-${t}`,
      role: "tool",
      kind: "tool_result",
      toolCallId: callId,
      originalBytes: new TextEncoder().encode(`result ${t}`),
    });
  }
  return out;
}

describe("runReplayV2", () => {
  test("replays a strict source-order prefix up to the effective cut with no orphans", () => {
    const sessionId = "s-vc0b-1";
    const occurrences = buildBalancedStream(sessionId, 50); // seq 1..150
    const requestedSeq = 149n;
    const { report, bytes } = runReplayV2({
      sessionId,
      occurrences,
      requestedSeq,
      committedSeq: 100n,
      capturedHighWater: 120n,
      anchorFloor: 0n,
      mode: "A",
    });
    // effective = min(boundarySafe, committed=100, captured=120); boundarySafe is
    // the largest pair-safe seq <= 149 over pairs (call c, result c+1). 100 is
    // inside a result window (call 100 result 101 => 100<=100<101 => split) so
    // it retreats to call boundary: call at turn? call seqs are 2,5,8,...; the
    // largest call <= 100 is 98 => effective 97.
    assert.equal(report.counts.reordered, 0, "no reordered pairs");
    assert.equal(report.counts.splitPairs, 0, "no split pairs after effective cut");
    assert.equal(report.counts.orphanToolEvents, 0, "no orphan tool events");
    assert.ok(report.counts.replayed <= requestedSeq, "prefix does not exceed request");
    assert.equal(bytes.length, report.counts.bytes);
    // The kept prefix must be a strict ascending subsequence of the stream.
    assert.equal(isAscendingPrefix(occurrences, bytes, report.counts.replayed), true);
  });

  test("10,000 replay turns: zero reordered / split / orphan pairs", () => {
    const sessionId = "s-vc0b-bulk";
    const turns = 10_000; // 30,000 occurrences
    const occurrences = buildBalancedStream(sessionId, turns);
    const requestedSeq = BigInt(occurrences.length);
    const { report } = runReplayV2({
      sessionId,
      occurrences,
      requestedSeq,
      committedSeq: BigInt(occurrences.length) - 1n,
      capturedHighWater: BigInt(occurrences.length),
      anchorFloor: 0n,
      mode: "A",
    });
    assert.equal(report.counts.scanned >= 10_000, true);
    assert.equal(report.counts.reordered, 0, "10k turns: zero reordered pairs");
    assert.equal(report.counts.splitPairs, 0, "10k turns: zero split pairs");
    assert.equal(report.counts.orphanToolEvents, 0, "10k turns: zero orphan tool events");
  });

  test("mode B sequential boundary scan matches mode A effective cut", () => {
    const occurrences = buildBalancedStream("s-vc0b-b", 30);
    const opts = {
      sessionId: "s-vc0b-b",
      occurrences,
      requestedSeq: BigInt(occurrences.length),
      committedSeq: 70n,
      capturedHighWater: 80n,
      anchorFloor: 0n,
    };
    const a = runReplayV2({ ...opts, mode: "A" });
    const b = runReplayV2({ ...opts, mode: "B" });
    assert.equal(a.report.cut.effectiveSeq, b.report.cut.effectiveSeq);
    // Mode B recomputes boundarySafety by a plain scan, so its boundarySafeSeq is
    // the same pair-safe value.
    const pairs = extractToolPairs(occurrences);
    const direct = largestPairSafeSeq(pairs, BigInt(occurrences.length));
    assert.equal(b.report.cut.boundarySafeSeq, direct);
  });

  test("mode C freezes derived high-water and returns zero bytes", () => {
    const emitted: string[] = [];
    const occurrences = buildBalancedStream("s-vc0b-c", 10);
    const { report, bytes } = runReplayV2({
      sessionId: "s-vc0b-c",
      occurrences,
      requestedSeq: BigInt(occurrences.length),
      committedSeq: 1000n,
      capturedHighWater: 42n,
      anchorFloor: 0n,
      mode: "C",
      emit: (ev) => emitted.push(ev),
    });
    assert.equal(bytes.length, 0);
    assert.equal(report.counts.replayed, 0);
    assert.ok(emitted.includes("vector_cortex_replay_highwater_frozen"));
  });

  test("emits cut_retreat events when a pair split occurs", () => {
    const emitted: string[] = [];
    // Stream turns: msgs 1,4,7,10,13; calls 2,5,8,11,14; results 3,6,9,12,15.
    const occurrences = buildBalancedStream("s-vc0b-retreat", 20);
    // committed lands exactly on call seq 11 (call 11, result 12) => the min is
    // inside a pair and the effective cut must retreat to call boundary (10).
    const { report } = runReplayV2({
      sessionId: "s-vc0b-retreat",
      occurrences,
      requestedSeq: 15n,
      committedSeq: 11n,
      capturedHighWater: 14n,
      anchorFloor: 0n,
      mode: "A",
      emit: (ev) => emitted.push(ev),
    });
    assert.equal(report.cut.effectiveSeq, 10n);
    assert.ok(emitted.includes("vector_cortex_replay_cut_retreat"));
    assert.ok(report.retreats.some((r) => r.code === "CUT_TOOL_PAIR_SPLIT"));
    assert.equal(report.counts.orphanToolEvents, 0);
  });

  test("ascending (seq,eventId) comparator is total and matches source order", () => {
    const a: ReplayOccurrenceV2 = { sessionId: "s", seq: 1n, eventId: "a", role: "user", kind: "m" };
    const b: ReplayOccurrenceV2 = { sessionId: "s", seq: 1n, eventId: "b", role: "user", kind: "m" };
    const c: ReplayOccurrenceV2 = { sessionId: "s", seq: 2n, eventId: "a", role: "user", kind: "m" };
    assert.ok(compareOccurrences(a, b) < 0);
    assert.ok(compareOccurrences(b, c) < 0);
    assert.ok(compareOccurrences(a, c) < 0);
    assert.equal(compareOccurrences(a, a), 0);
  });
});

/** True when `bytes` is exactly the concatenation of the first `count`
 * occurrences' originalBytes in source order (the replayed prefix). */
function isAscendingPrefix(
  occurrences: readonly ReplayOccurrenceV2[],
  bytes: Uint8Array,
  count: number,
): boolean {
  const prefix = occurrences.slice(0, count);
  const expected = new Uint8Array(
    prefix.reduce((acc, o) => acc + (o.originalBytes?.length ?? 0), 0),
  );
  let off = 0;
  for (const o of prefix) {
    const b = o.originalBytes;
    if (b) {
      expected.set(b, off);
      off += b.length;
    }
  }
  return Buffer.from(bytes).equals(Buffer.from(expected));
}
