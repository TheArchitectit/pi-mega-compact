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
import { createReplayReporter } from "./emit.js";
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

  test("mode B is byte-identical to mode A across a forced-retreat parameter corpus", () => {
    // Deliberate spread over committedSeq/capturedHighWater/requestedSeq/anchorFloor
    // values, including many that land INSIDE a call/result pair (forcing a
    // CUT_TOOL_PAIR_SPLIT retreat) and floors that clamp the cut. B must compute
    // the same effectiveSeq and produce identical replayed bytes via its own
    // independent algorithm.
    for (const turns of [5, 10, 20]) {
      const occurrences = buildBalancedStream("s-vc0b-ab-byte", turns);
      const N = BigInt(occurrences.length);
      for (const requestedSeq of [N, N - 1n, 2n, 5n, 7n]) {
        for (const committedSeq of [0n, 2n, 5n, 7n, N, N + 1n]) {
          for (const capturedHighWater of [0n, 4n, 9n, N, N + 5n]) {
            for (const anchorFloor of [0n, 1n, 4n]) {
              const opts = { sessionId: "s-vc0b-ab-byte", occurrences, requestedSeq, committedSeq, capturedHighWater, anchorFloor };
              const a = runReplayV2({ ...opts, mode: "A" });
              const b = runReplayV2({ ...opts, mode: "B" });
              assert.equal(
                b.report.cut.effectiveSeq,
                a.report.cut.effectiveSeq,
                `effectiveSeq diverge (req=${requestedSeq} com=${committedSeq} cap=${capturedHighWater} floor=${anchorFloor})`,
              );
              assert.ok(
                Buffer.from(b.bytes).equals(Buffer.from(a.bytes)),
                `bytes diverge (req=${requestedSeq} com=${committedSeq} cap=${capturedHighWater} floor=${anchorFloor})`,
              );
            }
          }
        }
      }
    }
  });

  test("mode B derives the same effectiveSeq via its own algorithm under forced fixtures", () => {
    // committedSeq lands exactly on call seq 5 (call 5 / result 6): the min is
    // inside a pair, so B (independent streaming) AND A must both land at 4
    // (retreat to call boundary), and B reaches it without A's subroutines.
    const occurrences = buildBalancedStream("s-vc0b-b-own", 10);
    const opts = { sessionId: "s-vc0b-b-own", occurrences, requestedSeq: 8n, committedSeq: 5n, capturedHighWater: 9n, anchorFloor: 0n };
    const b = runReplayV2({ ...opts, mode: "B" });
    assert.equal(b.report.cut.effectiveSeq, 4n, "B retreats to call boundary independently");
    assert.equal(b.report.counts.orphanToolEvents, 0);

    // capturedHighWater wins when it is the smallest, and the anchor floor clamps.
    const opts2 = { ...opts, committedSeq: 30n, capturedHighWater: 5n, anchorFloor: 3n };
    const b2 = runReplayV2({ ...opts2, mode: "B" });
    const a2 = runReplayV2({ ...opts2, mode: "A" });
    assert.equal(b2.report.cut.effectiveSeq, a2.report.cut.effectiveSeq);
    assert.equal(b2.report.cut.effectiveSeq, 4n, "captured+floor resolved identically to A");
  });

  test("mode B boundarySafeSeq matches the independent sequential scan", () => {
    const occurrences = buildBalancedStream("s-vc0b-b", 30);
    const opts = { sessionId: "s-vc0b-b", occurrences, requestedSeq: BigInt(occurrences.length), committedSeq: 70n, capturedHighWater: 80n, anchorFloor: 0n };
    const b = runReplayV2({ ...opts, mode: "B" });
    // B's boundarySafeSeq is its own largest pair-complete seq <= requestedSeq,
    // which must equal the pair-list scan A's largestPairSafeSeq returns.
    const pairs = extractToolPairs(occurrences);
    const direct = largestPairSafeSeq(pairs, BigInt(occurrences.length));
    assert.equal(b.report.cut.boundarySafeSeq, direct);
  });

  test("mode C freezes derived high-water and returns zero bytes via the real C path", () => {
    const emitted: string[] = [];
    const occurrences = buildBalancedStream("s-vc0b-c", 10);
    const reporter = createReplayReporter((ev) => emitted.push(ev));
    const { report, bytes } = runReplayV2({
      sessionId: "s-vc0b-c",
      occurrences,
      requestedSeq: BigInt(occurrences.length),
      committedSeq: 1000n,
      capturedHighWater: 42n,
      anchorFloor: 0n,
      mode: "C",
      reporter,
    });
    assert.equal(bytes.length, 0);
    assert.equal(report.counts.replayed, 0);
    // Exercises the real C branch (not a stub): the frozen event name round-trips
    // through the emit seam and reports the frozen high-water verbatim.
    assert.ok(emitted.includes("vector_cortex_replay_highwater_frozen"));
    assert.equal(report.cut.capturedHighWater, 42n);
  });

  test("emits cut_retreat events when a pair split occurs", () => {
    const emitted: string[] = [];
    // Stream turns: msgs 1,4,7,10,13; calls 2,5,8,11,14; results 3,6,9,12,15.
    const occurrences = buildBalancedStream("s-vc0b-retreat", 20);
    // committed lands exactly on call seq 11 (call 11, result 12) => the min is
    // inside a pair and the effective cut must retreat to call boundary (10).
    const reporter = createReplayReporter((ev) => emitted.push(ev));
    const { report } = runReplayV2({
      sessionId: "s-vc0b-retreat",
      occurrences,
      requestedSeq: 15n,
      committedSeq: 11n,
      capturedHighWater: 14n,
      anchorFloor: 0n,
      mode: "A",
      reporter,
    });
    assert.equal(report.cut.effectiveSeq, 10n);
    assert.ok(emitted.includes("vector_cortex_replay_cut_retreat"));
    assert.ok(report.retreats.some((r) => r.code === "CUT_TOOL_PAIR_SPLIT"));
    assert.equal(report.counts.orphanToolEvents, 0);
  });

  test("modes A and B agree on a stream ending in an unclosed tool call (VC0B-I11)", () => {
    // Trailing dangling call (call d with no result) must bound the cut
    // identically in both modes: both retreat to the last pair-complete seq.
    const sessionId = "s-vc0b-dangling";
    const enc = new TextEncoder();
    const occurrences: ReplayOccurrenceV2[] = [
      { sessionId, seq: 1n, eventId: "m1", role: "assistant", kind: "message", originalBytes: enc.encode("msg") },
      { sessionId, seq: 2n, eventId: "cc", role: "assistant", kind: "tool_call", toolCallId: "c", originalBytes: enc.encode("callc") },
      { sessionId, seq: 3n, eventId: "rc", role: "tool", kind: "tool_result", toolCallId: "c", originalBytes: enc.encode("resc") },
      { sessionId, seq: 4n, eventId: "cd", role: "assistant", kind: "tool_call", toolCallId: "d", originalBytes: enc.encode("calld") },
    ];
    const base = { sessionId, occurrences, requestedSeq: 4n, committedSeq: 4n, capturedHighWater: 4n, anchorFloor: 0n };
    const a = runReplayV2({ ...base, mode: "A" });
    const b = runReplayV2({ ...base, mode: "B" });
    assert.equal(a.report.cut.effectiveSeq, b.report.cut.effectiveSeq, "A and B agree on the cut");
    assert.equal(a.report.cut.effectiveSeq, 3n, "both retreat below the dangling call");
    assert.ok(Buffer.from(a.bytes).equals(Buffer.from(b.bytes)), "byte-identical replayed prefix");
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
