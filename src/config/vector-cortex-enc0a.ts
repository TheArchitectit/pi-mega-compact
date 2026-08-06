/**
 * config/vector-cortex-enc0a.ts — ENC-0a learned-encoder backend-decision flag.
 *
 * Extracted from vector-cortex.ts so that file stays under the 300-line soft
 * limit (soft-as-hard gate), exactly as vector-cortex-vc9a.ts..vector-cortex-vc9d.ts
 * were. This is the first ENC (real learned encoder) sprint flag. vector-cortex.ts
 * re-exports the ENUM below and root src/config.ts re-exports it, so no consumer
 * import path changes.
 *
 * ENC-0a locks the runtime-backend choice (transformers.js/WASM vs
 * onnxruntime-node native), the per-platform install-size matrix, the opset
 * baseline (re-baselined 17 -> 21) and the license/pinning audit. It writes a
 * durable decision record and bench JSON but touches neither the store schema
 * nor stateDir tables (pure migration).
 *
 * The split is purely mechanical: ENC_0A_ENABLED is byte-identical in name,
 * semantics, and default to the definition it replaces, and vector-cortex.ts
 * re-exports it so every existing `from "./config/vector-cortex.js"` import
 * keeps resolving unchanged.
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

import { sprintFlag } from "./vector-cortex-flag.js";

/**
 * ENC-0a — learned-encoder backend-decision lock. Default ON.
 * `MEGACOMPACT_ENC_0A=0` disables and is byte-identical to the predecessor
 * (placeholder encoder): no decision record is written and no newer
 * backend-resolution script runs — the runtime keeps serving mode B trigram
 * exactly as before. This flag MUST also be a dashboard SETTINGS toggle (visible
 * in config UI, never in EXCLUDED_SETTINGS), mirroring VC4A..VC9D.
 */
export const ENC_0A_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_ENC_0A");
