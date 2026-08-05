/**
 * config/vector-cortex-vc8c.ts — VC8C canary-selection sprint flag.
 *
 * Extracted from vector-cortex.ts so that file stays under the 300-line soft
 * limit (soft-as-hard gate), exactly as vector-cortex-breakers.ts and
 * vector-cortex-early.ts were. This is the CANARY-SELECTION flag (external Rust
 * parity / engine triad A/B/C). vector-cortex.ts re-exports it below so no
 * consumer import path changes.
 *
 * The split is purely mechanical: VC8C_ENABLED is byte-identical in name,
 * semantics, and default to the definition it replaces, and vector-cortex.ts
 * re-exports it so every existing `from "./config/vector-cortex.js"` import
 * keeps resolving unchanged.
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

import { sprintFlag } from "./vector-cortex-flag.js";

/**
 * VC8C — canary selection + external Rust parity (EngineAbiV1 / ParityReportV1).
 * Default ON. `MEGACOMPACT_VC8C=0` disables and is byte-identical to the
 * predecessor (VC8B): the engine selector and the cross-conformance runner
 * STILL RUN (they are PURE — ABI/evidence matching plus neutral length-framed
 * byte comparison, with no clock, storage, or network), so a qualified external
 * artifact is still accepted and a parity mismatch still demotes to mode B with
 * the flag off. The flag gates ONLY the
 * `vector_cortex_engine_parity_checked` / `vector_cortex_engine_selection_demoted`
 * events and the engine parity/selection dashboard seam, which reports
 * `enabled:false` + mode C when off. This flag MUST also be a dashboard SETTINGS
 * toggle (visible in config UI, never in EXCLUDED_SETTINGS), mirroring VC4A..VC8B.
 */
export const VC8C_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC8C");
