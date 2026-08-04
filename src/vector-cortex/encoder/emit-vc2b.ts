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

export type EncoderEmit = (event: string, fields: Record<string, unknown>) => void;

/** The two-event VC2B reporter surface. */
export interface EncoderHeadsReporter {
  readonly headsEmitted: (fields: Record<string, unknown>) => void;
  readonly fallbackSelected: (fields: Record<string, unknown>) => void;
}

/** A flag-gated no-op reporter (zero emissions, default when none injected). */
export const NOOP_VC2B_REPORTER: EncoderHeadsReporter = {
  headsEmitted: () => {},
  fallbackSelected: () => {},
};

/**
 * Flag-gated emit: no-op when VC2B is off or no emitter is supplied. The
 * returned reporter is itself flag-gated (`VC2B_ENABLED`), so wiring it into a
 * producer seam yields zero emissions when `MEGACOMPACT_VC2B=0` (byte-identical
 * to the predecessor).
 */
export function createEncoderHeadsReporter(emit?: EncoderEmit): EncoderHeadsReporter {
  const fire = (event: string, fields: Record<string, unknown>): void => {
    if (!VC2B_ENABLED()) return;
    try {
      emit?.(event, { ...fields, ts: new Date().toISOString() });
    } catch {
      /* non-fatal observability */
    }
  };
  return {
    headsEmitted: (fields) => fire("vector_cortex_encoder_heads_emitted", fields),
    fallbackSelected: (fields) => fire("vector_cortex_encoder_fallback_selected", fields),
  };
}
