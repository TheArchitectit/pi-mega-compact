/**
 * vector-cortex/eval/metrics.ts — canonical metric ordering + fixed histogram.
 *
 * 1. Stable sort rows by `(session, seq, event)` — session string byte order,
 *    then integer seq ascending, then event-name byte order as tiebreak
 *    (EVAL-ORDER-003: equal seq rows use event-name order).
 * 2. Bucket latency values at exactly 1/5/10/25/50/100/250ms with inclusive
 *    boundaries (EVAL-BUCKET-001); values past 250ms kept in a separate
 *    overflow bucket. Histogram totals are permutation-stable.
 *
 * Pure/no side effects (PREVENT-PI-004).
 */

import { LATENCY_BUCKETS } from "./types.js";
import type { MetricEventV1, EvalReject } from "./types.js";

/** Inclusive-boundary bucket edges, with a sentinel past the largest edge. */
const EDGES: readonly number[] = LATENCY_BUCKETS;
const OVERFLOW_INDEX = EDGES.length;

/** Histogram cell counts aligned to EDGES, plus a trailing overflow cell. */
export function emptyHistogram(): number[] {
  return new Array<number>(EDGES.length + 1).fill(0);
}

/**
 * Per-session histogram of `value` (when the sample is in `unit`), plus a
 * non-latency count kept separate so totals are permutation-stable.
 */
export interface LatencyHistogram {
  /** Cells: one per bucket edge, then overflow. Sum == counted latency samples. */
  cells: number[];
  /** Bucket label for each cell (overflow label is "250+" passed via >250). */
  edges: readonly number[];
  /** Number of latency samples that landed past the largest edge. */
  overflow: number;
  /** Total latency samples bucketed (cells sum). */
  total: number;
}

export interface MetricsResult {
  /** Rows in canonical `(session, seq, event)` order. */
  readonly rows: readonly MetricEventV1[];
  /** Per-session latency histograms (mode A observed). */
  readonly histogram: LatencyHistogram;
  /** Rejections encountered while validating streaming input. */
  readonly rejects: readonly EvalReject[];
}

/** True when a sample carries a latency (`unit === "ms"`) datum. */
export function isLatencySample(m: MetricEventV1): boolean {
  return m.unit === "ms";
}

/** Bucket a latency ms value into a cell index (0..EDGES.length, last=overflow). */
export function bucketIndex(value: number): number {
  if (!Number.isFinite(value) || value < 0) return OVERFLOW_INDEX;
  for (let i = 0; i < EDGES.length; i++) {
    if (value <= EDGES[i]) return i; // inclusive upper boundary
  }
  return OVERFLOW_INDEX;
}

/**
 * Bucket latency sample values across all rows into the fixed histogram.
 * Overflow is kept separate (counted in `overflow` and the trailing cell).
 */
export function bucketHistogram(rows: readonly MetricEventV1[]): LatencyHistogram {
  const cells = emptyHistogram();
  let overflow = 0;
  for (const m of rows) {
    if (!isLatencySample(m)) continue;
    const idx = bucketIndex(m.value);
    cells[idx] += 1;
    if (idx === EDGES.length) overflow += 1;
  }
  return {
    cells,
    edges: [...EDGES],
    overflow,
    total: cells.reduce((a, b) => a + b, 0),
  };
}

/**
 * Stable sort MetricEventV1 rows by `(session, seq, event)`:
 *  - session: UTF-8 / JS string byte order;
 *  - seq: ascending numeric;
 *  - event: ascending string byte order (tiebreak for equal seq).
 * Equal content stays separate occurrences (never deduplicated here).
 */
export function sortCanonical(rows: readonly MetricEventV1[]): MetricEventV1[] {
  const out = [...rows];
  out.sort((a, b) => {
    const s = a.session < b.session ? -1 : a.session > b.session ? 1 : 0;
    if (s !== 0) return s;
    if (a.seq !== b.seq) return a.seq - b.seq;
    return a.event < b.event ? -1 : a.event > b.event ? 1 : 0;
  });
  return out;
}

/**
 * Assisted sort plus histogram, returning both under one result.
 * The observer (mode A) calls this before JSONL serialization.
 */
export function buildMetrics(rows: readonly MetricEventV1[]): MetricsResult {
  return {
    rows: sortCanonical(rows),
    histogram: bucketHistogram(rows),
    rejects: [],
  };
}
