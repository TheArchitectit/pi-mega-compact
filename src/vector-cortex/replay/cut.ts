/**
 * vector-cortex/replay/cut.ts — ReplayCutV2 effective-cut calculator (VC0B).
 *
 * M3 effective-cut rule: effective = min(boundarySafeSeq, committedSeq,
 * capturedHighWater), capped by requestedSeq, then retreated to the call
 * boundary whenever the candidate intersects a tool call/result pair, then
 * clamped to the recent-anchor floor. On a tie among the min sources we choose
 * the LOWER source order and record CUT_LOWEST_SOURCE_ORDER. This is the
 * successor to the legacy capped-replay effective cut — the defect at
 * docs/vector-cortex/SPRINT_PLAN.md M3 ("capped replay effective cut must
 * respect boundary/commit/capture minima") is fixed here.
 *
 * Pure/deterministic — no network, no side effects (PREVENT-PI-004).
 */

import type {
  ReplayCutV2,
  ReplayRetreatCode,
  ReplayRetreatRecord,
  ReplayToolPair,
} from "./types.js";

export interface EffectiveCutInput {
  /** Caller's desired cap; effective never exceeds this. */
  readonly requestedSeq: bigint;
  /** Largest pair-safe cap (already boundary-safe). */
  readonly boundarySafeSeq: bigint;
  /** Contiguous durable authority high-water. */
  readonly committedSeq: bigint;
  /** Derived high-water captured/frozen at replay start. */
  readonly capturedHighWater: bigint;
  /** Recent-anchor floor (inclusive lower bound the cut never crosses). */
  readonly anchorFloor: bigint;
  /** Tool call/result pairs (callSeq < resultSeq) to reason over. */
  readonly pairs: readonly ReplayToolPair[];
}

export interface EffectiveCutOutput {
  readonly cut: ReplayCutV2;
  readonly retreats: readonly ReplayRetreatRecord[];
}

const MIN_SOURCES = ["boundary", "committed", "captured"] as const;
type MinSource = (typeof MIN_SOURCES)[number];

/**
 * min-of-three, capped by requestedSeq, with deterministic lower-source
 * tie-breaking. Returns the min value and every source that tied for it.
 * On a tie the LOWER source order wins; `sources[0]` is the winning source.
 */
function minOfCapped(
  requestedSeq: bigint,
  boundarySafeSeq: bigint,
  committedSeq: bigint,
  capturedHighWater: bigint,
): { value: bigint; sources: MinSource[] } {
  const values: [MinSource, bigint][] = [
    ["boundary", boundarySafeSeq],
    ["committed", committedSeq],
    ["captured", capturedHighWater],
  ];
  const minVal = values.reduce<bigint>((a, [, v]) => (v < a ? v : a), requestedSeq);
  const floors = values.filter(([, v]) => v === minVal).map(([s]) => s);
  // If a source value exceeds requestedSeq it is capped away; the min is
  // positioned at requestedSeq only when every source is above the request.
  const value = floors.length > 0 ? minVal : requestedSeq;
  return { value, sources: floors.length > 0 ? floors : ["boundary"] };
}

/** True when a cut at seq `e` does NOT split any tool call/result pair. */
export function cutIsPairSafe(e: bigint, pairs: readonly ReplayToolPair[]): boolean {
  for (const p of pairs) {
    // Cutting at e keeps events with seq <= e. A pair is split when the call
    // (callSeq) is kept but the result (resultSeq) is dropped.
    if (p.callSeq <= e && e < p.resultSeq) return false;
  }
  return true;
}

/**
 * Retreat `e` upward-locked toward the call boundary of any pair it splits.
 * Returns the largest pair-safe e <= start, never below `floor`.
 *
 * `splitResolved` is true when a CUT_TOOL_PAIR_SPLIT retreat occurred; when a
 * retreat would cross the floor the cut clamps AT the floor and the reason
 * becomes CUT_ANCHOR_FLOOR (the floor is assumed pair-safe for legal inputs).
 */
function retreatAgainstPairs(
  start: bigint,
  pairs: readonly ReplayToolPair[],
  floor: bigint,
): { effective: bigint; split: boolean; floorClamped: boolean } {
  let e = start;
  let split = false;
  let floorClamped = false;
  for (;;) {
    let hit = false;
    for (const p of pairs) {
      if (p.callSeq <= e && e < p.resultSeq) {
        hit = true;
        const target = p.callSeq - 1n;
        if (target < floor) {
          // No-progress guard (VC0B-I12): the retreat target lies below the
          // floor. If the floor itself still splits a pair we must not loop
          // back onto it (that hangs the synchronous agent loop) — clamp AT
          // the floor once and stop. The floor is taken as the legal cut.
          e = floor;
          floorClamped = true;
        } else {
          e = target;
        }
        split = true;
        break;
      }
    }
    // Terminate when no pair splits e, OR when we have already clamped to the
    // floor (the floor is an absolute lower bound; we never retreat past it
    // even if it is not itself pair-safe).
    if (!hit || floorClamped) return { effective: e, split, floorClamped };
  }
}

/**
 * Compute the v2 effective cut. Pure with respect to the provided inputs.
 */
export function computeEffectiveCutV2(input: EffectiveCutInput): EffectiveCutOutput {
  const { requestedSeq, boundarySafeSeq, committedSeq, capturedHighWater, anchorFloor, pairs } = input;

  const retreats: ReplayRetreatRecord[] = [];

  // Step 1 — min-of-three (capped by requestedSeq) with lower-source tie-break.
  const min = minOfCapped(requestedSeq, boundarySafeSeq, committedSeq, capturedHighWater);
  let effective: bigint = min.value;
  // Tie among the min sources: resolved to the LOWER source order — record it.
  if (min.sources.length > 1) {
    retreats.push({
      code: "CUT_LOWEST_SOURCE_ORDER",
      fromSeq: effective,
      toSeq: effective,
    });
  }

  // Step 2 — pair retreat (never below the anchor floor).
  const retreat = retreatAgainstPairs(effective, pairs, anchorFloor);
  if (retreat.split && retreat.floorClamped) {
    retreats.push({ code: "CUT_ANCHOR_FLOOR", fromSeq: effective, toSeq: retreat.effective });
  } else if (retreat.split) {
    retreats.push({ code: "CUT_TOOL_PAIR_SPLIT", fromSeq: effective, toSeq: retreat.effective });
  }
  effective = retreat.effective;

  // Step 3 — final anchor-floor clamp (safety; legal floors are already >=).
  if (effective < anchorFloor) {
    retreats.push({ code: "CUT_ANCHOR_FLOOR", fromSeq: effective, toSeq: anchorFloor });
    effective = anchorFloor;
  }

  const cut: ReplayCutV2 = {
    requestedSeq,
    boundarySafeSeq,
    committedSeq,
    capturedHighWater,
    effectiveSeq: effective,
  };
  return { cut, retreats };
}

/** Re-export for callers that want just the code type. */
export type { ReplayRetreatCode };
