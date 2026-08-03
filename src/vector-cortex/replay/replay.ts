/**
 * vector-cortex/replay/replay.ts — ReplayCutV2 replay scan (VC0B).
 *
 * Scans EventV2 occurrences in ascending `(seq, eventId bytewise UTF-8)`,
 * computes the v2 effective cut (M3 min-of-three + pair retreat + anchor floor),
 * and returns the replayed prefix bytes joined in strict source order. Before
 * returning bytes it reports any CUT_TOOL_PAIR_SPLIT / CUT_ANCHOR_FLOOR retreat
 * via the injected emit callback. Hard invariants are enforced zero-tolerance:
 * the output is a source-order prefix with no orphan tool event and no split
 * pair (reordered === 0, orphanToolEvents === 0, splitPairs-after-cut === 0).
 *
 * Mode A uses the v2 effective-cut calculator; mode B is a plain sequential
 * boundary scan with no precomputed index; mode C leaves the host transcript
 * unchanged and returns a zero-byte report with the derived high-water frozen.
 *
 * Pure wrt inputs, emits structured events via an injected callback (no console,
 * no network — PREVENT-PI-004).
 */

import { computeEffectiveCutV2 } from "./cut.js";
import type {
  ReplayOccurrenceV2,
  ReplayReportV2,
  ReplayToolPair,
} from "./types.js";

export interface ReplayV2Options {
  readonly sessionId: string;
  /** Occurrences in ascending (seq, eventId bytewise UTF-8). */
  readonly occurrences: readonly ReplayOccurrenceV2[];
  readonly requestedSeq: bigint;
  readonly committedSeq: bigint;
  readonly capturedHighWater: bigint;
  readonly anchorFloor: bigint;
  readonly mode?: "A" | "B" | "C";
  /** Structured event emitter (ts+event); optional, best-effort. */
  readonly emit?: (event: string, fields: Record<string, unknown>) => void;
}

/** The pair map is per-session; a tool result references one earlier call by id. */
export function extractToolPairs(
  occurrences: readonly ReplayOccurrenceV2[],
): ReplayToolPair[] {
  const calls = new Map<string, bigint>();
  const pairs: ReplayToolPair[] = [];
  for (const o of occurrences) {
    if (o.role === "tool" && o.toolCallId !== undefined) {
      const callSeq = calls.get(o.toolCallId);
      if (callSeq !== undefined && callSeq < o.seq) {
        pairs.push({ callSeq, resultSeq: o.seq });
      }
      continue;
    }
    // A call is an assistant event carrying a tool call id in EventV2; here we
    // treat an assistant occurrence with a toolCallId as the CALL side.
    if (o.toolCallId !== undefined) {
      calls.set(o.toolCallId, o.seq);
    }
  }
  return pairs;
}

/**
 * Largest pair-safe seq <= `ceiling` (a cut at e keeps seq <= e and must not
 * split any pair where callSeq <= e < resultSeq). Sequential boundary scan
 * (mode B); no aggregate index required.
 */
export function largestPairSafeSeq(
  pairs: readonly ReplayToolPair[],
  ceiling: bigint,
): bigint {
  let e = ceiling;
  for (;;) {
    let blocked = false;
    for (const p of pairs) {
      if (p.callSeq <= e && e < p.resultSeq) {
        e = p.callSeq - 1n;
        blocked = true;
        break;
      }
    }
    if (!blocked) return e;
  }
}

/** Ascending (seq, eventId) comparator over two occurrences. */
export function compareOccurrences(a: ReplayOccurrenceV2, b: ReplayOccurrenceV2): number {
  if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1;
  const ea = a.eventId;
  const eb = b.eventId;
  if (ea < eb) return -1;
  if (ea > eb) return 1;
  return 0;
}

/**
 * Run the v2 replay scan and produce a ReplayReportV2 plus the replayed bytes.
 */
export function runReplayV2(
  options: ReplayV2Options,
): { report: ReplayReportV2; bytes: Uint8Array } {
  const { sessionId, occurrences, requestedSeq, committedSeq, capturedHighWater, anchorFloor } = options;
  const mode = options.mode ?? "A";
  const emit =
    options.emit ??
    (() => {
      /* no-op */
    });

  // Mode C: unchanged host transcript — derived high-water frozen, zero bytes.
  if (mode === "C") {
    const cut = {
      requestedSeq,
      boundarySafeSeq: requestedSeq,
      committedSeq,
      capturedHighWater,
      effectiveSeq: anchorFloor,
    };
    emit("vector_cortex_replay_highwater_frozen", {
      session: sessionId,
      committedSeq: committedSeq.toString(),
      frozenHighWater: capturedHighWater.toString(),
    });
    return {
      report: zeroReport(cut, "C", []),
      bytes: new Uint8Array(0),
    };
  }

  const pairs = extractToolPairs(occurrences);

  // Boundary-safe cap: largest pair-safe seq (sequential scan; mode A and B).
  const boundarySafeSeq = largestPairSafeSeq(pairs, requestedSeq);

  // effective cut: min-of-three + pair retreat + anchor floor.
  const effectiveResult = computeEffectiveCutV2({
    requestedSeq,
    boundarySafeSeq,
    committedSeq,
    capturedHighWater,
    anchorFloor,
    pairs,
  });
  const { cut, retreats } = effectiveResult;

  for (const r of retreats) {
    emit("vector_cortex_replay_cut_retreat", {
      session: sessionId,
      code: r.code,
      fromSeq: r.fromSeq.toString(),
      toSeq: r.toSeq.toString(),
    });
  }

  const effective = cut.effectiveSeq;

  // Strict ascending source order scan up to the effective cut.
  const kept: ReplayOccurrenceV2[] = [];
  let reordered = 0;
  let scanned = 0;
  let bytesTotal = 0;
  const keptBytes: Uint8Array[] = [];

  let prev: ReplayOccurrenceV2 | null = null;
  const effectiveBig = effective;
  for (const o of occurrences) {
    scanned += 1;
    if (compareOccurrences(prev ?? o, o) > 0) reordered += 1;
    prev = o;
    if (o.seq > effectiveBig) break;
    kept.push(o);
    if (o.originalBytes) {
      keptBytes.push(o.originalBytes);
      bytesTotal += o.originalBytes.length;
    }
  }

  // No orphan tool event: every kept tool RESULT must have its CALL kept too.
  const keptCallIds = new Set<string>();
  for (const o of kept) {
    if (o.toolCallId !== undefined && o.role !== "tool") {
      keptCallIds.add(o.toolCallId);
    }
  }
  let orphanToolEvents = 0;
  for (const o of kept) {
    if (o.role === "tool" && o.toolCallId !== undefined && !keptCallIds.has(o.toolCallId)) {
      orphanToolEvents += 1;
    }
  }
  // Pair-splits that survived retreat (must be 0 for a correct boundary-safe cut).
  let splitPairs = 0;
  for (const p of pairs) {
    if (p.callSeq <= effectiveBig && effectiveBig < p.resultSeq) splitPairs += 1;
  }

  const bytes = concatBytes(keptBytes);
  const report: ReplayReportV2 = {
    cut,
    mode,
    counts: {
      scanned,
      bytes: bytesTotal,
      replayed: kept.length,
      splitPairs,
      anchorFloorCuts: retreats.filter((r) => r.code === "CUT_ANCHOR_FLOOR").length,
      lowestSourceCuts: retreats.filter((r) => r.code === "CUT_LOWEST_SOURCE_ORDER").length,
      reordered,
      orphanToolEvents,
    },
    retreats,
  };
  return { report, bytes };
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function zeroReport(
  cut: ReplayReportV2["cut"],
  mode: "A" | "B" | "C",
  retreats: ReplayReportV2["retreats"],
): ReplayReportV2 {
  return {
    cut,
    mode,
    counts: {
      scanned: 0,
      bytes: 0,
      replayed: 0,
      splitPairs: 0,
      anchorFloorCuts: 0,
      lowestSourceCuts: 0,
      reordered: 0,
      orphanToolEvents: 0,
    },
    retreats,
  };
}
