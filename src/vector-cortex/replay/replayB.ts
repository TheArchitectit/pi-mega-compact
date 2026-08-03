/**
 * vector-cortex/replay/replayB.ts — Mode B: independent deterministic replay cut
 * (VC0B, TRIAD_RESILIENCE).
 *
 * Mode B is the deliberately SLOW-but-simple local algorithm. It is a genuine
 * counterpart to mode A (`./cut.ts`): it shares NO subroutine with A — no
 * `computeEffectiveCutV2`, no `largestPairSafeSeq`, no `cutIsPairSafe`, no
 * min-of-three shortcut. Instead it walks the authoritative observed occurrence
 * bytes in ascending `(seq, eventId)` order from seq 0 and, at EVERY step,
 * checks tool-pair completeness (via its own open-call tracker built from the
 * bytes) plus the authority high-water caps and the anchor floor.
 *
 * Contract parity: the v2 effective cut is a well-defined pure function of the
 * stream and the authority inputs, so two independent implementations of the
 * same rule MUST agree. A optimizes via a precomputed pair list + min-of-three +
 * retreat; B brute-forces the LARGEST seq that satisfies every constraint by
 * scanning — slower (O(n·open)), which is exactly its purpose: when the breaker
 * flips to B it catches bugs in A because the two share no code.
 *
 * Pure/deterministic, no network, no side effects (PREVENT-PI-004).
 */

import type { ReplayOccurrenceV2 } from "./types.js";

export interface ReplayBCut {
  /** Largest pair-complete seq <= requestedSeq (comparable to A's boundary). */
  readonly boundarySafeSeq: bigint;
  /** The cut actually applied: largest pair-complete seq <= the authority cap,
   *  never below the anchor floor. */
  readonly effectiveSeq: bigint;
}

export interface ReplayBInput {
  /** Occurrences in ascending (seq, eventId bytewise UTF-8) source order. */
  readonly occurrences: readonly ReplayOccurrenceV2[];
  readonly requestedSeq: bigint;
  /** Contiguous durable authority high-water. */
  readonly committedSeq: bigint;
  /** Derived high-water captured/frozen at replay start. */
  readonly capturedHighWater: bigint;
  /** Recent-anchor floor (inclusive lower bound the cut never crosses). */
  readonly anchorFloor: bigint;
}

/**
 * Independent mode-B effective cut. Walks the occurrence bytes once, tracking
 * open tool calls from the bytes themselves (no extracted pair list). The
 * boundary-safe seq is the largest pair-complete seq <= requestedSeq; the
 * effective seq is the largest pair-complete seq that also lies within the
 * authority ceiling (requested/committed/captured, applied as independent
 * sequential caps — no shared min-of-three) and at/above the anchor floor.
 */
export function computeEffectiveCutV2B(input: ReplayBInput): ReplayBCut {
  const { occurrences, requestedSeq, committedSeq, capturedHighWater, anchorFloor } = input;

  // Independent sequential authority ceiling (NOT A's minOfCapped).
  let ceiling = requestedSeq;
  if (ceiling > committedSeq) ceiling = committedSeq;
  if (ceiling > capturedHighWater) ceiling = capturedHighWater;

  // Open tool calls awaiting a result (toolCallId -> callSeq), built from bytes.
  const open = new Map<string, bigint>();
  let boundarySafeSeq = 0n; // largest pair-complete seq <= requestedSeq
  let effectiveSeq = 0n; // largest pair-complete seq <= ceiling (>= floor)

  for (const o of occurrences) {
    if (o.seq > requestedSeq) break;
    const s = o.seq;

    if (o.toolCallId !== undefined && o.role !== "tool") {
      // A CALL: it stays open until its result is observed.
      open.set(o.toolCallId, s);
    } else if (o.toolCallId !== undefined && o.role === "tool") {
      // Its RESULT: the pair closes.
      open.delete(o.toolCallId);
    }

    // A cut at `s` is pair-complete iff no still-open call lies at or below `s`
    // (such a call's result is beyond the cut, so keeping the call orphans it).
    let complete = true;
    for (const cseq of open.values()) {
      if (cseq <= s) {
        complete = false;
        break;
      }
    }
    if (!complete) continue;

    boundarySafeSeq = s;
    if (s <= ceiling && s >= anchorFloor) effectiveSeq = s;
  }

  // Anchor floor is an absolute lower bound (parity with A's final clamp).
  if (effectiveSeq < anchorFloor) effectiveSeq = anchorFloor;

  return { boundarySafeSeq, effectiveSeq };
}
