/**
 * config/vector-cortex-ml5a.ts — ML5-A five-head training + calibration flag.
 *
 * Extracted from vector-cortex.ts so that file stays under the 300-line soft
 * limit (soft-as-hard gate), exactly as vector-cortex-vc9a.ts..vector-cortex-vc9d.ts
 * were. This is the ML5 training sprint flag. vector-cortex.ts re-exports the
 * ENUM below and root src/config.ts re-exports it, so no consumer import path
 * changes.
 *
 * The split is purely mechanical: ML5A_ENABLED is byte-identical in name,
 * semantics, and default to the definition it replaces, and vector-cortex.ts
 * re-exports it so every existing `from "./config/vector-cortex.js"` import
 * keeps resolving unchanged.
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

import { sprintFlag } from "./vector-cortex-flag.js";

/**
 * ML5-A — five-head training + calibrated onnx asset. Default ON.
 * `MEGACOMPACT_ML5_A=0` disables and is byte-identical to the placeholder
 * predecessor (VC2C-era): `calibrate.ts`/`heads.ts` keep serving the LCG fake
 * projections and the placeholder `fitTemperature`/`fitThreshold`, mode B
 * trigram continues serving, and no trained artifact is loaded (a fresh/no
 * corpus also no-ops gracefully — asset_emitted:false, placeholder behavior,
 * byte-identical). This flag MUST also be a dashboard SETTINGS toggle (visible
 * in config UI, never in EXCLUDED_SETTINGS), mirroring VC4A..VC9D.
 */
export const ML5A_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_ML5_A");
