/**
 * config/vector-cortex-dash-0a.ts — DASH-0a dashboard consolidation tab-plan flag.
 *
 * Extracted to this sibling (per the vector-cortex-cosfp.ts precedent) so
 * src/config/vector-cortex.ts stays under the 300-line soft limit. The flag is
 * positive, defaults ON, and `MEGACOMPACT_DASH_0A=0` is byte-identical to the
 * predecessor: the merge plan module is never imported by the shell, so all 13
 * current tab/section top-level components render exactly as today. Registered
 * as a visible VECTOR_CORTEX_SETTINGS boolDirect toggle, never EXCLUDED.
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

import { sprintFlag } from "./vector-cortex-flag.js";

/**
 * DASH-0a — dashboard tab-audit + merge plan. Default ON.
 * `MEGACOMPACT_DASH_0A=0` disables and is byte-identical to the predecessor:
 * the plan module (DASH_TAB_PLAN / DEEP_LINK_TARGETS / nav-map) is a static
 * constant module that nothing imports at runtime, so the shell and all 13
 * tab/section top-level files render exactly as today. This sprint records the
 * plan only; DASH-0b/0c/0d consume it.
 */
export const DASH_0A_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_DASH_0A");
