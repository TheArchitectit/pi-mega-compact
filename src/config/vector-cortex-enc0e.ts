/**
 * config/vector-cortex-enc0e.ts — ENC-0e darwin-x64 explicit demotion reason.
 *
 * Extracted from vector-cortex.ts so that file stays under the 300-line soft
 * limit (soft-as-hard gate), exactly as vector-cortex-enc0a.ts / enc0b.ts /
 * enc0c.ts / enc0d.ts and the VC8C/VC9A-D/ML5A-E/DEDUP_ATTR siblings were.
 * vector-cortex.ts re-exports the flag below and root src/config.ts re-exports
 * it, so no consumer import path changes.
 *
 * ENC-0e closes HG-4's operator-visibility gap on macOS Intel (darwin-x64): the
 * platform has no native binary upstream (arm64-only; a darwin-x64
 * transform-class package ships only WASM), so the runtime demotes to mode-B
 * WASM per HG-4. That demotion already exists in the ML5-C decision rule —
 * ENC-0e makes it EXPLICIT by surfacing a deterministic demotion reason on the
 * runtime-selection event and on the Setup Cortex blockers card, so an
 * Intel-Mac operator sees exactly why mode A is unreachable.
 *
 * `MEGACOMPACT_ENC_0E=0` strips ONLY the reason surface: no demotionReason on
 * the runtime-selection event, no Setup card row. The ML5-C demotion itself
 * (mode-B/WASM on Intel Mac) remains the default and is NOT gated off — so the
 * flag-off path is byte-identical to the predecessor. The flag MUST also be a
 * dashboard SETTINGS toggle (visible, never in EXCLUDED_SETTINGS).
 *
 * The split is purely mechanical: ENC_0E_ENABLED follows ENC_0D_ENABLED in
 * name, semantics, and default, and vector-cortex.ts re-exports it so every
 * existing `from "./config/vector-cortex.js"` import keeps resolving unchanged.
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

import { sprintFlag } from "./vector-cortex-flag.js";

/**
 * ENC-0e — darwin-x64 explicit demotion reason. Default ON.
 * `MEGACOMPACT_ENC_0E=0` disables and is byte-identical to the predecessor
 * (ENC-0d): the runtime-selection event carries no demotionReason and the Setup
 * Cortex blockers card renders no demotion-reason row. The ML5-C darwin-x64
 * WASM demotion itself is NOT gated off — only the explicit reason surface is.
 * This flag MUST also be a dashboard SETTINGS toggle (visible in config UI,
 * never in EXCLUDED_SETTINGS), mirroring ENC_0A/ENC_0B/ENC_0C/ENC_0D.
 */
export const ENC_0E_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_ENC_0E");
