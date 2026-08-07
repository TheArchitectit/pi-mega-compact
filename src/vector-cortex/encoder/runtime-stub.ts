/**
 * vector-cortex/encoder/runtime-stub.ts — the VC2A-era deterministic LCG
 * placeholder (`projectSemantic`) + token-seed helper, split out of runtime.ts
 * so `runtime.ts` stays under its 300-line soft limit as the delegate-shell.
 *
 * This placeholder is the VC2A-era stand-in for a real ONNX EncoderRuntime
 * inference result (the actual weights were VC2C and the runtime-selection
 * dispatch is ML5-C). It remains exported so tests driving end-to-end shape
 * keep working even when no backend session is active.
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

import { ENCODER_SEMANTIC_WIDTH } from "./types.js";

/** A deterministic seeded projection so the mode-A inference path is testable
 *  end-to-end without onnxruntime (real weights + execution are VC2C). */
export function projectSemantic(seed: number, n: number): Float32Array {
  const out = new Float32Array(n);
  let state = (seed >>> 0) ^ 0x9e3779b9;
  let sum = 0;
  // guardrails-allow PREVENT-STUB-001: ML5-A (VC2A seeded-projection placeholder; real ONNX inference subs in ML5-D/C)
  // guardrails-allow PREVENT-MOCK-001: ML5-A placeholder seeded PRNG; L2-normalized synthetic projection, real EncoderRuntime inference is the accuracy floor (accuracy floor acknowledged)
  for (let i = 0; i < n; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = (state / 4294967296) * 2 - 1;
    sum += out[i]! * out[i]!;
  }
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < n; i++) out[i] = out[i]! / norm;
  return out;
}

/** Deterministic token seed derived from the verified asset bytes count. */
export function seedFromBytes(embeddedBytes: number): number {
  return (embeddedBytes * 2654435761) >>> 0;
}

/** The semantic embedding width from the normative types barrel. */
export { ENCODER_SEMANTIC_WIDTH };
