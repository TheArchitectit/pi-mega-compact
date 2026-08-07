/**
 * config/vector-cortex-dash-0d.ts — DASH-0d dashboard consolidation roll-up flag.
 *
 * Extracted to this sibling (per the vector-cortex-dash-0c.ts precedent) so
 * src/config/vector-cortex.ts stays under the 300-line soft limit. The flag is
 * positive, defaults ON, and `MEGACOMPACT_DASH_0D=0` is byte-identical to the
 * predecessor (DASH-0c): App.tsx renders the pre-rollup 13-tab surface set and
 * the registry holds the 13-tab union; no indirection name is removed and no
 * audit/verifier script is invoked by CI. Registered as a visible
 * VECTOR_CORTEX_SETTINGS boolDirect toggle, never EXCLUDED.
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

import { sprintFlag } from "./vector-cortex-flag.js";

/**
 * DASH-0d — final DASH sprint, the roll-up that makes the 7-surface target
 * externally provable: (1) App.tsx consolidates its lazy list to the 7 fixed
 * navigational surfaces (Overview, Sessions, Cache+Performance, Memory Graph,
 * Diagnostics, Setup, Admin) with an additive hash→surface router; (2) the
 * duplicate TurnsTab/MetricsTab indirection bodies are reconciled to their
 * canonical homes (TurnMemoryView / MetricsCards); (3) new dash-tab-count.mjs
 * and dashboard-audit.mjs verifiers prove the consolidated surface count + a11y
 * contract; (4) conformance fixtures DASH-0D-001..004 + evidence roll-up.
 * `MEGACOMPACT_DASH_0D=0` renders the pre-rollup 13-surface set — byte-identical.
 */
export const DASH_0D_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_DASH_0D");
