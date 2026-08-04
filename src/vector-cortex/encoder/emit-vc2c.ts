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
 * emitters are non-fatal (never break the agent loop). Pi-agnostic, zero network
 * (PREVENT-PI-004), no `any` (PREVENT-011).
 */

import { VC2C_ENABLED } from "../../config/vector-cortex.js";
import { Logger } from "../../log.js";

export type EncoderEmit = (event: string, fields: Record<string, unknown>) => void;

/** The two-event VC2C reporter surface (qualification passed / demoted). */
export interface EncoderQualificationReporter {
  readonly qualificationPassed: (fields: Record<string, unknown>) => void;
  readonly qualificationDemoted: (fields: Record<string, unknown>) => void;
}

/** A flag-gated no-op reporter (zero emissions, structural no-op). */
export const NOOP_VC2C_REPORTER: EncoderQualificationReporter = {
  qualificationPassed: () => {},
  qualificationDemoted: () => {},
};

/** Default structured sink (real producer — never silently drops). */
function defaultEmitFor(logPath: string | undefined): EncoderEmit {
  const logger = new Logger(logPath === undefined ? {} : { path: logPath });
  return (event, fields) => {
    logger.info(event, fields);
  };
}

/** Options for the default logger-backed sink. */
export interface EncoderQualificationEmitOptions {
  readonly logPath?: string;
}

/**
 * Flag-gated emit, defaulting to a real logger-backed sink. The returned
 * reporter is itself flag-gated (`VC2C_ENABLED`), so wiring it into a producer
 * seam yields zero emissions when `MEGACOMPACT_VC2C=0` (byte-identical to the
 * predecessor). Pass an explicit `emit` to route elsewhere (tests, downstream
 * consumers); omit it to emit real structured log lines.
 */
export function createEncoderQualificationReporter(
  emit?: EncoderEmit,
  opts: EncoderQualificationEmitOptions = {},
): EncoderQualificationReporter {
  const sink = emit ?? defaultEmitFor(opts.logPath);
  const fire = (event: string, fields: Record<string, unknown>): void => {
    if (!VC2C_ENABLED()) return;
    try {
      sink(event, { ...fields, ts: new Date().toISOString() });
    } catch {
      /* non-fatal observability */
    }
  };
  return {
    qualificationPassed: (fields) => fire("vector_cortex_encoder_qualification_passed", fields),
    qualificationDemoted: (fields) => fire("vector_cortex_encoder_qualification_demoted", fields),
  };
}
