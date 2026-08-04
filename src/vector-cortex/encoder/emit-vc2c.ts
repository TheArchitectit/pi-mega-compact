/**
 * vector-cortex/encoder/emit-vc2c.ts — VC2C observability seam.
 *
 * Owns the two VC2C events (task 5), gated on `MEGACOMPACT_VC2C` so the
 * flag-OFF path emits zero events (mode C parity, byte-identical predecessor):
 *
 *   vector_cortex_encoder_qualification_passed   — a QualifiedEncoderV1 produced (A)
 *   vector_cortex_encoder_qualification_demoted  — qualification failed; all of A demoted
 *
 * Every event is a JSON line with `ts` + `event` (ENGINEERING_PRACTICES §8); the
 * `ts` is the numeric epoch-ms timestamp the `Logger` injects (LogEntry.ts is
 * `number`), so these events are consistent with the rest of the log stream
 * (code-review Q04 — no ISO-string ts override). The emitters are non-fatal
 * (never break the agent loop). Pi-agnostic, zero network (PREVENT-PI-004), no
 * `any` (PREVENT-011).
 */

import { VC2C_ENABLED } from "../../config/vector-cortex.js";
import { Logger } from "../../log.js";

export type EncoderEmit = (event: string, fields: Record<string, unknown>) => void;

/** The two-event VC2C reporter surface (qualification passed / demoted). */
export interface EncoderQualificationReporter {
  readonly qualificationPassed: (fields: Record<string, unknown>) => void;
  readonly qualificationDemoted: (fields: Record<string, unknown>) => void;
}

/**
 * The default emitter: routes both VC2C events into the append-only structured
 * logger (`src/log.ts`) as JSON lines with `event` (the logger injects the
 * numeric `ts`). Supplying `emit:` to `createEncoderQualificationReporter`
 * replaces this with a caller-provided sink (used by tests and downstream
 * consumers). Making the default a REAL producer means a caller that just
 * invokes the producer seam (`selectQualifiedEncoder`) without injecting an
 * emitter still yields structured telemetry instead of silently dropping every
 * event (task 5). Best-effort: the logger swallows all I/O errors.
 */
function defaultEmitFor(): EncoderEmit {
  const logger = new Logger();
  return (event, fields) => {
    logger.info(event, fields);
  };
}

/**
 * Flag-gated emit, defaulting to a real logger-backed sink. The returned
 * reporter is itself flag-gated (`VC2C_ENABLED`), so wiring it into a producer
 * seam yields zero emissions when `MEGACOMPACT_VC2C=0` (byte-identical to the
 * predecessor). Pass an explicit `emit` to route elsewhere (tests, downstream
 * consumers); omit it to emit real structured log lines. The `ts` is set by the
 * underlying sink (numeric epoch-ms from `Logger`), not overridden here (Q04).
 */
export function createEncoderQualificationReporter(
  emit?: EncoderEmit,
): EncoderQualificationReporter {
  const sink = emit ?? defaultEmitFor();
  const fire = (event: string, fields: Record<string, unknown>): void => {
    if (!VC2C_ENABLED()) return;
    try {
      sink(event, fields);
    } catch {
      /* non-fatal observability */
    }
  };
  return {
    qualificationPassed: (fields) => fire("vector_cortex_encoder_qualification_passed", fields),
    qualificationDemoted: (fields) => fire("vector_cortex_encoder_qualification_demoted", fields),
  };
}
