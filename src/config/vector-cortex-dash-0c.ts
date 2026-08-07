/**
 * config/vector-cortex-dash-0c.ts — DASH-0c dashboard consolidation execution flag.
 *
 * Extracted to this sibling (per the vector-cortex-dash-0a.ts precedent) so
 * src/config/vector-cortex.ts stays under the 300-line soft limit. The flag is
 * positive, defaults ON, and `MEGACOMPACT_DASH_0C=0` is byte-identical to the
 * predecessor: CacheTab and MetricsTab render as two independent top-level
 * surfaces, MaintenanceTab and ConfigTab render exactly as today, and SetupTab
 * keeps its Config sub-tab. Registered as a visible VECTOR_CORTEX_SETTINGS
 * boolDirect toggle, never EXCLUDED.
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

import { sprintFlag } from "./vector-cortex-flag.js";

/**
 * DASH-0c — second execution sprint of the DASH consolidation plan:
 * (1) Cache+Performance — CacheTab absorbs MetricsTab as a Performance section
 *     via MetricsCards; (2) Admin — MaintenanceTab + ConfigTab combine under a
 *     new AdminTab delegate-shell with an AdminViews toggle, and SetupTab hides
 *     its Config sub-tab. `MEGACOMPACT_DASH_0C=0` renders the predecessor
 *     standalone surfaces — byte-identical.
 */
export const DASH_0C_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_DASH_0C");
