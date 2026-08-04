/**
 * vector-cortex/eval/reader.ts — evaluation reader (aggregate-only).
 *
 * Reader-only capability: `summarizeEvalRows` collapses a set of MetricEventV1
 * rows into an aggregate summary for the dashboard `GET /api/vector-cortex/
 * evaluation` endpoint. No writable capability — the observer writes via its
 * own path; this reader never mutates. Predecessor (flag-off / mode C) emits
 * an empty summary byte-identical to "no data".
 *
 * Pure + local, zero network (PREVENT-PI-004).
 */

import { buildMetrics } from "./metrics.js";
import type { MetricEventV1 } from "./types.js";

export interface EvalSummary {
  /** Samples aggregated. */
  readonly samples: number;
  /** Per-mode distribution (A/B/C). */
  readonly byMode: Readonly<{ A: number; B: number; C: number }>;
  /** Fixed latency histogram with its inclusive edges + separate overflow. */
  readonly histogram: {
    readonly edges: readonly number[];
    readonly cells: readonly number[];
    readonly overflow: number;
    readonly total: number;
  };
}

/** Aggregate rows into a reader-only summary (histogram + per-mode counts). */
export function summarizeEvalRows(rows: readonly MetricEventV1[]): EvalSummary {
  const byMode = { A: 0, B: 0, C: 0 };
  for (const r of rows) byMode[r.mode] += 1;
  const metrics = buildMetrics(rows as MetricEventV1[]);
  return {
    samples: rows.length,
    byMode,
    histogram: {
      edges: metrics.histogram.edges,
      cells: metrics.histogram.cells,
      overflow: metrics.histogram.overflow,
      total: metrics.histogram.total,
    },
  };
}
