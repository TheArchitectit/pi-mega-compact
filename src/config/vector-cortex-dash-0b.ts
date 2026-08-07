/**
 * config/vector-cortex-dash-0b.ts — DASH-0b dashboard consolidation execution flag.
 *
 * Extracted to this sibling (per the vector-cortex-dash-0a.ts precedent) so
 * src/config/vector-cortex.ts stays under the 300-line soft limit. The flag is
 * positive, defaults ON, and `MEGACOMPACT_DASH_0B=0` is byte-identical to the
 * predecessor: SessionsTab and TurnsTab render as two independent top-level
 * surfaces and VectorCortexTab keeps its flat card layout. Registered as a
 * visible VECTOR_CORTEX_SETTINGS boolDirect toggle, never EXCLUDED.
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

import { sprintFlag } from "./vector-cortex-flag.js";

/**
 * DASH-0b — first execution sprint of the DASH consolidation plan:
 * (1) Sessions surface absorbs TurnsTab as a drill-down via TurnMemoryView,
 * (2) VectorCortexTab re-groups its flat cards under 4 `<section>` headers.
 * `MEGACOMPACT_DASH_0B=0` renders the pre-DASH surfaces independently and the
 * flat 14-card VectorCortexTab layout — byte-identical predecessor.
 */
export const DASH_0B_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_DASH_0B");
