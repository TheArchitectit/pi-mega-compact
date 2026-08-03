/**
 * vector-cortex/replay/types.ts — ReplayCutV2 / ReplayReportV2 contract types
 * and the registered CUT / M3 conformance ID ranges.
 *
 * Owned by VC0B (replay correctness). Consumes reviewer-accepted predecessor
 * contracts and common contracts only (EventV2 minimal shape). Pure type/schema
 * definitions — no runtime network, no side effects (PREVENT-PI-004 / PREVENT-011).
 */

/**
 * Minimal EventV2 occurrence shape sufficient for the replay scan, consumed
 * contractually from EventV2 (VC1A owns the full codec). Ordering is
 * `(sessionId, seq, eventId bytewise UTF-8)`. A tool result references exactly
 * one earlier CALL in the same session via `toolCallId`.
 */
export interface ReplayOccurrenceV2 {
  readonly sessionId: string;
  /** Monotonic per-session sequence (bigint). */
  readonly seq: bigint;
  /** Occurrence id; bytewise UTF-8 tiebreak within equal seq. */
  readonly eventId: string;
  readonly role: "policy" | "user" | "assistant" | "tool";
  readonly kind: string;
  /** Present on a tool RESULT; names exactly one earlier CALL in this session. */
  readonly toolCallId?: string;
  /** Original event bytes (authoritative per EventV2); used for the byte count. */
  readonly originalBytes?: Uint8Array;
}

/** A tool call/result pair in a session (call seq < result seq). */
export interface ReplayToolPair {
  readonly callSeq: bigint;
  readonly resultSeq: bigint;
}

/**
 * ReplayCutV2 — the five authoritative values of the effective cut.
 *
 * `effectiveSeq` is `min(boundarySafeSeq, committedSeq, capturedHighWater)`
 * (capped by `requestedSeq`), then retreated to the call boundary whenever the
 * candidate intersects a tool call/result pair, then clamped to the anchor
 * floor. Flags: `MEGACOMPACT_VC0B=0` routes to the legacy capped replay.
 */
export interface ReplayCutV2 {
  /** Caller's desired cap (the largest seq the caller asked to replay to). */
  readonly requestedSeq: bigint;
  /** Largest pair-safe cap that never splits a tool call/result pair. */
  readonly boundarySafeSeq: bigint;
  /** Contiguous durable authority high-water (min source). */
  readonly committedSeq: bigint;
  /** Derived high-water captured/frozen at the start of replay (min source). */
  readonly capturedHighWater: bigint;
  /** The resulting cut actually applied to the replay scan. */
  readonly effectiveSeq: bigint;
}

/** Retreat/retraction reasons recorded on a ReplayReportV2. */
export type ReplayRetreatCode =
  | "CUT_TOOL_PAIR_SPLIT"
  | "CUT_ANCHOR_FLOOR"
  | "CUT_LOWEST_SOURCE_ORDER";

/** A single recorded retreat (fromSeq -> toSeq with its reason). */
export interface ReplayRetreatRecord {
  readonly code: ReplayRetreatCode;
  readonly fromSeq: bigint;
  readonly toSeq: bigint;
}

/**
 * ReplayReportV2 — outcome of a replay scan. Counts are exact; the hard
 * invariants (zero reordered pairs, zero orphan tool events, zero split pairs
 * after the effective cut) are enforced as zero-tolerance.
 */
export interface ReplayReportV2 {
  readonly cut: ReplayCutV2;
  /** Triad mode that produced this report: "A" | "B" | "C". */
  readonly mode: "A" | "B" | "C";
  readonly counts: {
    /** Total occurrences scanned (ascending (seq,eventId)). */
    readonly scanned: number;
    /** Bytes returned (sum of replayed originalBytes lengths). */
    readonly bytes: number;
    /** Occurrences replayed (seq <= effectiveSeq). */
    readonly replayed: number;
    /** Retreats of kind CUT_TOOL_PAIR_SPLIT. */
    readonly splitPairs: number;
    /** Retreats of kind CUT_ANCHOR_FLOOR. */
    readonly anchorFloorCuts: number;
    /** Tie-break retreats of kind CUT_LOWEST_SOURCE_ORDER. */
    readonly lowestSourceCuts: number;
    /** Reordered (out-of-source-order) pairs — MUST be 0. */
    readonly reordered: number;
    /** Orphan tool events after the cut — MUST be 0. */
    readonly orphanToolEvents: number;
  };
  /** Every retreat applied, in apply order. */
  readonly retreats: readonly ReplayRetreatRecord[];
}

/**
 * Registered CUT conformance ID range (CUT-001..020). The acceptance test
 * reads these rows from the v2 manifest and asserts their expected bytes/results.
 */
export const CUT_IDS = [
  "CUT-001",
  "CUT-002",
  "CUT-003",
  "CUT-004",
  "CUT-005",
  "CUT-006",
  "CUT-007",
  "CUT-008",
  "CUT-009",
  "CUT-010",
  "CUT-011",
  "CUT-012",
  "CUT-013",
  "CUT-014",
  "CUT-015",
  "CUT-016",
  "CUT-017",
  "CUT-018",
  "CUT-019",
  "CUT-020",
] as const;

/**
 * Registered M3 conformance ID range (M3-001..010) for the effective-cut-v2
 * migration (copy/validate/switch). The migration fixtures assert that crash
 * after M3 copy validation but before pointer switch retains the old cut pointer
 * and resumes idempotently.
 */
export const M3_IDS = [
  "M3-001",
  "M3-002",
  "M3-003",
  "M3-004",
  "M3-005",
  "M3-006",
  "M3-007",
  "M3-008",
  "M3-009",
  "M3-010",
] as const;
