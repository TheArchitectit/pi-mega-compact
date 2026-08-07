/**
 * config/vector-cortex-enc0d.ts — ENC-0d promotion gate over real trained assets.
 *
 * Extracted from vector-cortex.ts so that file stays under the 300-line soft
 * limit (soft-as-hard gate), exactly as vector-cortex-enc0a.ts / enc0b.ts /
 * enc0c.ts and the VC8C/VC9A-D/ML5A-E/DEDUP_ATTR siblings were. vector-cortex.ts
 * re-exports the flag below and root src/config.ts re-exports it, so no
 * consumer import path changes.
 *
 * ENC-0d turns the ML5-E promotion gate into the real-asset promotion path:
 * it accepts a `{color}` real candidate manifest (the ENC-0c trained head
 * weights + the ENC-0b trunk, staged under
 * ~/.pi/mega-compact-encoder/candidates/), digest-verifies every staged byte
 * before any swap, and performs an atomic asset swap with rollback-to-previous
 * on qualification failure. The extension itself never stages candidate assets —
 * only the operator trains them. When the flag is ON and a digest-verified
 * green candidate exists, an atomic swap is performed and the runtime flips into
 * qualified mode A; a red qualification (or any verification failure) keeps the
 * prior asset live and emits a demotion.
 *
 * `MEGACOMPACT_ENC_0D=0` accepts no candidate, swaps nothing, emits nothing, and
 * the shipped manifest stays at the ENC-0c survivor — byte-identical predecessor.
 *
 * The split is purely mechanical: ENC_0D_ENABLED follows ENC_0C_ENABLED in name,
 * semantics, and default, and vector-cortex.ts re-exports it so every existing
 * `from "./config/vector-cortex.js"` import keeps resolving unchanged.
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

import { sprintFlag } from "./vector-cortex-flag.js";

/**
 * ENC-0d — atomic real-asset promotion over trained candidates. Default ON.
 * `MEGACOMPACT_ENC_0D=0` disables and is byte-identical to the predecessor
 * (ENC-0c): no candidate is accepted, no swap is performed, no promote/
 * demote/rollback events are emitted, and the shipped manifest stays at the
 * ENC-0c survivor. This flag MUST also be a dashboard SETTINGS toggle (visible
 * in config UI, never in EXCLUDED_SETTINGS), mirroring ENC_0A/ENC_0B/ENC_0C.
 */
export const ENC_0D_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_ENC_0D");
