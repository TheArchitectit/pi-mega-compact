/**
 * config/vector-cortex-pcc.ts — PC-C dashboard prompt-cache visibility flag.
 *
 * Extracted from vector-cortex.ts so that file stays under the 300-line soft
 * limit (soft-as-hard gate), exactly as the vector-cortex-vc9{a,b,c,d}.ts
 * siblings were. This is the PC-C dashboard per-turn prefix-stability flag.
 * vector-cortex.ts re-exports it below and root src/config.ts re-exports it,
 * so no consumer import path changes.
 *
 * The split is purely mechanical: PCC_ENABLED is byte-identical in name,
 * semantics, and default to the sprint-flag convention it follows, and
 * vector-cortex.ts re-exports it so every existing `from
 * "./config/vector-cortex.js"` import keeps resolving unchanged.
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

import { sprintFlag } from "./vector-cortex-flag.js";

/**
 * PC-C — dashboard per-turn prefix-stability visibility. Default ON.
 * `MEGACOMPACT_PC_C=0` disables and is byte-identical to the predecessor
 * (PC-B-era): /api/prefix-stability returns 404/disabled and the CacheTab
 * renders exactly as before (stripe distribution + hit-rate trend only). When
 * ON, the endpoint surfaces the per-turn stable-prefix ratio trend from the
 * `prefix_stability` events in the monitoring log. The response contains
 * aggregate ratios/counts only, never message content (EVAL-REDACT-002), and
 * reads only the local events log (PREVENT-PI-004). This flag MUST also be a
 * dashboard SETTINGS toggle (visible in config UI, never in EXCLUDED_SETTINGS),
 * mirroring the other PC/VC flags.
 */
export const PCC_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_PC_C");
