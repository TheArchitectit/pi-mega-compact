/**
 * vector-cortex/encoder/emit-vc2b.ts — VC2B observability seam.
 *
 * Owns the two VC2B events (task 5), gated on `MEGACOMPACT_VC2B` so the
 * flag-OFF path emits zero events (mode C parity, byte-identical predecessor):
 *
 *   vector_cortex_encoder_heads_emitted      — a multi-head VectorSetV1 produced
 *   vector_cortex_encoder_fallback_selected  — a mode B/C fallback selected
 *
 * No dashboard or API change is necessary for this internal sprint (task 5).
 * Every event is a JSON line with `ts` + `event` (ENGINEERING_PRACTICES §8); the
 * emitters are non-fatal (never break the agent loop). Pi-agnostic, zero network
 * (PREVENT-PI-004), no `any` (PREVENT-011).
 */

import { VC2B_ENABLED } from "../../config/vector-cortex.js";
import { Logger } from "../../log.js";

export type EncoderEmit = (event: string, fields: Record<string, unknown>) => void;

/** The two-event VC2B reporter surface. */
export interface EncoderHeadsReporter {
  readonly headsEmitted: (fields: Record<string, unknown>) => void;
  readonly fallbackSelected: (fields: Record<string, unknown>) => void;
}

/** A flag-gated no-op reporter (zero emissions, structural no-op). */
export const NOOP_VC2B_REPORTER: EncoderHeadsReporter = {
  headsEmitted: () => {},
  fallbackSelected: () => {},
};

/**
 * The default emitter: routes both VC2B events into the append-only structured
 * logger (`src/log.ts`) as JSON lines with `ts` + `event`. Supplying `emit:` to
 * `createEncoderHeadsReporter` replaces this with a caller-provided sink (used
 * by tests and downstream consumers). Making the default a REAL producer means a
 * caller that just invokes the producer seam (`encodeOrFallback`, `encodeVectorSet`,
 * `selectTrigramBFallback`, `selectLexicalC`) without injecting an emitter still
 * yields structured telemetry instead of silently dropping every event (task 5,
 * code-review Q01). Best-effort: the logger swallows all I/O errors.
 */
function defaultEmitFor(logPath: string | undefined): EncoderEmit {
  const logger = new Logger(logPath === undefined ? {} : { path: logPath });
  return (event, fields) => {
    logger.info(event, fields);
  };
}

/** Options for the default logger-backed sink (used when no `emit` is injected). */
export interface EncoderHeadsEmitOptions {
  /** Where the default structured sink writes (defaults to the global log path). */
  readonly logPath?: string;
}

/**
 * Flag-gated emit, defaulting to a real logger-backed sink. The returned
 * reporter is itself flag-gated (`VC2B_ENABLED`), so wiring it into a producer
 * seam yields zero emissions when `MEGACOMPACT_VC2B=0` (byte-identical to the
 * predecessor). Pass an explicit `emit` to route elsewhere (tests, downstream
 * consumers); omit it to emit real structured log lines (Q01: the default is a
 * live producer, not a silent no-op). `opts.logPath` only redirects the default
 * sink and is ignored when `emit` is supplied.
 */
export function createEncoderHeadsReporter(
  emit?: EncoderEmit,
  opts: EncoderHeadsEmitOptions = {},
): EncoderHeadsReporter {
  const sink = emit ?? defaultEmitFor(opts.logPath);
  const fire = (event: string, fields: Record<string, unknown>): void => {
    if (!VC2B_ENABLED()) return;
    try {
      sink(event, { ...fields, ts: new Date().toISOString() });
    } catch {
      /* non-fatal observability */
    }
  };
  return {
    headsEmitted: (fields) => fire("vector_cortex_encoder_heads_emitted", fields),
    fallbackSelected: (fields) => fire("vector_cortex_encoder_fallback_selected", fields),
  };
}
