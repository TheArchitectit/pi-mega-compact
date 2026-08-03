/**
 * vector-cortex/replay/cut.test.ts — ReplayCutV2 effective-cut calculator tests
 * (VC0B). Mirrors the conformance fixtures CUT-PAIR-001 / CUT-ANCHOR-002 /
 * CUT-HIGHWATER-003 plus deterministic tie-break + boundary cases. Real logic,
 * no mocks.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  computeEffectiveCutV2,
  cutIsPairSafe,
} from "./cut.js";
import type { ReplayToolPair } from "./types.js";

function cut(
  requestedSeq: number,
  boundarySafeSeq: number,
  committedSeq: number,
  capturedHighWater: number,
  anchorFloor: number,
  pairs: { callSeq: number; resultSeq: number }[] = [],
) {
  return computeEffectiveCutV2({
    requestedSeq: BigInt(requestedSeq),
    boundarySafeSeq: BigInt(boundarySafeSeq),
    committedSeq: BigInt(committedSeq),
    capturedHighWater: BigInt(capturedHighWater),
    anchorFloor: BigInt(anchorFloor),
    pairs: pairs.map((p) => ({ callSeq: BigInt(p.callSeq), resultSeq: BigInt(p.resultSeq) })),
  });
}

describe("ReplayCutV2 effective cut", () => {
  test("CUT-PAIR-001: requested cut between call c7 and result r7 retreats before c7", () => {
    const { cut: c, retreats } = cut(8, 8, 9, 9, 0, [{ callSeq: 7, resultSeq: 9 }]);
    assert.equal(c.effectiveSeq, 6n, "retreats before the call (call-1)");
    assert.ok(retreats.some((r) => r.code === "CUT_TOOL_PAIR_SPLIT"));
    assert.equal(c.effectiveSeq, c.requestedSeq - 2n);
  });

  test("CUT-ANCHOR-002: retreat cannot cross the recent-anchor floor", () => {
    const { cut: c, retreats } = cut(9, 9, 8, 7, 5, [{ callSeq: 6, resultSeq: 8 }]);
    assert.equal(c.effectiveSeq, 5n); // pair retreat target == legal floor
    assert.equal(c.effectiveSeq >= 5n, true, "effective never below the floor");
    assert.ok(retreats.some((r) => r.code === "CUT_TOOL_PAIR_SPLIT"));
  });

  test("CUT-HIGHWATER-003: captured high-water below committed seq wins", () => {
    const { cut: c, retreats } = cut(10, 10, 9, 4, 0);
    assert.equal(c.effectiveSeq, 4n);
    assert.equal(retreats.length, 0);
  });

  test("effective is min(boundarySafe, committed, captured) capped by requested", () => {
    // committed unique min.
    assert.equal(cut(20, 20, 3, 9, 0).cut.effectiveSeq, 3n);
    // captured unique min (CUT-HIGHWATER).
    assert.equal(cut(30, 30, 28, 9, 0).cut.effectiveSeq, 9n);
    // all sources above request -> capped to requested.
    assert.equal(cut(6, 30, 40, 50, 0).cut.effectiveSeq, 6n);
  });

  test("tie among min sources resolves to the LOWER source order", () => {
    const { cut: c, retreats } = cut(20, 20, 5, 5, 0);
    assert.equal(c.effectiveSeq, 5n);
    assert.ok(retreats.some((r) => r.code === "CUT_LOWEST_SOURCE_ORDER"));
  });

  test("cut inside a pair retreats to the call boundary (not the requested value)", () => {
    const { cut: c, retreats } = cut(16, 16, 13, 14, 0, [{ callSeq: 12, resultSeq: 15 }]);
    assert.equal(c.effectiveSeq, 11n);
    assert.ok(retreats.some((r) => r.code === "CUT_TOOL_PAIR_SPLIT"));
  });

  test("anchor floor above the min raises the cut without splitting", () => {
    const { cut: c, retreats } = cut(10, 5, 3, 2, 4);
    assert.equal(c.effectiveSeq, 4n); // floor wins
    assert.ok(retreats.some((r) => r.code === "CUT_ANCHOR_FLOOR"));
    assert.equal(cutIsPairSafe(c.effectiveSeq, [] as ReplayToolPair[]), true);
  });
});

describe("cutIsPairSafe", () => {
  test("arbitrary interleavings: result preserved without its call is unsafe", () => {
    const pairs: ReplayToolPair[] = [{ callSeq: 3n, resultSeq: 8n }];
    assert.equal(cutIsPairSafe(7n, pairs), false); // call dropped, result kept
    assert.equal(cutIsPairSafe(8n, pairs), true); // whole pair kept
    assert.equal(cutIsPairSafe(2n, pairs), true); // whole pair dropped
  });
});

describe("retreat no-progress guard (VC0B-I12)", () => {
  test("anchor floor sitting inside a tool pair terminates instead of hanging", () => {
    // Floor 7 lies strictly inside pair (call 6, result 10); candidate 9 splits
    // it. The retreat target (call-1 = 5) is below the floor, so without the
    // no-progress guard the loop re-finds the same pair forever. With the guard
    // it clamps AT the floor once and returns.
    const { cut: c, retreats } = cut(9, 9, 9, 9, 7, [{ callSeq: 6, resultSeq: 10 }]);
    assert.equal(c.effectiveSeq, 7n, "clamps at the floor, never below it");
    assert.ok(retreats.some((r) => r.code === "CUT_ANCHOR_FLOOR"));
  });

  test("floor inside pair with a lower pair also terminates", () => {
    // Floor 7 splits pair (6,10) — a malformed input (a legal floor must be
    // pair-safe), but the no-progress guard must still terminate rather than
    // re-find the same pair forever. Retreat lands on the lower pair boundary
    // (10), which is above the floor, so it stops there without hanging.
    const { cut: c } = cut(12, 12, 12, 12, 7, [
      { callSeq: 6, resultSeq: 10 },
      { callSeq: 11, resultSeq: 13 },
    ]);
    assert.equal(c.effectiveSeq, 10n, "terminates at the pair boundary, no hang");
    assert.ok(c.effectiveSeq >= 7n, "never retreats below the floor");
  });
});
