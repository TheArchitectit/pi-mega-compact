/**
 * vector-cortex/encoder/emit.ts — VC2A observability seam.
 *
 * Emits the two VC2A structured events, gated on `MEGACOMPACT_VC2A` (mode C
 * parity: flag OFF => zero emissions). Every event is a JSON line with `ts` +
 * `event` (ENGINEERING_PRACTICES §8); the emitters are never fatal on consumer
 * failure (non-fatal observability, never breaks the agent loop).
 *
 *   vector_cortex_encoder_asset_verified   — a qualified manifest+digest load
 *   vector_cortex_encoder_runtime_demoted  — a demotion to mode B or C
 *
 * No network, no side effects beyond the supplied emit callback
 * (PREVENT-PI-004 / PREVENT-011).
 */

import { VC2A_ENABLED } from "../../config/vector-cortex.js";

export type EncoderEmit = (event: string, fields: Record<string, unknown>) => void;

/** The reporter surface consumed by the runtime + ONNX seams. */
export interface EncoderReporter {
  readonly assetVerified: (fields: Record<string, unknown>) => void;
  readonly runtimeDemoted: (fields: Record<string, unknown>) => void;
  /** ENC-0b: fires when a real ONNX InferenceSession is successfully created. */
  readonly onnxSessionLoaded: (fields: Record<string, unknown>) => void;
}

/** A flag-gated no-op reporter (zero emissions, default when none injected). */
export const NOOP_ENCODER_REPORTER: EncoderReporter = {
  assetVerified: () => {},
  runtimeDemoted: () => {},
  onnxSessionLoaded: () => {},
};

/**
 * Flag-gated emit: no-op when VC2A is off or no emitter is supplied. The
 * returned reporter is itself flag-gated (`VC2A_ENABLED`), so wiring it into a
 * runtime seam yields zero emissions when `MEGACOMPACT_VC2A=0` (byte-identical
 * to the predecessor).
 */
export function createEncoderReporter(emit?: EncoderEmit): EncoderReporter {
  const fire = (event: string, fields: Record<string, unknown>): void => {
    if (!VC2A_ENABLED()) return;
    try {
      emit?.(event, { ...fields, ts: new Date().toISOString() });
    } catch {
      /* non-fatal observability */
    }
  };
  return {
    assetVerified: (fields) => fire("vector_cortex_encoder_asset_verified", fields),
    runtimeDemoted: (fields) => fire("vector_cortex_encoder_runtime_demoted", fields),
    onnxSessionLoaded: (fields) => fire("vector_cortex_encoder_onnx_loaded", fields),
  };
}
