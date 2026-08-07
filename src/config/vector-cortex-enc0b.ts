/**
 * config/vector-cortex-enc0b.ts — ENC-0b real ONNX trunk fetch + gated inference flag.
 *
 * Extracted from vector-cortex.ts so that file stays under the 300-line soft
 * limit (soft-as-hard gate), exactly as vector-cortex-enc0a.ts and the
 * VC8C/VC9A-D/ML5A-E/DEDUP_ATTR siblings were. vector-cortex.ts re-exports the
 * flag below and root src/config.ts re-exports it, so no consumer import path
 * changes.
 *
 * ENC-0b fetches the real bge-small-en-v1.5 int8 ONNX model from the Hugging
 * Face Hub (build-time fetch into the assets directory, NOT a runtime network
 * call — PREVENT-PI-004 safe), wires an ONNX InferenceSession via
 * onnxruntime-web WASM, and runs gated inference through it. The gate is
 * controlled by this flag: OFF = the LCG placeholder encoder serves
 * byte-identical predecessor output and no ONNX session is constructed.
 *
 * The split is purely mechanical: ENC_0B_ENABLED is byte-identical in name,
 * semantics, and default to the definition it replaces, and vector-cortex.ts
 * re-exports it so every existing `from "./config/vector-cortex.js"` import
 * keeps resolving unchanged.
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

import { sprintFlag } from "./vector-cortex-flag.js";

/**
 * ENC-0b — real ONNX trunk fetch + gated inference. Default ON.
 * `MEGACOMPACT_ENC_0B=0` disables and is byte-identical to the predecessor
 * (ENC-0a / LCG placeholder): no ONNX session is built, the real bge-small
 * model is not loaded, and the encoder continues serving the LCG placeholder
 * output exactly as before. This flag MUST also be a dashboard SETTINGS toggle
 * (visible in config UI, never in EXCLUDED_SETTINGS), mirroring ENC_0A and
 * VC4A..VC9D.
 */
export const ENC_0B_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_ENC_0B");
