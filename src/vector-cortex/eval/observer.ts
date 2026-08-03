/**
 * vector-cortex/eval/observer.ts — VC0A structured observer (triad mode A).
 *
 * Connects to the evaluation reader: accepts MetricEventV1 samples, maintains
 * the canonical `(session, seq, event)` ordered set plus the fixed latency
 * histogram, and emits two structured local events:
 *   - vector_cortex_eval_sample_recorded   (one per accepted sample)
 *   - vector_cortex_eval_redaction_rejected (when a redaction fails)
 *
 * Mode C (observer absent) is the responsibility of the caller: no observes(),
 * no writes, byte-identical to the predecessor. This module never touches the
 * network (PREVENT-PI-004) — it only manipulates in-memory rows and emits
 * structured log lines through an injected logging callback so it stays
 * pi-agnostic and deterministically testable.
 */

import { buildMetrics, sortCanonical } from "./metrics.js";
import type { MetricEventV1 } from "./types.js";

export interface EvalObserverOptions {
  /** Callback emitting structured log lines (ts + event). Swallows errors. */
  readonly emit: (event: string, fields: Record<string, unknown>) => void;
  /**
   * Optional persistence callback for one accepted sample (redacted metric
   * row). The pure observer stays in-memory; a host supplies this to bridge
   * the observer to disk JSONL for the separate-process dashboard reader.
   * Swallows errors — best-effort, non-fatal.
   */
  readonly persist?: (sample: MetricEventV1) => void;
}

export interface EvalObserver {
  /** Record one sample; emits vector_cortex_eval_sample_recorded. */
  record(sample: MetricEventV1): void;
  /** Report a redaction failure (raw content that could not be redacted). */
  rejectRedaction(field: string, reason: string): void;
  /** Canonical-ordered rows seen so far. */
  rows(): readonly MetricEventV1[];
}

/**
 * Build a structured observer (mode A). Best-effort: emitting never throws
 * into the extension path (non-fatal observability).
 */
export function createEvalObserver(opts: EvalObserverOptions): EvalObserver {
  const rows: MetricEventV1[] = [];

  function emit(event: string, fields: Record<string, unknown>): void {
    try {
      opts.emit(event, fields);
    } catch {
      /* non-fatal observability — never break the agent loop */
    }
  }

  return {
    record(sample) {
      rows.push(sample);
      if (opts.persist) {
        try {
          opts.persist(sample);
        } catch {
          /* non-fatal observability */
        }
      }
      emit("vector_cortex_eval_sample_recorded", {
        session: sample.session,
        seq: sample.seq,
        event: sample.event,
        unit: sample.unit,
        mode: sample.mode,
      });
    },
    rejectRedaction(field, reason) {
      emit("vector_cortex_eval_redaction_rejected", { field, reason });
    },
    rows() {
      return sortCanonical(rows);
    },
  };
}

/** Aggregate metrics result from an observer's rows (canonical + histogram). */
export function observerMetrics(result: { rows: () => readonly MetricEventV1[] }) {
  return buildMetrics(result.rows() as MetricEventV1[]);
}
